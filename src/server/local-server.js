/**
 * Stream Companion Local Server
 *
 * Lightweight server that:
 * 1. Syncs with remote Docker server via WebSocket
 * 2. Serves overlays locally for OBS (no bandwidth usage)
 * 3. Broadcasts state to local overlay clients
 *
 * The remote server handles all heavy lifting:
 * - Twitch integration
 * - Data persistence
 * - API logic
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const SyncClient = require('./sync-client');

// Sounds directory
const SOUNDS_DIR = path.join(process.env.APPDATA || process.env.HOME, 'StreamCompanion', 'sounds');

// Ensure sounds directory exists
function ensureSoundsDir() {
  if (!fs.existsSync(SOUNDS_DIR)) {
    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
  }
}
ensureSoundsDir();

// Configure multer for sound uploads
const soundStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureSoundsDir();
    cb(null, SOUNDS_DIR);
  },
  filename: (req, file, cb) => {
    // Sanitize filename
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safeName);
  }
});

const soundUpload = multer({
  storage: soundStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.mp3', '.wav', '.ogg'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .mp3, .wav, .ogg files allowed'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// Local settings file (persists across updates)
const SETTINGS_FILE = path.join(process.env.APPDATA || process.env.HOME, 'StreamCompanion', 'settings.json');

function ensureSettingsDir() {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadLocalSettings() {
  try {
    ensureSettingsDir();
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[LocalServer] Error loading settings:', e);
  }
  return {};
}

function saveLocalSettings(settings) {
  try {
    ensureSettingsDir();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    return true;
  } catch (e) {
    console.error('[LocalServer] Error saving settings:', e);
    return false;
  }
}

let localSettings = loadLocalSettings();

// Configuration
const CONFIG = {
  httpPort: process.env.HTTP_PORT || 8877,
  wsPort: process.env.WS_PORT || 8878,
  overlaysDir: process.env.OVERLAYS_DIR || 'C:\\Streaming\\Programs\\StreamCompanion\\src\\overlays',
  remoteWsUrl: process.env.REMOTE_WS_URL || 'wss://stream.soupymediagroup.com/ws',
  remoteApiUrl: process.env.REMOTE_API_URL || 'https://stream.soupymediagroup.com'
};

// Local WebSocket clients (overlays)
const localClients = new Set();

// State synced from remote
let syncedState = {
  dbdChallenge: null,
  twitch: { connected: false, channel: null }
};

// ========== CHAT COMMANDS ==========
// Get command settings from localSettings (persisted)
function getCommandSettings() {
  return localSettings.commandSettings || {
    enabled: true,
    prefix: '!',
    permissions: {
      sound: 'mods',
      alert: 'mods',
      sfx: 'everyone'
    }
  };
}

// Get custom commands from localSettings
function getCustomCommands() {
  return localSettings.customCommands || [];
}

function canUseCommand(msg, requiredLevel) {
  if (requiredLevel === 'everyone') return true;
  if (requiredLevel === 'subscribers' && (msg.isSubscriber || msg.isMod || msg.isBroadcaster)) return true;
  if (requiredLevel === 'mods' && (msg.isMod || msg.isBroadcaster)) return true;
  if (requiredLevel === 'broadcaster' && msg.isBroadcaster) return true;
  return false;
}

function handleChatCommand(msg) {
  const settings = getCommandSettings();
  if (!settings.enabled) return;
  if (!msg.message) return;

  const messageText = msg.message;
  const messageLower = messageText.toLowerCase();

  // Check built-in commands (start with prefix like !)
  if (messageText.startsWith(settings.prefix || '!')) {
    const parts = messageText.slice((settings.prefix || '!').length).split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    const builtInPermission = settings.permissions?.[command];
    if (builtInPermission) {
      if (!canUseCommand(msg, builtInPermission)) {
        console.log(`[ChatCmd] ${msg.displayName} tried !${command} but lacks permission`);
        return;
      }

      console.log(`[ChatCmd] ${msg.displayName} used !${command} ${args.join(' ')}`);

      switch (command) {
        case 'sound':
        case 'sfx':
          if (args.length > 0) {
            const soundFile = args[0].includes('.') ? args[0] : `${args[0]}.mp3`;
            broadcastToOverlays({ type: 'play-sound', data: { sound: soundFile } });
          }
          break;

        case 'alert':
          if (args.length > 0) {
            const alertType = args[0].toLowerCase();
            const alert = {
              type: alertType,
              message: `${msg.displayName} triggered an alert!`,
              subtext: args.slice(1).join(' ') || '',
              name: msg.displayName,
              isManual: true
            };
            broadcastToOverlays({ type: 'new-alert', data: alert });
          }
          break;
      }
      return;
    }
  }

  // Check custom commands/triggers
  const customCommands = getCustomCommands();
  for (const cmd of customCommands) {
    const trigger = (cmd.trigger || cmd.name || '').toLowerCase();
    if (!trigger) continue;

    let matched = false;
    const matchType = cmd.matchType || 'startswith';

    switch (matchType) {
      case 'exact':
        matched = messageLower === trigger;
        break;
      case 'startswith':
        matched = messageLower.startsWith(trigger);
        break;
      case 'contains':
        matched = messageLower.includes(trigger);
        break;
    }

    if (matched) {
      if (!canUseCommand(msg, cmd.permission || 'everyone')) {
        console.log(`[ChatCmd] ${msg.displayName} tried "${trigger}" but lacks permission`);
        continue;
      }

      console.log(`[ChatCmd] ${msg.displayName} triggered "${trigger}" (${matchType})`);

      switch (cmd.action) {
        case 'sound':
          broadcastToOverlays({ type: 'play-sound', data: { sound: cmd.value } });
          break;
        case 'alert':
          broadcastToOverlays({ type: 'new-alert', data: {
            type: cmd.value,
            message: `${msg.displayName} triggered an alert!`,
            name: msg.displayName,
            isManual: true
          }});
          break;
      }
      return; // Only trigger first matching command
    }
  }
}

// ========== SYNC CLIENT ==========
const syncClient = new SyncClient({
  serverUrl: CONFIG.remoteWsUrl,

  onStateUpdate: (state) => {
    syncedState = { ...syncedState, ...state };
    // Forward to all local overlay clients
    broadcastToOverlays({ type: 'state-update', data: syncedState });

    // Handle specific event types that overlays care about
    if (state.type) {
      broadcastToOverlays({ type: state.type, data: state.data });
    }
  },

  onChatMessage: (msg) => {
    broadcastToOverlays({ type: 'twitch-chat', data: msg });
    // Handle chat commands
    handleChatCommand(msg);
  },

  onTwitchEvent: (event) => {
    broadcastToOverlays({ type: 'twitch-event', data: event });
  },

  onConnectionChange: (connected) => {
    console.log(`[LocalServer] Remote sync: ${connected ? 'connected' : 'disconnected'}`);
    broadcastToOverlays({ type: 'sync-status', data: { connected } });
  }
});

// ========== LOCAL WEBSOCKET SERVER ==========
const wss = new WebSocketServer({ port: CONFIG.wsPort });

wss.on('connection', (ws, req) => {
  console.log('[LocalServer] Overlay client connected');
  localClients.add(ws);

  // Send current state to new client
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      dbdChallenge: syncedState.dbdChallenge,
      twitch: syncedState.twitch,
      syncConnected: syncClient.isConnected()
    }
  }));

  ws.on('close', () => {
    localClients.delete(ws);
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      // Forward requests to remote server via sync client
      if (data.type === 'sync-request') {
        ws.send(JSON.stringify({
          type: 'sync',
          data: syncedState
        }));
      }
    } catch (e) {
      console.error('[LocalServer] Error handling message:', e);
    }
  });
});

function broadcastToOverlays(data) {
  const message = JSON.stringify(data);
  localClients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// ========== EXPRESS SERVER ==========
const app = express();
app.use(express.json());

// CORS for browser access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve overlays locally
app.use(express.static(CONFIG.overlaysDir));

// Health/status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    localServer: true,
    remoteSyncConnected: syncClient.isConnected(),
    remoteUrl: CONFIG.remoteApiUrl,
    state: syncedState
  });
});

// Proxy state requests (for renderer)
app.get('/api/dbd/state', (req, res) => {
  res.json(syncedState.dbdChallenge || {});
});

app.get('/api/twitch/status', (req, res) => {
  res.json(syncedState.twitch || { connected: false });
});

// Stub endpoints for renderer compatibility (data comes from remote in sync mode)
app.get('/api/alerts', (req, res) => res.json([]));
app.get('/api/actions', (req, res) => res.json([]));
app.get('/api/games', (req, res) => res.json([]));
app.get('/api/settings', (req, res) => res.json({}));

// Proxy write requests to remote server
const proxyToRemote = async (req, res) => {
  try {
    const url = `${CONFIG.remoteApiUrl}${req.originalUrl}`;
    const options = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' }
    };

    if (req.method !== 'GET' && req.body) {
      options.body = JSON.stringify(req.body);
    }

    const response = await fetch(url, options);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    console.error('[LocalServer] Proxy error:', e.message);
    res.status(500).json({ error: 'Failed to reach remote server', message: e.message });
  }
};

// DBD Challenge API proxy routes
app.post('/api/dbd/start', proxyToRemote);
app.post('/api/dbd/select-killer', proxyToRemote);
app.post('/api/dbd/record-game', proxyToRemote);
app.post('/api/dbd/random-killer', proxyToRemote);
app.post('/api/dbd/end', proxyToRemote);
app.get('/api/dbd/config', proxyToRemote);

// Twitch API proxy routes
app.post('/api/twitch/channel', proxyToRemote);
app.post('/api/twitch/connect', proxyToRemote);
app.post('/api/twitch/disconnect', proxyToRemote);
app.post('/api/twitch/say', proxyToRemote);
app.get('/api/twitch/chat', proxyToRemote);
app.get('/api/twitch/events', proxyToRemote);
app.get('/api/twitch/top-gifters', proxyToRemote);
app.get('/api/twitch/gift-history', proxyToRemote);
app.get('/api/twitch/recent-followers', proxyToRemote);
app.get('/api/twitch/recent-subs', proxyToRemote);
app.get('/api/twitch/recent-raids', proxyToRemote);
app.get('/api/twitch/channel-info', proxyToRemote);
app.get('/api/twitch/followers', proxyToRemote);
app.get('/api/twitch/subscribers', proxyToRemote);

// Ticker messages
app.get('/api/ticker/messages', proxyToRemote);
app.post('/api/ticker/messages', proxyToRemote);
app.put('/api/ticker/messages/:id', proxyToRemote);
app.delete('/api/ticker/messages/:id', proxyToRemote);

// DBD Tracker settings (stored locally)
app.get('/api/dbd/tracker/settings', (req, res) => {
  res.json({
    apiUrl: localSettings.dbdTrackerUrl || '',
    autoPoll: localSettings.dbdAutoPoll || false
  });
});

app.post('/api/dbd/tracker/settings', (req, res) => {
  const { apiUrl, autoPoll } = req.body;

  if (apiUrl !== undefined) {
    localSettings.dbdTrackerUrl = apiUrl;
  }
  if (autoPoll !== undefined) {
    localSettings.dbdAutoPoll = autoPoll;
  }

  if (saveLocalSettings(localSettings)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

app.post('/api/dbd/tracker/check', async (req, res) => {
  const apiUrl = localSettings.dbdTrackerUrl;

  if (!apiUrl) {
    return res.status(400).json({ error: 'No tracker URL configured' });
  }

  try {
    const response = await fetch(apiUrl);
    const data = await response.json();

    if (data.ok) {
      res.json({ success: true, matches: data.matches?.length || 0 });
    } else {
      res.json({ success: false, error: 'Invalid response from tracker' });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Test alerts (handled locally - broadcasts to local overlay clients)
app.post('/api/test-alert', (req, res) => {
  const { type } = req.body;
  const testNames = ['TestUser123', 'StreamFan99', 'NightOwl_TV', 'GamerPro2024', 'CoolViewer'];
  const randomName = testNames[Math.floor(Math.random() * testNames.length)];

  // Format alert for the overlay (expects: type, message, subtext, profileImage)
  let alert = {
    type: type,
    name: randomName,
    isTest: true
  };

  switch (type) {
    case 'follow':
      alert.message = `${randomName} just followed!`;
      alert.subtext = 'Welcome to the community!';
      break;
    case 'subscription':
      const tier = ['Tier 1', 'Tier 2', 'Tier 3'][Math.floor(Math.random() * 3)];
      const months = Math.floor(Math.random() * 24) + 1;
      alert.message = `${randomName} subscribed!`;
      alert.subtext = `${tier} - ${months} month${months > 1 ? 's' : ''}`;
      break;
    case 'raid':
      const viewers = Math.floor(Math.random() * 100) + 5;
      alert.message = `${randomName} is raiding!`;
      alert.subtext = `${viewers} viewers`;
      break;
    case 'cheer':
      const bits = [100, 500, 1000, 5000][Math.floor(Math.random() * 4)];
      alert.message = `${randomName} cheered ${bits} bits!`;
      alert.subtext = 'Test cheer message!';
      break;
    default:
      alert.message = `${randomName}`;
      alert.subtext = 'Test alert';
  }

  console.log('[LocalServer] Broadcasting test alert:', alert);
  broadcastToOverlays({ type: 'new-alert', data: alert });
  res.json({ success: true, alert });
});

// ========== STREAM DECK TRIGGERS ==========

// Play a sound (Stream Deck can call this)
// POST /api/trigger/sound { "sound": "airhorn.mp3" }
app.post('/api/trigger/sound', (req, res) => {
  const { sound } = req.body;
  if (!sound) {
    return res.status(400).json({ error: 'Missing sound parameter' });
  }
  console.log('[LocalServer] Playing sound:', sound);
  broadcastToOverlays({ type: 'play-sound', data: { sound } });
  res.json({ success: true, sound });
});

// Trigger a custom alert (Stream Deck can call this)
// POST /api/trigger/alert { "type": "follow", "message": "Custom message", "subtext": "Optional" }
app.post('/api/trigger/alert', (req, res) => {
  const { type, message, subtext, name } = req.body;
  const alert = {
    type: type || 'default',
    message: message || 'Alert!',
    subtext: subtext || '',
    name: name || 'StreamDeck',
    isManual: true
  };
  console.log('[LocalServer] Manual alert:', alert);
  broadcastToOverlays({ type: 'new-alert', data: alert });
  res.json({ success: true, alert });
});

// Trigger overlay actions (Stream Deck can call this)
// POST /api/trigger/overlay { "action": "celebration" }
app.post('/api/trigger/overlay', (req, res) => {
  const { action } = req.body;
  if (!action) {
    return res.status(400).json({ error: 'Missing action parameter' });
  }
  console.log('[LocalServer] Overlay action:', action);
  broadcastToOverlays({ type: 'overlay-action', data: { action } });
  res.json({ success: true, action });
});

// List available sounds (from AppData sounds folder)
app.get('/api/sounds', (req, res) => {
  try {
    ensureSoundsDir();
    const files = fs.readdirSync(SOUNDS_DIR).filter(f =>
      f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.ogg')
    );
    res.json({ sounds: files });
  } catch (e) {
    res.json({ sounds: [], error: e.message });
  }
});

// Serve sounds from AppData folder
app.use('/sounds', express.static(SOUNDS_DIR));

// Upload sounds with error handling
app.post('/api/sounds/upload', (req, res, next) => {
  soundUpload.array('sounds', 20)(req, res, (err) => {
    if (err) {
      console.error('[LocalServer] Upload error:', err);
      return res.status(400).json({ success: false, error: err.message || 'Upload failed' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files selected' });
    }
    const uploaded = req.files.map(f => f.filename);
    console.log('[LocalServer] Uploaded sounds:', uploaded);
    res.json({ success: true, files: uploaded });
  });
});

// Delete a sound
app.delete('/api/sounds/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(SOUNDS_DIR, filename);
  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get alert sound settings
app.get('/api/sounds/alerts', (req, res) => {
  res.json({
    settings: localSettings.alertSounds || {
      follow: '',
      subscription: '',
      raid: '',
      cheer: '',
      gift: '',
      volume: 70
    }
  });
});

// Save alert sound settings
app.post('/api/sounds/alerts', (req, res) => {
  localSettings.alertSounds = req.body.settings;
  if (saveLocalSettings(localSettings)) {
    // Broadcast to overlays so they update their sound config
    broadcastToOverlays({ type: 'alert-sounds-update', data: req.body.settings });
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ========== COMMANDS MANAGEMENT ==========

// Get commands and settings
app.get('/api/commands', (req, res) => {
  res.json({
    commands: localSettings.customCommands || [],
    settings: localSettings.commandSettings || {
      enabled: true,
      prefix: '!',
      permissions: { sound: 'mods', sfx: 'everyone', alert: 'mods' }
    }
  });
});

// Save command settings
app.post('/api/commands/settings', (req, res) => {
  localSettings.commandSettings = req.body;
  if (saveLocalSettings(localSettings)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Add a custom command
app.post('/api/commands', (req, res) => {
  if (!localSettings.customCommands) {
    localSettings.customCommands = [];
  }
  const cmd = {
    id: Date.now().toString(),
    name: req.body.name,
    action: req.body.action,
    value: req.body.value,
    permission: req.body.permission || 'mods'
  };
  localSettings.customCommands.push(cmd);
  if (saveLocalSettings(localSettings)) {
    res.json({ success: true, command: cmd });
  } else {
    res.status(500).json({ error: 'Failed to save command' });
  }
});

// Update a custom command
app.put('/api/commands/:id', (req, res) => {
  if (!localSettings.customCommands) {
    return res.status(404).json({ error: 'Command not found' });
  }
  const index = localSettings.customCommands.findIndex(c => c.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Command not found' });
  }
  localSettings.customCommands[index] = { ...localSettings.customCommands[index], ...req.body };
  if (saveLocalSettings(localSettings)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to save command' });
  }
});

// Delete a custom command
app.delete('/api/commands/:id', (req, res) => {
  if (!localSettings.customCommands) {
    return res.status(404).json({ error: 'Command not found' });
  }
  localSettings.customCommands = localSettings.customCommands.filter(c => c.id !== req.params.id);
  if (saveLocalSettings(localSettings)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to delete command' });
  }
});

// ========== START SERVER ==========
const server = app.listen(CONFIG.httpPort, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════╗
║     Stream Companion Local Server          ║
╠════════════════════════════════════════════╣
║  Overlays:   http://localhost:${CONFIG.httpPort}          ║
║  WebSocket:  ws://localhost:${CONFIG.wsPort}              ║
║  Remote:     ${CONFIG.remoteApiUrl}
╚════════════════════════════════════════════╝
  `);

  // Connect to remote server
  syncClient.connect();
});

// Exports for main process
module.exports = {
  getState: () => syncedState,
  isRemoteConnected: () => syncClient.isConnected(),
  broadcastToOverlays,
  CONFIG
};
