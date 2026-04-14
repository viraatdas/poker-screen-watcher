const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const screenshot = require('screenshot-desktop');

// Load .env file
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

let mainWindow;
let overlayWindow;
let tray;
let genAI;
let model;
let chatSession;
let isCapturing = false;
let captureInterval = null;
let lastScreenshot = null;

// --- Player Stats ---
const statsPath = path.join(__dirname, 'player_stats.json');
let playerStats = {};
let currentTablePlayers = [];

function loadStats() {
  try {
    if (fs.existsSync(statsPath)) {
      playerStats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    }
  } catch { playerStats = {}; }
}

function saveStats() {
  fs.writeFileSync(statsPath, JSON.stringify(playerStats, null, 2));
}

function updatePlayerStats(players) {
  if (!players || !Array.isArray(players)) return;

  for (const p of players) {
    const name = (p.name || '').trim();
    if (!name || name === 'Unknown' || name === 'Hero') continue;

    if (!playerStats[name]) {
      playerStats[name] = {
        hands_seen: 0,
        vpip: 0,
        pfr: 0,
        aggression_actions: 0,
        passive_actions: 0,
        showdowns: 0,
        notes: [],
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        tables_seen: 0,
      };
    }

    const s = playerStats[name];
    s.last_seen = new Date().toISOString();
    s.hands_seen++;
    if (p.vpip) s.vpip++;
    if (p.pfr) s.pfr++;
    if (p.action === 'bet' || p.action === 'raise') s.aggression_actions++;
    if (p.action === 'call' || p.action === 'check') s.passive_actions++;
    if (p.showdown) s.showdowns++;
    if (p.note && !s.notes.includes(p.note)) {
      s.notes.push(p.note);
      if (s.notes.length > 20) s.notes.shift();
    }
  }

  saveStats();
}

function detectTableChange(newPlayers) {
  if (!newPlayers || newPlayers.length === 0) return { changed: false };

  const newNames = newPlayers.map(p => (p.name || '').trim()).filter(n => n && n !== 'Hero');
  const oldNames = currentTablePlayers;

  if (oldNames.length === 0) {
    currentTablePlayers = newNames;
    return { changed: true, type: 'first_capture', players: newNames };
  }

  const stayed = newNames.filter(n => oldNames.includes(n));
  const left = oldNames.filter(n => !newNames.includes(n));
  const joined = newNames.filter(n => !oldNames.includes(n));

  currentTablePlayers = newNames;

  // More than half the table changed = new table
  if (left.length > oldNames.length / 2) {
    return { changed: true, type: 'new_table', left, joined, stayed };
  }
  if (joined.length > 0 || left.length > 0) {
    return { changed: true, type: 'players_changed', left, joined, stayed };
  }
  return { changed: false };
}

function getStatsForPlayers(names) {
  const result = {};
  for (const name of names) {
    if (playerStats[name]) {
      const s = playerStats[name];
      const hands = s.hands_seen || 1;
      result[name] = {
        hands: s.hands_seen,
        vpip_pct: Math.round((s.vpip / hands) * 100),
        pfr_pct: Math.round((s.pfr / hands) * 100),
        agg_factor: s.passive_actions > 0
          ? (s.aggression_actions / s.passive_actions).toFixed(1)
          : s.aggression_actions > 0 ? 'INF' : '0',
        notes: s.notes.slice(-3),
        type: categorizePlayer(s),
      };
    }
  }
  return result;
}

function categorizePlayer(s) {
  const hands = s.hands_seen || 1;
  if (hands < 5) return 'Unknown';
  const vpip = (s.vpip / hands) * 100;
  const pfr = (s.pfr / hands) * 100;
  if (vpip > 40 && pfr > 20) return 'LAG';
  if (vpip > 40) return 'Loose Passive';
  if (vpip < 20 && pfr > 15) return 'TAG';
  if (vpip < 20) return 'Nit';
  return 'Regular';
}

