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
    this.state = {
      dbdChallenge: null,
      twitch: { connected: false, channel: null }
    };
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
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

      this.ws.on('close', () => {
        console.log('[SyncClient] Disconnected from remote server');
        this.connected = false;
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
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[SyncClient] Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);
    console.log(`[SyncClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => this.connect(), delay);
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
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  getState() {
    return this.state;
  }

  isConnected() {
    return this.connected;
  }
}

module.exports = SyncClient;
