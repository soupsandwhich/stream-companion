// Minimal bridge for the renderer (contextIsolation on, no Node in the page).
// Only these IPC channels are reachable from the UI.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = ['get-version', 'check-for-updates', 'install-update', 'open-sounds-folder'];
const EVENTS = ['update-status', 'update-downloaded'];

contextBridge.exposeInMainWorld('companion', {
  invoke: (channel, ...args) => {
    if (!INVOKE.includes(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, callback) => {
    if (!EVENTS.includes(channel)) return;
    // Don't hand the IpcRendererEvent (and its sender) to the page
    ipcRenderer.on(channel, (event, ...args) => callback({}, ...args));
  }
});
