'use strict';

const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { AtomicJsonStore, readJsonWithBackup } = require('./atomic-json-store');

const STATE_VERSION = 2;
const MIN_ALARM_MINUTES = 1;
const MAX_ALARM_MINUTES = 24 * 60;
const OVERDUE_GRACE_MS = 15 * 60 * 1000;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_MAX_RECORDS = 200;
const COMMAND_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const COMMAND_MAX_RECORDS = 5000;

const LIVE_ALARM_STATUSES = new Set(['scheduled', 'ringing']);
const HISTORY_ALARM_STATUSES = new Set(['dismissed', 'completed', 'missed']);
const VALID_CATEGORIES = new Set(['important', 'later', 'today']);

const ACTIONS = Object.freeze({
  TODO_ADD: 'todo/add',
  TODO_ADD_WITH_ALARM: 'todo/add-with-alarm',
  TODO_UPDATE: 'todo/update',
  TODO_DELETE: 'todo/delete',
  ALARM_ADD: 'alarm/add',
  ALARM_CANCEL: 'alarm/cancel',
  ALARM_RING: 'alarm/ring',
  ALARM_DISMISS: 'alarm/dismiss',
  ALARM_COMPLETE: 'alarm/complete',
  ALARM_SNOOZE: 'alarm/snooze',
  ALARM_MISS: 'alarm/miss',
  ALARMS_RECONCILE: 'alarms/reconcile',
  COMMAND_RECORD: 'command/record',
  COMMAND_APPLY: 'command/apply',
  MAINTENANCE_PRUNE: 'maintenance/prune',
});

const COMMAND_ACTIONS = new Set([
  ACTIONS.TODO_ADD,
  ACTIONS.TODO_ADD_WITH_ALARM,
  ACTIONS.TODO_UPDATE,
  ACTIONS.TODO_DELETE,
  ACTIONS.ALARM_ADD,
  ACTIONS.ALARM_CANCEL,
]);

class AppStateError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'AppStateError';
    this.code = code;
    Object.assign(this, details);
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function epochNow(now) {
  const value = typeof now === 'function' ? now() : (now == null ? Date.now() : now);
  const epoch = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(epoch)) throw new TypeError('now must resolve to a finite epoch value');
  return epoch;
}

function asIso(value, fallbackEpoch) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return new Date(numeric).toISOString();
  return new Date(fallbackEpoch).toISOString();
}

function makeId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function cleanId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanTitle(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCategory(value) {
  const category = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return VALID_CATEGORIES.has(category) ? category : 'today';
}

function validateMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < MIN_ALARM_MINUTES || minutes > MAX_ALARM_MINUTES) {
    throw new AppStateError(
      `Alarm minutes must be an integer from ${MIN_ALARM_MINUTES} through ${MAX_ALARM_MINUTES}`,
      'INVALID_ALARM_MINUTES',
      { min: MIN_ALARM_MINUTES, max: MAX_ALARM_MINUTES, value },
    );
  }
  return minutes;
}

function freezeFireAt(minutes, now = Date.now()) {
  const safeMinutes = validateMinutes(minutes);
  return epochNow(now) + safeMinutes * 60 * 1000;
}

function validateAlarmTarget(payload, now) {
  const minutes = validateMinutes(payload.minutes);
  const fireAt = payload.fireAt == null ? freezeFireAt(minutes, now) : Number(payload.fireAt);
  if (!Number.isFinite(fireAt)) {
    throw new AppStateError('fireAt must be a finite epoch value', 'INVALID_FIRE_AT');
  }
  if (fireAt <= now) {
    throw new AppStateError('The frozen alarm target has already passed', 'ALARM_TARGET_EXPIRED', {
      fireAt,
      now,
    });
  }
  if (fireAt > now + MAX_ALARM_MINUTES * 60 * 1000) {
    throw new AppStateError('fireAt exceeds the 24 hour alarm limit', 'ALARM_TARGET_TOO_FAR');
  }
  return { minutes, fireAt };
}

