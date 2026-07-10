'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  LocalAuth,
  SCRYPT_PARAMS,
  validatePassword,
} = require('../../src/lib/local-auth');

async function makeTempDir(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gurutime-auth-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('defaults to disabled and discards legacy unlockedUntil state', async (t) => {
  const directory = await makeTempDir(t);
  const filePath = path.join(directory, 'auth.json');
  const now = Date.parse('2026-07-10T12:00:00Z');
  await fs.promises.writeFile(filePath, JSON.stringify({ unlockedUntil: now + 60 * 60_000 }), { mode: 0o644 });

  const auth = await LocalAuth.open({ filePath, now: () => now });
  assert.deepEqual(auth.getState(), {
    enabled: false,
    unlocked: true,
    failedAttempts: 0,
    retryAfterMs: 0,
  });
  const storedText = await fs.promises.readFile(filePath, 'utf8');
  const stored = JSON.parse(storedText);
  assert.equal(stored.enabled, false);
  assert.equal(Object.hasOwn(stored, 'unlockedUntil'), false);
  assert.equal((await fs.promises.stat(filePath)).mode & 0o777, 0o600);
});

test('stores only an exact scrypt configuration and keeps unlock state in memory', async (t) => {
  const directory = await makeTempDir(t);
  const filePath = path.join(directory, 'auth.json');
  const now = Date.parse('2026-07-10T12:00:00Z');
  const password = 'güvenli-şifre';
  const auth = await LocalAuth.open({ filePath, now: () => now });

  const enabled = await auth.enable(password);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.unlocked, true);
  const rawText = await fs.promises.readFile(filePath, 'utf8');
  const raw = JSON.parse(rawText);
  assert.equal(rawText.includes(password), false);
  assert.equal(raw.password.algorithm, 'scrypt');
  assert.equal(raw.password.N, 2 ** 15);
  assert.equal(raw.password.r, 8);
  assert.equal(raw.password.p, 1);
  assert.equal(raw.password.keylen, 32);
  assert.equal(Buffer.from(raw.password.salt, 'base64').length, 16);
  assert.equal(Buffer.from(raw.password.hash, 'base64').length, 32);
  assert.equal((await fs.promises.stat(filePath)).mode & 0o777, 0o600);

  auth.lock();
  assert.equal(auth.isUnlocked(), false);
  const reopened = await LocalAuth.open({ filePath, now: () => now });
  assert.equal(reopened.isEnabled(), true);
  assert.equal(reopened.isUnlocked(), false);
  assert.equal((await reopened.verify(password)).ok, true);
  assert.equal(reopened.isUnlocked(), true);
});

test('enforces exponential failed-attempt delays and resets them after success', async (t) => {
  const directory = await makeTempDir(t);
  const filePath = path.join(directory, 'auth.json');
  let now = Date.parse('2026-07-10T12:00:00Z');
  const auth = await LocalAuth.open({
    filePath,
    now: () => now,
    delayBaseMs: 10,
    delayMaxMs: 40,
  });
  await auth.enable('doğru-şifre');
  auth.lock();

  const first = await auth.verify('yanlış-1');
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'invalid-password');
  assert.equal(first.retryAfterMs, 10);
  assert.equal(first.failedAttempts, 1);

  const blocked = await auth.verify('doğru-şifre');
  assert.equal(blocked.reason, 'rate-limited');
  assert.equal(blocked.retryAfterMs, 10);

  now += 10;
  const second = await auth.verify('yanlış-2');
  assert.equal(second.retryAfterMs, 20);
  assert.equal(second.failedAttempts, 2);

  now += 20;
  const success = await auth.verify('doğru-şifre');
  assert.equal(success.ok, true);
  assert.equal(success.failedAttempts, 0);
  assert.equal(success.retryAfterMs, 0);
  assert.equal(success.unlocked, true);
});

test('requires six characters and leaves the mutation queue usable after validation errors', async (t) => {
  assert.throws(() => validatePassword('12345'), { code: 'PASSWORD_TOO_SHORT' });
  assert.equal(validatePassword('123456'), '123456');
  assert.deepEqual(SCRYPT_PARAMS, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    keylen: 32,
    saltBytes: 16,
    maxmem: 64 * 1024 * 1024,
  });

  const directory = await makeTempDir(t);
  const auth = await LocalAuth.open({ filePath: path.join(directory, 'auth.json') });
  await assert.rejects(auth.enable('short'), { code: 'PASSWORD_TOO_SHORT' });
  const enabled = await auth.enable('uzun-şifre');
  assert.equal(enabled.ok, true);
});

test('changes the password safely and can disable the optional lock', async (t) => {
  const directory = await makeTempDir(t);
  const filePath = path.join(directory, 'auth.json');
  let now = Date.parse('2026-07-10T12:00:00Z');
  const auth = await LocalAuth.open({ filePath, now: () => now, delayBaseMs: 1 });
  await auth.enable('ilk-şifre');
  auth.lock();

  const changed = await auth.changePassword('ilk-şifre', 'ikinci-şifre');
  assert.equal(changed.ok, true);
  auth.lock();
  const oldAttempt = await auth.verify('ilk-şifre');
  assert.equal(oldAttempt.ok, false);
  now += oldAttempt.retryAfterMs;
  assert.equal((await auth.verify('ikinci-şifre')).ok, true);

  const disabled = await auth.disable();
  assert.equal(disabled.ok, true);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.unlocked, true);
  const reopened = await LocalAuth.open({ filePath, now: () => now });
  assert.equal(reopened.isEnabled(), false);
  assert.equal(reopened.isUnlocked(), true);
});

test('locked auth requires verification before disabling', async (t) => {
  const directory = await makeTempDir(t);
  const filePath = path.join(directory, 'auth.json');
  const auth = await LocalAuth.open({ filePath });
  await auth.enable('kilit-şifresi');
  auth.lock();

  const denied = await auth.disable();
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'authentication-required');
  assert.equal(auth.isEnabled(), true);
  const disabled = await auth.disable('kilit-şifresi');
  assert.equal(disabled.ok, true);
  assert.equal(auth.isEnabled(), false);
});
