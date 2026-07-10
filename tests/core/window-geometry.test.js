'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { computeTimerOverlayBounds } = require('../../src/lib/window-geometry');

test('timer overlay preserves the macOS menu bar and bottom work area', () => {
  const result = computeTimerOverlayBounds({
    displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 25, width: 1440, height: 850 },
    trayBounds: { x: 700, y: 0, width: 24, height: 25 },
    topClearance: 0,
  });

  assert.deepEqual(result, {
    x: 0,
    y: 25,
    width: 1440,
    height: 850,
    anchorX: 712,
    anchorY: 0,
  });
});

test('timer overlay geometry remains correct on a display above the primary screen', () => {
  const result = computeTimerOverlayBounds({
    displayBounds: { x: -200, y: -900, width: 1200, height: 900 },
    workArea: { x: -200, y: -875, width: 1200, height: 850 },
    trayBounds: { x: 300, y: -900, width: 20, height: 25 },
    topClearance: 0,
  });

  assert.equal(result.y, -875);
  assert.equal(result.height, 850);
  assert.equal(result.anchorX, 510);
  assert.equal(result.anchorY, 0);
});
