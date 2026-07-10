import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  customSecretRules,
  scanArtifact,
  scanBuffer
} from '../../scripts/release/scan-secrets.mjs';

test('detects the removed legacy password without exposing matched content', () => {
  const findings = scanBuffer(Buffer.from('legacy=199064'), 'app.js');
  assert.deepEqual(findings, [{ file: 'app.js', rule: 'legacy-default-password' }]);
  assert.equal(JSON.stringify(findings).includes('199064'), false);
});

test('detects operator-declared secrets and respects scoped allowlist', () => {
  const extraRules = customSecretRules(JSON.stringify(['a-private-test-value']));
  const findings = scanBuffer(Buffer.from('value=a-private-test-value'), 'config.json', { extraRules });
  assert.equal(findings[0].rule, 'declared-secret-1');
  assert.deepEqual(
    scanBuffer(Buffer.from('value=a-private-test-value'), 'config.json', {
      extraRules,
      allowlist: { paths: [{ path: 'config.json', rule: 'declared-secret-1' }] }
    }),
    []
  );
});

test('recursively scans an unpacked app directory', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gurutime-secret-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(path.join(temp, 'safe.txt'), 'no credentials here');
  await writeFile(path.join(temp, 'unsafe.txt'), '-----BEGIN PRIVATE KEY-----');
  const findings = await scanArtifact(temp, {
    projectRoot: path.resolve('.'),
    allowlistFile: path.join(temp, 'missing-allowlist.json'),
    declaredSecrets: ''
  });
  assert.deepEqual(findings, [{ file: 'unsafe.txt', rule: 'private-key' }]);
});
