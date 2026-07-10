#!/usr/bin/env node

import process from 'node:process';
import WebSocket from 'ws';

const origin = String(process.env.GURUTIME_LOAD_ORIGIN || '').replace(/\/$/u, '');
const installations = Math.max(1, Math.min(1000, Number(process.env.GURUTIME_LOAD_INSTALLATIONS) || 250));
const concurrency = Math.max(1, Math.min(100, Number(process.env.GURUTIME_LOAD_CONCURRENCY) || 25));
const holdMs = Math.max(1000, Number(process.env.GURUTIME_LOAD_HOLD_MS) || 65000);

if (process.env.GURUTIME_LOAD_ALLOW !== '1') {
  throw new Error('Set GURUTIME_LOAD_ALLOW=1 to confirm the staging load test.');
}
if (!/^https:\/\//u.test(origin) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u.test(origin)) {
  throw new Error('GURUTIME_LOAD_ORIGIN must be staging HTTPS or local Wrangler.');
}

async function json(pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}: ${body.message || body.error || 'unknown'}`);
  return body;
}

async function openInstallation(index) {
  const startedAt = performance.now();
  const enrollment = await json('/api/v1/installations/enroll', { method: 'POST', body: '{}' });
  const headers = {
    'x-gurutime-installation': enrollment.installationId,
    authorization: `GuruTimeDevice ${enrollment.deviceSecret}`,
  };
  const ticket = await json('/api/v1/controller/ticket', { method: 'POST', headers, body: '{}' });
  const socketOrigin = origin.replace(/^https:/u, 'wss:').replace(/^http:/u, 'ws:');
  const socket = new WebSocket(
    `${socketOrigin}/api/v1/controller/socket/${enrollment.installationId}`,
    ['gurutime.v1', `ticket.${ticket.ticket}`],
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`socket ${index} timed out`)), 10000);
    socket.once('open', () => { clearTimeout(timeout); resolve(); });
    socket.once('error', reject);
  });
  return { socket, connectMs: performance.now() - startedAt };
}

const opened = [];
let cursor = 0;
async function worker() {
  while (cursor < installations) {
    const index = cursor;
    cursor += 1;
    opened.push(await openInstallation(index));
  }
}

try {
  await Promise.all(Array.from({ length: Math.min(concurrency, installations) }, worker));
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  const latencies = opened.map((entry) => entry.connectMs).sort((a, b) => a - b);
  const p99 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.99) - 1)];
  const alive = opened.filter((entry) => entry.socket.readyState === WebSocket.OPEN).length;
  process.stdout.write(JSON.stringify({ installations, alive, connectP99Ms: Math.round(p99), holdMs }, null, 2) + '\n');
  if (alive !== installations) throw new Error(`${installations - alive} sockets closed during the hibernation hold.`);
} finally {
  await Promise.all(opened.map(({ socket }) => new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.once('close', resolve);
    socket.close(1000, 'load test complete');
    setTimeout(resolve, 1000);
  })));
}
