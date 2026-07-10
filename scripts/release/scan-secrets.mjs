#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BUILTIN_RULES = [
  { id: 'legacy-default-password', pattern: /(?:^|[^0-9])199064(?:[^0-9]|$)/ },
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'live-payment-or-github-token', pattern: /(?:sk_live_|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/ },
  { id: 'long-lived-url-token', pattern: /[?&](?:access_?token|token|secret|api_?key)=[A-Za-z0-9._~-]{20,}/i },
  {
    id: 'embedded-release-credential',
    pattern: /(?:AWS_SECRET_ACCESS_KEY|APPLE_APP_SPECIFIC_PASSWORD|R2_SECRET_ACCESS_KEY|VERCEL_TOKEN)\s*[:=]\s*["'][A-Za-z0-9/+_.-]{12,}["']/
  }
];

const MAX_FILE_SIZE = 512 * 1024 * 1024;

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${command} failed with exit code ${code}`));
    });
  });
}

export function customSecretRules(raw = process.env.GURUTIME_SECRET_SCAN_VALUES) {
  if (!raw) return [];
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    values = raw.split('\n');
  }
  if (!Array.isArray(values)) throw new Error('GURUTIME_SECRET_SCAN_VALUES must be a JSON array or newline list');
  return values
    .filter((value) => typeof value === 'string' && value.length >= 6)
    .map((value, index) => ({ id: `declared-secret-${index + 1}`, literal: Buffer.from(value) }));
}

function isAllowed(relative, ruleId, allowlist) {
  return (allowlist.paths || []).some((entry) => {
    return entry?.path === relative && entry?.rule === ruleId;
  });
}

export function scanBuffer(buffer, relative, { allowlist = {}, extraRules = [] } = {}) {
  const findings = [];
  const text = buffer.toString('latin1');
  for (const rule of BUILTIN_RULES) {
    if (rule.pattern.test(text) && !isAllowed(relative, rule.id, allowlist)) {
      findings.push({ file: relative, rule: rule.id });
    }
  }
  for (const rule of extraRules) {
    if (buffer.includes(rule.literal) && !isAllowed(relative, rule.id, allowlist)) {
      findings.push({ file: relative, rule: rule.id });
    }
  }
  return findings;
}

async function scanDirectory(root, options, findings, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await scanDirectory(absolute, options, findings, relative);
      continue;
    }
    if (!entry.isFile()) continue;
    const details = await stat(absolute);
    if (details.size > MAX_FILE_SIZE) throw new Error(`refusing to skip oversized file during secret scan: ${relative}`);
    if (entry.name.endsWith('.asar')) {
      await scanAsar(absolute, options, findings, relative);
      continue;
    }
    findings.push(...scanBuffer(await readFile(absolute), relative, options));
  }
}

async function scanAsar(asarFile, options, findings, prefix = path.basename(asarFile)) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gurutime-asar-'));
  const tool = path.join(options.projectRoot, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
  const toolDetails = await stat(tool).catch(() => null);
  if (!toolDetails?.isFile()) {
    await rm(temp, { recursive: true, force: true });
    throw new Error('cannot inspect ASAR: install project dependencies first');
  }
  try {
    await run(process.execPath, [tool, 'extract', asarFile, temp]);
    await scanDirectory(temp, options, findings, prefix);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function scanDmg(dmg, options, findings) {
  if (process.platform !== 'darwin') throw new Error('DMG secret scanning requires macOS');
  const mountPoint = await mkdtemp(path.join(os.tmpdir(), 'gurutime-dmg-'));
  let attached = false;
  try {
    await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmg], { capture: true });
    attached = true;
    await scanDirectory(mountPoint, options, findings);
  } finally {
    if (attached) await run('hdiutil', ['detach', mountPoint, '-quiet']).catch(() => {});
    await rm(mountPoint, { recursive: true, force: true });
  }
}

export async function scanArtifact(target, {
  projectRoot = process.cwd(),
  allowlistFile = path.join(projectRoot, 'build', 'secret-scan-allowlist.json'),
  declaredSecrets = process.env.GURUTIME_SECRET_SCAN_VALUES
} = {}) {
  const targetPath = path.resolve(target);
  const details = await stat(targetPath).catch(() => null);
  if (!details) throw new Error('secret scan target does not exist');
  const allowlist = JSON.parse(await readFile(allowlistFile, 'utf8').catch(() => '{"paths":[],"rules":[]}'));
  const options = { projectRoot, allowlist, extraRules: customSecretRules(declaredSecrets) };
  const findings = [];
  if (details.isDirectory()) await scanDirectory(targetPath, options, findings);
  else if (targetPath.endsWith('.dmg')) await scanDmg(targetPath, options, findings);
  else if (targetPath.endsWith('.asar')) await scanAsar(targetPath, options, findings);
  else findings.push(...scanBuffer(await readFile(targetPath), path.basename(targetPath), options));
  return findings;
}

async function main() {
  const target = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (!target) throw new Error('usage: scan-secrets <app|asar|dmg|directory> [--json]');
  const findings = await scanArtifact(target);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, findings }, null, 2)}\n`);
  } else if (findings.length) {
    for (const finding of findings) {
      process.stderr.write(`[release] secret rule ${finding.rule} matched in ${finding.file}\n`);
    }
  }
  if (findings.length) {
    process.stderr.write(`[release] Secret scan failed with ${findings.length} finding(s). Values were redacted.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('[release] Secret scan passed.\n');
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  main().catch((error) => {
    process.stderr.write(`[release] ${error.message}\n`);
    process.exitCode = 1;
  });
}
