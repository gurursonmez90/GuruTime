const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  GitHubUpdateClient,
  canonicalJson,
  compareVersions,
  publicKeyId,
  trustedGitHubReleaseUrl,
  verifySignedEnvelope,
} = require('../src/lib/update-client');

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

function jsonResponse(url, value, { ok = true, status = 200 } = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    ok,
    status,
    url,
    arrayBuffer: async () => bytes,
  };
}

test('GitHub updates prefer a trusted newer release', async () => {
  const client = new GitHubUpdateClient({
    currentVersion: '1.1.0',
    fetchImpl: async (url) => jsonResponse(url, {
      tag_name: 'v1.2.0',
      html_url: 'https://github.com/gurursonmez90/GuruTime/releases/tag/v1.2.0',
      draft: false,
      prerelease: false,
    }),
  });
  assert.deepEqual(await client.check(), {
    available: true,
    version: '1.2.0',
    url: 'https://github.com/gurursonmez90/GuruTime/releases/tag/v1.2.0',
    kind: 'release',
  });
});

test('GitHub updates fall back to the versioned main branch after a push', async () => {
  const client = new GitHubUpdateClient({
    currentVersion: '1.1.0',
    fetchImpl: async (url) => {
      if (url.includes('api.github.com')) return jsonResponse(url, {}, { ok: false, status: 404 });
      return jsonResponse(url, { version: '1.2.0' });
    },
  });
  assert.deepEqual(await client.check(), {
    available: true,
    version: '1.2.0',
    url: 'https://github.com/gurursonmez90/GuruTime',
    kind: 'source',
  });
});

test('GitHub release links cannot leave the expected repository', () => {
  assert.throws(
    () => trustedGitHubReleaseUrl('https://example.com/fake', 'gurursonmez90/GuruTime'),
    /güvenilir değil/,
  );
  assert.throws(
    () => trustedGitHubReleaseUrl('https://github.com/other/repo/releases/tag/v2.0.0', 'gurursonmez90/GuruTime'),
    /beklenen depoya/,
  );
});
