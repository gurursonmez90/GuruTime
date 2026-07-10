#!/usr/bin/env node

import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey } from 'node:crypto';

const REQUIRED_CONFIG_SNIPPETS = [
  ['universal target', /\barch:\s*\n\s*- universal\b/],
  ['hardened runtime', /\bhardenedRuntime:\s*true\b/],
  ['explicit custom notarization mode', /\bnotarize:\s*false\b/],
  ['main entitlements', /\bentitlements:\s*build\/entitlements\.mac\.plist\b/],
  ['inherited entitlements', /\bentitlementsInherit:\s*build\/entitlements\.mac\.inherit\.plist\b/],
  ['app notarization hook', /\bafterSign:\s*scripts\/release\/notarize-app\.cjs\b/],
  ['DMG notarization hook', /\bafterAllArtifactBuild:\s*scripts\/release\/finalize-artifacts\.cjs\b/],
  ['universal artifact name', /artifactName:.*-universal\.\$\{ext\}/]
];

function runCapture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', () => resolve({ ok: false, output: '' }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

function validVersion(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || '');
}

export function validateDownloadsOrigin(value) {
  if (!value) return 'GURUTIME_DOWNLOADS_ORIGIN is missing';
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'GURUTIME_DOWNLOADS_ORIGIN must be a valid URL';
  }
  if (url.protocol !== 'https:') return 'GURUTIME_DOWNLOADS_ORIGIN must use HTTPS';
  if (url.username || url.password || url.search || url.hash) {
    return 'GURUTIME_DOWNLOADS_ORIGIN must be a clean origin without credentials, query, or fragment';
  }
  if (/(?:^|\.)(?:r2\.dev|workers\.dev)$/i.test(url.hostname)) {
    return 'GURUTIME_DOWNLOADS_ORIGIN must use the production custom domain, not r2.dev or workers.dev';
  }
  return null;
}

