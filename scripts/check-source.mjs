#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();

async function filesUnder(relative) {
  const output = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else output.push(full);
    }
  }
  await walk(path.join(root, relative));
  return output;
}

const sourceFiles = await filesUnder('src');
const scripts = [...sourceFiles, ...(await filesUnder('bin')), ...(await filesUnder('scripts/release'))]
  .filter((file) => /\.(?:js|cjs|mjs)$/u.test(file));

for (const file of scripts) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) {
    process.stderr.write(checked.stderr || checked.stdout || `Syntax check failed: ${file}\n`);
    process.exitCode = 1;
  }
}

const securityTargets = await Promise.all(sourceFiles
  .filter((file) => /\.(?:js|html)$/u.test(file))
  .map(async (file) => ({ file, text: await readFile(file, 'utf8') })));

const forbidden = [
  ['retired fixed password', /AUTH_PASSWORD\s*=|199064/u],
  ['unsafe Electron Node integration', /nodeIntegration\s*:\s*true/u],
  ['disabled Electron context isolation', /contextIsolation\s*:\s*false/u],
  ['wildcard CORS', /Access-Control-Allow-Origin['"\s:]+\*/u],
  ['token-bearing redirect', /[?&]token=/u],
];

for (const { file, text } of securityTargets) {
  for (const [label, pattern] of forbidden) {
    if (pattern.test(text)) {
      process.stderr.write(`[check] ${label}: ${path.relative(root, file)}\n`);
      process.exitCode = 1;
    }
  }
}

if (!process.exitCode) {
  process.stdout.write(`[check] ${scripts.length} JavaScript dosyası ve güvenlik taban çizgisi doğrulandı.\n`);
}
