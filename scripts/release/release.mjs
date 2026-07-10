#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectPreflight } from './preflight.mjs';
import { generateUpdateManifest } from './generate-update-manifest.mjs';
import { publishR2 } from './publish-r2.mjs';
import { verifyArtifact } from './verify-artifact.mjs';

function run(command, args, { env = process.env } = {}) {
  process.stdout.write(`[release] ${command} ${args.join(' ')}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} failed with exit code ${code}`));
    });
  });
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

async function findArtifact(outputDir, version) {
  const files = await readdir(outputDir);
  const expected = files.filter((file) => file.endsWith('.dmg') && file.includes(version) && file.endsWith('-universal.dmg'));
  if (expected.length !== 1) throw new Error(`expected one ${version} universal DMG, found ${expected.length}`);
  return path.join(outputDir, expected[0]);
}

export async function release({
  root = process.cwd(),
  channel,
  publish = false,
  dryRun = false,
  env = process.env
}) {
  if (!['stable', 'beta'].includes(channel)) throw new Error('--channel stable or --channel beta is required');
  const packageData = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = packageData.version;
  if (channel === 'stable' && typeof version === 'string' && version.includes('-')) {
    throw new Error('stable channel cannot publish a prerelease package version');
  }
  const preflight = await collectPreflight({ root, env, strict: !dryRun, publish });
  for (const warning of preflight.warnings) process.stdout.write(`[release] warning: ${warning}\n`);
  if (preflight.errors.length) throw new Error(`preflight failed:\n- ${preflight.errors.join('\n- ')}`);

  const outputDir = path.join(root, 'dist', 'public');
  const manifestDir = path.join(outputDir, 'updates', channel, version);
  if (dryRun) {
    process.stdout.write(`[release] dry-run: build GuruTime ${version} as arm64+x86_64 universal DMG\n`);
    process.stdout.write('[release] dry-run: verify Developer ID, hardened runtime, notarization, staple, Gatekeeper, and secrets\n');
    process.stdout.write(`[release] dry-run: sign ${channel} update manifest with Ed25519\n`);
    if (publish) process.stdout.write('[release] dry-run: publish immutable objects to R2 and retain five channel versions\n');
    return { version, channel, dryRun: true };
  }

  const builder = path.join(root, 'node_modules', '.bin', 'electron-builder');
  await run(builder, ['--config', 'build/electron-builder.public.yml', '--mac', '--universal', '--publish', 'never'], {
    env: { ...env, GURUTIME_RELEASE_MODE: 'release' }
  });
  const artifact = await findArtifact(outputDir, version);
  await verifyArtifact(artifact, { projectRoot: root });
  const generated = await generateUpdateManifest({
    artifact,
    channel,
    version,
    origin: env.GURUTIME_DOWNLOADS_ORIGIN,
    signingKeyFile: env.GURUTIME_UPDATE_SIGNING_KEY_FILE,
    outputDir: manifestDir
  });
  if (publish) {
    await publishR2({ artifact, manifestDir, channel, version, env });
  }
  return { artifact, manifestDir, keyId: generated.manifest.signature.keyId, version, channel };
}

async function main() {
  const argv = process.argv.slice(2);
  const result = await release({
    channel: argValue(argv, '--channel'),
    publish: argv.includes('--publish'),
    dryRun: argv.includes('--dry-run')
  });
  if (result.dryRun) {
    process.stdout.write('[release] Dry-run completed without signing, notarizing, or uploading.\n');
  } else {
    process.stdout.write(`[release] Release verified: ${result.artifact}\n`);
    process.stdout.write(`[release] Signed update manifest key id: ${result.keyId}\n`);
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  main().catch((error) => {
    process.stderr.write(`[release] ${error.message}\n`);
    process.exitCode = 1;
  });
}