function uniqueId(candidate, usedIds, idFactory) {
  let id = cleanId(candidate);
  if (id && !usedIds.has(id)) {
    usedIds.add(id);
    return id;
  }
  let attempts = 0;
  do {
    id = cleanId(attempts < 32 ? idFactory() : makeId()) || makeId();
    attempts += 1;
  } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

function normalizeTodo(raw, context) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanTitle(raw.title ?? raw.text ?? raw.note);
  if (!title) return null;
  const id = uniqueId(raw.id, context.usedIds, context.idFactory);
  const createdAt = asIso(raw.createdAt, context.now);
  const updatedAt = asIso(raw.updatedAt, Date.parse(createdAt));
  const todo = {
    id,
    title,
    category: normalizeCategory(raw.category),
    isDone: Boolean(raw.isDone ?? raw.completed),
    isArchived: Boolean(raw.isArchived ?? raw.archived),
    createdAt,
    updatedAt,
  };
  if (typeof raw.source === 'string' && raw.source.trim()) todo.source = raw.source.trim();
  return todo;
}

function normalizeAlarm(raw, context, history = false) {
  if (!raw || typeof raw !== 'object') return null;
  let minutes;
  try {
    minutes = validateMinutes(raw.minutes);
  } catch (_) {
    return null;
  }
  const fireAt = Number(raw.fireAt);
  if (!Number.isFinite(fireAt)) return null;
  const allowed = history ? HISTORY_ALARM_STATUSES : LIVE_ALARM_STATUSES;
  const defaultStatus = history ? null : 'scheduled';
  const status = allowed.has(raw.status) ? raw.status : defaultStatus;
  if (!status) return null;

  const id = uniqueId(raw.id, context.usedIds, context.idFactory);
  const createdFallback = Math.min(context.now, fireAt - minutes * 60 * 1000);
  const createdAt = asIso(raw.createdAt, createdFallback);
  const updatedAt = asIso(raw.updatedAt, context.now);
  const occurrence = Number.isInteger(Number(raw.occurrence)) && Number(raw.occurrence) > 0
    ? Number(raw.occurrence)
    : 1;
  const snoozeCount = Number.isInteger(Number(raw.snoozeCount)) && Number(raw.snoozeCount) >= 0
    ? Number(raw.snoozeCount)
    : 0;
  const taskId = cleanId(raw.taskId);
  const linkedTodo = context.todosById && context.todosById.get(taskId);
  const taskTitle = cleanTitle(raw.taskTitle) || linkedTodo?.title || 'Zaman doldu';
  const alarm = {
    id,
    taskId,
    taskTitle,
    minutes,
    originalMinutes: (() => {
      try { return validateMinutes(raw.originalMinutes ?? minutes); } catch (_) { return minutes; }
    })(),
    fireAt,
    status,
    occurrence,
    snoozeCount,
    createdAt,
    updatedAt,
    startedRingingAt: raw.startedRingingAt
      ? asIso(raw.startedRingingAt, context.now)
      : null,
  };
  if (Number.isFinite(Number(raw.lateByMs)) && Number(raw.lateByMs) >= 0) {
    alarm.lateByMs = Number(raw.lateByMs);
  }
  if (history) alarm.resolvedAt = asIso(raw.resolvedAt, context.now);
  return alarm;
}

function pruneHistory(history, now) {
  const cutoff = now - HISTORY_RETENTION_MS;
  const retained = history.filter((record) => {
    const resolvedAt = Date.parse(record.resolvedAt);
    return Number.isFinite(resolvedAt) && resolvedAt >= cutoff;
  });
  return retained.length > HISTORY_MAX_RECORDS
    ? retained.slice(retained.length - HISTORY_MAX_RECORDS)
    : retained;
}

function pruneProcessedCommands(records, now) {
  const cutoff = now - COMMAND_RETENTION_MS;
  const seen = new Set();
  const retained = [];
  for (const record of records) {
    const id = cleanId(typeof record === 'string' ? record : record?.id);
    const processedAt = asIso(typeof record === 'string' ? now : record?.processedAt, now);
    if (!id || seen.has(id) || Date.parse(processedAt) < cutoff) continue;
    seen.add(id);
    retained.push({ id, processedAt });
  }
  return retained.length > COMMAND_MAX_RECORDS
    ? retained.slice(retained.length - COMMAND_MAX_RECORDS)
    : retained;
}

function createEmptyState(now = Date.now()) {
  const epoch = epochNow(now);
  return {
    version: STATE_VERSION,
    revision: 0,
    updatedAt: new Date(epoch).toISOString(),
    todos: [],
    activeAlarms: [],
    alarmHistory: [],
    processedCommandIds: [],
  };
}

