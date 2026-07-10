'use strict';

const crypto = require('crypto');
const { AtomicJsonStore } = require('./atomic-json-store');

const AUTH_VERSION = 1;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 1024;
const SCRYPT_PARAMS = Object.freeze({
  N: 2 ** 15,
  r: 8,
  p: 1,
  keylen: 32,
  saltBytes: 16,
  maxmem: 64 * 1024 * 1024,
});
const DEFAULT_DELAY_BASE_MS = 500;
const DEFAULT_DELAY_MAX_MS = 5 * 60 * 1000;

class LocalAuthError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'LocalAuthError';
    this.code = code;
    Object.assign(this, details);
  }
}

function epochNow(now) {
  const value = typeof now === 'function' ? now() : (now == null ? Date.now() : now);
  const epoch = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(epoch)) throw new TypeError('now must resolve to a finite epoch value');
  return epoch;
}

function validatePassword(password) {
  if (typeof password !== 'string') {
    throw new LocalAuthError('Password must be a string', 'INVALID_PASSWORD');
  }
  const length = Array.from(password).length;
  if (length < MIN_PASSWORD_LENGTH) {
    throw new LocalAuthError(
      `Password must contain at least ${MIN_PASSWORD_LENGTH} characters`,
      'PASSWORD_TOO_SHORT',
      { minLength: MIN_PASSWORD_LENGTH },
    );
  }
  if (length > MAX_PASSWORD_LENGTH) {
    throw new LocalAuthError('Password is too long', 'PASSWORD_TOO_LONG', {
      maxLength: MAX_PASSWORD_LENGTH,
    });
  }
  return password;
}

function decodeBase64Exact(value, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buffer = Buffer.from(value, 'base64');
  return buffer.length === expectedLength ? buffer : null;
}

function isValidPasswordRecord(record) {
  return Boolean(
    record
    && record.algorithm === 'scrypt'
    && Number(record.N) === SCRYPT_PARAMS.N
    && Number(record.r) === SCRYPT_PARAMS.r
    && Number(record.p) === SCRYPT_PARAMS.p
    && Number(record.keylen) === SCRYPT_PARAMS.keylen
    && decodeBase64Exact(record.salt, SCRYPT_PARAMS.saltBytes)
    && decodeBase64Exact(record.hash, SCRYPT_PARAMS.keylen),
  );
}

function disabledConfig(now) {
  return {
    version: AUTH_VERSION,
    enabled: false,
    password: null,
    updatedAt: new Date(now).toISOString(),
  };
}

