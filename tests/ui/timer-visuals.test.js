'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const visuals = require('../../src/timer-visuals.js');

function localTime(hour, minute = 0) {
  return new Date(2026, 6, 10, hour, minute, 0, 0).getTime();
}

test('target hour bands select the exact requested time theme', () => {
  const cases = [
    [0, 0, 'indigo', '#7771E8'],
    [5, 59, 'indigo', '#7771E8'],
    [6, 0, 'amber', '#D8872F'],
    [11, 59, 'amber', '#D8872F'],
    [12, 0, 'cobalt', '#3F78D8'],
    [17, 59, 'cobalt', '#3F78D8'],
    [18, 0, 'coral', '#D86455'],
    [21, 59, 'coral', '#D86455'],
    [22, 0, 'indigo', '#7771E8'],
    [23, 59, 'indigo', '#7771E8'],
  ];

  cases.forEach(([hour, minute, name, color]) => {
    assert.deepEqual(visuals.getTimeTheme(localTime(hour, minute)), { name, color });
  });
});

test('capsule duration stays complete for minute and hour combinations', () => {
  assert.equal(visuals.formatDurationShort(1), '1 dk sonra');
  assert.equal(visuals.formatDurationShort(30), '30 dk sonra');
  assert.equal(visuals.formatDurationShort(60), '1 sa sonra');
  assert.equal(visuals.formatDurationShort(90), '1 sa 30 dk sonra');
  assert.equal(visuals.formatDurationShort(119), '1 sa 59 dk sonra');
  assert.equal(visuals.formatDurationShort(120), '2 sa sonra');
  assert.equal(visuals.formatDurationShort(1440), '24 sa sonra');

  assert.equal(visuals.formatDurationLong(90), '1 saat 30 dakika sonra');
  assert.equal(visuals.normalizeMinutes(1500), 1440);
  assert.equal(visuals.normalizeMinutes(0), 0);
});

test('local target clock uses two digit hours and minutes', () => {
  assert.equal(visuals.formatLocalTime(localTime(0, 0)), '00:00');
  assert.equal(visuals.formatLocalTime(localTime(7, 5)), '07:05');
  assert.equal(visuals.formatLocalTime(Number.NaN), '--:--');
});

test('confirmation dialog is centered under the capsule with a 14px gap', () => {
  const capsule = visuals.computeCapsuleRect({
    endpointX: 500,
    endpointY: 200,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  const dialog = visuals.computeDialogPosition({
    endpointX: 500,
    endpointY: 200,
    viewportWidth: 1000,
    viewportHeight: 800,
    dialogHeight: 250,
  });

  assert.equal(dialog.placement, 'below');
  assert.equal(dialog.left, 340);
  assert.equal(dialog.top, capsule.bottom + 14);
});

test('confirmation dialog flips above when the bottom edge is crowded', () => {
  const capsule = visuals.computeCapsuleRect({
    endpointX: 500,
    endpointY: 730,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  const dialog = visuals.computeDialogPosition({
    endpointX: 500,
    endpointY: 730,
    viewportWidth: 1000,
    viewportHeight: 800,
    dialogHeight: 250,
  });

  assert.equal(dialog.placement, 'above');
  assert.equal(dialog.top + 250 + 14, capsule.top);
});

test('capsule and dialog stay inside viewport side margins', () => {
  const capsule = visuals.computeCapsuleRect({
    endpointX: -100,
    endpointY: 100,
    viewportWidth: 600,
    viewportHeight: 500,
  });
  const dialog = visuals.computeDialogPosition({
    endpointX: 900,
    endpointY: 100,
    viewportWidth: 600,
    viewportHeight: 500,
    dialogHeight: 220,
  });

  assert.equal(capsule.left, 12);
  assert.equal(dialog.left, 268);
  assert.equal(dialog.left + dialog.width, 588);
});

test('reduced motion rope interpolation preserves both fixed endpoints', () => {
  const points = visuals.interpolateRopePoints({ x: 10, y: -4 }, { x: 210, y: 396 }, 20);
  assert.equal(points.length, 21);
  assert.deepEqual(points[0], { x: 10, y: -4 });
  assert.deepEqual(points[20], { x: 210, y: 396 });
  assert.deepEqual(points[10], { x: 110, y: 196 });
});

test('overlay renderer has no direct Electron access and exposes dialog semantics', () => {
  const root = path.resolve(__dirname, '../..');
  const html = fs.readFileSync(path.join(root, 'src/timer-overlay.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'src/timer-visuals.js'), 'utf8');

  assert.doesNotMatch(html, /require\s*\(\s*['"]electron['"]\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*['"]electron['"]\s*\)/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /prefers-reduced-transparency/);
  assert.match(html, /prefers-contrast/);
});

test('timer overlay uses a non-activating macOS panel', () => {
  const root = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');

  assert.match(source, /type:\s*process\.platform === 'darwin' \? 'panel' : undefined/);
  assert.match(source, /showInactive\(\)/);
  assert.ok(
    source.indexOf('timerOverlay.showInactive();') < source.indexOf('const actualOverlayBounds = timerOverlay.getBounds();'),
    'the panel must be shown before measuring its macOS-clamped bounds',
  );
});
