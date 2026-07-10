'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  AppStateV2,
  HISTORY_MAX_RECORDS,
  migrateLegacyState,
  normalizeV2State,
  validateMinutes,
  freezeFireAt,
} = require('../../src/lib/app-state-v2');

async function makeTempDir(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gurutime-state-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('migrates legacy arrays and applies the 15-minute overdue policy', async (t) => {
  const directory = await makeTempDir(t);
  const now = Date.parse('2026-07-10T12:00:00.000Z');
  const todosPath = path.join(directory, 'todos.json');
  const alarmsPath = path.join(directory, 'alarms.json');
  const statePath = path.join(directory, 'app-state-v2.json');
  const todos = [
    { id: 'todo-1', title: ' Sunum hazırla ', category: 'important', createdAt: now - 60_000 },
    { id: 'todo-2', title: 'Arama yap', category: 'unknown' },
  ];
  const alarms = [
    { id: 'future', taskId: 'todo-1', taskTitle: 'Sunum hazırla', minutes: 30, fireAt: now + 30 * 60_000 },
    { id: 'late', taskId: 'todo-1', minutes: 10, fireAt: now - 10 * 60_000 },
    { id: 'missed', taskId: 'todo-2', minutes: 20, fireAt: now - 16 * 60_000 },
    { id: 'invalid', minutes: 0, fireAt: now + 1_000 },
  ];
  await fs.promises.writeFile(todosPath, JSON.stringify({ todos }));
  await fs.promises.writeFile(alarmsPath, JSON.stringify(alarms));

  const store = await AppStateV2.open({ statePath, filePath: statePath, legacyTodosPath: todosPath, legacyAlarmsPath: alarmsPath, now: () => now });
  const state = store.getState();

  assert.equal(state.version, 2);
  assert.deepEqual(state.todos.map((todo) => todo.title), ['Sunum hazırla', 'Arama yap']);
  assert.equal(state.todos[1].category, 'today');
  assert.equal(state.activeAlarms.length, 2);
  assert.equal(state.activeAlarms.find((alarm) => alarm.id === 'future').status, 'scheduled');
  assert.equal(state.activeAlarms.find((alarm) => alarm.id === 'late').status, 'ringing');
  assert.equal(state.activeAlarms.find((alarm) => alarm.id === 'late').lateByMs, 10 * 60_000);
  assert.equal(state.alarmHistory.length, 1);
  assert.equal(state.alarmHistory[0].status, 'missed');
  assert.equal(state.alarmHistory[0].id, 'missed');

  const persisted = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
  assert.equal(persisted.version, 2);
  assert.equal((await fs.promises.stat(statePath)).mode & 0o777, 0o600);
});

test('pure legacy migration accepts wrapped arrays', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const migrated = migrateLegacyState({
    todos: { todos: [{ id: 'one', title: 'Bir' }] },
    alarms: { alarms: [{ id: 'alarm', taskId: 'one', minutes: 1, fireAt: now + 60_000 }] },
  }, { now });
  assert.equal(migrated.todos.length, 1);
  assert.equal(migrated.activeAlarms.length, 1);
  assert.equal(migrated.activeAlarms[0].occurrence, 1);
});

test('serializes concurrent mutations without losing updates and recovers after rejection', async (t) => {
  const directory = await makeTempDir(t);
  const now = Date.parse('2026-07-10T12:00:00Z');
  let sequence = 0;
  const store = await AppStateV2.open({
    filePath: path.join(directory, 'state.json'),
    legacyTodos: [],
    legacyAlarms: [],
    now: () => now,
    idFactory: () => `generated-${++sequence}`,
  });

  await assert.rejects(store.addTodo({ title: '   ' }), { code: 'INVALID_TODO_TITLE' });
  await Promise.all(Array.from({ length: 25 }, (_, index) => (
    store.addTodo({ title: `Görev ${index}` })
  )));

  const state = store.getState();
  assert.equal(state.todos.length, 25);
  assert.equal(new Set(state.todos.map((todo) => todo.id)).size, 25);
  assert.equal(state.revision, 25);
});