// --- Prompts ---
const ANALYSIS_PROMPT = `You are an expert poker coach analyzing a screenshot of an online poker game.

You MUST respond with valid JSON only. No markdown, no code fences, no extra text.

JSON schema:
{
  "situation": "2-3 sentence read of the current game state",
  "action": "Your recommended action: FOLD / CHECK / CALL / BET [size] / RAISE [size]",
  "why": "1-2 sentence reasoning",
  "confidence": "HIGH / MEDIUM / LOW",
  "street": "PREFLOP / FLOP / TURN / RIVER / UNKNOWN",
  "pot_size": "estimated pot size or null",
  "hero_cards": "hero's hole cards or null",
  "board": "community cards or null",
  "players": [
    {
      "name": "player screen name",
      "position": "seat position if visible",
      "stack": "stack size if visible",
      "action": "their last action: bet/raise/call/check/fold/none",
      "vpip": true/false (did they voluntarily put money in),
      "pfr": true/false (did they raise preflop),
      "showdown": false,
      "note": "brief behavioral note or null"
    }
  ]
}

If you cannot read certain fields, set them to null. Always try to extract player names.
If this is NOT a poker screenshot, respond: {"situation": "No poker table detected", "action": "WAITING", "why": "Screenshot does not show a poker game", "confidence": "HIGH", "street": "UNKNOWN", "pot_size": null, "hero_cards": null, "board": null, "players": []}`;

const CHAT_PROMPT = `You are an expert poker coach in a live chat with a player. You have access to their current game screenshot and player statistics from their session.

Be conversational but concise. You can discuss:
- Current hand strategy and what they should do
- Player tendencies and reads based on tracked stats
- Hand ranges, pot odds, equity calculations
- General poker theory and concepts
- Review of past hands

When player stats are provided, reference them naturally. For example: "Player X has been playing 45% of hands with a 3.2 aggression factor - they're a LAG, so their raise here is wide."

Keep responses under 150 words unless they ask for detailed analysis.`;

function initGemini(apiKey) {
  genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  chatSession = null;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 800,
    minWidth: 480,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    title: 'Poker Screen Watcher',
    backgroundColor: '#0f0f1a',
  });

  mainWindow.loadFile('ui/main.html');

  mainWindow.on('close', (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createOverlayWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 420,
    height: 320,
    x: width - 440,
    y: 20,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    focusable: false,
  });

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile('ui/overlay.html');
  overlayWindow.setVisibleOnAllWorkspaces(true);
}

function createTray() {
  const icon = nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAADlJREFUOI1jYBhsgJGBgYGBgYEhm4GBIRuXHBMDA8N/BgaG/wwMDP8ZGBj+48qjG4BsACMjNkUDCgAALRkEBnOixCsAAAAASUVORK5CYII=',
      'base64'
    )
  );
  icon.setTemplateImage(true);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Window', click: () => mainWindow.show() },
    {
      label: 'Toggle Overlay',
      click: () => {
        if (overlayWindow.isVisible()) overlayWindow.hide();
        else overlayWindow.show();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        tray = null;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Poker Screen Watcher');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => mainWindow.show());
}

async function captureScreen() {
  try {
    const imgBuffer = await screenshot({ format: 'png' });
    lastScreenshot = imgBuffer.toString('base64');
    return lastScreenshot;
  } catch (err) {
    console.error('Screenshot failed:', err);
    return null;
  }
}

async function analyzeScreenshot(base64Image, apiKey) {
  if (!model) initGemini(apiKey);

  try {
    const result = await model.generateContent([
      ANALYSIS_PROMPT,
      {
        inlineData: {
          mimeType: 'image/png',
          data: base64Image,
        },
      },
    ]);

    const text = result.response.text().trim();

    // Strip markdown code fences if Gemini wraps them
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Fallback for non-JSON responses
      return {
        situation: text,
        action: 'SEE DETAILS',
        why: '',
        confidence: 'LOW',
        street: 'UNKNOWN',
        players: [],
      };
    }

    // Process players
    if (parsed.players && parsed.players.length > 0) {
      const tableChange = detectTableChange(parsed.players);
      if (tableChange.changed) {
        parsed._tableChange = tableChange;
      }
      updatePlayerStats(parsed.players);

      // Attach stored stats to the response
      const names = parsed.players.map(p => p.name).filter(Boolean);
      parsed._playerStats = getStatsForPlayers(names);
    }

    return parsed;
  } catch (err) {
    console.error('Gemini API error:', err);
    return {
      situation: `Error: ${err.message}`,
      action: 'ERROR',
      why: 'API call failed',
      confidence: 'LOW',
      street: 'UNKNOWN',
      players: [],
    };
  }
}

