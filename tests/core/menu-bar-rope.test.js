'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  MENU_BAR_ROPE_JXA,
  computeMenuBarRopeWindow,
  createMenuBarRopeController,
  ropeColorForTime,
} = require('../../src/lib/menu-bar-rope');

test('menu bar rope starts below the status title and overlaps the canvas seam', () => {
  assert.deepEqual(computeMenuBarRopeWindow({
    trayBounds: { x: 3300, y: 0, width: 79, height: 30 },
    displayBounds: { x: 0, y: 0, width: 3440, height: 1440 },
    workArea: { x: 0, y: 30, width: 3440, height: 1410 },
    primaryDisplayBounds: { x: 0, y: 0, width: 3440, height: 1440 },
  }), {
    x: 3338,
    y: 1408,
    width: 4,
    height: 13,
    screenTop: 19,
    screenBottom: 32,
  });
});

test('menu bar rope converts displays above the primary screen to Cocoa coordinates', () => {
  const result = computeMenuBarRopeWindow({
    trayBounds: { x: 300, y: -900, width: 80, height: 30 },
    displayBounds: { x: -200, y: -900, width: 1200, height: 900 },
    workArea: { x: -200, y: -870, width: 1200, height: 870 },
    primaryDisplayBounds: { x: 0, y: 0, width: 1440, height: 900 },
  });

  assert.equal(result.screenTop, -881);
  assert.equal(result.y, 1768);
});

test('native menu bar segment stays above glass and passes pointer input through', () => {
  assert.match(MENU_BAR_ROPE_JXA, /NSScreenSaverWindowLevel/);
  assert.match(MENU_BAR_ROPE_JXA, /ignoresMouseEvents = true/);
  assert.match(MENU_BAR_ROPE_JXA, /cornerRadius = width \/ 2/);
});

test('menu bar rope controller launches fixed osascript and cleans it up', () => {
  const calls = [];
  const process = new EventEmitter();
  process.exitCode = null;
  process.killed = false;
  process.kill = (signal) => {
    process.killed = true;
    process.signal = signal;
  };
  const controller = createMenuBarRopeController({
    platform: 'darwin',
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return process;
    },
  });

  controller.show({
    trayBounds: { x: 100, y: 0, width: 80, height: 30 },
    displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 30, width: 1440, height: 870 },
    primaryDisplayBounds: { x: 0, y: 0, width: 1440, height: 900 },
    fireAt: new Date(2026, 6, 12, 12).getTime(),
  });
  controller.hide();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/osascript');
  assert.deepEqual(calls[0].options, { stdio: 'ignore' });
  assert.equal(process.signal, 'SIGTERM');
});

test('menu bar rope color matches timer hour bands', () => {
  assert.deepEqual(ropeColorForTime(new Date(2026, 6, 12, 5).getTime()), [119 / 255, 113 / 255, 232 / 255]);
  assert.deepEqual(ropeColorForTime(new Date(2026, 6, 12, 9).getTime()), [216 / 255, 135 / 255, 47 / 255]);
  assert.deepEqual(ropeColorForTime(new Date(2026, 6, 12, 12).getTime()), [63 / 255, 120 / 255, 216 / 255]);
  assert.deepEqual(ropeColorForTime(new Date(2026, 6, 12, 20).getTime()), [216 / 255, 100 / 255, 85 / 255]);
});