function normalizeV2State(raw, options = {}) {
  const now = epochNow(options.now);
  const idFactory = options.idFactory || makeId;
  const state = createEmptyState(now);
  const todoIds = new Set();
  const todoContext = { now, idFactory, usedIds: todoIds };
  const rawTodos = Array.isArray(raw?.todos) ? raw.todos : [];
  state.todos = rawTodos.map((todo) => normalizeTodo(todo, todoContext)).filter(Boolean);

  const todosById = new Map(state.todos.map((todo) => [todo.id, todo]));
  const alarmIds = new Set();
  const alarmContext = { now, idFactory, usedIds: alarmIds, todosById };
  const rawActiveAlarms = Array.isArray(raw?.activeAlarms)
    ? raw.activeAlarms
    : (Array.isArray(raw?.alarms) ? raw.alarms : []);
  state.activeAlarms = rawActiveAlarms
    .map((alarm) => normalizeAlarm(alarm, alarmContext, false))
    .filter(Boolean);
  state.alarmHistory = (Array.isArray(raw?.alarmHistory) ? raw.alarmHistory : [])
    .map((alarm) => normalizeAlarm(alarm, alarmContext, true))
    .filter(Boolean);
  state.alarmHistory = pruneHistory(state.alarmHistory, now);
  state.processedCommandIds = pruneProcessedCommands(raw?.processedCommandIds || [], now);
  state.revision = Number.isInteger(Number(raw?.revision)) && Number(raw.revision) >= 0
    ? Number(raw.revision)
    : 0;
  state.updatedAt = asIso(raw?.updatedAt, now);
  return state;
}

function legacyArray(value, property) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value[property])) return value[property];
  return [];
}

function toHistoryRecord(alarm, status, now) {
  return {
    ...alarm,
    status,
    updatedAt: new Date(now).toISOString(),
    resolvedAt: new Date(now).toISOString(),
  };
}

function applyOverduePolicyMutable(state, now) {
  const activeAlarms = [];
  const ringing = [];
  const missed = [];

  for (const alarm of state.activeAlarms) {
    if (alarm.fireAt > now) {
      activeAlarms.push(alarm);
      continue;
    }
    const lateByMs = Math.max(0, now - alarm.fireAt);
    if (lateByMs <= OVERDUE_GRACE_MS) {
      if (alarm.status !== 'ringing') {
        alarm.status = 'ringing';
        alarm.startedRingingAt = new Date(now).toISOString();
        alarm.updatedAt = new Date(now).toISOString();
      }
      alarm.lateByMs = lateByMs;
      activeAlarms.push(alarm);
      ringing.push({ id: alarm.id, occurrence: alarm.occurrence, lateByMs });
    } else {
      const record = toHistoryRecord({ ...alarm, lateByMs }, 'missed', now);
      state.alarmHistory.push(record);
      missed.push({ id: alarm.id, occurrence: alarm.occurrence, lateByMs });
    }
  }

  state.activeAlarms = activeAlarms;
  state.alarmHistory = pruneHistory(state.alarmHistory, now);
  return { ringing, missed };
}

/** Migrates legacy todos/alarms arrays and immediately applies wake/start overdue policy. */
function migrateLegacyState(legacy = {}, options = {}) {
  const now = epochNow(options.now);
  const idFactory = options.idFactory || makeId;
  const state = createEmptyState(now);
  const todoIds = new Set();
  const rawTodos = legacyArray(legacy.todos ?? legacy, 'todos');
  state.todos = rawTodos
    .map((todo) => normalizeTodo(todo, { now, idFactory, usedIds: todoIds }))
    .filter(Boolean);

  const todosById = new Map(state.todos.map((todo) => [todo.id, todo]));
  const alarmIds = new Set();
  const rawAlarms = legacyArray(legacy.alarms, 'alarms');
  state.activeAlarms = rawAlarms
    .map((alarm) => normalizeAlarm(alarm, {
      now,
      idFactory,
      usedIds: alarmIds,
      todosById,
    }, false))
    .filter(Boolean);

  applyOverduePolicyMutable(state, now);
  return state;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppStateError(`${label} must be an object`, 'INVALID_ACTION_PAYLOAD');
  }
  return value;
}

function requireId(value, label = 'id') {
  const id = cleanId(value);
  if (!id) throw new AppStateError(`${label} is required`, 'INVALID_ID');
  return id;
}

function requireOccurrence(value) {
  const occurrence = Number(value);
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    throw new AppStateError('occurrence must be a positive integer', 'INVALID_OCCURRENCE');
  }
  return occurrence;
}

