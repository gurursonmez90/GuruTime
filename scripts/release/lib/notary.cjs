'use strict';

const { spawn } = require('node:child_process');
const { mkdtemp, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (!options.quiet) {
      const shown = options.display || [command, ...args].join(' ');
      process.stdout.write(`[release] ${shown}\n`);
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(`${command} failed with exit code ${code}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function requireRegularFile(file, label) {
  if (!file) throw new Error(`${label} is required`);
  const details = await stat(file).catch(() => null);
  if (!details || !details.isFile()) throw new Error(`${label} does not point to a regular file`);
}

async function notaryAuthArgs(env = process.env) {
  if (env.GURUTIME_NOTARY_PROFILE) {
    return ['--keychain-profile', env.GURUTIME_NOTARY_PROFILE];
  }

  if (env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER || env.APPLE_API_KEY_FILE) {
    if (!env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER || !env.APPLE_API_KEY_FILE) {
      throw new Error('APPLE_API_KEY_ID, APPLE_API_ISSUER and APPLE_API_KEY_FILE must be set together');
    }
    await requireRegularFile(env.APPLE_API_KEY_FILE, 'APPLE_API_KEY_FILE');
    return [
      '--key', env.APPLE_API_KEY_FILE,
      '--key-id', env.APPLE_API_KEY_ID,
      '--issuer', env.APPLE_API_ISSUER
    ];
  }

  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD || env.APPLE_TEAM_ID) {
    if (!env.APPLE_ID || !env.APPLE_APP_SPECIFIC_PASSWORD || !env.APPLE_TEAM_ID) {
      throw new Error('APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID must be set together');
    }
    return [
      '--apple-id', env.APPLE_ID,
      '--password', env.APPLE_APP_SPECIFIC_PASSWORD,
      '--team-id', env.APPLE_TEAM_ID
    ];
  }

  throw new Error(
    'Notarization credentials missing. Set GURUTIME_NOTARY_PROFILE, App Store Connect API credentials, or Apple ID credentials.'
  );
}

function isRelease(env = process.env) {
  return env.GURUTIME_RELEASE_MODE === 'release';
}

async function verifySignedApp(appPath, env = process.env) {
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { env });
  const details = await run('codesign', ['-d', '--verbose=4', appPath], {
    env,
    capture: true,
    quiet: true
  });
  const output = `${details.stdout}\n${details.stderr}`;
  if (!/Runtime Version|flags=.*runtime/i.test(output)) {
    throw new Error('Signed app does not advertise hardened runtime');
  }
  if (!/Authority=Developer ID Application:/i.test(output)) {
    throw new Error('App is not signed with a Developer ID Application identity');
  }
}

async function submitAndWait(artifactPath, env = process.env) {
  const auth = await notaryAuthArgs(env);
  await run(
    'xcrun',
    ['notarytool', 'submit', artifactPath, '--wait', '--output-format', 'json', ...auth],
    { env, display: `xcrun notarytool submit ${path.basename(artifactPath)} --wait [credentials redacted]` }
  );
}

async function stapleAndValidate(artifactPath, env = process.env) {
  await run('xcrun', ['stapler', 'staple', artifactPath], { env });
  await run('xcrun', ['stapler', 'validate', artifactPath], { env });
}

async function notarizeApp(appPath, env = process.env) {
  await verifySignedApp(appPath, env);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gurutime-notary-'));
  const archive = path.join(tempDir, `${path.basename(appPath, '.app')}.zip`);
  try {
    await run('ditto', ['-c', '-k', '--keepParent', appPath, archive], { env });
    await submitAndWait(archive, env);
    await stapleAndValidate(appPath, env);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function notarizeDiskImage(dmgPath, env = process.env) {
  await submitAndWait(dmgPath, env);
  await stapleAndValidate(dmgPath, env);
}

module.exports = {
  isRelease,
  notarizeApp,
  notarizeDiskImage,
  notaryAuthArgs,
  run,
  stapleAndValidate,
  verifySignedApp
};
