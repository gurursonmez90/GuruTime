#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_NAME = 'GuruTime';
const SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'GuruTime');
const COMMAND_DIR = path.join(SUPPORT_DIR, 'hermes-commands');
const DEFAULT_TIMEOUT_MS = 10000;

function usage(exitCode = 0) {
  const out = `GuruTime CLI — Hermes köprüsü

Kullanım:
  gurutime note "metin" [--category today|important|later] [--json]
  gurutime alarm "metin" --in 20m [--category today|important|later] [--json]
  gurutime alarm "metin" --minutes 20 [--category today|important|later] [--json]
  gurutime alarm "metin" --at 18:30 [--category today|important|later] [--json]
  gurutime list [--json]
  gurutime delete-note <todo-id> [--json]
  gurutime cancel-alarm <alarm-id> [--json]

Süre örnekleri:
  15, 15m, 1h, 1h30m, 2d, 45s

Kategori varsayılanı: today
`;
  (exitCode ? console.error : console.log)(out.trimEnd());
  process.exit(exitCode);
}

function fail(message, exitCode = 1) {
  console.error(`Hata: ${message}`);
  process.exit(exitCode);
}

function makeId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseArgs(argv) {
  const command = argv[2];
  const flags = { json: false, category: 'today' };
  const positional = [];

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--json') { flags.json = true; continue; }

    if (arg.startsWith('--')) {
      const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s).filter((part) => part !== undefined);
      const key = rawKey;
      let value = inlineValue;
      if (value === undefined || value === '') {
        if (i + 1 >= argv.length) fail(`--${key} değeri eksik`);
        value = argv[++i];
      }
      flags[key] = value;
      continue;
    }

    positional.push(arg);
  }

  return { command, flags, positional };
}

function normalizeCategory(category) {
  const key = String(category || 'today').trim().toLowerCase();
  return ['today', 'important', 'later'].includes(key) ? key : 'today';
}

function parseDuration(input) {
  if (input === undefined || input === null || input === '') return null;
  const text = String(input).trim().toLowerCase().replace(',', '.');

  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);

  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(d|day|days|g|gün|h|hr|hour|hours|sa|saat|m|min|minute|minutes|dk|dakika|s|sec|second|seconds|sn|saniye)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2];
    if (['d', 'day', 'days', 'g', 'gün'].includes(unit)) total += n * 1440;
    else if (['h', 'hr', 'hour', 'hours', 'sa', 'saat'].includes(unit)) total += n * 60;
    else if (['m', 'min', 'minute', 'minutes', 'dk', 'dakika'].includes(unit)) total += n;
    else if (['s', 'sec', 'second', 'seconds', 'sn', 'saniye'].includes(unit)) total += n / 60;
  }

  return matched ? total : null;
}

function parseClockTime(input) {
  const text = String(input || '').trim();
  const clock = text.match(/^(\d{1,2})(?::|\.)(\d{2})$/);
  if (!clock) return null;

  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target;
}

function minutesUntilAt(input) {
  const clock = parseClockTime(input);
  let target = clock;
  if (!target) {
    const ms = Date.parse(String(input));
    if (Number.isFinite(ms)) target = new Date(ms);
  }
  if (!target) return null;

  const diff = (target.getTime() - Date.now()) / 60000;
  return diff > 0 ? diff : null;
}

function openGuruTime(commandPath) {
  // -n is intentional: if GuruTime is already running, macOS otherwise only
  // activates the existing LSUIElement app and may drop --args. A short-lived
  // second Electron instance triggers app.on('second-instance') and exits via
  // the single-instance lock after delivering the command argv.
  const args = ['-n', '-gj', '-a', APP_NAME, '--args', '--gurutime-command-file', commandPath];
  let res = spawnSync('/usr/bin/open', args, { encoding: 'utf8' });
  if (res.status === 0) return;

  const appPath = '/Applications/GuruTime.app';
  if (fs.existsSync(appPath)) {
    res = spawnSync('/usr/bin/open', ['-n', '-gj', appPath, '--args', '--gurutime-command-file', commandPath], { encoding: 'utf8' });
  }

  if (res.status !== 0) {
    const stderr = String(res.stderr || res.stdout || '').trim();
    fail(`GuruTime açılamadı${stderr ? `: ${stderr}` : ''}`);
  }
}

