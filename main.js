const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const screenshot = require('screenshot-desktop');
const sharp = require('sharp');

// Load .env file
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

let mainWindow, overlayWindow, hudWindow, tray;
let genAI, model, chatModel, chatSession;
let isCapturing = false;
let captureInterval = null;
let lastScreenshot = null; // compressed jpeg base64
let analysisInFlight = false;
let lastBoard = ''; // track board to detect new cards / new hand
let lastAnalysis = null;

// --- Player Stats ---
const statsPath = path.join(__dirname, 'player_stats.json');
let playerStats = {};
let currentTablePlayers = [];

function loadStats() {
  try {
    if (fs.existsSync(statsPath)) playerStats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
  } catch { playerStats = {}; }
}

function saveStats() {
  fs.writeFileSync(statsPath, JSON.stringify(playerStats, null, 2));
}

// Only call this when a NEW HAND is detected (board changes to empty/preflop)
function updatePlayerStatsNewHand(players) {
  if (!players || !Array.isArray(players)) return;
  for (const p of players) {
    const name = (p.name || '').trim();
    if (!name || name === 'Unknown' || name === 'Hero') continue;
    if (!playerStats[name]) {
      playerStats[name] = { hands_seen: 0, vpip: 0, pfr: 0, aggression_actions: 0, passive_actions: 0, notes: [], first_seen: new Date().toISOString(), last_seen: new Date().toISOString() };
    }
    const s = playerStats[name];
    s.last_seen = new Date().toISOString();
    s.hands_seen++;
    if (p.vpip) s.vpip++;
    if (p.pfr) s.pfr++;
  }
  saveStats();
}

// Call on every capture to track actions (doesn't inflate hand count)
function updatePlayerActions(players) {
  if (!players || !Array.isArray(players)) return;
  for (const p of players) {
    const name = (p.name || '').trim();
    if (!name || name === 'Unknown' || name === 'Hero') continue;
    if (!playerStats[name]) continue; // only track known players
    const s = playerStats[name];
    s.last_seen = new Date().toISOString();
    if (p.action === 'bet' || p.action === 'raise') s.aggression_actions++;
    if (p.action === 'call' || p.action === 'check') s.passive_actions++;
    if (p.note && !s.notes.includes(p.note)) { s.notes.push(p.note); if (s.notes.length > 15) s.notes.shift(); }
  }
  saveStats();
}

function detectTableChange(newPlayers) {
  if (!newPlayers || newPlayers.length === 0) return { changed: false };
  const newNames = newPlayers.map(p => (p.name || '').trim()).filter(n => n && n !== 'Hero');
  const oldNames = currentTablePlayers;
  if (oldNames.length === 0) { currentTablePlayers = newNames; return { changed: true, type: 'first_capture', players: newNames }; }
  const left = oldNames.filter(n => !newNames.includes(n));
  const joined = newNames.filter(n => !oldNames.includes(n));
  currentTablePlayers = newNames;
  if (left.length > oldNames.length / 2) return { changed: true, type: 'new_table', left, joined };
  if (joined.length > 0 || left.length > 0) return { changed: true, type: 'players_changed', left, joined };
  return { changed: false };
}

function getStatsForPlayers(names) {
  const result = {};
  for (const name of names) {
    if (!playerStats[name]) continue;
    const s = playerStats[name];
    const h = s.hands_seen || 1;
    result[name] = {
      hands: s.hands_seen,
      vpip_pct: Math.round((s.vpip / h) * 100),
      pfr_pct: Math.round((s.pfr / h) * 100),
      agg_factor: s.passive_actions > 0 ? (s.aggression_actions / s.passive_actions).toFixed(1) : (s.aggression_actions > 0 ? 'INF' : '0'),
      notes: s.notes.slice(-3),
      type: categorizePlayer(s),
    };
  }
  return result;
}

function categorizePlayer(s) {
  const h = s.hands_seen || 1;
  if (h < 5) return '?';
  const v = (s.vpip / h) * 100, p = (s.pfr / h) * 100;
  if (v > 40 && p > 20) return 'LAG';
  if (v > 40) return 'Fish';
  if (v < 20 && p > 15) return 'TAG';
  if (v < 20) return 'Nit';
  return 'Reg';
}

