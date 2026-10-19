const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

// Same folder the app already uses for settings.json and sounds
const DATA_DIR = path.join(app.getPath('appData'), 'StreamCompanion');
const logFile = logger.init(path.join(DATA_DIR, 'logs'));

let mainWindow = null;
let server = null;

// ========== SINGLE INSTANCE ==========
// A second copy can't bind 8877/8878, so hand off to the running one instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[Main] Another instance is already running - focusing it and exiting');
  app.quit();
} else {
  main();
}

function main() {
  const { autoUpdater } = require('electron-updater');

  console.log(`[Main] Stream Companion v${app.getVersion()} starting (log: ${logFile})`);

  app.on('second-instance', () => {
    console.log('[Main] Second launch blocked - focusing existing window');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (app.isReady()) {
      createWindow();
    }
  });

  // Disable GPU cache to prevent errors
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disable-gpu-cache');

  // Keep running through a stray error mid-stream, but log it instead of
  // hiding it. (Registering these handlers also stops Electron's default
  // crash dialog for uncaught exceptions, which is the only dialog we suppress.)
  process.on('uncaughtException', (err) => {
    console.error('[Main] Uncaught exception:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[Main] Unhandled rejection:', err);
  });

  // Auto-updater configuration
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  // Check if running in sync mode (connects to remote Docker server).
  // Sync mode is the default; set SYNC_MODE=false for the old standalone server.
  const SYNC_MODE = process.env.SYNC_MODE !== 'false';

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      },
      icon: path.join(__dirname, '../renderer/icon.png')
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    mainWindow.webContents.on('render-process-gone', (event, details) => {
      console.error('[Main] Renderer process gone:', details.reason, details.exitCode);
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  app.whenReady().then(() => {
    if (SYNC_MODE) {
      console.log('[Main] Starting in SYNC mode - connecting to remote server');
      server = require('../server/local-server.js');
      server.start().catch(err => {
        console.error('[Main] Local server failed to start:', err.message);
        dialog.showErrorBox('Stream Companion - local server not started',
          `${err.message}.\n\nOverlays and games will not work until this is fixed ` +
          `(close whatever is using ports 8877/8878 and restart the app).\n\nLog: ${logFile}`);
      });
    } else {
      console.log('[Main] Starting in STANDALONE mode - full local server');
      server = require('../server/index.js');
    }

    createWindow();

    // Check for updates after window is ready
    setTimeout(() => {
      checkForUpdates();
    }, 3000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  // ========== AUTO-UPDATER ==========
  function checkForUpdates() {
    console.log('[Updater] Checking for updates...');
    autoUpdater.checkForUpdates().catch(err => {
      console.log('[Updater] Update check failed:', err.message);
    });
  }

  autoUpdater.on('checking-for-update', () => {
    sendStatusToWindow('Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Update available:', info.version);
    sendStatusToWindow(`Update available: v${info.version}`);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] No update available');
    sendStatusToWindow('App is up to date');
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message);
    sendStatusToWindow('Update error: ' + err.message);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    sendStatusToWindow(`Downloading update: ${Math.round(progressObj.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Update downloaded:', info.version);
    sendStatusToWindow(`Update ready: v${info.version} - Restart to install`);
    if (mainWindow) {
      mainWindow.webContents.send('update-downloaded', info.version);
    }
  });

  function sendStatusToWindow(text) {
    if (mainWindow) {
      mainWindow.webContents.send('update-status', text);
    }
  }

  // IPC handlers for manual update controls
  ipcMain.handle('check-for-updates', () => {
    checkForUpdates();
  });

  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle('get-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('open-sounds-folder', () => {
    const soundsDir = path.join(DATA_DIR, 'sounds');
    if (!fs.existsSync(soundsDir)) {
      fs.mkdirSync(soundsDir, { recursive: true });
    }
    shell.openPath(soundsDir);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Clean shutdown: stop the sync client and release 8877/8878
  app.on('before-quit', () => {
    console.log('[Main] Quitting');
    if (server && server.close) {
      try {
        server.close();
      } catch (e) {
        console.error('[Main] Error stopping local server:', e);
      }
    }
  });
}