function occurrenceMatch(state, payload) {
  const id = requireId(payload.id ?? payload.alarmId, 'alarmId');
  const occurrence = requireOccurrence(payload.occurrence);
  const index = state.activeAlarms.findIndex((alarm) => alarm.id === id);
  if (index === -1) {
    const terminal = state.alarmHistory.find(
      (record) => record.id === id && record.occurrence === occurrence,
    );
    return {
      applied: false,
      duplicate: Boolean(terminal),
      notFound: !terminal,
      id,
      occurrence,
      terminalStatus: terminal?.status,
    };
  }
  const alarm = state.activeAlarms[index];
  if (alarm.occurrence !== occurrence) {
    return {
      applied: false,
      stale: true,
      id,
      occurrence,
      currentOccurrence: alarm.occurrence,
    };
  }
  return { applied: true, id, occurrence, index, alarm };
}

function finalizeState(state, now) {
  state.alarmHistory = pruneHistory(state.alarmHistory, now);
  state.processedCommandIds = pruneProcessedCommands(state.processedCommandIds, now);
  state.version = STATE_VERSION;
  state.revision += 1;
  state.updatedAt = new Date(now).toISOString();
}

function reduceState(currentState, action, options = {}) {
  if (!looksLikeV2State(currentState)) {
    throw new AppStateError('Reducer received an invalid AppStateV2 snapshot', 'INVALID_APP_STATE');
  }
  if (!action || typeof action.type !== 'string') {
    throw new AppStateError('Action type is required', 'INVALID_ACTION');
  }
  const now = epochNow(options.now);
  const idFactory = options.idFactory || makeId;
  let state = deepClone(currentState);
  const payload = action.payload == null ? {} : requireObject(action.payload, 'action.payload');
  let result;
  let changed = false;

  switch (action.type) {
    case ACTIONS.TODO_ADD: {
      const title = cleanTitle(payload.title);
      if (!title) throw new AppStateError('Todo title is required', 'INVALID_TODO_TITLE');
      const used = new Set(state.todos.map((todo) => todo.id));
      const requestedId = cleanId(payload.id);
      if (requestedId && used.has(requestedId)) {
        throw new AppStateError('Todo id already exists', 'DUPLICATE_TODO_ID', { id: requestedId });
      }
      const id = uniqueId(requestedId, used, idFactory);
      const todo = {
        id,
        title,
        category: normalizeCategory(payload.category),
        isDone: Boolean(payload.isDone),
        isArchived: Boolean(payload.isArchived),
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      if (typeof payload.source === 'string' && payload.source.trim()) {
        todo.source = payload.source.trim();
      }
      state.todos.push(todo);
      changed = true;
      result = { added: true, todo };
      break;
    }

    case ACTIONS.TODO_ADD_WITH_ALARM: {
      // Validate the complete aggregate before modifying either collection so
      // an expired frozen target can never leave behind an orphan todo.
      const title = cleanTitle(payload.title);
      if (!title) throw new AppStateError('Todo title is required', 'INVALID_TODO_TITLE');
      const { minutes, fireAt } = validateAlarmTarget(payload, now);

      const todoIds = new Set(state.todos.map((todo) => todo.id));
      const requestedTodoId = cleanId(payload.todoId);
      if (requestedTodoId && todoIds.has(requestedTodoId)) {
        throw new AppStateError('Todo id already exists', 'DUPLICATE_TODO_ID', {
          id: requestedTodoId,
        });
      }
      const alarmIds = new Set(state.activeAlarms.map((alarm) => alarm.id));
      for (const history of state.alarmHistory) alarmIds.add(history.id);
      const requestedAlarmId = cleanId(payload.alarmId);
      if (requestedAlarmId && alarmIds.has(requestedAlarmId)) {
        throw new AppStateError('Alarm id already exists', 'DUPLICATE_ALARM_ID', {
          id: requestedAlarmId,
        });
      }

      const todoId = uniqueId(requestedTodoId, todoIds, idFactory);
      const alarmId = uniqueId(requestedAlarmId, alarmIds, idFactory);
      const timestamp = new Date(now).toISOString();
      const todo = {
        id: todoId,
        title,
        category: normalizeCategory(payload.category),
        isDone: false,
        isArchived: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (typeof payload.source === 'string' && payload.source.trim()) {
        todo.source = payload.source.trim();
      }
      const alarm = {
        id: alarmId,
        taskId: todo.id,
        taskTitle: todo.title,
        minutes,
        originalMinutes: minutes,
        fireAt,
        status: 'scheduled',
        occurrence: 1,
        snoozeCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedRingingAt: null,
      };

      state.todos.push(todo);
      state.activeAlarms.push(alarm);
      changed = true;
      result = { todo, alarm };
      break;
    }

    case ACTIONS.TODO_UPDATE: {
      const id = requireId(payload.id ?? payload.taskId, 'taskId');
      const index = state.todos.findIndex((todo) => todo.id === id);
      if (index === -1) {
        result = { updated: false, notFound: true, id };
        break;
      }
      const patch = requireObject(payload.patch ?? payload, 'todo patch');
      const todo = { ...state.todos[index] };
      if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
        const title = cleanTitle(patch.title);
        if (!title) throw new AppStateError('Todo title is required', 'INVALID_TODO_TITLE');
        todo.title = title;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'category')) {
        todo.category = normalizeCategory(patch.category);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'isDone')) todo.isDone = Boolean(patch.isDone);
      if (Object.prototype.hasOwnProperty.call(patch, 'isArchived')) {
        todo.isArchived = Boolean(patch.isArchived);
      }
      todo.updatedAt = new Date(now).toISOString();
      state.todos[index] = todo;
      if (todo.title !== currentState.todos[index].title) {
        for (const alarm of state.activeAlarms) {
          if (alarm.taskId === id) {
            alarm.taskTitle = todo.title;
            alarm.updatedAt = new Date(now).toISOString();
          }
        }
      }
      changed = true;
      result = { updated: true, todo };
      break;
    }

    case ACTIONS.TODO_DELETE: {
      const id = requireId(payload.id ?? payload.taskId, 'taskId');
      const index = state.todos.findIndex((todo) => todo.id === id);
      if (index === -1) {
        result = { deleted: false, notFound: true, id };
        break;
      }
      const [todo] = state.todos.splice(index, 1);
      const removedAlarmIds = state.activeAlarms
        .filter((alarm) => alarm.taskId === id)
        .map((alarm) => alarm.id);
      state.activeAlarms = state.activeAlarms.filter((alarm) => alarm.taskId !== id);
      changed = true;
      result = { deleted: true, todo, removedAlarmIds };
      break;
    }

    case ACTIONS.ALARM_ADD: {
      const { minutes, fireAt } = validateAlarmTarget(payload, now);
      const used = new Set(state.activeAlarms.map((alarm) => alarm.id));
      for (const history of state.alarmHistory) used.add(history.id);
      const requestedId = cleanId(payload.id ?? payload.alarmId);
      if (requestedId && used.has(requestedId)) {
        throw new AppStateError('Alarm id already exists', 'DUPLICATE_ALARM_ID', { id: requestedId });
      }
      const id = uniqueId(requestedId, used, idFactory);
      const taskId = cleanId(payload.taskId);
      const todo = state.todos.find((item) => item.id === taskId);
      const taskTitle = cleanTitle(payload.taskTitle) || todo?.title || 'Zaman doldu';
      const alarm = {
        id,
        taskId,
        taskTitle,
        minutes,
        originalMinutes: minutes,
        fireAt,
        status: 'scheduled',
        occurrence: 1,
        snoozeCount: 0,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        startedRingingAt: null,
      };
      state.activeAlarms.push(alarm);
      changed = true;
      result = { added: true, alarm };
      break;
    }

    case ACTIONS.ALARM_CANCEL: {
      const id = requireId(payload.id ?? payload.alarmId, 'alarmId');
      const index = state.activeAlarms.findIndex((alarm) => alarm.id === id);
      if (index === -1) {
        result = { applied: false, notFound: true, id };
        break;
      }
      const alarm = state.activeAlarms[index];
      if (payload.occurrence != null) {
        const occurrence = requireOccurrence(payload.occurrence);
        if (alarm.occurrence !== occurrence) {
          result = {
            applied: false,
            stale: true,
            id,
            occurrence,
            currentOccurrence: alarm.occurrence,
          };
          break;
        }
      }
      if (alarm.status !== 'scheduled') {
        result = {
          applied: false,
          invalidStatus: true,
          id,
          occurrence: alarm.occurrence,
          currentStatus: alarm.status,
        };
        break;
      }
      state.activeAlarms.splice(index, 1);
      changed = true;
      result = { applied: true, cancelled: true, alarm };
      break;
    }

    case ACTIONS.ALARM_RING: {
      const match = occurrenceMatch(state, payload);
      if (!match.applied) {
        result = match;
        break;
      }
      const alarm = match.alarm;
      if (alarm.status === 'ringing') {
        result = { applied: false, duplicate: true, id: alarm.id, occurrence: alarm.occurrence };
        break;
      }
      if (now < alarm.fireAt) {
        result = { applied: false, early: true, id: alarm.id, occurrence: alarm.occurrence };
        break;
      }
      const lateByMs = now - alarm.fireAt;
      if (lateByMs > OVERDUE_GRACE_MS) {
        state.activeAlarms.splice(match.index, 1);
        const record = toHistoryRecord({ ...alarm, lateByMs }, 'missed', now);
        state.alarmHistory.push(record);
        changed = true;
        result = { applied: true, status: 'missed', alarm: record };
        break;
      }
      alarm.status = 'ringing';
      alarm.startedRingingAt = new Date(now).toISOString();
      alarm.updatedAt = new Date(now).toISOString();
      alarm.lateByMs = lateByMs;
      changed = true;
      result = { applied: true, status: 'ringing', alarm };
      break;
    }

    case ACTIONS.ALARM_DISMISS:
    case ACTIONS.ALARM_COMPLETE:
    case ACTIONS.ALARM_MISS: {
      const match = occurrenceMatch(state, payload);
      if (!match.applied) {
        result = match;
        break;
      }
      const outcome = action.type === ACTIONS.ALARM_DISMISS
        ? 'dismissed'
        : (action.type === ACTIONS.ALARM_COMPLETE ? 'completed' : 'missed');
      if (outcome !== 'missed' && match.alarm.status !== 'ringing') {
        result = {
          applied: false,
          invalidStatus: true,
          id: match.id,
          occurrence: match.occurrence,
          currentStatus: match.alarm.status,
        };
        break;
      }
      state.activeAlarms.splice(match.index, 1);
      const record = toHistoryRecord(match.alarm, outcome, now);
      state.alarmHistory.push(record);
      let todo = null;
      if (outcome === 'completed' && match.alarm.taskId) {
        const todoIndex = state.todos.findIndex((item) => item.id === match.alarm.taskId);
        if (todoIndex !== -1) {
          todo = {
            ...state.todos[todoIndex],
            isDone: true,
            updatedAt: new Date(now).toISOString(),
          };
          state.todos[todoIndex] = todo;
        }
      }
      changed = true;
      result = { applied: true, status: outcome, alarm: record, todo };
      break;
    }

    case ACTIONS.ALARM_SNOOZE: {
      const match = occurrenceMatch(state, payload);
      if (!match.applied) {
        result = match;
        break;
      }
      if (match.alarm.status !== 'ringing') {
        result = {
          applied: false,
          invalidStatus: true,
          id: match.id,
          occurrence: match.occurrence,
          currentStatus: match.alarm.status,
        };
        break;
      }
      const minutes = validateMinutes(payload.minutes);
      match.alarm.minutes = minutes;
      match.alarm.fireAt = freezeFireAt(minutes, now);
      match.alarm.status = 'scheduled';
      match.alarm.occurrence += 1;
      match.alarm.snoozeCount += 1;
      match.alarm.updatedAt = new Date(now).toISOString();
      match.alarm.startedRingingAt = null;
      delete match.alarm.lateByMs;
      changed = true;
      result = { applied: true, status: 'scheduled', alarm: match.alarm };
      break;
    }

    case ACTIONS.ALARMS_RECONCILE: {
      const before = JSON.stringify(state.activeAlarms);
      const historyCount = state.alarmHistory.length;
      result = applyOverduePolicyMutable(state, now);
      changed = before !== JSON.stringify(state.activeAlarms)
        || historyCount !== state.alarmHistory.length;
      result.applied = changed;
      break;
    }

    case ACTIONS.COMMAND_RECORD: {
      const id = requireId(payload.id ?? payload.commandId, 'commandId');
      const duplicate = state.processedCommandIds.some((record) => record.id === id);
      if (duplicate) {
        result = { recorded: false, duplicate: true, id };
        break;
      }
      state.processedCommandIds.push({ id, processedAt: new Date(now).toISOString() });
      changed = true;
      result = { recorded: true, duplicate: false, id };
      break;
    }

    case ACTIONS.COMMAND_APPLY: {
      const commandId = requireId(payload.id ?? payload.commandId, 'commandId');
      const duplicate = state.processedCommandIds.some((record) => record.id === commandId);
      if (duplicate) {
        result = { applied: false, duplicate: true, commandId };
        break;
      }
      const innerAction = requireObject(payload.action, 'command action');
      if (typeof innerAction.type !== 'string' || !COMMAND_ACTIONS.has(innerAction.type)) {
        throw new AppStateError(
          `Unsupported command action: ${innerAction.type || '<missing>'}`,
          'UNSUPPORTED_COMMAND_ACTION',
          { actionType: innerAction.type },
        );
      }

      // The inner reducer validates and applies its domain mutation without a
      // revision bump. Recording the command then finalizes both changes as a
      // single durable snapshot below.
      const inner = reduceState(state, innerAction, {
        now,
        idFactory,
        deferFinalize: true,
      });
      state = inner.state;
      state.processedCommandIds.push({
        id: commandId,
        processedAt: new Date(now).toISOString(),
      });
      changed = true;
      result = {
        applied: inner.changed,
        duplicate: false,
        commandId,
        actionResult: inner.result,
      };
      break;
    }

    case ACTIONS.MAINTENANCE_PRUNE: {
      const historyBefore = state.alarmHistory.length;
      const commandsBefore = state.processedCommandIds.length;
      state.alarmHistory = pruneHistory(state.alarmHistory, now);
      state.processedCommandIds = pruneProcessedCommands(state.processedCommandIds, now);
      changed = historyBefore !== state.alarmHistory.length
        || commandsBefore !== state.processedCommandIds.length;
      result = { applied: changed };
      break;
    }

    default:
      throw new AppStateError(`Unsupported action: ${action.type}`, 'UNKNOWN_ACTION', {
        actionType: action.type,
      });
  }

  if (changed && !options.deferFinalize) finalizeState(state, now);
  return { state, result, changed };
}

