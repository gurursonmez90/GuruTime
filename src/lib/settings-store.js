const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  alarmMode: 'balanced',
  notificationPrivacy: 'generic',
  phoneNotifications: false,
  launchAtLogin: false,
  localNetworkEnabled: false,
  cloudEnabled: false,
  cloudOrigin: '',
  downloadsOrigin: '',
  updateChannel: 'stable',
  appLock: Object.freeze({
    lockOnRestart: true,
    lockOnScreenLock: true,
  }),
  sharing: Object.freeze({
    linkPinByDefault: true,
    directQrPinByDefault: false,
  }),
});

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function normalizeOrigin(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(raw)) return '';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function normalizeDownloadsOrigin(value) {
  const origin = normalizeOrigin(value);
  if (!origin) return '';
  try {
    const hostname = new URL(origin).hostname;
    if (/(?:^|\.)(?:r2\.dev|workers\.dev)$/i.test(hostname)) return '';
    return origin;
  } catch (_) {
    return '';
  }
}

function normalizeSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  const appLock = input.appLock && typeof input.appLock === 'object' ? input.appLock : {};
  const sharing = input.sharing && typeof input.sharing === 'object' ? input.sharing : {};

  return {
    schemaVersion: 1,
    alarmMode: input.alarmMode === 'quiet' || input.alarmMode === 'strong' ? input.alarmMode : 'balanced',
    notificationPrivacy: input.notificationPrivacy === 'detailed' ? 'detailed' : 'generic',
    phoneNotifications: input.phoneNotifications === true,
    launchAtLogin: input.launchAtLogin === true,
    localNetworkEnabled: input.localNetworkEnabled === true,
    cloudEnabled: input.cloudEnabled === true,
    cloudOrigin: normalizeOrigin(input.cloudOrigin),
    downloadsOrigin: normalizeDownloadsOrigin(input.downloadsOrigin),
    updateChannel: input.updateChannel === 'beta' ? 'beta' : 'stable',
    appLock: {
      lockOnRestart: appLock.lockOnRestart !== false,
      lockOnScreenLock: appLock.lockOnScreenLock !== false,
    },
    sharing: {
      linkPinByDefault: sharing.linkPinByDefault !== false,
      directQrPinByDefault: sharing.directQrPinByDefault === true,
    },
  };
}

function mergeSettings(current, patch) {
  const input = patch && typeof patch === 'object' ? patch : {};
  return normalizeSettings({
    ...current,
    ...input,
    appLock: { ...current.appLock, ...(input.appLock || {}) },
    sharing: { ...current.sharing, ...(input.sharing || {}) },
  });
}

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.value = cloneDefaults();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.value = normalizeSettings(parsed);
    } catch (_) {
      this.value = cloneDefaults();
    }
    return this.get();
  }

  get() {
    return JSON.parse(JSON.stringify(this.value));
  }

  update(patch) {
    this.value = mergeSettings(this.value, patch);
    this.persist();
    return this.get();
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch (_) {}
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  SettingsStore,
  mergeSettings,
  normalizeDownloadsOrigin,
  normalizeOrigin,
  normalizeSettings,
};
