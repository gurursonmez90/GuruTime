'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CREDENTIAL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RECONNECT_MS = 30000;

function normalizeOrigin(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  const url = new URL(text);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Cloudflare relay adresi HTTPS olmalı.');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function socketUrl(origin, installationId) {
  const url = new URL(`/api/v1/controller/socket/${encodeURIComponent(installationId)}`, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function decodeAesKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{40,48}$/.test(value)) throw new Error('Eşleştirme anahtarı geçersiz.');
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32) throw new Error('Eşleştirme anahtarı 256-bit olmalı.');
  return key;
}

function decryptEnvelope(pairingKey, ciphertext) {
  const key = decodeAesKey(pairingKey);
  if (typeof ciphertext !== 'string' || !/^[A-Za-z0-9_-]{20,3800}$/.test(ciphertext)) {
    throw new Error('Şifreli komut zarfı geçersiz.');
  }
  const envelope = Buffer.from(ciphertext, 'base64url');
  if (envelope.length < 12 + 16 + 2) throw new Error('Şifreli komut zarfı çok kısa.');
  const iv = envelope.subarray(0, 12);
  const tag = envelope.subarray(envelope.length - 16);
  const encrypted = envelope.subarray(12, envelope.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (plaintext.length > 4096) throw new Error('Çözülmüş komut çok büyük.');
  const parsed = JSON.parse(plaintext.toString('utf8'));
  if (!parsed || parsed.v !== 1 || typeof parsed.kind !== 'string' || !parsed.payload || typeof parsed.payload !== 'object') {
    throw new Error('Çözülmüş komut şeması geçersiz.');
  }
  return parsed;
}

function atomicWritePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

class CloudRelayClient {
  constructor({
    credentialsPath,
    safeStorage,
    onCommand,
    onInfo,
    onError,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = WebSocket,
  } = {}) {
    if (!credentialsPath) throw new TypeError('credentialsPath is required');
    this.credentialsPath = credentialsPath;
    this.safeStorage = safeStorage;
    this.onCommand = typeof onCommand === 'function' ? onCommand : async () => ({ ok: true });
    this.onInfo = typeof onInfo === 'function' ? onInfo : () => {};
    this.onError = typeof onError === 'function' ? onError : () => {};
    this.fetch = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.enabled = false;
    this.origin = '';
    this.installationId = '';
    this.secrets = { deviceSecret: '', keyring: {}, syncedAlarms: {} };
    this.devices = [];
    this.connected = false;
    this.lastError = '';
    this.lastSyncAt = '';
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.generation = 0;
    this.syncedAlarms = new Map();
    this.syncTail = Promise.resolve();
    this.messageTail = Promise.resolve();
    this.configuredOnce = false;
  }

  getInfo() {
    return {
      enabled: this.enabled,
      enrolled: Boolean(this.installationId && this.secrets.deviceSecret),
      connected: this.connected,
      origin: this.origin,
      installationId: this.installationId,
      devices: this.devices.map((device) => ({ ...device })),
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
    };
  }

  emitInfo(patch = {}) {
    Object.assign(this, patch);
    this.onInfo(this.getInfo());
  }

  reportError(error) {
    const message = error && typeof error.message === 'string' ? error.message : 'Cloud relay hatası.';
    this.emitInfo({ lastError: message, connected: false });
    this.onError(error instanceof Error ? error : new Error(message));
  }

  encryptionAvailable() {
    return Boolean(
      this.safeStorage
      && typeof this.safeStorage.isEncryptionAvailable === 'function'
      && this.safeStorage.isEncryptionAvailable()
      && typeof this.safeStorage.encryptString === 'function'
      && typeof this.safeStorage.decryptString === 'function'
    );
  }

  loadCredentials() {
    this.installationId = '';
    this.secrets = { deviceSecret: '', keyring: {}, syncedAlarms: {} };
    this.syncedAlarms = new Map();
    if (!fs.existsSync(this.credentialsPath)) return false;
    const record = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
    if (record.version !== CREDENTIAL_VERSION || record.origin !== this.origin || typeof record.sealed !== 'string') return false;
    if (!this.encryptionAvailable()) throw new Error('Keychain kullanılamadığı için bulut anahtarları açılamadı.');
    const decrypted = this.safeStorage.decryptString(Buffer.from(record.sealed, 'base64'));
    const secrets = JSON.parse(decrypted);
    if (typeof record.installationId !== 'string' || typeof secrets.deviceSecret !== 'string') throw new Error('Bulut kimlik bilgileri bozuk.');
    this.installationId = record.installationId;
    this.secrets = {
      deviceSecret: secrets.deviceSecret,
      keyring: secrets.keyring && typeof secrets.keyring === 'object' ? secrets.keyring : {},
      syncedAlarms: secrets.syncedAlarms && typeof secrets.syncedAlarms === 'object' ? secrets.syncedAlarms : {},
    };
    this.syncedAlarms = new Map(Object.entries(this.secrets.syncedAlarms));
    return true;
  }

  persistCredentials() {
    if (!this.encryptionAvailable()) throw new Error('Keychain kullanılamadığı için bulut anahtarları kaydedilemedi.');
    const sealed = this.safeStorage.encryptString(JSON.stringify(this.secrets)).toString('base64');
    atomicWritePrivateJson(this.credentialsPath, {
      version: CREDENTIAL_VERSION,
      origin: this.origin,
      installationId: this.installationId,
      sealed,
      updatedAt: new Date().toISOString(),
    });
  }

  pruneKeyring() {
    const now = Date.now();
    const activeKeyIds = new Set(this.devices.map((device) => device.keyId));
    for (const [keyId, record] of Object.entries(this.secrets.keyring || {})) {
      if (!record || typeof record.key !== 'string') {
        delete this.secrets.keyring[keyId];
        continue;
      }
      if (record.pending && Number(record.expiresAt) < now && !activeKeyIds.has(keyId)) delete this.secrets.keyring[keyId];
    }
  }

  async request(pathname, { method = 'GET', body, authenticated = true, headers = {} } = {}) {
    if (typeof this.fetch !== 'function') throw new Error('HTTP istemcisi kullanılamıyor.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const requestHeaders = { Accept: 'application/json', ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (authenticated) {
      if (!this.installationId || !this.secrets.deviceSecret) throw new Error('Cloudflare kurulumu eşleştirilmemiş.');
      requestHeaders['X-GuruTime-Installation'] = this.installationId;
      requestHeaders.Authorization = `GuruTimeDevice ${this.secrets.deviceSecret}`;
    }
    try {
      const response = await this.fetch(new URL(pathname, this.origin), {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const error = new Error(parsed.message || parsed.error || `Cloud relay HTTP ${response.status}`);
        error.status = response.status;
        error.code = parsed.code;
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Cloud relay isteği zaman aşımına uğradı.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async configure({ enabled, origin }) {
    const nextOrigin = origin ? normalizeOrigin(origin) : '';
    const changed = this.enabled !== Boolean(enabled) || this.origin !== nextOrigin;
    if (this.configuredOnce && !changed) return this.getInfo();
    if (changed) await this.stop();
    this.configuredOnce = true;
    this.enabled = Boolean(enabled);
    this.origin = nextOrigin;
    this.generation += 1;
    const generation = this.generation;
    this.emitInfo({ lastError: '', connected: false });
    if (!this.enabled) return this.getInfo();
    if (!this.origin) {
      this.reportError(new Error('Cloudflare relay için production origin gerekli.'));
      return this.getInfo();
    }
    try {
      const loaded = this.loadCredentials();
      if (!loaded) await this.enroll();
      if (generation !== this.generation || !this.enabled) return this.getInfo();
      await this.refreshPhones();
      await this.connect(generation);
    } catch (error) {
      this.reportError(error);
      this.scheduleReconnect(generation);
    }
    return this.getInfo();
  }

  async enroll(turnstileToken = '') {
    if (!this.encryptionAvailable()) throw new Error('Keychain kullanılamadığı için güvenli enrollment yapılamıyor.');
    const response = await this.request('/api/v1/installations/enroll', {
      method: 'POST',
      authenticated: false,
      body: turnstileToken ? { turnstileToken } : {},
    });
    if (typeof response.installationId !== 'string' || typeof response.deviceSecret !== 'string') {
      throw new Error('Enrollment yanıtı geçersiz.');
    }
    this.installationId = response.installationId;
    this.secrets = { deviceSecret: response.deviceSecret, keyring: {}, syncedAlarms: {} };
    this.syncedAlarms = new Map();
    this.persistCredentials();
    this.emitInfo({ lastError: '' });
    return this.getInfo();
  }

  authHeaders() {
    return {
      'X-GuruTime-Installation': this.installationId,
      Authorization: `GuruTimeDevice ${this.secrets.deviceSecret}`,
    };
  }

  async connect(generation = this.generation) {
    if (!this.enabled || generation !== this.generation) return;
    const ticket = await this.request('/api/v1/controller/ticket', { method: 'POST', body: {} });
    if (generation !== this.generation || !this.enabled) return;
    const socket = new this.WebSocketImpl(
      socketUrl(this.origin, this.installationId),
      ['gurutime.v1', `ticket.${ticket.ticket}`],
    );
    this.socket = socket;
    socket.on('open', () => {
      if (generation !== this.generation || socket !== this.socket) return socket.close();
      this.reconnectAttempt = 0;
      this.emitInfo({ connected: true, lastError: '' });
    });
    socket.on('message', (data) => {
      this.messageTail = this.messageTail
        .then(() => this.handleSocketMessage(socket, data))
        .catch((error) => this.onError(error));
    });
    socket.on('close', () => {
      if (socket === this.socket) this.socket = null;
      if (generation === this.generation && this.enabled) {
        this.emitInfo({ connected: false });
        this.scheduleReconnect(generation);
      }
    });
    socket.on('error', (error) => {
      if (generation === this.generation) this.reportError(new Error(`WebSocket bağlantısı kurulamadı: ${error.message}`));
    });
  }

  scheduleReconnect(generation = this.generation) {
    if (!this.enabled || generation !== this.generation || this.reconnectTimer) return;
    const delay = Math.min(MAX_RECONNECT_MS, 1000 * (2 ** Math.min(this.reconnectAttempt, 5)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.enabled || generation !== this.generation) return;
      this.connect(generation).catch((error) => {
        this.reportError(error);
        this.scheduleReconnect(generation);
      });
    }, delay);
  }

  async handleSocketMessage(socket, raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    if (text === 'ping') {
      if (socket.readyState === this.WebSocketImpl.OPEN) socket.send('pong');
      return;
    }
    const frame = JSON.parse(text);
    if (frame.type === 'hello') return;
    if (frame.type !== 'command') return;
    const keyId = typeof frame.keyId === 'string' ? frame.keyId : '';
    const record = this.secrets.keyring[keyId];
    if (!record?.key) throw new Error(`Komut için eşleştirme anahtarı bulunamadı: ${keyId}`);
    const plaintext = decryptEnvelope(record.key, frame.ciphertext);
    if (plaintext.kind !== frame.kind) throw new Error('Komut türü şifreli zarfla eşleşmiyor.');
    await this.onCommand({
      commandId: frame.commandId,
      phoneId: frame.phoneId,
      keyId,
      type: plaintext.kind,
      payload: plaintext.payload,
    }, { source: 'cloud', phoneId: frame.phoneId, keyId });
    if (socket.readyState === this.WebSocketImpl.OPEN) {
      socket.send(JSON.stringify({ type: 'ack', commandId: frame.commandId, leaseToken: frame.leaseToken }));
      this.emitInfo({ lastSyncAt: new Date().toISOString(), lastError: '' });
    }
  }

  async createInvite({ requirePin = true } = {}) {
    if (!this.enabled) throw new Error('Cloudflare relay kapalı.');
    const invite = await this.request('/api/v1/controller/invites', {
      method: 'POST',
      body: { requirePin: Boolean(requirePin) },
      headers: { 'X-GuruTime-Origin': this.origin },
    });
    const keyId = String(invite.keyId || '');
    decodeAesKey(invite.pairingKey);
    if (!/^[0-9a-f-]{36}$/i.test(keyId)) throw new Error('Eşleştirme keyId değeri geçersiz.');
    this.secrets.keyring[keyId] = {
      key: invite.pairingKey,
      pending: true,
      expiresAt: Number(invite.expiresAt) || Date.now() + 10 * 60 * 1000,
    };
    this.pruneKeyring();
    this.persistCredentials();
    return invite;
  }

  async refreshPhones() {
    if (!this.installationId) return [];
    const response = await this.request('/api/v1/controller/phones');
    this.devices = Array.isArray(response.phones) ? response.phones : [];
    const keyIds = new Set(this.devices.map((device) => device.keyId));
    for (const [keyId, record] of Object.entries(this.secrets.keyring)) {
      if (keyIds.has(keyId)) record.pending = false;
    }
    this.pruneKeyring();
    this.persistCredentials();
    this.emitInfo({ lastError: '' });
    return this.devices;
  }

  async revokeDevice(phoneId) {
    const device = this.devices.find((item) => item.id === phoneId);
    await this.request(`/api/v1/controller/phones/${encodeURIComponent(phoneId)}`, { method: 'DELETE' });
    if (device?.keyId) delete this.secrets.keyring[device.keyId];
    this.persistCredentials();
    await this.refreshPhones();
    return { ok: true };
  }

  syncAlarms(alarms = []) {
    const wanted = new Map(
      alarms
        .filter((alarm) => alarm.status === 'scheduled' || alarm.status === 'ringing')
        .map((alarm) => [
          `${alarm.id}:${alarm.occurrence}`,
          { alarmId: alarm.id, occurrence: alarm.occurrence, fireAt: Number(alarm.fireAt) },
        ]),
    );
    this.syncTail = this.syncTail.then(async () => {
      if (!this.enabled || !this.installationId) return;
      let changed = false;
      for (const [key, alarm] of wanted) {
        const existing = this.syncedAlarms.get(key);
        if (existing?.fireAt === alarm.fireAt) continue;
        await this.request('/api/v1/controller/alarms', { method: 'PUT', body: alarm });
        this.syncedAlarms.set(key, alarm);
        changed = true;
      }
      for (const [key, alarm] of [...this.syncedAlarms]) {
        if (wanted.has(key)) continue;
        await this.request('/api/v1/controller/alarms', {
          method: 'DELETE',
          body: { alarmId: alarm.alarmId, occurrence: alarm.occurrence },
        });
        this.syncedAlarms.delete(key);
        changed = true;
      }
      if (changed) {
        this.secrets.syncedAlarms = Object.fromEntries(this.syncedAlarms);
        this.persistCredentials();
      }
      this.emitInfo({ lastSyncAt: new Date().toISOString(), lastError: '' });
    });
    return this.syncTail;
  }

  async stop() {
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try { socket.close(1000, 'client stop'); } catch (_) {}
    }
    this.connected = false;
    this.emitInfo();
  }
}

module.exports = {
  CloudRelayClient,
  CREDENTIAL_VERSION,
  decodeAesKey,
  decryptEnvelope,
  normalizeOrigin,
  socketUrl,
};
