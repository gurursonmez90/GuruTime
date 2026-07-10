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
  const workTop = Math.max(display.y, work.y);
  const workBottom = Math.min(display.y + display.height, work.y + work.height);
  const trayBottom = tray.y + tray.height;
  const wantedTop = Math.max(workTop, trayBottom + clearance);
  const y = Math.min(wantedTop, Math.max(workTop, workBottom - 1));

  return {
    x: display.x,
    y,
    width: display.width,
    height: Math.max(1, workBottom - y),
    anchorX: Math.round(tray.x + tray.width / 2 - display.x),
    anchorY: Math.round(trayBottom - y),
  };
}

module.exports = { computeTimerOverlayBounds };
