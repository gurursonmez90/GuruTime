import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pinUpdatePublicKey } from '../../scripts/release/pin-update-public-key.mjs';

test('pins only an Ed25519 public key for the packaged updater', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gurutime-pin-'));
  const { publicKey } = generateKeyPairSync('ed25519');
  const source = path.join(directory, 'public.pem');
  const destination = path.join(directory, 'src', 'update-public-key.pem');
  await writeFile(source, publicKey.export({ type: 'spki', format: 'pem' }));
  const result = await pinUpdatePublicKey(source, destination);
  assert.match(result.keyId, /^[0-9a-f]{16}$/);
  assert.match(await readFile(destination, 'utf8'), /BEGIN PUBLIC KEY/);
});
