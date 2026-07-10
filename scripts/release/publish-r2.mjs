#!/usr/bin/env node

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './generate-update-manifest.mjs';

const IMMUTABLE_CACHE = 'public,max-age=31536000,immutable';
const POINTER_CACHE = 'no-store,max-age=0';

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value || '');
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error('cannot compare invalid versions');
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (!left.prerelease.length && right.prerelease.length) return 1;
  if (left.prerelease.length && !right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = left.prerelease[index];
    const r = right.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null) return ln - rn;
    if (ln !== null) return -1;
    if (rn !== null) return 1;
    return l.localeCompare(r);
  }
  return 0;
}

export function versionsToPrune(versions, keep = 5) {
  return [...new Set(versions)]
    .filter((version) => parseVersion(version))
    .sort((a, b) => compareVersions(b, a))
    .slice(keep);
}

export function assertNoDowngrade(candidate, existingVersions) {
  const valid = existingVersions.filter((version) => parseVersion(version));
  if (!valid.length) return;
  const newest = valid.sort((a, b) => compareVersions(b, a))[0];
  if (compareVersions(candidate, newest) < 0) {
    throw new Error(`refusing channel rollback from ${newest} to ${candidate}; publish a newer version instead`);
  }
}

export function immutableKeys({ channel, version, artifactName }) {
  if (!['stable', 'beta'].includes(channel)) throw new Error('channel must be stable or beta');
  if (!parseVersion(version)) throw new Error('version is invalid');
  if (path.basename(artifactName) !== artifactName) throw new Error('artifactName must not contain path segments');
  const prefix = `releases/${channel}/${version}`;
  return {
    artifact: `${prefix}/${artifactName}`,
    manifest: `${prefix}/manifest.json`,
    latest: `releases/${channel}/latest.json`
  };
}

