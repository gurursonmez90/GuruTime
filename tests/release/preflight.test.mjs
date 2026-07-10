import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  collectPreflight,
  validateDownloadsOrigin,
  validateStaticConfig
} from '../../scripts/release/preflight.mjs';

const root = path.resolve('.');

test('public build config mandates universal hardened signed release hooks', async () => {
  const config = await readFile(path.join(root, 'build', 'electron-builder.public.yml'), 'utf8');
  const packageData = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(validateStaticConfig(config, packageData), []);
});

test('production downloads require a custom HTTPS origin', () => {
  assert.match(validateDownloadsOrigin('http://downloads.example'), /HTTPS/);
  assert.match(validateDownloadsOrigin('https://preview.workers.dev'), /custom domain/);
  assert.equal(validateDownloadsOrigin('https://downloads.gurutime.example'), null);
});

test('dry-run preflight performs static validation without credentials', async () => {
  const result = await collectPreflight({
    root,
    strict: false,
    publish: false,
    env: { GURUTIME_DOWNLOADS_ORIGIN: 'https://downloads.gurutime.example' }
  });
  assert.deepEqual(result.errors, []);
});
