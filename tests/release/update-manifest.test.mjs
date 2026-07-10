import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertReleaseCoordinates,
  canonicalJson,
  generateUpdateManifest
} from '../../scripts/release/generate-update-manifest.mjs';
import { publishR2 } from '../../scripts/release/publish-r2.mjs';

test('generates verifiable Ed25519 manifests with immutable universal URLs', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gurutime-manifest-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyFile = path.join(temp, 'update-private.pem');
  const artifact = path.join(temp, 'GuruTime-2.3.4-universal.dmg');
  const output = path.join(temp, 'output');
  await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(artifact, Buffer.from('test disk image bytes'));

  const result = await generateUpdateManifest({
    artifact,
    channel: 'stable',
    version: '2.3.4',
    origin: 'https://downloads.gurutime.example',
    signingKeyFile: keyFile,
    outputDir: output,
    publishedAt: '2026-07-10T12:00:00.000Z'
  });
  const signature = Buffer.from(result.manifest.signature.value, 'base64');
  assert.equal(
    verify(null, Buffer.from(canonicalJson(result.manifest.payload)), publicKey, signature),
    true
  );
  assert.equal(
    result.artifactRecord.url,
    'https://downloads.gurutime.example/releases/stable/2.3.4/GuruTime-2.3.4-universal.dmg'
  );
  assert.equal(result.artifactRecord.arch, 'universal');
  assert.equal(result.latest.payload.manifestUrl, 'https://downloads.gurutime.example/releases/stable/2.3.4/manifest.json');
  assert.match(await readFile(path.join(output, 'update-public-key.pem'), 'utf8'), /BEGIN PUBLIC KEY/);
  const keys = await publishR2({
    artifact,
    manifestDir: output,
    channel: 'stable',
    version: '2.3.4',
    dryRun: true,
    env: {
      R2_ACCOUNT_ID: 'test-account',
      R2_BUCKET: 'test-bucket',
      GURUTIME_DOWNLOADS_ORIGIN: 'https://downloads.gurutime.example'
    }
  });
  assert.equal(keys.manifest, 'releases/stable/2.3.4/manifest.json');
});

test('stable channel rejects prerelease and development origins', () => {
  assert.throws(
    () => assertReleaseCoordinates({ channel: 'stable', version: '2.0.0-beta.1', origin: 'https://downloads.example' }),
    /prerelease/
  );
  assert.throws(
    () => assertReleaseCoordinates({ channel: 'beta', version: '2.0.0-beta.1', origin: 'https://demo.r2.dev' }),
    /r2\.dev/
  );
});
