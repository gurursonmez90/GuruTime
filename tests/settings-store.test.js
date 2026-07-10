const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SettingsStore, normalizeDownloadsOrigin, normalizeSettings } = require('../src/lib/settings-store');

test('settings are private, local-first and locked down by default', () => {
  const settings = normalizeSettings({});
  assert.equal(settings.localNetworkEnabled, false);
  assert.equal(settings.cloudEnabled, false);
  assert.equal(settings.phoneNotifications, false);
  assert.equal(settings.updateChannel, 'stable');
  assert.equal(settings.sharing.linkPinByDefault, true);
  assert.equal(settings.sharing.directQrPinByDefault, false);
});

test('settings store only accepts a secure cloud origin', () => {
  assert.equal(normalizeSettings({ cloudOrigin: 'http://example.com' }).cloudOrigin, '');
  assert.equal(normalizeSettings({ cloudOrigin: 'https://app.example.com/path?q=x' }).cloudOrigin, 'https://app.example.com');
  assert.equal(normalizeSettings({ cloudOrigin: 'http://localhost:8787' }).cloudOrigin, 'http://localhost:8787');
});

test('downloads require a custom origin rather than a development host', () => {
  assert.equal(normalizeDownloadsOrigin('https://bucket.r2.dev'), '');
  assert.equal(normalizeDownloadsOrigin('https://downloads.example.com'), 'https://downloads.example.com');
});

test('settings store persists with owner-only permissions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gurutime-settings-'));
  const file = path.join(dir, 'settings.json');
  const store = new SettingsStore(file);
  store.load();
  const saved = store.update({ alarmMode: 'strong', localNetworkEnabled: true });
  assert.equal(saved.alarmMode, 'strong');
  assert.equal(saved.localNetworkEnabled, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