test('todo edits propagate titles and deletion cleans up every linked active alarm', async (t) => {
  const directory = await makeTempDir(t);
  const now = Date.parse('2026-07-10T12:00:00Z');
  const store = await AppStateV2.open({
    filePath: path.join(directory, 'state.json'),
    legacyTodos: [],
    legacyAlarms: [],
    now: () => now,
  });
  const todo = (await store.addTodo({ id: 'todo', title: 'Eski başlık' })).result.todo;
  await store.addAlarm({ id: 'one', taskId: todo.id, minutes: 5 });
  await store.addAlarm({ id: 'two', taskId: todo.id, minutes: 10 });
  await store.updateTodo(todo.id, { title: 'Yeni başlık', isArchived: true });
  assert.deepEqual(store.getState().activeAlarms.map((alarm) => alarm.taskTitle), ['Yeni başlık', 'Yeni başlık']);

  const deletion = await store.deleteTodo(todo.id);
  assert.deepEqual(deletion.result.removedAlarmIds, ['one', 'two']);
  assert.equal(deletion.state.todos.length, 0);
  assert.equal(deletion.state.activeAlarms.length, 0);
  assert.equal(deletion.state.alarmHistory.length, 0);
});

test('adds a rope-confirm todo and alarm in one write and never leaves a partial todo', async () => {
  let now = Date.parse('2026-07-10T12:00:00Z');
  let persisted = null;
  let writes = 0;
  let failWrites = false;
  const memoryStore = {
    async read() {
      return persisted
        ? { value: JSON.parse(JSON.stringify(persisted)), source: 'primary', recovered: false, error: null }
        : { value: null, source: 'fallback', recovered: false, error: null };
    },
    async write(value) {
      if (failWrites) throw new Error('simulated crash during persistence');
      persisted = JSON.parse(JSON.stringify(value));
      writes += 1;
    },
  };
  const store = await AppStateV2.open({
    filePath: '/memory/app-state-v2.json',
    store: memoryStore,
    legacyTodos: [],
    legacyAlarms: [],
    now: () => now,
  });
  writes = 0;

  const committed = await store.addTodoWithAlarm({
    todoId: 'rope-todo',
    alarmId: 'rope-alarm',
    title: 'Sunumu tamamla',
    category: 'important',
    source: 'rope',
    minutes: 30,
    fireAt: now + 30 * 60_000,
  });
  assert.deepEqual(Object.keys(committed.result).sort(), ['alarm', 'todo']);
  assert.equal(committed.result.alarm.taskId, committed.result.todo.id);
  assert.equal(committed.result.todo.source, 'rope');
  assert.equal(writes, 1);
  assert.equal(persisted.todos.length, 1);
  assert.equal(persisted.activeAlarms.length, 1);

  const beforeCrash = store.getState();
  failWrites = true;
  await assert.rejects(
    store.addTodoWithAlarm({
      title: 'Yarım kalmamalı',
      minutes: 5,
      fireAt: now + 5 * 60_000,
    }),
    /simulated crash/,
  );
  assert.deepEqual(store.getState(), beforeCrash);
  assert.deepEqual(persisted, beforeCrash);

  failWrites = false;
  now += 31 * 60_000;
  await assert.rejects(
    store.addTodoWithAlarm({
      title: 'Hedefi geçmiş',
      minutes: 30,
      fireAt: Date.parse('2026-07-10T12:30:00Z'),
    }),
    { code: 'ALARM_TARGET_EXPIRED' },
  );
  assert.deepEqual(store.getState(), beforeCrash);
  assert.equal(writes, 1);
});

test('alarm lifecycle preserves id, increments occurrence, and ignores stale actions', async (t) => {
  const directory = await makeTempDir(t);
  let now = Date.parse('2026-07-10T12:00:00Z');
  const store = await AppStateV2.open({
    filePath: path.join(directory, 'state.json'),
    legacyTodos: [],
    legacyAlarms: [],
    now: () => now,
  });
  await store.addTodo({ id: 'todo', title: 'Raporu bitir' });
  const added = await store.addAlarm({ id: 'alarm', taskId: 'todo', minutes: 1 });
  assert.equal(added.result.alarm.status, 'scheduled');
  assert.equal(added.result.alarm.occurrence, 1);

  now += 60_000;
  assert.equal((await store.ringAlarm('alarm', 1)).result.status, 'ringing');
  const snoozed = await store.snoozeAlarm('alarm', 1, 10);
  assert.equal(snoozed.result.alarm.id, 'alarm');
  assert.equal(snoozed.result.alarm.occurrence, 2);
  assert.equal(snoozed.result.alarm.snoozeCount, 1);

  const stale = await store.dismissAlarm('alarm', 1);
  assert.equal(stale.result.stale, true);
  assert.equal(stale.result.currentOccurrence, 2);
  assert.equal(stale.state.activeAlarms.length, 1);

  now += 10 * 60_000;
  await store.ringAlarm('alarm', 2);
  const completed = await store.completeAlarm('alarm', 2);
  assert.equal(completed.result.status, 'completed');
  assert.equal(completed.state.todos[0].isDone, true);
  assert.equal(completed.state.activeAlarms.length, 0);
  assert.equal(completed.state.alarmHistory[0].status, 'completed');

  const duplicate = await store.completeAlarm('alarm', 2);
  assert.equal(duplicate.result.duplicate, true);
  assert.equal(duplicate.state.alarmHistory.length, 1);
});

