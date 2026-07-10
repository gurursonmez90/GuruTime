#!/usr/bin/env node

import { createHash, createPublicKey } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export async function pinUpdatePublicKey(source, destination = path.resolve('src/update-public-key.pem')) {
  if (!source) throw new Error('usage: pin-update-public-key <public-key.pem>');
  const pem = await readFile(path.resolve(source));
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('pinned update key must be Ed25519');
  const exported = key.export({ type: 'spki', format: 'pem' });
  const der = key.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256').update(der).digest('hex').slice(0, 16);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, exported, { mode: 0o644 });
  await rename(temporary, destination);
  return { destination, keyId };
}

async function main() {
  const result = await pinUpdatePublicKey(process.argv[2]);
  process.stdout.write(`[release] Pinned Ed25519 update key ${result.keyId} at ${result.destination}\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  main().catch((error) => {
    process.stderr.write(`[release] ${error.message}\n`);
    process.exitCode = 1;
  });
}
