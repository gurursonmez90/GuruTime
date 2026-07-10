'use strict';

const path = require('node:path');
const { isRelease, notarizeApp } = require('./lib/notary.cjs');

module.exports = async function notarizeAppAfterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  if (!isRelease()) {
    throw new Error('Public build config is fail-closed. Use scripts/release/release.mjs to create a release.');
  }
  if (process.env.GURUTIME_SKIP_NOTARIZE === '1') {
    throw new Error('GURUTIME_SKIP_NOTARIZE is forbidden when GURUTIME_RELEASE_MODE=release');
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  await notarizeApp(appPath);
};
