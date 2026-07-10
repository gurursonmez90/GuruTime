const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { decryptEnvelope, normalizeOrigin, socketUrl } = require('../src/lib/cloud-client');

function encryptEnvelope(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
}

test('cloud command AES-GCM envelope decrypts and authenticates', () => {
  const key = crypto.randomBytes(32);
  const payload = { v: 1, kind: 'task.create', createdAt: Date.now(), payload: { title: 'Test' } };
  const encrypted = encryptEnvelope(key, payload);
  assert.deepEqual(decryptEnvelope(key.toString('base64url'), encrypted), payload);
  const tampered = Buffer.from(encrypted, 'base64url');
  tampered[15] ^= 1;
  assert.throws(() => decryptEnvelope(key.toString('base64url'), tampered.toString('base64url')));
});

test('controller socket carries ticket only in subprotocol, never query', () => {
  const url = socketUrl('https://app.example.com', '4a6bf5cf-6abe-47ab-a52a-00d129bad3bd');
  assert.equal(url, 'wss://app.example.com/api/v1/controller/socket/4a6bf5cf-6abe-47ab-a52a-00d129bad3bd');
  assert.equal(new URL(url).search, '');
});

test('production origin must be HTTPS', () => {
  assert.equal(normalizeOrigin('https://app.example.com/path'), 'https://app.example.com');
  assert.equal(normalizeOrigin('http://localhost:8787/x'), 'http://localhost:8787');
  assert.throws(() => normalizeOrigin('http://app.example.com'));
});
