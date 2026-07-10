'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIRECTORY_MODE = 0o700;

function makeTemporaryPath(filePath, suffix = 'tmp') {
  const nonce = crypto.randomBytes(6).toString('hex');
  return `${filePath}.${suffix}-${process.pid}-${Date.now()}-${nonce}`;
}

async function exists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await fs.promises.open(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    // Some filesystems do not support fsync on directory handles. The file
    // itself has already been synced, so only ignore those platform errors.
    if (!error || !['EINVAL', 'EPERM', 'EISDIR', 'EBADF', 'ENOTSUP'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function writeAndSync(filePath, contents, mode) {
  const handle = await fs.promises.open(filePath, 'wx', mode);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.chmod(filePath, mode);
}

async function parseJsonFile(filePath, validate) {
  const text = await fs.promises.readFile(filePath, 'utf8');
  if (!text.trim()) throw new SyntaxError(`JSON file is empty: ${filePath}`);
  const value = JSON.parse(text);
  if (validate && !validate(value)) {
    throw new TypeError(`JSON file did not pass validation: ${filePath}`);
  }
  return value;
}

/**
 * Reads an atomic JSON file, falling back to its last verified backup.
 *
 * @returns {Promise<{value: *, source: 'primary'|'backup'|'fallback', recovered: boolean, error: Error|null}>}
 */
async function readJsonWithBackup(filePath, options = {}) {
  const { fallback = null, validate } = options;
  let primaryError = null;

  try {
    const value = await parseJsonFile(filePath, validate);
    return { value, source: 'primary', recovered: false, error: null };
  } catch (error) {
    if (!error || error.code !== 'ENOENT') primaryError = error;
  }

  const backupPath = `${filePath}.bak`;
  try {
    const value = await parseJsonFile(backupPath, validate);
    return { value, source: 'backup', recovered: true, error: primaryError };
  } catch (backupError) {
    const missingPrimary = !primaryError && backupError && backupError.code === 'ENOENT';
    return {
      value: typeof fallback === 'function' ? fallback() : fallback,
      source: 'fallback',
      recovered: false,
      error: missingPrimary ? null : (primaryError || backupError),
    };
  }
}

/**
 * Durably writes JSON through a same-directory temporary file and keeps the
 * previous parseable primary at `${filePath}.bak`.
 */
async function atomicWriteJson(filePath, value, options = {}) {
  const mode = options.mode == null ? DEFAULT_FILE_MODE : options.mode;
  const directoryMode = options.directoryMode == null
    ? DEFAULT_DIRECTORY_MODE
    : options.directoryMode;
  const directoryPath = path.dirname(filePath);
  const primaryTempPath = makeTemporaryPath(filePath);
  const backupPath = `${filePath}.bak`;
  const backupTempPath = makeTemporaryPath(backupPath);
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== 'string') {
    throw new TypeError('Atomic JSON value must be serializable');
  }
  const json = `${serialized}\n`;

  await fs.promises.mkdir(directoryPath, { recursive: true, mode: directoryMode });

  try {
    await writeAndSync(primaryTempPath, json, mode);

    // Never replace a good backup with a corrupt primary. Parsing before the
    // copy also means recovery remains possible after an interrupted repair.
    if (await exists(filePath)) {
      try {
        const current = await fs.promises.readFile(filePath, 'utf8');
        JSON.parse(current);
        await writeAndSync(backupTempPath, current, mode);
        await fs.promises.rename(backupTempPath, backupPath);
      } catch (error) {
        if (await exists(backupTempPath)) {
          await fs.promises.unlink(backupTempPath).catch(() => {});
        }
        if (error && !['SyntaxError'].includes(error.name)) throw error;
      }
    }

    await fs.promises.rename(primaryTempPath, filePath);
    await fs.promises.chmod(filePath, mode);
    if (await exists(backupPath)) await fs.promises.chmod(backupPath, mode);
    await syncDirectory(directoryPath);
  } finally {
    await fs.promises.unlink(primaryTempPath).catch(() => {});
    await fs.promises.unlink(backupTempPath).catch(() => {});
  }
}

class AtomicJsonStore {
  constructor(filePath, options = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('AtomicJsonStore requires a file path');
    }
    this.filePath = filePath;
    this.options = { ...options };
  }

  read(options = {}) {
    return readJsonWithBackup(this.filePath, { ...this.options, ...options });
  }

  write(value, options = {}) {
    return atomicWriteJson(this.filePath, value, { ...this.options, ...options });
  }
}

module.exports = {
  AtomicJsonStore,
  atomicWriteJson,
  readJsonWithBackup,
  DEFAULT_FILE_MODE,
  DEFAULT_DIRECTORY_MODE,
};
