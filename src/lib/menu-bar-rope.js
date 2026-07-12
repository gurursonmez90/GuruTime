'use strict';

const { spawn } = require('child_process');

const MENU_BAR_ROPE_JXA = String.raw`
ObjC.import('Cocoa');

function run(argv) {
  $.NSApplication.sharedApplication;
  const x = Number(argv[0]);
  const y = Number(argv[1]);
  const width = Number(argv[2]);
  const height = Number(argv[3]);
  const red = Number(argv[4]);
  const green = Number(argv[5]);
  const blue = Number(argv[6]);
  const rect = $.NSMakeRect(x, y, width, height);
  const window = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    rect,
    0,
    $.NSBackingStoreBuffered,
    false,
  );
  const color = $.NSColor.colorWithSRGBRedGreenBlueAlpha(red, green, blue, 1);

  window.opaque = false;
  window.hasShadow = false;
  window.backgroundColor = $.NSColor.clearColor;
  window.ignoresMouseEvents = true;
  window.level = $.NSScreenSaverWindowLevel;
  window.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces
    | $.NSWindowCollectionBehaviorFullScreenAuxiliary
    | $.NSWindowCollectionBehaviorStationary;
  window.contentView.wantsLayer = true;
  window.contentView.layer.backgroundColor = color.CGColor;
  window.contentView.layer.cornerRadius = width / 2;
  window.orderFrontRegardless;
  $.NSApp.run;
}
`;

const ROPE_COLORS = Object.freeze({
  indigo: Object.freeze([119 / 255, 113 / 255, 232 / 255]),
  amber: Object.freeze([216 / 255, 135 / 255, 47 / 255]),
  cobalt: Object.freeze([63 / 255, 120 / 255, 216 / 255]),
  coral: Object.freeze([216 / 255, 100 / 255, 85 / 255]),
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rect(value = {}) {
  return {
    x: finite(value.x),
    y: finite(value.y),
    width: Math.max(1, finite(value.width, 1)),
    height: Math.max(1, finite(value.height, 1)),
  };
}

function ropeColorForTime(fireAt = Date.now()) {
  const date = new Date(Number(fireAt));
  const hour = Number.isFinite(date.getTime()) ? date.getHours() : 12;
  if (hour >= 22 || hour < 6) return ROPE_COLORS.indigo;
  if (hour < 12) return ROPE_COLORS.amber;
  if (hour < 18) return ROPE_COLORS.cobalt;
  return ROPE_COLORS.coral;
}

function computeMenuBarRopeWindow({
  trayBounds,
  displayBounds,
  workArea,
  primaryDisplayBounds,
  ropeWidth = 4,
  overlap = 2,
} = {}) {
  const tray = rect(trayBounds);
  const display = rect(displayBounds);
  const work = rect(workArea || displayBounds);
  const primary = rect(primaryDisplayBounds || displayBounds);
  const width = Math.max(2, Math.round(finite(ropeWidth, 4)));
  const menuTop = display.y;
  const menuBottom = Math.min(display.y + display.height, Math.max(menuTop + 1, work.y));
  const menuHeight = Math.max(1, menuBottom - menuTop);
  // The native status title is vertically centered. Starting at 64% of the
  // menu-bar height places the rope immediately under its text baseline.
  const screenTop = Math.round(menuTop + menuHeight * 0.64);
  const screenBottom = menuBottom + Math.max(0, Math.round(finite(overlap, 2)));
  const height = Math.max(1, screenBottom - screenTop);
  const x = Math.round(tray.x + tray.width / 2 - width / 2);
  const primaryBottom = primary.y + primary.height;

  return {
    x,
    y: Math.round(primaryBottom - (screenTop + height)),
    width,
    height,
    screenTop,
    screenBottom,
  };
}

function createMenuBarRopeController({
  platform = process.platform,
  spawnProcess = spawn,
} = {}) {
  let child = null;

  function hide() {
    const active = child;
    child = null;
    if (active && active.exitCode === null && !active.killed) active.kill('SIGTERM');
  }

  function show(options = {}) {
    hide();
    if (platform !== 'darwin') return null;

    const bounds = computeMenuBarRopeWindow(options);
    const color = ropeColorForTime(options.fireAt);
    const args = [
      '-l',
      'JavaScript',
      '-e',
      MENU_BAR_ROPE_JXA,
      '--',
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      ...color,
    ].map(String);
    const next = spawnProcess('/usr/bin/osascript', args, { stdio: 'ignore' });
    child = next;
    next.once('error', () => {
      if (child === next) child = null;
    });
    next.once('exit', () => {
      if (child === next) child = null;
    });
    return bounds;
  }

  return Object.freeze({ show, hide });
}

module.exports = {
  MENU_BAR_ROPE_JXA,
  ROPE_COLORS,
  computeMenuBarRopeWindow,
  createMenuBarRopeController,
  ropeColorForTime,
};