test('cancels only scheduled alarms without adding a history record', async (t) => {
  const directory = await makeTempDir(t);
  let now = Date.parse('2026-07-10T12:00:00Z');
  const store = await AppStateV2.open({
    filePath: path.join(directory, 'state.json'),
    legacyTodos: [],
    legacyAlarms: [],
    now: () => now,
  });
  await store.addAlarm({ id: 'scheduled', taskTitle: 'İptal edilecek', minutes: 5 });
  const stale = await store.cancelAlarm('scheduled', 2);
  assert.equal(stale.result.stale, true);
  assert.equal(stale.state.activeAlarms.length, 1);

  const cancelled = await store.cancelAlarm('scheduled');
  assert.equal(cancelled.result.cancelled, true);
  assert.equal(cancelled.state.activeAlarms.length, 0);
  assert.equal(cancelled.state.alarmHistory.length, 0);
  assert.equal((await store.cancelAlarm('scheduled')).result.notFound, true);

  await store.addAlarm({ id: 'ringing', taskTitle: 'Çalıyor', minutes: 1 });
  now += 60_000;
  await store.ringAlarm('ringing', 1);
  const refused = await store.cancelAlarm('ringing');
  assert.equal(refused.result.invalidStatus, true);
  assert.equal(refused.state.activeAlarms[0].status, 'ringing');
});

test('reconcile rings alarms up to 15 minutes late and records older alarms as missed', async (t) => {
  const directory = await makeTempDir(t);
  let now = Date.parse('2026-07-10T12:00:00Z');
  const store = await AppStateV2.open({
    filePath: path.join(directory, 'state.json'),
    legacyTodos: [],
    legacyAlarms: [],
    now: () => now,
  });
  await store.addAlarm({ id: 'recent', taskTitle: 'Yeni', minutes: 1 });
  await store.addAlarm({ id: 'old', taskTitle: 'Eski', minutes: 1, fireAt: now + 2 * 60_000 });
  now += 17 * 60_000;

  const reconciled = await store.reconcileAlarms();
  assert.deepEqual(reconciled.result.ringing.map((item) => item.id), ['old']);
  assert.deepEqual(reconciled.result.missed.map((item) => item.id), ['recent']);
  assert.equal(reconciled.state.activeAlarms[0].status, 'ringing');
  assert.equal(reconciled.state.alarmHistory[0].status, 'missed');
});

test('validates the 1-1440 minute range and rejects an expired frozen target', async (t) => {
  assert.equal(validateMinutes(1), 1);
  assert.equal(validateMinutes('1440'), 1440);
  assert.throws(() => validateMinutes(0), { code: 'INVALID_ALARM_MINUTES' });
  assert.throws(() => validateMinutes(1441), { code: 'INVALID_ALARM_MINUTES' });
  assert.throws(() => validateMinutes(1.5), { code: 'INVALID_ALARM_MINUTES' });

  const now = Date.parse('2026-07-10T12:00:00Z');
  assert.equal(freezeFireAt(90, now), now + 90 * 60_000);
  const directory = await makeTempDir(t);
  const store = await AppStateV2.open({
    filePath: path.join(directory, 'state.json'),
    legacyTodos: [],
    legacyAlarms: [],
    now: () => now,
  });
  await assert.rejects(
    store.addAlarm({ minutes: 30, fireAt: now }),
    { code: 'ALARM_TARGET_EXPIRED' },
  );
});

