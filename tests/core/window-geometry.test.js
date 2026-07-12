'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  computeTimerOverlayBounds,
  computeTrayAnchor,
  computeVisibleRopeAnchor,
} = require('../../src/lib/window-geometry');

test('timer overlay reaches behind the macOS menu bar while preserving the bottom work area', () => {
  const result = computeTimerOverlayBounds({
    displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 25, width: 1440, height: 850 },
    trayBounds: { x: 700, y: 0, width: 24, height: 25 },
    topClearance: 0,
  });

  assert.deepEqual(result, {
    x: 0,
    y: 0,
    width: 1440,
    height: 875,
    anchorX: 712,
    anchorY: 25,
  });
});

test('timer overlay geometry remains correct on a display above the primary screen', () => {
  const result = computeTimerOverlayBounds({
    displayBounds: { x: -200, y: -900, width: 1200, height: 900 },
    workArea: { x: -200, y: -875, width: 1200, height: 850 },
    trayBounds: { x: 300, y: -900, width: 20, height: 25 },
    topClearance: 0,
  });

  assert.equal(result.y, -900);
  assert.equal(result.height, 875);
  assert.equal(result.anchorX, 510);
  assert.equal(result.anchorY, 25);
});

test('timer overlay keeps the raw tray anchor available after macOS panel clamping', () => {
  const anchor = computeTrayAnchor({
    trayBounds: { x: 700, y: 0, width: 24, height: 25 },
    overlayBounds: { x: 0, y: 25, width: 1440, height: 850 },
  });

  assert.deepEqual(anchor, {
    x: 712,
    y: -12,
  });
});

test('timer overlay starts the rope at the first visible pixel below the menu bar', () => {
  assert.deepEqual(computeVisibleRopeAnchor({
    trayBounds: { x: 700, y: 0, width: 24, height: 25 },
    overlayBounds: { x: 0, y: 0, width: 1440, height: 875 },
    workArea: { x: 0, y: 25, width: 1440, height: 850 },
  }), {
    x: 712,
    y: 25,
  });

  assert.deepEqual(computeVisibleRopeAnchor({
    trayBounds: { x: 700, y: 0, width: 24, height: 25 },
    overlayBounds: { x: 0, y: 25, width: 1440, height: 850 },
    workArea: { x: 0, y: 25, width: 1440, height: 850 },
  }), {
    x: 712,
    y: 0,
  });
});
