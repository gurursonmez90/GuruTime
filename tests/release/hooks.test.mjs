import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const notarizeApp = require('../../scripts/release/notarize-app.cjs');
const finalizeArtifacts = require('../../scripts/release/finalize-artifacts.cjs');

test('public electron-builder hooks fail closed outside the release orchestrator', async () => {
  const previous = process.env.GURUTIME_RELEASE_MODE;
  delete process.env.GURUTIME_RELEASE_MODE;
  try {
    await assert.rejects(
      notarizeApp({ electronPlatformName: 'darwin' }),
      /fail-closed/
    );
    await assert.rejects(
      finalizeArtifacts({ artifactPaths: [] }),
      /fail-closed/
    );
  } finally {
    if (previous === undefined) delete process.env.GURUTIME_RELEASE_MODE;
    else process.env.GURUTIME_RELEASE_MODE = previous;
  }
});
