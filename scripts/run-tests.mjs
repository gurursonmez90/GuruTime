#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const testsRoot = path.join(root, 'tests');
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (/\.test\.(?:js|mjs)$/u.test(entry.name)) files.push(full);
  }
}

await walk(testsRoot);
files.sort();
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