export function validateStaticConfig(configText, packageData) {
  const errors = [];
  if (!validVersion(packageData.version)) errors.push('package.json must contain a valid semver version');
  for (const [label, pattern] of REQUIRED_CONFIG_SNIPPETS) {
    if (!pattern.test(configText)) errors.push(`public build config is missing ${label}`);
  }
  if (/\bidentity:\s*["']?-?["']?\s*$/m.test(configText)) {
    errors.push('public build config must not disable code signing');
  }
  if (/\bhardenedRuntime:\s*false\b/.test(configText)) {
    errors.push('public build config explicitly disables hardened runtime');
  }
  return errors;
}

function hasNotaryCredentials(env) {
  return Boolean(
    env.GURUTIME_NOTARY_PROFILE ||
    (env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER && env.APPLE_API_KEY_FILE) ||
    (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
  );
}

async function signingKeyError(file, root) {
  if (!file) return 'GURUTIME_UPDATE_SIGNING_KEY_FILE is missing';
  const resolved = path.resolve(file);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return 'update signing key must be stored outside the repository';
  }
  const details = await stat(resolved).catch(() => null);
  if (!details?.isFile()) return 'GURUTIME_UPDATE_SIGNING_KEY_FILE must point to a regular file';
  if ((details.mode & 0o077) !== 0) return 'update signing key permissions must be 0600 or stricter';
  return null;
}

async function pinnedKeyError(signingKeyFile, pinnedKeyFile) {
  const pinned = await readFile(pinnedKeyFile).catch(() => null);
  if (!pinned) return 'src/update-public-key.pem is missing; run release:pin-key before a public build';
  try {
    const pinnedKey = createPublicKey(pinned);
    if (pinnedKey.asymmetricKeyType !== 'ed25519') return 'pinned update public key must be Ed25519';
    const privateKey = createPrivateKey(await readFile(signingKeyFile));
    const expected = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const actual = pinnedKey.export({ type: 'spki', format: 'der' });
    if (!expected.equals(actual)) return 'pinned update public key does not match the release signing key';
    return null;
  } catch {
    return 'pinned update public key could not be validated';
  }
}

export async function collectPreflight({
  root = process.cwd(),
  env = process.env,
  strict = true,
  publish = false,
  platform = process.platform
} = {}) {
  const errors = [];
  const warnings = [];
  const configFile = path.join(root, 'build', 'electron-builder.public.yml');
  const packageFile = path.join(root, 'package.json');
  const [configText, packageText] = await Promise.all([
    readFile(configFile, 'utf8').catch(() => null),
    readFile(packageFile, 'utf8').catch(() => null)
  ]);

  if (!configText) errors.push('build/electron-builder.public.yml is missing');
  if (!packageText) errors.push('package.json is missing');
  if (configText && packageText) {
    let packageData;
    try {
      packageData = JSON.parse(packageText);
    } catch {
      errors.push('package.json is not valid JSON');
    }
    if (packageData) errors.push(...validateStaticConfig(configText, packageData));
  }

  for (const relative of [
    'build/entitlements.mac.plist',
    'build/entitlements.mac.inherit.plist',
    'scripts/release/notarize-app.cjs',
    'scripts/release/finalize-artifacts.cjs'
  ]) {
    await access(path.join(root, relative), constants.R_OK).catch(() => errors.push(`${relative} is not readable`));
  }

  const originError = validateDownloadsOrigin(env.GURUTIME_DOWNLOADS_ORIGIN);
  if (strict && originError) errors.push(originError);
  else if (originError) warnings.push(originError);

  if (strict) {
    if (platform !== 'darwin') errors.push('public macOS release must run on macOS');
    if (!env.CSC_NAME || !/^Developer ID Application:/i.test(env.CSC_NAME)) {
      errors.push('CSC_NAME must name a Developer ID Application identity');
    }
    if (!hasNotaryCredentials(env)) errors.push('notarytool credentials are missing');
    if (env.APPLE_API_KEY_FILE) {
      const apiKey = path.resolve(env.APPLE_API_KEY_FILE);
      const relative = path.relative(path.resolve(root), apiKey);
      const details = await stat(apiKey).catch(() => null);
      if (!details?.isFile()) errors.push('APPLE_API_KEY_FILE must point to a regular file');
      else if ((details.mode & 0o077) !== 0) errors.push('APPLE_API_KEY_FILE permissions must be 0600 or stricter');
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        errors.push('APPLE_API_KEY_FILE must be stored outside the repository');
      }
    }
    const keyError = await signingKeyError(env.GURUTIME_UPDATE_SIGNING_KEY_FILE, root);
    if (keyError) errors.push(keyError);
    else {
      const pinError = await pinnedKeyError(
        env.GURUTIME_UPDATE_SIGNING_KEY_FILE,
        path.join(root, 'src', 'update-public-key.pem')
      );
      if (pinError) errors.push(pinError);
    }

    for (const command of ['codesign', 'ditto', 'hdiutil', 'lipo', 'security', 'spctl', 'xcrun']) {
      const result = await runCapture('/usr/bin/which', [command]);
      if (!result.ok) errors.push(`${command} is not available`);
    }
    const notarytool = await runCapture('xcrun', ['notarytool', '--version']);
    if (!notarytool.ok) errors.push('xcrun notarytool is unavailable');

    if (env.CSC_NAME) {
      const identities = await runCapture('security', ['find-identity', '-v', '-p', 'codesigning']);
      if (!identities.ok || !identities.output.includes(env.CSC_NAME)) {
        errors.push('CSC_NAME was not found in the login/system keychains');
      }
    }
  }

  if (publish) {
    for (const name of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      if (!env[name]) errors.push(`${name} is required for R2 publication`);
    }
    if (strict) {
      const aws = await runCapture('/usr/bin/which', ['aws']);
      if (!aws.ok) errors.push('AWS CLI is required for R2 publication');
    }
  }

  return { errors, warnings };
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    publish: argv.includes('--publish')
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await collectPreflight({ strict: !options.dryRun, publish: options.publish });
  for (const warning of result.warnings) process.stdout.write(`[release] warning: ${warning}\n`);
  if (result.errors.length) {
    for (const error of result.errors) process.stderr.write(`[release] error: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`[release] Preflight passed${options.dryRun ? ' in dry-run mode' : ''}.\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  main().catch((error) => {
    process.stderr.write(`[release] ${error.message}\n`);
    process.exitCode = 1;
  });
}
