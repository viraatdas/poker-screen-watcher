const { app, BrowserWindow, ipcMain, screen, globalShortcut, desktopCapturer, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const screenshot = require('screenshot-desktop');

let mainWindow;
let overlayWindow;
let tray;
let anthropic;
let isCapturing = false;
let captureInterval = null;
let lastScreenshot = null;

const POKER_SYSTEM_PROMPT = `You are an expert poker coach and strategist. You analyze screenshots of online poker games and provide real-time strategic advice.

When analyzing a poker screenshot, identify and consider:
- Your hole cards (the cards dealt to the player)
- Community cards (flop, turn, river)
- Current pot size and bet amounts
- Your stack size and opponents' stack sizes
- Your position at the table (early, middle, late, blinds)
- Number of players still in the hand
- The current street (preflop, flop, turn, river)
- Any visible player actions (check, bet, raise, fold indicators)
- Tournament vs cash game indicators
- Blind levels

Based on this analysis, provide:
1. A brief read of the current situation (2-3 sentences max)
2. Your recommended action (fold/check/call/bet/raise) with sizing if applicable
3. A short reasoning (1-2 sentences)

Keep responses concise and actionable — this is an overlay the player reads mid-game.
Format your response as:
SITUATION: [brief read]
ACTION: [recommended action]
WHY: [reasoning]

If you cannot clearly read the cards or game state, say what you can see and give the best advice possible with available information.`;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 400,
    minHeight: 500,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    title: 'Poker Screen Watcher',
    backgroundColor: '#1a1a2e',
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
  const { width, height } = primaryDisplay.workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 380,
    height: 220,
    x: width - 400,
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

  overlayWindow.setIgnoresMouseEvents(true, { forward: true });
  overlayWindow.loadFile('ui/overlay.html');
  overlayWindow.setVisibleOnAllWorkspaces(true);
}

function createTray() {
  // Create a simple tray icon (16x16 template image)
  const icon = nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAADlJREFUOI1jYBhsgJGBgYGBgYEhm4GBIRuXHBMDA8N/BgaG/wwMDP8ZGBj+48qjG4BsACMjNkUDCgAALRkEBnOixCsAAAAASUVORK5CYII=',
      'base64'
    )
  );
  icon.setTemplateImage(true);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => mainWindow.show(),
    },
    {
      label: 'Toggle Overlay',
      click: () => {
        if (overlayWindow.isVisible()) {
          overlayWindow.hide();
        } else {
          overlayWindow.show();
        }
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
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: POKER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: 'Analyze this poker screenshot and give me strategic advice.',
            },
          ],
        },
      ],
    });

    return response.content[0].text;
  } catch (err) {
    console.error('API error:', err);
    return `Error: ${err.message}`;
  }
}

async function chatWithAI(messages, apiKey) {
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey });
  }

  try {
    // Build message array, attaching the last screenshot to the latest user message if available
    const apiMessages = messages.map((msg, i) => {
      if (msg.role === 'user' && i === messages.length - 1 && lastScreenshot) {
        return {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: lastScreenshot,
              },
            },
            { type: 'text', text: msg.content },
          ],
        };
      }
      return { role: msg.role, content: msg.content };
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: POKER_SYSTEM_PROMPT + '\n\nYou are now in chat mode. The player may ask follow-up questions about strategy, hand ranges, odds, or general poker theory. If a screenshot is attached, reference the current game state. Be conversational but still concise.',
      messages: apiMessages,
    });

    return response.content[0].text;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// IPC Handlers
ipcMain.handle('capture-and-analyze', async (event, apiKey) => {
  mainWindow.webContents.send('status', 'Capturing screen...');
  overlayWindow.webContents.send('overlay-status', 'Analyzing...');

  const img = await captureScreen();
  if (!img) return 'Failed to capture screen';

  mainWindow.webContents.send('status', 'Analyzing with AI...');
  mainWindow.webContents.send('screenshot-taken', img);

  const analysis = await analyzeScreenshot(img, apiKey);

  overlayWindow.webContents.send('overlay-update', analysis);
  mainWindow.webContents.send('status', 'Ready');
  mainWindow.webContents.send('analysis-result', analysis);

  return analysis;
});

ipcMain.handle('start-auto-capture', async (event, apiKey, intervalSeconds) => {
  if (isCapturing) return;
  isCapturing = true;

  const doCapture = async () => {
    if (!isCapturing) return;
    const img = await captureScreen();
    if (img) {
      mainWindow.webContents.send('screenshot-taken', img);
      mainWindow.webContents.send('status', 'Analyzing...');
      overlayWindow.webContents.send('overlay-status', 'Analyzing...');

      const analysis = await analyzeScreenshot(img, apiKey);
      overlayWindow.webContents.send('overlay-update', analysis);
      mainWindow.webContents.send('analysis-result', analysis);
      mainWindow.webContents.send('status', `Auto-capture every ${intervalSeconds}s`);
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
  mainWindow.webContents.send('status', 'Stopped');
});

ipcMain.handle('chat', async (event, messages, apiKey) => {
  return await chatWithAI(messages, apiKey);
});

ipcMain.handle('toggle-overlay', () => {
  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    overlayWindow.show();
  }
});

ipcMain.handle('set-overlay-interactive', (event, interactive) => {
  overlayWindow.setIgnoresMouseEvents(!interactive, { forward: true });
  if (interactive) {
    overlayWindow.setFocusable(true);
  } else {
    overlayWindow.setFocusable(false);
  }
});

ipcMain.handle('move-overlay', (event, x, y) => {
  overlayWindow.setPosition(x, y);
});

ipcMain.handle('save-api-key', (event, apiKey) => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ apiKey }));
});

ipcMain.handle('load-api-key', () => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return data.apiKey || '';
  } catch {
    return '';
  }
});

app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  createTray();

  // Global shortcut: Cmd+Shift+P to capture
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    mainWindow.webContents.send('trigger-capture');
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
