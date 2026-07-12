'use strict';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizedRect(value = {}) {
  return {
    x: finite(value.x),
    y: finite(value.y),
    width: Math.max(1, finite(value.width, 1)),
    height: Math.max(1, finite(value.height, 1)),
  };
}

function computeTrayAnchor({
  trayBounds,
  overlayBounds,
} = {}) {
  const tray = normalizedRect(trayBounds);
  const overlay = normalizedRect(overlayBounds);

  return {
    x: Math.round(tray.x + tray.width / 2 - overlay.x),
    y: Math.round(tray.y + tray.height / 2 - overlay.y),
  };
}

function computeVisibleRopeAnchor({
  trayBounds,
  overlayBounds,
  workArea,
  topClearance = 0,
} = {}) {
  const overlay = normalizedRect(overlayBounds);
  const work = normalizedRect(workArea || overlayBounds);
  const anchor = computeTrayAnchor({ trayBounds, overlayBounds });
  const clearance = Math.max(0, finite(topClearance));
  const visibleTop = Math.max(0, work.y - overlay.y) + clearance;
  const y = Math.max(visibleTop, anchor.y + clearance);

  return {
    x: anchor.x,
    y: Math.round(Math.min(Math.max(0, overlay.height - 1), y)),
  };
}

function computeTimerOverlayBounds({
  displayBounds,
  workArea,
  trayBounds,
  topClearance = 0,
} = {}) {
  const display = normalizedRect(displayBounds);
  const work = normalizedRect(workArea || displayBounds);
  const tray = normalizedRect(trayBounds);
  const clearance = Math.max(0, finite(topClearance));
  const workBottom = Math.min(display.y + display.height, work.y + work.height);
  // Start the transparent panel at the display edge so the rope can be
  // painted behind the macOS menu bar and meet its tray icon without a gap.
  // The panel still ends at the work area's bottom edge, preserving the Dock.
  const y = display.y;
  const height = Math.max(1, workBottom - y);
  const overlay = { x: display.x, y, width: display.width, height };
  const anchor = computeVisibleRopeAnchor({
    trayBounds: tray,
    overlayBounds: overlay,
    workArea: work,
    topClearance: clearance,
  });

  return {
    x: display.x,
    y,
    width: display.width,
    height,
    anchorX: anchor.x,
    anchorY: anchor.y,
  };
}

module.exports = { computeTimerOverlayBounds, computeTrayAnchor, computeVisibleRopeAnchor };
