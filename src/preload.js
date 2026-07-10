const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'load-todos',
  'mutate-todo',
  'get-remote-info',
  'get-cloud-relay-info',
  'get-auth-state',
  'verify-password',
  'set-app-password',
  'disable-app-password',
  'get-settings',
  'update-settings',
  'get-alarm-history',
  'create-pairing-invite',
  'revoke-paired-device',
  'copy-text',
  'qr-data-url',
  'timer-confirm',
  'timer-cancel',
  'alarm-window-dismiss',
  'alarm-window-snooze',
  'alarm-window-complete-task',
  'alarm-window-hide',
]);

const SEND_CHANNELS = new Set([
  'set-alarm',
  'cancel-alarm',
  'quit-app',
  'get-alarms',
  'dismiss-alarm',
]);

const RECEIVE_CHANNELS = new Set([
  'set-mode',
  'alarms-updated',
  'reload-todos',
  'remote-updated',
  'cloud-relay-updated',
  'auth-state-changed',
  'settings-updated',
  'popover-opened',
]);

function invoke(channel, ...args) {
  if (!INVOKE_CHANNELS.has(channel)) {
    return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
  }
  return ipcRenderer.invoke(channel, ...args);
}

function send(channel, ...args) {
  if (!SEND_CHANNELS.has(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
  ipcRenderer.send(channel, ...args);
}

function on(channel, callback) {
  if (!RECEIVE_CHANNELS.has(channel) || typeof callback !== 'function') {
    throw new Error(`IPC listener not allowed: ${channel}`);
  }
  const listener = (_event, ...args) => callback(undefined, ...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('guruTime', {
  ipc: Object.freeze({ invoke, send, on }),
  qrDataUrl: (value, options) => invoke('qr-data-url', value, options),
  overlay: Object.freeze({
    onInitAnchor: (callback) => subscribe('init-anchor', callback),
    onTimerUpdate: (callback) => subscribe('timer-update', callback),
    onTimerRelease: (callback) => subscribe('timer-release', callback),
    confirm: (payload) => invoke('timer-confirm', payload),
    cancel: () => invoke('timer-cancel'),
  }),
});

contextBridge.exposeInMainWorld('guruTimeAlarm', Object.freeze({
  onState: (callback) => subscribe('alarm-window-state', callback),
  dismiss: (payload) => invoke('alarm-window-dismiss', payload),
  snooze: (payload) => invoke('alarm-window-snooze', payload),
  completeTask: (payload) => invoke('alarm-window-complete-task', payload),
  hide: () => invoke('alarm-window-hide'),
}));

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
