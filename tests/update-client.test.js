const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { canonicalJson, compareVersions, publicKeyId, verifySignedEnvelope } = require('../src/lib/update-client');

function signed(payload, privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    schemaVersion: 1,
    payload,
    signature: {
      algorithm: 'Ed25519',
      keyId: publicKeyId(publicKey),
      value: crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64'),
    },
  };
}

test('signed update envelope rejects tampering', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = signed({ version: '2.0.0', channel: 'stable' }, privateKey);
  assert.deepEqual(verifySignedEnvelope(envelope, publicKey), envelope.payload);
  envelope.payload.version = '9.0.0';
  assert.throws(() => verifySignedEnvelope(envelope, publicKey));
});

test('version comparison handles release and beta ordering', () => {
  assert.equal(compareVersions('1.1.0', '1.0.9'), 1);
  assert.equal(compareVersions('1.1.0-beta.2', '1.1.0-beta.1'), 1);
  assert.equal(compareVersions('1.1.0', '1.1.0-beta.9'), 1);
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
});
