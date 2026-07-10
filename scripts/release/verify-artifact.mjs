#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { scanArtifact } from './scan-secrets.mjs';

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`[release] ${command} ${args.join(' ')}\n`);
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    if (capture) {
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(output);
      reject(new Error(`${command} failed with exit code ${code}`));
    });
  });
}

export function assertUniversalArchitectures(output) {
  const architectures = new Set(output.trim().split(/\s+/).filter(Boolean));
  if (architectures.size !== 2 || !architectures.has('arm64') || !architectures.has('x86_64')) {
    throw new Error(`expected arm64+x86_64 universal binary, found: ${[...architectures].join(', ') || 'none'}`);
  }
}

async function mountedApp(mountPoint) {
  const entries = await readdir(mountPoint, { withFileTypes: true });
  const apps = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (apps.length !== 1) throw new Error(`expected exactly one app in DMG, found ${apps.length}`);
  return path.join(mountPoint, apps[0].name);
}

export async function verifyArtifact(dmg, { projectRoot = process.cwd(), scanSecrets = true } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS artifact verification must run on macOS');
  const details = await stat(dmg).catch(() => null);
  if (!details?.isFile() || path.extname(dmg).toLowerCase() !== '.dmg') throw new Error('a DMG artifact is required');

  await run('xcrun', ['stapler', 'validate', dmg]);
  await run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);

  const mountPoint = await mkdtemp(path.join(os.tmpdir(), 'gurutime-verify-'));
  let attached = false;
  try {
    await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmg], { capture: true });
    attached = true;
    const app = await mountedApp(mountPoint);
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    const signature = await run('codesign', ['-d', '--verbose=4', app], { capture: true });
    if (!/Authority=Developer ID Application:/i.test(signature)) {
      throw new Error('app is not signed with Developer ID Application');
    }
    if (!/Runtime Version|flags=.*runtime/i.test(signature)) {
      throw new Error('app does not advertise hardened runtime');
    }
    await run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);

    const info = path.join(app, 'Contents', 'Info.plist');
    const executableName = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', info], { capture: true })).trim();
    const executable = path.join(app, 'Contents', 'MacOS', executableName);
    const archs = await run('lipo', ['-archs', executable], { capture: true });
    assertUniversalArchitectures(archs);
  } finally {
    if (attached) await run('hdiutil', ['detach', mountPoint, '-quiet']).catch(() => {});
    await rm(mountPoint, { recursive: true, force: true });
  }

  if (scanSecrets) {
    const findings = await scanArtifact(dmg, { projectRoot });
    if (findings.length) {
      const rules = [...new Set(findings.map((finding) => finding.rule))].join(', ');
      throw new Error(`secret scan failed (${rules}); values were redacted`);
    }
  }
  return { ok: true };
}

async function main() {
  const dmg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (!dmg) throw new Error('usage: verify-artifact <GuruTime-version-universal.dmg> [--skip-secret-scan]');
  await verifyArtifact(path.resolve(dmg), { scanSecrets: !process.argv.includes('--skip-secret-scan') });
  process.stdout.write('[release] Universal signature, hardened runtime, notarization, staple, Gatekeeper, and secret checks passed.\n');
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  main().catch((error) => {
    process.stderr.write(`[release] ${error.message}\n`);
    process.exitCode = 1;
  });
}
