const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// Disable GPU cache to prevent errors
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-cache');

// Suppress error dialogs - log to console instead
dialog.showErrorBox = (title, content) => {
  console.error(`Error suppressed - ${title}: ${content}`);
};

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

// Auto-updater configuration
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = console;

const SERVER_PORT = 8877;
let mainWindow;
let server;

// Check if running in sync mode (connects to remote Docker server)
const SYNC_MODE = process.env.SYNC_MODE === 'true' || true; // Default to sync mode

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, '../renderer/icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Start server - use local sync server or full standalone server
  if (SYNC_MODE) {
    console.log('[Main] Starting in SYNC mode - connecting to remote server');
    server = require('../server/local-server.js');
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
  console.log('[Updater] Checking for update...');
  sendStatusToWindow('Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
  console.log('[Updater] Update available:', info.version);
  sendStatusToWindow(`Update available: v${info.version}`);
});

autoUpdater.on('update-not-available', (info) => {
  console.log('[Updater] No update available');
  sendStatusToWindow('App is up to date');
});

autoUpdater.on('error', (err) => {
  console.error('[Updater] Error:', err.message);
  sendStatusToWindow('Update error: ' + err.message);
});

autoUpdater.on('download-progress', (progressObj) => {
  const msg = `Downloading update: ${Math.round(progressObj.percent)}%`;
  console.log('[Updater]', msg);
  sendStatusToWindow(msg);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[Updater] Update downloaded:', info.version);
  sendStatusToWindow(`Update ready: v${info.version} - Restart to install`);

  // Show notification to user
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
  const soundsDir = path.join(process.env.APPDATA || process.env.HOME, 'StreamCompanion', 'sounds');
  const fs = require('fs');
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

// Clean shutdown
app.on('before-quit', () => {
  if (server && server.close) {
    server.close();
  }
});