function looksLikeV2State(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.version === STATE_VERSION
    && Number.isInteger(Number(value.revision))
    && Number(value.revision) >= 0
    && typeof value.updatedAt === 'string'
    && Number.isFinite(Date.parse(value.updatedAt))
    && Array.isArray(value.todos)
    && Array.isArray(value.activeAlarms)
    && Array.isArray(value.alarmHistory)
    && Array.isArray(value.processedCommandIds),
  );
}

class AppStateV2 extends EventEmitter {
  constructor(options = {}) {
    super();
    if (typeof options.filePath !== 'string' || !options.filePath.trim()) {
      throw new TypeError('AppStateV2 requires filePath');
    }
    this.filePath = options.filePath;
    this.legacyTodosPath = options.legacyTodosPath
      || path.join(path.dirname(options.filePath), 'todos.json');
    this.legacyAlarmsPath = options.legacyAlarmsPath
      || path.join(path.dirname(options.filePath), 'alarms.json');
    this._legacyTodos = options.legacyTodos;
    this._legacyAlarms = options.legacyAlarms;
    this._now = options.now || Date.now;
    this._idFactory = options.idFactory || makeId;
    this._store = options.store || new AtomicJsonStore(options.filePath, { mode: 0o600 });
    this._state = createEmptyState(this._now);
    this._loaded = false;
    this._tail = Promise.resolve();
  }