test('history is retained for 30 days and capped at 200 records', () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  const recent = Array.from({ length: 205 }, (_, index) => ({
    id: `recent-${index}`,
    taskId: '',
    taskTitle: `Alarm ${index}`,
    minutes: 1,
    fireAt: now - 60_000,
    status: 'dismissed',
    occurrence: 1,
    snoozeCount: 0,
    resolvedAt: now - (205 - index) * 1_000,
  }));
  const old = {
    ...recent[0],
    id: 'too-old',
    resolvedAt: now - 31 * 24 * 60 * 60_000,
  };
  const normalized = normalizeV2State({ version: 2, todos: [], activeAlarms: [], alarmHistory: [old, ...recent] }, { now });
  assert.equal(normalized.alarmHistory.length, HISTORY_MAX_RECORDS);
  assert.equal(normalized.alarmHistory.some((alarm) => alarm.id === 'too-old'), false);
  assert.equal(normalized.alarmHistory[0].id, 'recent-5');
});

test('processed command ids are deduplicated across concurrent calls and persisted', async (t) => {
  const directory = await makeTempDir(t);
  const filePath = path.join(directory, 'state.json');
  const now = Date.parse('2026-07-10T12:00:00Z');
  const store = await AppStateV2.open({ filePath, legacyTodos: [], legacyAlarms: [], now: () => now });
  const [first, second] = await Promise.all([
    store.markCommandProcessed('command-1'),
    store.markCommandProcessed('command-1'),
  ]);
  assert.equal(first.result.recorded, true);
  assert.equal(second.result.duplicate, true);
  assert.equal(store.getState().processedCommandIds.length, 1);
  assert.equal(store.hasProcessedCommand('command-1'), true);

  const reopened = await AppStateV2.open({ filePath, now: () => now });
  assert.equal(reopened.hasProcessedCommand('command-1'), true);
});

test('applies a relay command and its dedupe marker in one revision and snapshot', async () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  let persisted = null;
  let writes = 0;
  const memoryStore = {
    async read() {
      return persisted
        ? { value: JSON.parse(JSON.stringify(persisted)), source: 'primary', recovered: false, error: null }
        : { value: null, source: 'fallback', recovered: false, error: null };
    },
    async write(value) {
      persisted = JSON.parse(JSON.stringify(value));
      writes += 1;
    },
  };
  const store = await AppStateV2.open({
    filePath: '/memory/relay-state.json',
    store: memoryStore,
    legacyTodos: [],
    legacyAlarms: [],
    now: () => now,
  });
  writes = 0;

  const first = await store.applyCommand('relay-1', {
    type: 'todo/add-with-alarm',
    payload: {
      todoId: 'remote-todo',
      alarmId: 'remote-alarm',
      title: 'Telefondan gelen',
      minutes: 10,
      fireAt: now + 10 * 60_000,
      source: 'cloud',
    },
  });
  assert.equal(first.result.applied, true);
  assert.equal(first.state.revision, 1);
  assert.equal(first.state.todos.length, 1);
  assert.equal(first.state.activeAlarms.length, 1);
  assert.deepEqual(first.state.processedCommandIds.map((record) => record.id), ['relay-1']);
  assert.deepEqual(persisted, first.state);
  assert.equal(writes, 1);

  const snapshot = store.getState();
  const duplicate = await store.applyCommand('relay-1', {
    type: 'todo/delete',
    payload: { id: 'remote-todo' },
  });
  assert.equal(duplicate.result.duplicate, true);
  assert.deepEqual(duplicate.state, snapshot);
  assert.equal(duplicate.state.revision, 1);
  assert.equal(writes, 1);

  await assert.rejects(
    store.applyCommand('relay-invalid', { type: 'alarm/snooze', payload: {} }),
    { code: 'UNSUPPORTED_COMMAND_ACTION' },
  );
  assert.equal(store.hasProcessedCommand('relay-invalid'), false);
  assert.equal(writes, 1);
});

test('falls back to a verified backup and repairs a corrupt primary', async (t) => {
  const directory = await makeTempDir(t);
  const filePath = path.join(directory, 'state.json');
  const now = Date.parse('2026-07-10T12:00:00Z');
  const store = await AppStateV2.open({ filePath, legacyTodos: [], legacyAlarms: [], now: () => now });
  await store.addTodo({ id: 'first', title: 'Birinci' });
  await store.addTodo({ id: 'second', title: 'İkinci' });
  await fs.promises.writeFile(filePath, '{corrupt');

  const recovered = await AppStateV2.open({ filePath, now: () => now });
  assert.deepEqual(recovered.getState().todos.map((todo) => todo.id), ['first']);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(filePath, 'utf8')));
  const backup = JSON.parse(await fs.promises.readFile(`${filePath}.bak`, 'utf8'));
  assert.deepEqual(backup.todos.map((todo) => todo.id), ['first']);
});
