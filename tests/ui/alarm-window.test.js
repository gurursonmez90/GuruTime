'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const alarmView = require('../../src/alarm-window.js');

test('lateness and queue messages cover empty, singular, and plural values', () => {
  assert.equal(alarmView.formatOverdue(0), 'Tam zamanında');
  assert.equal(alarmView.formatOverdue(1), '1 dakika gecikti');
  assert.equal(alarmView.formatOverdue(18), '18 dakika gecikti');
  assert.equal(alarmView.formatQueueCount(0), 'Başka alarm yok');
  assert.equal(alarmView.formatQueueCount(1), 'Sırada 1 alarm daha var');
  assert.equal(alarmView.formatQueueCount(3), 'Sırada 3 alarm daha var');
});

test('normal alarm state exposes its task and idempotency identity', () => {
  const state = alarmView.normalizeAlarmState({
    alarm: {
      id: 'alarm-42',
      taskId: 'task-8',
      taskTitle: 'Teklifi gönder',
      occurrence: 3,
    },
    queueCount: 2,
    overdueMinutes: 4,
    privacyMode: false,
  });

  assert.equal(state.alarmId, 'alarm-42');
  assert.equal(state.occurrence, 3);
  assert.equal(state.title, 'Teklifi gönder');
  assert.equal(state.queueCount, 2);
  assert.equal(state.overdueMinutes, 4);
  assert.equal(state.canCompleteTask, true);
  assert.deepEqual(alarmView.buildActionPayload(state, { minutes: 10 }), {
    alarmId: 'alarm-42',
    occurrence: 3,
    minutes: 10,
  });
});

test('privacy mode never exposes the task title', () => {
  const state = alarmView.normalizeAlarmState({
    alarm: {
      id: 'alarm-private',
      taskId: 'task-private',
      taskTitle: 'Gizli müşteri adı',
      occurrence: 1,
    },
    privacyMode: true,
  });

  assert.equal(state.title, 'Zaman doldu');
  assert.equal(state.description, 'Görev ayrıntıları gizlendi.');
  assert.doesNotMatch(`${state.title} ${state.description}`, /Gizli müşteri adı/);
});

test('alarm without a linked task cannot expose the complete action as available', () => {
  const state = alarmView.normalizeAlarmState({
    alarm: { id: 'standalone', title: 'Su iç', occurrence: 0 },
  });

  assert.equal(state.alarmId, 'standalone');
  assert.equal(state.canCompleteTask, false);
  assert.equal(state.occurrence, 0);
});

test('alarm markup provides every requested action and accessibility fallback', () => {
  const root = path.resolve(__dirname, '../..');
  const html = fs.readFileSync(path.join(root, 'src/alarm-window.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'src/alarm-window.js'), 'utf8');

  assert.match(html, /role="alertdialog"/);
  assert.match(html, />Tamam<\/button>/);
  assert.match(html, />Görevi bitir<\/button>/);
  [5, 10, 15, 30].forEach((minutes) => {
    assert.match(html, new RegExp(`data-snooze="${minutes}"`));
  });
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /prefers-reduced-transparency/);
  assert.match(html, /prefers-contrast/);
  assert.doesNotMatch(source, /require\s*\(\s*['"]electron['"]\s*\)/);
});
