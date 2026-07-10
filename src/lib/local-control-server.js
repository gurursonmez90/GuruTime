const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');

const MAX_BODY_BYTES = 4096;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_COMMANDS_PER_MINUTE = 20;

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function timingSafeEqualString(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function localAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

function securityHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, securityHeaders());
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (_) {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

class LocalControlServer {
  constructor({ port = 47831, mobileFile, getSnapshot, executeCommand, now = () => Date.now() } = {}) {
    this.port = Number(port) || 47831;
    this.mobileFile = mobileFile;
    this.getSnapshot = typeof getSnapshot === 'function' ? getSnapshot : async () => ({});
    this.executeCommand = typeof executeCommand === 'function' ? executeCommand : async () => ({ ok: false });
    this.now = now;
    this.server = null;
    this.actualPort = 0;
    this.invites = new Map();
    this.sessions = new Map();
    this.pairingFailures = new Map();
  }

  async start() {
    if (this.server) return this.getInfo();
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'Internal error' });
        else response.end();
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.actualPort = this.server.address().port;
    return this.getInfo();
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.actualPort = 0;
    this.invites.clear();
    this.sessions.clear();
    await new Promise((resolve) => server.close(resolve));
  }

  getInfo() {
    const port = this.actualPort;
    const urls = port ? localAddresses().map((address) => `http://${address}:${port}/mobile`) : [];
    return { enabled: Boolean(this.server), port, urls, primaryUrl: urls[0] || '' };
  }

  createInvite() {
    if (!this.server) throw new Error('Yerel ağ sunucusu kapalı.');
    this.prune();
    const secret = randomToken(32);
    const id = randomToken(12);
    this.invites.set(id, { secretHash: digest(secret), expiresAt: this.now() + PAIRING_TTL_MS });
    const base = this.getInfo().primaryUrl;
    if (!base) throw new Error('Yerel ağ adresi bulunamadı.');
    return {
      inviteUrl: `${base}#pair=${encodeURIComponent(`${id}.${secret}`)}`,
      expiresAt: this.now() + PAIRING_TTL_MS,
    };
  }

  revokeSession(id) {
    const wanted = String(id || '');
    for (const [tokenHash, session] of this.sessions) {
      if (session.id === wanted) return this.sessions.delete(tokenHash);
    }
    return false;
  }

  listSessions() {
    this.prune();
    return [...this.sessions.values()].map(({ id, createdAt, lastSeenAt }) => ({ id, name: 'Yerel telefon', createdAt, lastSeenAt }));
  }

  prune() {
    const now = this.now();
    for (const [id, invite] of this.invites) if (invite.expiresAt <= now) this.invites.delete(id);
    for (const [hash, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(hash);
    for (const [ip, record] of this.pairingFailures) if (record.lockedUntil <= now && now - record.windowAt > 15 * 60 * 1000) this.pairingFailures.delete(ip);
  }

  validateOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;
    const expected = `http://${request.headers.host}`;
    return timingSafeEqualString(origin, expected);
  }

  authenticate(request) {
    this.prune();
    const match = String(request.headers.authorization || '').match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
    if (!match) return null;
    const session = this.sessions.get(digest(match[1]));
    if (!session || session.expiresAt <= this.now()) return null;
    session.lastSeenAt = this.now();
    return session;
  }

  checkRate(session) {
    const now = this.now();
    if (now - session.rateWindowAt >= RATE_WINDOW_MS) {
      session.rateWindowAt = now;
      session.rateCount = 0;
    }
    session.rateCount += 1;
    return session.rateCount <= MAX_COMMANDS_PER_MINUTE;
  }

  async handle(request, response) {
    this.prune();
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (!this.validateOrigin(request)) return sendJson(response, 403, { error: 'Origin rejected' });

    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(302, { ...securityHeaders('text/plain; charset=utf-8'), Location: '/mobile' });
      response.end('GuruTime');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/mobile') {
      const html = fs.readFileSync(this.mobileFile, 'utf8');
      response.writeHead(200, {
        ...securityHeaders('text/html; charset=utf-8'),
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      });
      response.end(html);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/mobile-control.js') {
      const scriptPath = this.mobileFile.replace(/\.html$/, '.js');
      const script = fs.readFileSync(scriptPath, 'utf8');
      response.writeHead(200, securityHeaders('text/javascript; charset=utf-8'));
      response.end(script);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { ok: true });
    if (request.method === 'OPTIONS') {
      response.writeHead(405, securityHeaders());
      response.end();
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/session') {
      const ip = request.socket.remoteAddress || 'unknown';
      const failures = this.pairingFailures.get(ip);
      if (failures?.lockedUntil > this.now()) return sendJson(response, 429, { error: 'Eşleştirme geçici olarak kilitli.' });
      const body = await readJson(request);
      const [id, secret] = String(body.pairingCode || '').split('.');
      const invite = this.invites.get(id);
      if (!invite || invite.expiresAt <= this.now() || !timingSafeEqualString(invite.secretHash, digest(secret))) {
        const now = this.now();
        const record = failures && now - failures.windowAt < 15 * 60 * 1000 ? failures : { count: 0, windowAt: now, lockedUntil: 0 };
        record.count += 1;
        if (record.count >= 5) record.lockedUntil = now + 15 * 60 * 1000;
        this.pairingFailures.set(ip, record);
        return sendJson(response, 401, { error: 'Eşleştirme kodu geçersiz.' });
      }
      this.invites.delete(id);
      this.pairingFailures.delete(ip);
      const token = randomToken(32);
      const sessionId = randomToken(12);
      const now = this.now();
      this.sessions.set(digest(token), {
        id: sessionId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + SESSION_TTL_MS,
        rateWindowAt: now,
        rateCount: 0,
      });
      return sendJson(response, 201, { token, sessionId, expiresAt: now + SESSION_TTL_MS });
    }

    const session = this.authenticate(request);
    if (!session) return sendJson(response, 401, { error: 'Oturum gerekli.' });

    if (request.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(response, 200, await this.getSnapshot());
    }

    if (request.method === 'POST' && url.pathname === '/api/commands') {
      if (!this.checkRate(session)) return sendJson(response, 429, { error: 'Dakikalık komut sınırı aşıldı.' });
      const body = await readJson(request);
      const result = await this.executeCommand(body, { source: 'local', sessionId: session.id });
      return sendJson(response, 200, result || { ok: true });
    }

    return sendJson(response, 404, { error: 'Not found' });
  }
}

module.exports = {
  LocalControlServer,
  MAX_BODY_BYTES,
  MAX_COMMANDS_PER_MINUTE,
  PAIRING_TTL_MS,
  digest,
  timingSafeEqualString,
};
