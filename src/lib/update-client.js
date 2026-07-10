'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_MANIFEST_BYTES = 128 * 1024;

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function normalizeDownloadsOrigin(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Güncelleme origin’i temiz bir HTTPS adresi olmalı.');
  }
  if (/(?:^|\.)(?:r2\.dev|workers\.dev)$/i.test(url.hostname)) {
    throw new Error('Güncellemeler production özel alan adını kullanmalı.');
  }
  url.pathname = '';
  return url.toString().replace(/\/$/, '');
}

function publicKeyId(publicKey) {
  const key = publicKey && publicKey.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Güncelleme anahtarı Ed25519 olmalı.');
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function verifySignedEnvelope(envelope, publicKey) {
  if (!envelope || envelope.schemaVersion !== 1 || !envelope.payload || !envelope.signature) {
    throw new Error('İmzalı güncelleme zarfı geçersiz.');
  }
  if (envelope.signature.algorithm !== 'Ed25519') throw new Error('Güncelleme imza algoritması geçersiz.');
  const expectedKeyId = publicKeyId(publicKey);
  if (envelope.signature.keyId !== expectedKeyId) throw new Error('Güncelleme anahtar kimliği eşleşmiyor.');
  const signature = Buffer.from(String(envelope.signature.value || ''), 'base64');
  const verified = crypto.verify(
    null,
    Buffer.from(canonicalJson(envelope.payload), 'utf8'),
    publicKey && publicKey.type === 'public' ? publicKey : crypto.createPublicKey(publicKey),
    signature,
  );
  if (!verified) throw new Error('Güncelleme imzası doğrulanamadı.');
  return envelope.payload;
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) throw new Error('Sürüm numarası geçersiz.');
    return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || '' };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

async function responseBytes(response, limit = MAX_MANIFEST_BYTES) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error('Güncelleme manifesti çok büyük.');
  return bytes;
}

class SignedUpdateClient {
  constructor({ origin, channel = 'stable', currentVersion, publicKeyPath, fetchImpl = globalThis.fetch } = {}) {
    this.origin = normalizeDownloadsOrigin(origin);
    this.channel = channel === 'beta' ? 'beta' : 'stable';
    this.currentVersion = currentVersion;
    this.publicKeyPath = publicKeyPath;
    this.fetch = fetchImpl;
  }

  readPublicKey() {
    const key = fs.readFileSync(this.publicKeyPath);
    publicKeyId(key);
    return key;
  }

  async fetchTrusted(url, maxBytes) {
    const expected = new URL(url);
    if (expected.origin !== this.origin) throw new Error('Güncelleme URL’si güvenilen origin dışında.');
    const response = await this.fetch(expected, { cache: 'no-store', redirect: 'follow' });
    if (!response.ok) throw new Error(`Güncelleme sunucusu HTTP ${response.status} döndürdü.`);
    const finalUrl = new URL(response.url || expected);
    if (finalUrl.origin !== this.origin) throw new Error('Güncelleme yönlendirmesi güvenilen origin dışında.');
    return responseBytes(response, maxBytes);
  }

  async check() {
    const publicKey = this.readPublicKey();
    const latestBytes = await this.fetchTrusted(`${this.origin}/releases/${this.channel}/latest.json`, MAX_MANIFEST_BYTES);
    const latestEnvelope = JSON.parse(latestBytes.toString('utf8'));
    const latest = verifySignedEnvelope(latestEnvelope, publicKey);
    if (latest.channel !== this.channel) throw new Error('Güncelleme kanalı eşleşmiyor.');
    if (compareVersions(latest.version, this.currentVersion) <= 0) return { available: false, version: latest.version };

    const manifestBytes = await this.fetchTrusted(latest.manifestUrl, MAX_MANIFEST_BYTES);
    const manifestHash = crypto.createHash('sha256').update(manifestBytes).digest('hex');
    if (manifestHash !== latest.manifestSha256) throw new Error('Güncelleme manifest özeti eşleşmiyor.');
    const manifestEnvelope = JSON.parse(manifestBytes.toString('utf8'));
    const manifest = verifySignedEnvelope(manifestEnvelope, publicKey);
    if (manifest.channel !== this.channel || manifest.version !== latest.version) {
      throw new Error('Güncelleme manifest koordinatları eşleşmiyor.');
    }
    const artifact = Array.isArray(manifest.artifacts) ? manifest.artifacts[0] : null;
    if (!artifact || artifact.arch !== 'universal' || artifact.contentType !== 'application/x-apple-diskimage') {
      throw new Error('Universal DMG artefact kaydı bulunamadı.');
    }
    if (new URL(artifact.url).origin !== this.origin) throw new Error('DMG URL’si güvenilen origin dışında.');
    return { available: true, version: manifest.version, artifact, manifest };
  }

  async download(artifact, destinationDirectory) {
    fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
    const response = await this.fetch(artifact.url, { cache: 'no-store', redirect: 'follow' });
    if (!response.ok || new URL(response.url || artifact.url).origin !== this.origin) {
      throw new Error('Güncelleme DMG dosyası güvenli biçimde indirilemedi.');
    }
    const filename = path.basename(new URL(artifact.url).pathname);
    if (!filename.endsWith('-universal.dmg')) throw new Error('Güncelleme dosya adı geçersiz.');
    const destination = path.join(destinationDirectory, filename);
    const temporary = `${destination}.part`;
    const output = fs.createWriteStream(temporary, { mode: 0o600 });
    const sha256 = crypto.createHash('sha256');
    const sha512 = crypto.createHash('sha512');
    let size = 0;
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > Number(artifact.size)) throw new Error('İndirilen güncelleme beklenenden büyük.');
        sha256.update(buffer);
        sha512.update(buffer);
        if (!output.write(buffer)) await new Promise((resolve) => output.once('drain', resolve));
      }
      await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
      if (size !== Number(artifact.size)
        || sha256.digest('hex') !== artifact.sha256
        || sha512.digest('base64') !== artifact.sha512) {
        throw new Error('İndirilen güncellemenin özeti eşleşmiyor.');
      }
      fs.renameSync(temporary, destination);
      return destination;
    } catch (error) {
      output.destroy();
      try { fs.unlinkSync(temporary); } catch (_) {}
      throw error;
    }
  }
}

module.exports = {
  SignedUpdateClient,
  canonicalJson,
  compareVersions,
  normalizeDownloadsOrigin,
  publicKeyId,
  verifySignedEnvelope,
};