  static async open(options = {}) {
    const instance = new AppStateV2(options);
    await instance.load();
    return instance;
  }

  async _readLegacyValue(provided, filePath, property) {
    if (provided !== undefined) return legacyArray(provided, property);
    const read = await readJsonWithBackup(filePath, { fallback: [] });
    return legacyArray(read.value, property);
  }

  async load() {
    if (this._loaded) return this;
    const now = epochNow(this._now);
    const loaded = await this._store.read({ fallback: null, validate: looksLikeV2State });
    let state;
    let shouldPersist = false;

    if (loaded.source === 'primary' || loaded.source === 'backup') {
      state = normalizeV2State(loaded.value, { now, idFactory: this._idFactory });
      const beforeOverdue = JSON.stringify({
        activeAlarms: state.activeAlarms,
        alarmHistory: state.alarmHistory,
      });
      const overdue = applyOverduePolicyMutable(state, now);
      const overdueChanged = beforeOverdue !== JSON.stringify({
        activeAlarms: state.activeAlarms,
        alarmHistory: state.alarmHistory,
      });
      if (overdueChanged) finalizeState(state, now);
      shouldPersist = loaded.recovered
        || overdueChanged
        || JSON.stringify(state) !== JSON.stringify(loaded.value);
    } else {
      const [todos, alarms] = await Promise.all([
        this._readLegacyValue(this._legacyTodos, this.legacyTodosPath, 'todos'),
        this._readLegacyValue(this._legacyAlarms, this.legacyAlarmsPath, 'alarms'),
      ]);
      state = migrateLegacyState({ todos, alarms }, { now, idFactory: this._idFactory });
      shouldPersist = true;
    }

    if (shouldPersist) await this._store.write(state);
    this._state = state;
    this._loaded = true;
    return this;
  }

