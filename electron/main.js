import { app, BrowserWindow, Tray, Menu, ipcMain, shell, Notification, nativeImage } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const SERVER_URL = `http://localhost:${PORT}`;
const iconPath = path.resolve(__dirname, 'assets/icon.png');

// Configure Downloads folder
const defaultDownloads = app.isPackaged
  ? path.join(app.getPath('downloads'), 'HyperTorrent')
  : path.resolve(__dirname, '../downloads');

if (!process.env.DOWNLOAD_DIR) {
  process.env.DOWNLOAD_DIR = defaultDownloads;
}

// Ensure download directory exists
if (!fs.existsSync(process.env.DOWNLOAD_DIR)) {
  try {
    fs.mkdirSync(process.env.DOWNLOAD_DIR, { recursive: true });
  } catch (e) {
    console.warn('[Electron] Could not create download dir:', e.message);
  }
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let hasShownMinimizeTip = false;

// Register Windows & OS deep link protocol for magnet links
function registerMagnetProtocol() {
  try {
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('magnet', process.execPath, [path.resolve(process.argv[1])]);
      }
    } else {
      app.setAsDefaultProtocolClient('magnet');
    }
  } catch (err) {
    console.warn('[Electron] Failed to register protocol client:', err.message);
  }
}

// Single Instance Lock: Ensure only one instance of HyperTorrent runs
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // Focus existing window and handle incoming magnet link
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();

      const magnetArg = commandLine.find(arg => typeof arg === 'string' && arg.startsWith('magnet:?'));
      if (magnetArg) {
        handleIncomingMagnet(magnetArg);
      }
    }
  });

  // Handle open-url on macOS
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (url.startsWith('magnet:?')) {
      handleIncomingMagnet(url);
    }
  });

  app.whenReady().then(async () => {
    registerMagnetProtocol();

    // 1. Launch backend engine
    try {
      await import('../server/index.js');
      console.log('[Electron] Server engine successfully booted.');
    } catch (err) {
      console.error('[Electron] Failed to import server:', err);
    }

    // 2. Wait for HTTP readiness
    await waitForServer(SERVER_URL);

    // 3. Create Main Window & Tray
    createMainWindow();
    createSystemTray();

    // 4. Handle initial command-line magnet link
    const initialMagnet = process.argv.find(arg => typeof arg === 'string' && arg.startsWith('magnet:?'));
    if (initialMagnet) {
      setTimeout(() => handleIncomingMagnet(initialMagnet), 1500);
    }
  });
}

// Wait for local HTTP server to respond with HTTP 200 before loading URL
function waitForServer(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const check = () => {
      const req = http.get(url, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve(true);
        } else {
          retry();
        }
      });
      req.on('error', retry);
      req.end();
    };

    const retry = () => {
      if (Date.now() - startTime > timeoutMs) {
        console.warn('[Electron] Server readiness timeout, proceeding to load URL anyway...');
        return resolve(false);
      }
      setTimeout(check, 100);
    };

    check();
  });
}

function createMainWindow() {
  const appIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'HyperTorrent — High-Speed BitTorrent Engine',
    icon: appIcon,
    backgroundColor: '#0a0b10', // Prevent white flash on launch
    autoHideMenuBar: true,
    show: false, // Show once ready-to-show for a buttery smooth launch
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true
    }
  });

  mainWindow.loadURL(SERVER_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Open target="_blank" links in default external browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Intercept close event: Minimize to tray instead of abruptly closing active downloads
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();

      if (!hasShownMinimizeTip && Notification.isSupported()) {
        hasShownMinimizeTip = true;
        const note = new Notification({
          title: 'HyperTorrent Running in Tray',
          body: 'Downloads will continue in the background. Right-click the tray icon to quit.',
          icon: appIcon
        });
        note.show();
      }
    }
  });
}

function createSystemTray() {
  try {
    let trayIcon = null;
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
    }

    if (!trayIcon) return;

    tray = new Tray(trayIcon);
    tray.setToolTip('HyperTorrent — High-Speed BitTorrent Engine');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show HyperTorrent',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: 'Open Downloads Folder',
        click: () => {
          shell.openPath(process.env.DOWNLOAD_DIR);
        }
      },
      { type: 'separator' },
      {
        label: '⚡ Turbo Boost All Swarms',
        click: async () => {
          try {
            await fetch(`${SERVER_URL}/api/torrents/boost-all`, { method: 'POST' });
            if (Notification.isSupported()) {
              new Notification({
                title: '⚡ Swarms Turbo Boosted',
                body: 'Injected 90+ live community trackers & re-announced swarms.'
              }).show();
            }
          } catch (e) {
            console.error('[Tray Boost Error]:', e.message);
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Quit HyperTorrent',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.focus();
        } else {
          mainWindow.show();
        }
      }
    });
  } catch (err) {
    console.warn('[Electron] Could not initialize tray:', err.message);
  }
}

// Push magnet link to backend and notify UI
async function handleIncomingMagnet(magnetUri) {
  try {
    console.log('[Electron] Handling incoming magnet link:', magnetUri.substring(0, 60));
    await fetch(`${SERVER_URL}/api/torrents/magnet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnetURI: magnetUri })
    });

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('incoming-magnet', magnetUri);
    }

    if (Notification.isSupported()) {
      new Notification({
        title: '⚡ Magnet Added to HyperTorrent',
        body: 'Download initiated from incoming magnet link.'
      }).show();
    }
  } catch (err) {
    console.error('[Electron] Error handling incoming magnet:', err.message);
  }
}

// IPC Handlers
ipcMain.handle('open-downloads-folder', () => {
  shell.openPath(process.env.DOWNLOAD_DIR);
});

ipcMain.handle('open-external', (_event, url) => {
  shell.openExternal(url);
});

// App lifecycle
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  } else if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});