// --- Prompts (kept short for speed) ---
function buildAnalysisPrompt() {
  let statsCtx = '';
  if (Object.keys(playerStats).length > 0) {
    const relevant = {};
    for (const name of currentTablePlayers) {
      if (playerStats[name]) {
        const s = playerStats[name], h = s.hands_seen || 1;
        relevant[name] = `${categorizePlayer(s)} VPIP:${Math.round((s.vpip/h)*100)}% PFR:${Math.round((s.pfr/h)*100)}%`;
      }
    }
    if (Object.keys(relevant).length > 0) {
      statsCtx = '\nKnown players: ' + Object.entries(relevant).map(([n,v]) => `${n}=${v}`).join(', ') + '. Factor these tendencies into your advice.';
    }
  }

  return `Poker coach. Analyze this screenshot. Respond ONLY with JSON, no markdown fences.${statsCtx}
{"s":"situation 1-2 sentences","a":"FOLD/CHECK/CALL/BET X/RAISE X","w":"why 1 sentence referencing player tendencies if known","c":"HIGH/MED/LOW","st":"PRE/FLOP/TURN/RIVER","pot":"pot size","hero":"hole cards","board":"board cards","p":[{"n":"name","act":"bet/raise/call/check/fold/none","v":true,"r":false,"x":0.5,"y":0.3}]}
For each player in "p", set "x" and "y" to their screen position as a fraction 0-1 (where 0,0 is top-left and 1,1 is bottom-right). Estimate based on where their name/avatar appears in the screenshot.
If not poker: {"s":"No poker table","a":"WAIT","w":"","c":"LOW","st":"","pot":"","hero":"","board":"","p":[]}`;
}

const CHAT_PROMPT = `Expert poker coach, live chat. Be concise (<100 words). Reference the screenshot and player stats if provided. Discuss strategy, ranges, odds, reads.`;

function initGemini(apiKey) {
  genAI = new GoogleGenerativeAI(apiKey);
  // Fastest available vision model
  model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
  chatModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  chatSession = null;
}

// Disable thinking for flash-lite to get raw speed
const ANALYSIS_CONFIG = { maxOutputTokens: 350, temperature: 0, thinkingConfig: { thinkingBudget: 0 } };

// --- Screenshot: capture, resize, compress to JPEG ---
async function captureScreen() {
  try {
    const imgBuffer = await screenshot({ format: 'png' });
    // Resize to 1024px wide, JPEG quality 60 for fast upload
    const compressed = await sharp(imgBuffer)
      .resize(1024, null, { withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();
    lastScreenshot = compressed.toString('base64');
    return lastScreenshot;
  } catch (err) {
    console.error('Screenshot failed:', err);
    return null;
  }
}

async function analyzeScreenshot(base64Image, apiKey) {
  if (!model) initGemini(apiKey);
  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [
        { text: buildAnalysisPrompt() },
        { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
      ]}],
      generationConfig: ANALYSIS_CONFIG,
    });

    const text = result.response.text().trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed;
    try { parsed = JSON.parse(text); } catch {
      return { s: text, a: 'SEE DETAILS', w: '', c: 'LOW', st: '', p: [] };
    }

    // Expand short keys for overlay
    const out = {
      situation: parsed.s || parsed.situation || '',
      action: parsed.a || parsed.action || '',
      why: parsed.w || parsed.why || '',
      confidence: parsed.c || parsed.confidence || '',
      street: parsed.st || parsed.street || '',
      pot_size: parsed.pot || parsed.pot_size || '',
      hero_cards: parsed.hero || parsed.hero_cards || '',
      board: parsed.board || '',
      players: (parsed.p || parsed.players || []).map(pl => ({
        name: pl.n || pl.name || '',
        action: pl.act || pl.action || 'none',
        vpip: pl.v ?? pl.vpip ?? false,
        pfr: pl.r ?? pl.pfr ?? false,
        note: pl.note || null,
        x: pl.x ?? null,
        y: pl.y ?? null,
      })),
    };

    // Detect board change (new card dealt or new hand)
    const newBoard = (out.board || '').trim();
    const boardChanged = newBoard !== lastBoard;
    if (boardChanged) {
      out._boardChanged = true;
      const isNewHand = !newBoard || newBoard.split(',').length <= 3 && lastBoard.split(',').length >= 4;
      lastBoard = newBoard;
      chatSession = null; // reset chat for new context
    }

    if (out.players.length > 0) {
      const tc = detectTableChange(out.players);
      if (tc.changed) out._tableChange = tc;

      // Only count hands_seen/vpip/pfr on new hands, not every screenshot
      if (boardChanged) {
        updatePlayerStatsNewHand(out.players);
      }
      // Always track actions
      updatePlayerActions(out.players);

      const names = out.players.map(p => p.name).filter(Boolean);
      out._playerStats = getStatsForPlayers(names);
      // Attach coordinates
      for (const p of out.players) {
        if (p.name && p.x != null && p.y != null && out._playerStats[p.name]) {
          out._playerStats[p.name].x = p.x;
          out._playerStats[p.name].y = p.y;
        }
      }
    }

    lastAnalysis = out;
    return out;
  } catch (err) {
    console.error('Gemini API error:', err);
    return { situation: `Error: ${err.message}`, action: 'ERROR', why: '', confidence: 'LOW', street: '', players: [] };
  }
}