function run(command, args, { capture = false, env = process.env, dryRun = false } = {}) {
  if (dryRun) {
    process.stdout.write(`[release] dry-run: ${command} ${args.join(' ')}\n`);
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function verifyEnvelope(envelope, publicKey) {
  if (envelope?.signature?.algorithm !== 'Ed25519' || !envelope.payload) return false;
  return cryptoVerify(
    null,
    Buffer.from(canonicalJson(envelope.payload), 'utf8'),
    publicKey,
    Buffer.from(envelope.signature.value || '', 'base64')
  );
}

function awsBase(accountId) {
  return ['--endpoint-url', `https://${accountId}.r2.cloudflarestorage.com`, '--region', 'auto'];
}

async function ensureAbsent({ bucket, key, accountId, env }) {
  const result = await run('aws', [
    ...awsBase(accountId), 's3api', 'head-object', '--bucket', bucket, '--key', key
  ], { capture: true, env });
  if (result.code === 0) throw new Error(`immutable R2 object already exists: ${key}`);
  if (!/(404|Not Found|NoSuchKey)/i.test(result.stderr)) {
    throw new Error(`could not verify immutable key availability: ${key}`);
  }
}

async function putObject({ bucket, key, file, accountId, contentType, cacheControl, checksum, env, dryRun }) {
  const args = [
    ...awsBase(accountId), 's3api', 'put-object',
    '--bucket', bucket,
    '--key', key,
    '--body', file,
    '--content-type', contentType,
    '--cache-control', cacheControl,
    '--metadata', `sha256=${checksum}`
  ];
  const result = await run('aws', args, { env, dryRun });
  if (result.code !== 0) throw new Error(`R2 upload failed: ${key}`);
}

async function listVersions({ bucket, channel, accountId, env }) {
  const prefix = `releases/${channel}/`;
  const result = await run('aws', [
    ...awsBase(accountId), 's3api', 'list-objects-v2',
    '--bucket', bucket,
    '--prefix', prefix,
    '--delimiter', '/',
    '--output', 'json'
  ], { capture: true, env });
  if (result.code !== 0) throw new Error('could not list R2 release versions');
  const parsed = JSON.parse(result.stdout || '{}');
  return (parsed.CommonPrefixes || [])
    .map(({ Prefix }) => Prefix?.slice(prefix.length).replace(/\/$/, ''))
    .filter(Boolean);
}

async function deletePrefix({ bucket, prefix, accountId, env, dryRun }) {
  const result = await run('aws', [
    ...awsBase(accountId), 's3', 'rm', `s3://${bucket}/${prefix}`, '--recursive'
  ], { env, dryRun });
  if (result.code !== 0) throw new Error(`could not prune ${prefix}`);
}

export async function publishR2({
  artifact,
  manifestDir,
  channel,
  version,
  env = process.env,
  dryRun = false
}) {
  const accountId = env.R2_ACCOUNT_ID;
  const bucket = env.R2_BUCKET;
  if (!accountId || !bucket) throw new Error('R2_ACCOUNT_ID and R2_BUCKET are required');
  if (!env.GURUTIME_DOWNLOADS_ORIGIN) throw new Error('GURUTIME_DOWNLOADS_ORIGIN is required');
  if (!dryRun && (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY)) {
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required');
  }
  const artifactInfo = await stat(artifact).catch(() => null);
  if (!artifactInfo?.isFile()) throw new Error('artifact is missing');
  const manifestFile = path.join(manifestDir, 'manifest.json');
  const latestFile = path.join(manifestDir, 'latest.json');
  const publicKeyFile = path.join(manifestDir, 'update-public-key.pem');
  await Promise.all([stat(manifestFile), stat(latestFile), stat(publicKeyFile)]);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const latest = JSON.parse(await readFile(latestFile, 'utf8'));
  const publicKey = createPublicKey(await readFile(publicKeyFile));
  if (publicKey.asymmetricKeyType !== 'ed25519' || !verifyEnvelope(manifest, publicKey) || !verifyEnvelope(latest, publicKey)) {
    throw new Error('update manifest signature validation failed');
  }
  if (manifest.payload?.channel !== channel || manifest.payload?.version !== version) {
    throw new Error('signed manifest coordinates do not match publication coordinates');
  }
  if (latest.payload?.channel !== channel || latest.payload?.version !== version) {
    throw new Error('signed latest pointer coordinates do not match publication coordinates');
  }

  const keys = immutableKeys({ channel, version, artifactName: path.basename(artifact) });
  const artifactChecksum = await sha256(artifact);
  const signedArtifact = manifest.payload.artifacts?.find((entry) => entry.arch === 'universal');
  const expectedOrigin = env.GURUTIME_DOWNLOADS_ORIGIN?.replace(/\/$/, '');
  if (!signedArtifact || signedArtifact.sha256 !== artifactChecksum || signedArtifact.size !== artifactInfo.size) {
    throw new Error('DMG does not match the signed manifest');
  }
  if (expectedOrigin && signedArtifact.url !== `${expectedOrigin}/${keys.artifact}`) {
    throw new Error('signed artifact URL does not match the production origin and immutable key');
  }
  if (latest.payload.manifestSha256 !== await sha256(manifestFile)) {
    throw new Error('latest pointer does not match the signed manifest bytes');
  }
  const awsEnv = {
    ...env,
    AWS_DEFAULT_REGION: 'auto',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_PAGER: ''
  };
  let existingVersions = [];
  if (!dryRun) {
    existingVersions = await listVersions({ bucket, channel, accountId, env: awsEnv });
    assertNoDowngrade(version, existingVersions);
    await ensureAbsent({ bucket, key: keys.artifact, accountId, env: awsEnv });
    await ensureAbsent({ bucket, key: keys.manifest, accountId, env: awsEnv });
  }

  await putObject({
    bucket,
    key: keys.artifact,
    file: artifact,
    accountId,
    contentType: 'application/x-apple-diskimage',
    cacheControl: IMMUTABLE_CACHE,
    checksum: artifactChecksum,
    env: awsEnv,
    dryRun
  });
  await putObject({
    bucket,
    key: keys.manifest,
    file: manifestFile,
    accountId,
    contentType: 'application/json; charset=utf-8',
    cacheControl: IMMUTABLE_CACHE,
    checksum: await sha256(manifestFile),
    env: awsEnv,
    dryRun
  });
  await putObject({
    bucket,
    key: keys.latest,
    file: latestFile,
    accountId,
    contentType: 'application/json; charset=utf-8',
    cacheControl: POINTER_CACHE,
    checksum: await sha256(latestFile),
    env: awsEnv,
    dryRun
  });

  if (!dryRun) {
    const remoteVersions = [...existingVersions, version];
    for (const oldVersion of versionsToPrune(remoteVersions, 5)) {
      await deletePrefix({
        bucket,
        prefix: `releases/${channel}/${oldVersion}/`,
        accountId,
        env: awsEnv,
        dryRun
      });
    }
  }
  return keys;
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const artifact = argValue(argv, '--artifact');
  const manifestDir = argValue(argv, '--manifest-dir');
  const channel = argValue(argv, '--channel');
  const version = argValue(argv, '--version');
  const dryRun = argv.includes('--dry-run');
  if (!artifact || !manifestDir || !channel || !version) {
    throw new Error('usage: publish-r2 --artifact <dmg> --manifest-dir <dir> --channel <stable|beta> --version <semver> [--dry-run]');
  }
  const keys = await publishR2({
    artifact: path.resolve(artifact),
    manifestDir: path.resolve(manifestDir),
    channel,
    version,
    dryRun
  });
  process.stdout.write(`[release] ${dryRun ? 'Validated' : 'Published'} ${channel} ${version} at ${keys.manifest}\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  main().catch((error) => {
    process.stderr.write(`[release] ${error.message}\n`);
    process.exitCode = 1;
  });
}