  _ensureLoaded() {
    if (!this._loaded) throw new AppStateError('AppStateV2.load() must complete first', 'STATE_NOT_LOADED');
  }

  getState() {
    this._ensureLoaded();
    return deepClone(this._state);
  }

  dispatch(action, options = {}) {
    this._ensureLoaded();
    const operation = this._tail.then(async () => {
      const reduced = reduceState(this._state, action, {
        now: options.now == null ? this._now : options.now,
        idFactory: this._idFactory,
      });
      if (reduced.changed) {
        await this._store.write(reduced.state);
        this._state = reduced.state;
        this.emit('change', this.getState(), deepClone(action), deepClone(reduced.result));
      }
      return { state: this.getState(), result: deepClone(reduced.result) };
    });
    this._tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  flush() {
    this._ensureLoaded();
    return this._tail.then(() => this.getState());
  }

  addTodo(input) {
    return this.dispatch({ type: ACTIONS.TODO_ADD, payload: input });
  }

  addTodoWithAlarm(input) {
    return this.dispatch({ type: ACTIONS.TODO_ADD_WITH_ALARM, payload: input });
  }

  updateTodo(id, patch) {
    return this.dispatch({ type: ACTIONS.TODO_UPDATE, payload: { id, patch } });
  }

  deleteTodo(id) {
    return this.dispatch({ type: ACTIONS.TODO_DELETE, payload: { id } });
  }

  addAlarm(input) {
    return this.dispatch({ type: ACTIONS.ALARM_ADD, payload: input });
  }

  cancelAlarm(id, occurrence) {
    return this.dispatch({
      type: ACTIONS.ALARM_CANCEL,
      payload: occurrence == null ? { id } : { id, occurrence },
    });
  }

  ringAlarm(id, occurrence) {
    return this.dispatch({ type: ACTIONS.ALARM_RING, payload: { id, occurrence } });
  }

  dismissAlarm(id, occurrence) {
    return this.dispatch({ type: ACTIONS.ALARM_DISMISS, payload: { id, occurrence } });
  }

  completeAlarm(id, occurrence) {
    return this.dispatch({ type: ACTIONS.ALARM_COMPLETE, payload: { id, occurrence } });
  }

  snoozeAlarm(id, occurrence, minutes) {
    return this.dispatch({ type: ACTIONS.ALARM_SNOOZE, payload: { id, occurrence, minutes } });
  }

  missAlarm(id, occurrence) {
    return this.dispatch({ type: ACTIONS.ALARM_MISS, payload: { id, occurrence } });
  }

  reconcileAlarms(now) {
    return this.dispatch(
      { type: ACTIONS.ALARMS_RECONCILE, payload: {} },
      now == null ? {} : { now },
    );
  }

  hasProcessedCommand(id) {
    this._ensureLoaded();
    const safeId = cleanId(id);
    return Boolean(safeId && this._state.processedCommandIds.some((record) => record.id === safeId));
  }

  markCommandProcessed(id) {
    return this.dispatch({ type: ACTIONS.COMMAND_RECORD, payload: { id } });
  }

  applyCommand(commandId, action) {
    return this.dispatch({
      type: ACTIONS.COMMAND_APPLY,
      payload: { commandId, action },
    });
  }
}

module.exports = {
  AppStateV2,
  AppStateError,
  ACTIONS,
  STATE_VERSION,
  MIN_ALARM_MINUTES,
  MAX_ALARM_MINUTES,
  OVERDUE_GRACE_MS,
  HISTORY_RETENTION_MS,
  HISTORY_MAX_RECORDS,
  createEmptyState,
  migrateLegacyState,
  normalizeV2State,
  looksLikeV2State,
  reduceState,
  validateMinutes,
  freezeFireAt,
};