async function chatWithAI(messages, apiKey) {
  if (!model) initGemini(apiKey);

  try {
    if (!chatSession) {
      // Build stats context
      let statsContext = '';
      if (currentTablePlayers.length > 0) {
        const stats = getStatsForPlayers(currentTablePlayers);
        if (Object.keys(stats).length > 0) {
          statsContext = '\n\nCurrent table player stats:\n' + JSON.stringify(stats, null, 2);
        }
      }

      chatSession = model.startChat({
        history: [],
        systemInstruction: CHAT_PROMPT + statsContext,
      });
    }

    const latestMsg = messages[messages.length - 1];
    const parts = [];
    if (lastScreenshot) {
      parts.push({
        inlineData: { mimeType: 'image/png', data: lastScreenshot },
      });
    }
    parts.push(latestMsg.content);

    const result = await chatSession.sendMessage(parts);
    return result.response.text();
  } catch (err) {
    chatSession = null;
    return `Error: ${err.message}`;
  }
}

// --- IPC Handlers ---

ipcMain.handle('capture-and-analyze', async (event, apiKey) => {
  mainWindow.webContents.send('status', 'capturing');
  overlayWindow.webContents.send('overlay-status', 'analyzing');

  const img = await captureScreen();
  if (!img) return { situation: 'Failed to capture screen', action: 'ERROR' };

  mainWindow.webContents.send('screenshot-taken', img);

  const analysis = await analyzeScreenshot(img, apiKey);

  overlayWindow.webContents.send('overlay-update', analysis);
  mainWindow.webContents.send('analysis-result', analysis);
  mainWindow.webContents.send('status', 'ready');

  return analysis;
});

ipcMain.handle('start-auto-capture', async (event, apiKey, intervalSeconds) => {
  if (isCapturing) return;
  isCapturing = true;

  const doCapture = async () => {
    if (!isCapturing) return;
    mainWindow.webContents.send('status', 'capturing');
    overlayWindow.webContents.send('overlay-status', 'analyzing');

    const img = await captureScreen();
    if (img) {
      mainWindow.webContents.send('screenshot-taken', img);
      const analysis = await analyzeScreenshot(img, apiKey);
      overlayWindow.webContents.send('overlay-update', analysis);
      mainWindow.webContents.send('analysis-result', analysis);
      mainWindow.webContents.send('status', 'auto');
    }
  };

  await doCapture();
  captureInterval = setInterval(doCapture, intervalSeconds * 1000);
});

ipcMain.handle('stop-auto-capture', () => {
  isCapturing = false;
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  mainWindow.webContents.send('status', 'stopped');
});

ipcMain.handle('chat', async (event, messages, apiKey) => {
  return await chatWithAI(messages, apiKey);
});

ipcMain.handle('toggle-overlay', () => {
  if (overlayWindow.isVisible()) overlayWindow.hide();
  else overlayWindow.show();
});

ipcMain.handle('get-all-stats', () => {
  return playerStats;
});

ipcMain.handle('clear-stats', () => {
  playerStats = {};
  currentTablePlayers = [];
  saveStats();
  return true;
});

ipcMain.handle('reset-chat', () => {
  chatSession = null;
  return true;
});

ipcMain.handle('save-api-key', (event, apiKey) => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ apiKey }));
});

ipcMain.handle('load-api-key', () => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (data.apiKey) return data.apiKey;
  } catch {}
  return process.env.GEMINI_API_KEY || '';
});

app.whenReady().then(() => {
  loadStats();
  createMainWindow();
  createOverlayWindow();
  createTray();

  globalShortcut.register('CommandOrControl+Shift+P', () => {
    mainWindow.webContents.send('trigger-capture');
  });

  // Cmd+\ to toggle overlay
  globalShortcut.register('CommandOrControl+\\', () => {
    if (overlayWindow.isVisible()) overlayWindow.hide();
    else overlayWindow.show();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
