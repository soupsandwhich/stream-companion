/**
 * Stream Companion Local Sync Client
 *
 * This module connects to the remote Docker server and syncs state.
 * The local app serves overlays locally for OBS (no bandwidth usage).
 */

const WebSocket = require('ws');

class SyncClient {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || 'wss://stream.soupymediagroup.com:3001';
    this.onStateUpdate = options.onStateUpdate || (() => {});
    this.onChatMessage = options.onChatMessage || (() => {});
    this.onTwitchEvent = options.onTwitchEvent || (() => {});
    this.onConnectionChange = options.onConnectionChange || (() => {});

    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 3000;
    this.pingInterval = null;
    this.pingIntervalMs = 20000; // 20 seconds
    this.reconnectTimer = null;
    this.stopped = false;
    this.state = {
      dbdChallenge: null,
      twitch: { connected: false, channel: null }
    };
  }

  connect() {
    this.stopped = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    console.log(`[SyncClient] Connecting to ${this.serverUrl}...`);

    try {
      this.ws = new WebSocket(this.serverUrl);

      this.ws.on('open', () => {
        console.log('[SyncClient] Connected to remote server');
        this.connected = true;
        this.reconnectAttempts = 0;
        this.onConnectionChange(true);

        // Request initial sync
        this.send({ type: 'sync-request' });

        // Start heartbeat ping interval
        this.startPingInterval();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (e) {
          console.error('[SyncClient] Error parsing message:', e);
        }
      });

      const ws = this.ws;
      ws.on('close', () => {
        if (this.ws !== ws) return; // an old socket we already replaced or closed
        console.log('[SyncClient] Disconnected from remote server');
        this.connected = false;
        this.ws = null;
        this.stopPingInterval();
        this.onConnectionChange(false);
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('[SyncClient] WebSocket error:', error.message);
      });
    } catch (e) {
      console.error('[SyncClient] Connection error:', e.message);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;

    this.reconnectAttempts++;
    // Back off up to 15s; after maxReconnectAttempts keep trying once a minute
    // instead of giving up (Tower restarts shouldn't need an app relaunch).
    const delay = this.reconnectAttempts > this.maxReconnectAttempts
      ? 60000
      : this.reconnectDelay * Math.min(this.reconnectAttempts, 5);
    console.log(`[SyncClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  handleMessage(message) {
    switch (message.type) {
      case 'pong':
        // Heartbeat response - connection is alive
        break;

      case 'init':
      case 'sync':
        this.state = { ...this.state, ...message.data };
        this.onStateUpdate(this.state);
        break;

      case 'twitch-status':
        this.state.twitch = message.data;
        this.onStateUpdate(this.state);
        break;

      case 'twitch-chat':
        this.onChatMessage(message.data);
        break;

      case 'twitch-event':
        this.onTwitchEvent(message.data);
        break;

      case 'dbd-challenge-started':
      case 'dbd-challenge-ended':
      case 'dbd-killer-selected':
      case 'dbd-game-recorded':
      case 'dbd-randomize-start':
        this.state.dbdChallenge = message.data;
        this.onStateUpdate(this.state);
        break;

      default:
        // Forward unknown messages to state update handler
        this.onStateUpdate({ type: message.type, data: message.data });
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  startPingInterval() {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.connected) {
        this.send({ type: 'ping' });
      }
    }, this.pingIntervalMs);
  }

  stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  disconnect() {
    this.stopped = true;
    this.stopPingInterval();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.terminate(); } catch (e) { /* already closed */ }
    }
    if (this.connected) {
      this.connected = false;
      this.onConnectionChange(false);
    }
  }

  getState() {
    return this.state;
  }

  isConnected() {
    return this.connected;
  }
}

module.exports = SyncClient;
