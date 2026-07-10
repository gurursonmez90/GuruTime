'use strict';

const path = require('node:path');
const { isRelease, notarizeDiskImage, run } = require('./lib/notary.cjs');

module.exports = async function finalizeArtifacts(context) {
  const diskImages = (context.artifactPaths || []).filter((file) => path.extname(file).toLowerCase() === '.dmg');
  if (!isRelease()) {
    throw new Error('Public build config is fail-closed. Use scripts/release/release.mjs to create a release.');
  }
  if (process.env.GURUTIME_SKIP_NOTARIZE === '1') {
    throw new Error('GURUTIME_SKIP_NOTARIZE is forbidden when GURUTIME_RELEASE_MODE=release');
  }
  if (diskImages.length !== 1) {
    throw new Error(`Expected exactly one universal DMG, found ${diskImages.length}`);
  }

  for (const diskImage of diskImages) {
    await notarizeDiskImage(diskImage);
    await run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', diskImage]);
  }
  return [];
};