async function chatWithAI(messages, apiKey) {
  if (!chatModel) initGemini(apiKey);
  try {
    if (!chatSession) {
      let sysText = CHAT_PROMPT;
      if (currentTablePlayers.length > 0) {
        const stats = getStatsForPlayers(currentTablePlayers);
        if (Object.keys(stats).length > 0) sysText += '\nPlayer stats: ' + JSON.stringify(stats);
      }
      if (lastAnalysis) {
        sysText += `\nCurrent hand: Hero has ${lastAnalysis.hero_cards || '?'}, board is ${lastAnalysis.board || 'none'}, pot ${lastAnalysis.pot_size || '?'}, street ${lastAnalysis.street || '?'}. Last advice was: ${lastAnalysis.action} - ${lastAnalysis.why}`;
      }
      chatSession = chatModel.startChat({
        history: [],
        systemInstruction: { role: 'user', parts: [{ text: sysText }] },
      });
    }
    const latest = messages[messages.length - 1];
    const parts = [];
    if (lastScreenshot) parts.push({ inlineData: { mimeType: 'image/jpeg', data: lastScreenshot } });
    parts.push(latest.content);
    const result = await chatSession.sendMessage(parts);
    return result.response.text();
  } catch (err) { chatSession = null; return `Error: ${err.message}`; }
}

// --- Windows ---
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 560, height: 800, minWidth: 480, minHeight: 600, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    title: 'Poker Screen Watcher', backgroundColor: '#0f0f1a',
  });
  mainWindow.loadFile('ui/main.html');
  mainWindow.on('close', (e) => { if (tray) { e.preventDefault(); mainWindow.hide(); } });
}

function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow = new BrowserWindow({
    width: 380, height: 480, x: width - 400, y: 20,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: true, hasShadow: false,
  });
  overlayWindow.loadFile('ui/overlay.html');
  overlayWindow.setVisibleOnAllWorkspaces(true);
}

function createHudWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  hudWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, hasShadow: false, focusable: false,
  });
  hudWindow.setIgnoreMouseEvents(true, { forward: true });
  hudWindow.loadFile('ui/hud.html');
  hudWindow.setVisibleOnAllWorkspaces(true);
}

function createTray() {
  const icon = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAADlJREFUOI1jYBhsgJGBgYGBgYEhm4GBIRuXHBMDA8N/BgaG/wwMDP8ZGBj+48qjG4BsACMjNkUDCgAALRkEBnOixCsAAAAASUVORK5CYII=', 'base64'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Poker Screen Watcher');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Settings', click: () => mainWindow.show() },
    { label: 'Toggle Overlay', click: () => {
      if (overlayWindow.isVisible()) { overlayWindow.hide(); hudWindow.hide(); }
      else { overlayWindow.show(); hudWindow.show(); }
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => { tray = null; app.quit(); } },
  ]));
  tray.on('click', () => {
    if (overlayWindow.isVisible()) { overlayWindow.hide(); hudWindow.hide(); }
    else { overlayWindow.show(); hudWindow.show(); }
  });
}

