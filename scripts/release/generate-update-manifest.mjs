#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function assertReleaseCoordinates({ channel, version, origin }) {
  if (!['stable', 'beta'].includes(channel)) throw new Error('channel must be stable or beta');
  if (!VERSION_PATTERN.test(version || '')) throw new Error('version must be semver-compatible');
  if (channel === 'stable' && version.includes('-')) {
    throw new Error('stable channel cannot publish a prerelease version');
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('downloads origin must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin.replace(/\/$/, '')) {
    throw new Error('downloads origin must be a clean HTTPS origin');
  }
  if (/(?:^|\.)(?:r2\.dev|workers\.dev)$/i.test(parsed.hostname)) {
    throw new Error('production manifests cannot point at r2.dev or workers.dev');
  }
}

async function hashFile(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

async function loadSigningKey(file) {
  if (!file) throw new Error('GURUTIME_UPDATE_SIGNING_KEY_FILE is required');
  const details = await stat(file).catch(() => null);
  if (!details?.isFile()) throw new Error('update signing key must be a regular file');
  if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
    throw new Error('update signing key permissions must be 0600 or stricter');
  }
  const key = createPrivateKey(await readFile(file));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('update signing key must be Ed25519');
  return key;
}

export function createSignedEnvelope(payload, privateKey) {
  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256').update(publicDer).digest('hex').slice(0, 16);
  const bytes = Buffer.from(canonicalJson(payload), 'utf8');
  const value = cryptoSign(null, bytes, privateKey).toString('base64');
  return {
    schemaVersion: 1,
    payload,
    signature: { algorithm: 'Ed25519', keyId, value }
  };
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await rename(temp, file);
}

export async function generateUpdateManifest({
  artifact,
  channel,
  version,
  origin,
  signingKeyFile,
  outputDir,
  publishedAt = new Date().toISOString()
}) {
  assertReleaseCoordinates({ channel, version, origin });
  const artifactDetails = await stat(artifact).catch(() => null);
  if (!artifactDetails?.isFile()) throw new Error('artifact must be a regular file');
  if (path.extname(artifact).toLowerCase() !== '.dmg') throw new Error('artifact must be a DMG');
  const filename = path.basename(artifact);
  if (!filename.includes(version) || !/-universal\.dmg$/i.test(filename)) {
    throw new Error('artifact filename must include the version and end in -universal.dmg');
  }

  const privateKey = await loadSigningKey(signingKeyFile);
  const base = origin.replace(/\/$/, '');
  const immutableKey = `releases/${channel}/${version}/${filename}`;
  const artifactRecord = {
    arch: 'universal',
    contentType: 'application/x-apple-diskimage',
    file: filename,
    size: artifactDetails.size,
    sha256: await hashFile(artifact, 'sha256', 'hex'),
    sha512: await hashFile(artifact, 'sha512', 'base64'),
    url: `${base}/${immutableKey}`
  };
  const manifestPayload = {
    schemaVersion: 1,
    channel,
    version,
    publishedAt,
    minimumMacOSVersion: '12.0',
    artifacts: [artifactRecord]
  };
  const manifest = createSignedEnvelope(manifestPayload, privateKey);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const manifestUrl = `${base}/releases/${channel}/${version}/manifest.json`;
  const latest = createSignedEnvelope({
    schemaVersion: 1,
    channel,
    version,
    publishedAt,
    manifestSha256,
    manifestUrl
  }, privateKey);

  const finalOutput = outputDir || path.join('dist', 'public', 'updates', channel, version);
  await atomicJson(path.join(finalOutput, 'manifest.json'), manifest);
  await atomicJson(path.join(finalOutput, 'latest.json'), latest);
  await writeFile(
    path.join(finalOutput, 'update-public-key.pem'),
    createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }),
    { mode: 0o644 }
  );
  return { artifactRecord, manifest, latest, manifestSha256, outputDir: finalOutput };
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const artifact = argValue(argv, '--artifact');
  const channel = argValue(argv, '--channel');
  const version = argValue(argv, '--version');
  if (!artifact || !channel || !version) {
    throw new Error('usage: generate-update-manifest --artifact <dmg> --channel <stable|beta> --version <semver> [--output <dir>]');
  }
  const result = await generateUpdateManifest({
    artifact: path.resolve(artifact),
    channel,
    version,
    origin: process.env.GURUTIME_DOWNLOADS_ORIGIN,
    signingKeyFile: process.env.GURUTIME_UPDATE_SIGNING_KEY_FILE,
    outputDir: argValue(argv, '--output') ? path.resolve(argValue(argv, '--output')) : undefined
  });
  process.stdout.write(`[release] Signed ${channel} ${version} manifest in ${result.outputDir}\n`);
  process.stdout.write(`[release] Update signing key id: ${result.manifest.signature.keyId}\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  main().catch((error) => {
    process.stderr.write(`[release] ${error.message}\n`);
    process.exitCode = 1;
  });
}