function invokeGuruTime(payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  fs.mkdirSync(COMMAND_DIR, { recursive: true });

  const id = payload.id || makeId();
  const commandPath = path.join(COMMAND_DIR, `${id}.command.json`);
  const replyPath = path.join(COMMAND_DIR, `${id}.reply.json`);
  const command = { id, replyPath, ...payload };

  fs.writeFileSync(commandPath, JSON.stringify(command, null, 2));
  openGuruTime(commandPath);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(replyPath)) {
      const reply = JSON.parse(fs.readFileSync(replyPath, 'utf8'));
      try { fs.unlinkSync(commandPath); } catch (_) {}
      try { fs.unlinkSync(replyPath); } catch (_) {}
      if (!reply.ok) fail(reply.error || 'GuruTime komutu başarısız');
      return reply;
    }
    sleep(100);
  }

  fail('GuruTime cevap vermedi. App kapalıysa açılmasını bekleyip tekrar dene. Bu köprü 10 saniye bekledi, sonra bıraktı.');
}

function formatFireAt(ms) {
  if (!ms) return '';
  return new Date(Number(ms)).toLocaleString('tr-TR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function printReply(reply, json) {
  if (json) {
    console.log(JSON.stringify(reply, null, 2));
    return;
  }

  if (reply.action === 'add-note') {
    console.log(`✅ GuruTime not eklendi: ${reply.todo.title} [${reply.todo.category}] (${reply.todo.id})`);
    return;
  }

  if (reply.action === 'add-alarm') {
    const when = formatFireAt(reply.alarm.fireAt);
    const mins = Math.round(Number(reply.alarm.minutes) * 100) / 100;
    console.log(`✅ GuruTime alarm kuruldu: ${reply.todo.title} — ${mins} dk sonra${when ? ` (${when})` : ''} (${reply.alarm.id})`);
    return;
  }

  if (reply.action === 'list') {
    const openTodos = reply.todos.filter((todo) => !todo.isArchived && !todo.isDone);
    console.log(`GuruTime: ${openTodos.length} açık not/görev, ${reply.alarms.length} aktif alarm`);
    openTodos.forEach((todo) => console.log(`- [${todo.category}] ${todo.title} (${todo.id})`));
    if (reply.alarms.length) {
      console.log('\nAlarmlar:');
      reply.alarms.forEach((alarm) => console.log(`- ${alarm.taskTitle} → ${formatFireAt(alarm.fireAt)} (${alarm.id})`));
    }
    return;
  }

  if (reply.action === 'delete-note') {
    console.log(`🗑️ GuruTime not silindi: ${reply.todo.title} (${reply.todo.id})`);
    return;
  }

  if (reply.action === 'cancel-alarm') {
    console.log(`🔕 GuruTime alarm iptal edildi: ${reply.alarm.taskTitle} (${reply.alarm.id})`);
    return;
  }

  console.log(JSON.stringify(reply, null, 2));
}

function main() {
  const { command, flags, positional } = parseArgs(process.argv);
  if (!command || command === '--help' || command === '-h') usage(0);

  const json = Boolean(flags.json);
  const category = normalizeCategory(flags.category);

  if (command === 'note' || command === 'add-note' || command === 'todo') {
    const title = positional.join(' ').trim();
    if (!title) usage(1);
    printReply(invokeGuruTime({ action: 'add-note', title, category }), json);
    return;
  }

  if (command === 'alarm' || command === 'remind') {
    const title = positional.join(' ').trim();
    if (!title) usage(1);

    const minutes = flags.minutes !== undefined
      ? parseDuration(flags.minutes)
      : flags.in !== undefined
        ? parseDuration(flags.in)
        : flags.at !== undefined
          ? minutesUntilAt(flags.at)
          : null;

    if (!Number.isFinite(minutes) || minutes <= 0) fail('Alarm için --in, --minutes veya --at vermen lazım. Örn: --in 20m / --at 18:30');

    printReply(invokeGuruTime({ action: 'add-alarm', title, category, minutes }), json);
    return;
  }

  if (command === 'list') {
    printReply(invokeGuruTime({ action: 'list' }), json);
    return;
  }

  if (command === 'delete-note' || command === 'delete-todo') {
    const id = positional[0];
    if (!id) usage(1);
    printReply(invokeGuruTime({ action: 'delete-note', taskId: id }), json);
    return;
  }

  if (command === 'cancel-alarm') {
    const id = positional[0];
    if (!id) usage(1);
    printReply(invokeGuruTime({ action: 'cancel-alarm', alarmId: id }), json);
    return;
  }

  usage(1);
}

main();