function getApiKey() {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try { const d = JSON.parse(fs.readFileSync(configPath, 'utf-8')); if (d.apiKey) return d.apiKey; } catch {}
  return process.env.GEMINI_API_KEY || '';
}

// --- Auto capture loop (non-blocking) ---
function doCapture(apiKey) {
  if (analysisInFlight) return; // skip if previous still running
  analysisInFlight = true;

  overlayWindow.webContents.send('overlay-status', 'analyzing');

  // Fire and forget -- don't await, so the interval keeps ticking
  (async () => {
    try {
      const img = await captureScreen();
      if (!img) return;
      mainWindow.webContents.send('screenshot-taken', img);
      const analysis = await analyzeScreenshot(img, apiKey);
      analysis._timestamp = new Date().toLocaleTimeString();
      overlayWindow.webContents.send('overlay-update', analysis);
      hudWindow.webContents.send('hud-update', analysis);
      mainWindow.webContents.send('analysis-result', analysis);
    } catch (err) {
      console.error('Capture error:', err);
    } finally {
      analysisInFlight = false;
    }
  })();
}

// --- IPC ---
ipcMain.handle('capture-and-analyze', async (e, apiKey) => {
  await doCapture(apiKey);
});

ipcMain.handle('start-auto-capture', (e, apiKey, sec) => {
  if (isCapturing) return;
  isCapturing = true;
  doCapture(apiKey);
  captureInterval = setInterval(() => doCapture(apiKey), sec * 1000);
});

ipcMain.handle('stop-auto-capture', () => {
  isCapturing = false;
  if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
});

ipcMain.handle('chat', async (e, msgs, apiKey) => chatWithAI(msgs, apiKey));
ipcMain.handle('toggle-overlay', () => {
  if (overlayWindow.isVisible()) { overlayWindow.hide(); hudWindow.hide(); }
  else { overlayWindow.show(); hudWindow.show(); }
});
ipcMain.handle('get-all-stats', () => playerStats);
ipcMain.handle('clear-stats', () => { playerStats = {}; currentTablePlayers = []; saveStats(); return true; });
ipcMain.handle('reset-chat', () => { chatSession = null; return true; });
ipcMain.handle('save-api-key', (e, k) => { fs.writeFileSync(path.join(app.getPath('userData'), 'config.json'), JSON.stringify({ apiKey: k })); });
ipcMain.handle('load-api-key', () => getApiKey());

// Overlay chat
let overlayChatHistory = [];
ipcMain.on('overlay-chat', async (event, text) => {
  const apiKey = getApiKey();
  if (!apiKey) { overlayWindow.webContents.send('chat-response', 'No API key. Set in tray > Settings.'); return; }
  overlayChatHistory.push({ role: 'user', content: text });
  const reply = await chatWithAI(overlayChatHistory, apiKey);
  overlayChatHistory.push({ role: 'assistant', content: reply });
  overlayWindow.webContents.send('chat-response', reply);
});

// --- App lifecycle ---
app.whenReady().then(() => {
  loadStats();
  createMainWindow();
  createOverlayWindow();
  createHudWindow();
  createTray();

  globalShortcut.register('CommandOrControl+Shift+P', () => doCapture(getApiKey()));

  globalShortcut.register('CommandOrControl+\\', () => {
    if (overlayWindow.isVisible()) {
      overlayWindow.hide();
      hudWindow.hide();
    } else {
      overlayWindow.show();
      hudWindow.show();
    }
  });

  // Auto-start capture
  const apiKey = getApiKey();
  if (apiKey) {
    setTimeout(async () => {
      isCapturing = true;
      doCapture(apiKey);
      captureInterval = setInterval(() => doCapture(apiKey), 5000);
      mainWindow.webContents.send('auto-started');
    }, 1500);
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (overlayWindow) { overlayWindow.isVisible() ? overlayWindow.focus() : overlayWindow.show(); } });