function normalizeConfig(raw, now) {
  // Legacy `{ unlockedUntil }` files intentionally confer no authentication
  // state. Unlock state is never migrated or persisted.
  if (!raw || raw.version !== AUTH_VERSION || raw.enabled !== true || !isValidPasswordRecord(raw.password)) {
    return disabledConfig(now);
  }
  return {
    version: AUTH_VERSION,
    enabled: true,
    password: {
      algorithm: 'scrypt',
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      keylen: SCRYPT_PARAMS.keylen,
      salt: raw.password.salt,
      hash: raw.password.hash,
    },
    updatedAt: Number.isFinite(Date.parse(raw.updatedAt))
      ? new Date(Date.parse(raw.updatedAt)).toISOString()
      : new Date(now).toISOString(),
  };
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: SCRYPT_PARAMS.maxmem,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function createPasswordRecord(password) {
  const safePassword = validatePassword(password);
  const salt = crypto.randomBytes(SCRYPT_PARAMS.saltBytes);
  const hash = await scryptAsync(safePassword, salt);
  return {
    algorithm: 'scrypt',
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    keylen: SCRYPT_PARAMS.keylen,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
}

async function comparePassword(password, record) {
  const salt = decodeBase64Exact(record?.salt, SCRYPT_PARAMS.saltBytes)
    || Buffer.alloc(SCRYPT_PARAMS.saltBytes);
  const expected = decodeBase64Exact(record?.hash, SCRYPT_PARAMS.keylen)
    || Buffer.alloc(SCRYPT_PARAMS.keylen);
  const candidate = await scryptAsync(typeof password === 'string' ? password : '', salt);
  // Both buffers are always exactly keylen bytes, avoiding length-dependent
  // comparison behavior and ensuring the actual comparison is constant-time.
  return crypto.timingSafeEqual(candidate, expected) && isValidPasswordRecord(record);
}

class LocalAuth {
  constructor(options = {}) {
    if (typeof options.filePath !== 'string' || !options.filePath.trim()) {
      throw new TypeError('LocalAuth requires filePath');
    }
    this.filePath = options.filePath;
    this._now = options.now || Date.now;
    this._delayBaseMs = Number.isFinite(options.delayBaseMs)
      ? Math.max(1, Number(options.delayBaseMs))
      : DEFAULT_DELAY_BASE_MS;
    this._delayMaxMs = Number.isFinite(options.delayMaxMs)
      ? Math.max(this._delayBaseMs, Number(options.delayMaxMs))
      : DEFAULT_DELAY_MAX_MS;
    this._store = options.store || new AtomicJsonStore(options.filePath, { mode: 0o600 });
    this._config = disabledConfig(epochNow(this._now));
    this._unlocked = false;
    this._failedAttempts = 0;
    this._blockedUntil = 0;
    this._loaded = false;
    this._tail = Promise.resolve();
  }

  static async open(options = {}) {
    const instance = new LocalAuth(options);
    await instance.load();
    return instance;
  }

  async load() {
    if (this._loaded) return this;
    const now = epochNow(this._now);
    const loaded = await this._store.read({ fallback: null });
    const config = normalizeConfig(loaded.value, now);
    const shouldPersist = loaded.source !== 'primary'
      || JSON.stringify(config) !== JSON.stringify(loaded.value);
    if (shouldPersist) await this._store.write(config);
    this._config = config;
    // A correct password hash never implies an unlocked process. Restart and
    // screen-lock behavior is therefore controlled solely in memory.
    this._unlocked = false;
    this._failedAttempts = 0;
    this._blockedUntil = 0;
    this._loaded = true;
    return this;
  }

  _ensureLoaded() {
    if (!this._loaded) throw new LocalAuthError('LocalAuth.load() must complete first', 'AUTH_NOT_LOADED');
  }

  _run(operation) {
    this._ensureLoaded();
    const promise = this._tail.then(operation);
    this._tail = promise.then(() => undefined, () => undefined);
    return promise;
  }

  getState() {
    this._ensureLoaded();
    const now = epochNow(this._now);
    const enabled = this._config.enabled;
    return {
      enabled,
      unlocked: !enabled || this._unlocked,
      failedAttempts: this._failedAttempts,
      retryAfterMs: Math.max(0, this._blockedUntil - now),
    };
  }

  isEnabled() {
    return this.getState().enabled;
  }

  isUnlocked() {
    return this.getState().unlocked;
  }

  async _attemptPassword(password) {
    const now = epochNow(this._now);
    const retryAfterMs = Math.max(0, this._blockedUntil - now);
    if (retryAfterMs > 0) {
      return {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs,
        failedAttempts: this._failedAttempts,
      };
    }

    const matches = await comparePassword(password, this._config.password);
    if (matches) {
      this._failedAttempts = 0;
      this._blockedUntil = 0;
      this._unlocked = true;
      return { ok: true, reason: 'verified', retryAfterMs: 0, failedAttempts: 0 };
    }

    this._unlocked = false;
    this._failedAttempts += 1;
    const exponent = Math.min(this._failedAttempts - 1, 30);
    const delay = Math.min(this._delayBaseMs * (2 ** exponent), this._delayMaxMs);
    this._blockedUntil = now + delay;
    return {
      ok: false,
      reason: 'invalid-password',
      retryAfterMs: delay,
      failedAttempts: this._failedAttempts,
    };
  }

  verify(password) {
    return this._run(async () => {
      if (!this._config.enabled) {
        return { ok: true, reason: 'disabled', ...this.getState() };
      }
      const result = await this._attemptPassword(password);
      return { ...result, ...this.getState() };
    });
  }

  enable(password) {
    return this._run(async () => {
      if (this._config.enabled) {
        throw new LocalAuthError('Local authentication is already enabled', 'AUTH_ALREADY_ENABLED');
      }
      const record = await createPasswordRecord(password);
      const next = {
        version: AUTH_VERSION,
        enabled: true,
        password: record,
        updatedAt: new Date(epochNow(this._now)).toISOString(),
      };
      await this._store.write(next);
      this._config = next;
      this._unlocked = true;
      this._failedAttempts = 0;
      this._blockedUntil = 0;
      return { ok: true, ...this.getState() };
    });
  }

  lock() {
    this._ensureLoaded();
    this._unlocked = false;
    return this.getState();
  }

  disable(password) {
    return this._run(async () => {
      if (!this._config.enabled) return { ok: true, reason: 'disabled', ...this.getState() };
      if (!this._unlocked) {
        if (typeof password !== 'string') {
          return { ok: false, reason: 'authentication-required', ...this.getState() };
        }
        const verified = await this._attemptPassword(password);
        if (!verified.ok) return { ...verified, ...this.getState() };
      }
      const next = disabledConfig(epochNow(this._now));
      await this._store.write(next);
      this._config = next;
      this._unlocked = false;
      this._failedAttempts = 0;
      this._blockedUntil = 0;
      return { ok: true, ...this.getState() };
    });
  }

  changePassword(currentPassword, newPassword) {
    return this._run(async () => {
      if (!this._config.enabled) {
        throw new LocalAuthError('Local authentication is disabled', 'AUTH_DISABLED');
      }
      const verified = await this._attemptPassword(currentPassword);
      if (!verified.ok) return { ...verified, ...this.getState() };
      const record = await createPasswordRecord(newPassword);
      const next = {
        version: AUTH_VERSION,
        enabled: true,
        password: record,
        updatedAt: new Date(epochNow(this._now)).toISOString(),
      };
      await this._store.write(next);
      this._config = next;
      this._unlocked = true;
      this._failedAttempts = 0;
      this._blockedUntil = 0;
      return { ok: true, ...this.getState() };
    });
  }

  flush() {
    this._ensureLoaded();
    return this._tail.then(() => this.getState());
  }
}

module.exports = {
  LocalAuth,
  LocalAuthError,
  AUTH_VERSION,
  MIN_PASSWORD_LENGTH,
  SCRYPT_PARAMS,
  DEFAULT_DELAY_BASE_MS,
  DEFAULT_DELAY_MAX_MS,
  validatePassword,
  createPasswordRecord,
  comparePassword,
};
