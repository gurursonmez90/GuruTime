'use strict';

const {
  app,
  BrowserWindow,
  Notification,
  Tray,
  clipboard,
  ipcMain,
  nativeImage,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const QRCode = require('qrcode');

const {
  ACTIONS,
  AppStateV2,
  freezeFireAt,
  validateMinutes,
} = require('./lib/app-state-v2');
const { LocalAuth } = require('./lib/local-auth');
const { LocalControlServer } = require('./lib/local-control-server');
const { SettingsStore } = require('./lib/settings-store');
const { SignedUpdateClient } = require('./lib/update-client');

let CloudRelayClient = null;
try {
  ({ CloudRelayClient } = require('./lib/cloud-client'));
} catch (_) {
  CloudRelayClient = null;
}

try { app.dock?.hide(); } catch (_) {}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  const POPOVER_WIDTH = 440;
  const POPOVER_HEIGHT = 820;
  const OVERLAY_TOP_CLEARANCE = 42;
  const DEFAULT_REMOTE_PORT = 47831;
  const ALARM_SOUND_PATH = '/System/Library/Sounds/Glass.aiff';
  const BALANCED_CADENCE_SECONDS = Object.freeze([0, 8, 20, 40, 70, 100]);
  const STRONG_CADENCE_SECONDS = Object.freeze([0, 5, 12, 22, 35, 50, 70, 95, 115]);
  const ALARM_SOUND_LIMIT_MS = 120 * 1000;
  const FOLLOWUP_NOTIFICATION_MS = 5 * 60 * 1000;

  const userDataPath = app.getPath('userData');
  const appStatePath = path.join(userDataPath, 'app-state-v2.json');
  const legacyTodosPath = path.join(userDataPath, 'todos.json');
  const legacyAlarmsPath = path.join(userDataPath, 'alarms.json');
  const authPath = path.join(userDataPath, 'local-auth-v2.json');
  const settingsPath = path.join(userDataPath, 'settings-v1.json');
  const cloudCredentialsPath = path.join(userDataPath, 'cloud-credentials-v1.json');
  const hermesCommandDir = path.join(userDataPath, 'hermes-commands');
  const mobileClientPath = path.join(__dirname, 'mobile-control.html');
  const preloadPath = path.join(__dirname, 'preload.js');

  let tray = null;
  let mainWindow = null;
  let timerOverlay = null;
  let alarmWindow = null;
  let appState = null;
  let auth = null;
  let settingsStore = null;
  let settings = null;
  let localServer = null;
  let cloudClient = null;
  let updateCheckTimer = null;
  let updateCheckBusy = false;
  let remoteInfo = { enabled: false, port: 0, urls: [], primaryUrl: '', devices: [] };
  let cloudInfo = { enabled: false, enrolled: false, connected: false, devices: [], lastError: '' };
  let quitting = false;

  let mouseDownAt = 0;
  let holdTimer = null;
  let cursorTimer = null;
  let trayStatusTimer = null;
  let trayOriginY = 0;
  let selectedMinutes = 0;
  let dragging = false;
  let pendingTimerSelection = null;

  const alarmScheduleTimers = new Map();
  const ringingQueue = [];
  const followupTimers = new Map();
  const nativeNotifications = new Map();
  const notifiedOccurrences = new Set();
  const silencedOccurrences = new Set();
  const soundTimers = new Set();
  const soundPlayers = new Set();
  let soundingOccurrence = '';

  let hermesWatcher = null;
  let hermesScanTimer = null;
  const hermesInFlight = new Set();

  function logError(...args) {
    console.error('[GuruTime]', ...args);
  }

  function occurrenceKey(alarmOrId, occurrence) {
    if (typeof alarmOrId === 'object' && alarmOrId) {
      return `${alarmOrId.id}:${Number(alarmOrId.occurrence) || 0}`;
    }
    return `${String(alarmOrId || '')}:${Number(occurrence) || 0}`;
  }

  function getSnapshot() {
    return appState ? appState.getState() : {
      version: 2,
      revision: 0,
      todos: [],
      activeAlarms: [],
      alarmHistory: [],
      processedCommandIds: [],
    };
  }

  function activeAlarmById(id) {
    return getSnapshot().activeAlarms.find((alarm) => alarm.id === String(id || '')) || null;
  }

  function cleanTitle(value) {
    const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (!title || title.length > 240) throw new Error('Görev adı 1 ile 240 karakter arasında olmalı.');
    return title;
  }

  function cleanCategory(value) {
    return ['important', 'later', 'today'].includes(value) ? value : 'today';
  }

  function cleanIdentifier(value, label = 'Kimlik') {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || id.length > 160) throw new Error(`${label} geçersiz.`);
    return id;
  }

  function secureWebPreferences(extra = {}) {
    return {
      preload: preloadPath,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
      ...extra,
    };
  }

  function lockDownWebContents(webContents) {
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file://')) event.preventDefault();
    });
    webContents.on('will-attach-webview', (event) => event.preventDefault());
  }

  function isSender(event, window) {
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
  }

  function requireMainSender(event) {
    if (!isSender(event, mainWindow)) throw new Error('Bu işlem bu pencereden kullanılamaz.');
  }

  function requireOverlaySender(event) {
    if (!isSender(event, timerOverlay)) throw new Error('Zamanlayıcı isteği reddedildi.');
  }

  function requireAlarmSender(event) {
    if (!isSender(event, alarmWindow)) throw new Error('Alarm isteği reddedildi.');
  }

  function requireUnlocked() {
    if (!auth?.isUnlocked()) {
      const error = new Error('GuruTime kilitli.');
      error.code = 'APP_LOCKED';
      throw error;
    }
  }

  function sendToMain(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  }

  function broadcastSnapshot(snapshot = getSnapshot()) {
    sendToMain('reload-todos');
    sendToMain('alarms-updated', snapshot.activeAlarms);
    updateTrayStatus(snapshot);
  }

  function configureMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    mainWindow = new BrowserWindow({
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      roundedCorners: true,
      skipTaskbar: true,
      webPreferences: secureWebPreferences(),
    });
    lockDownWebContents(mainWindow.webContents);
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.on('blur', () => {
      if (!dragging && !quitting) mainWindow.hide();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    return mainWindow;
  }

  function positionMainWindow() {
    if (!tray || !mainWindow || mainWindow.isDestroyed()) return;
    const trayBounds = tray.getBounds();
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    const workArea = display.workArea;
    const y = Math.round(trayBounds.y + trayBounds.height + 6);
    const availableHeight = Math.max(1, workArea.y + workArea.height - y - 10);
    const height = Math.max(Math.min(520, availableHeight), Math.min(POPOVER_HEIGHT, availableHeight));
    const width = Math.min(POPOVER_WIDTH, workArea.width - 20);
    const rawX = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
    const x = Math.min(Math.max(rawX, workArea.x + 10), workArea.x + workArea.width - width - 10);
    mainWindow.setBounds({ x, y, width, height });
  }

  function showMainWindow() {
    configureMainWindow();
    positionMainWindow();
    mainWindow.show();
    mainWindow.focus();
    sendToMain('popover-opened');
  }

  function toggleMainWindow() {
    configureMainWindow();
    if (mainWindow.isVisible()) mainWindow.hide();
    else showMainWindow();
  }

  function configureTimerOverlay() {
    if (timerOverlay && !timerOverlay.isDestroyed()) timerOverlay.destroy();
    const trayBounds = tray.getBounds();
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    const bounds = display.bounds;
    const overlayY = Math.max(bounds.y, trayBounds.y + trayBounds.height + OVERLAY_TOP_CLEARANCE);
    timerOverlay = new BrowserWindow({
      x: bounds.x,
      y: overlayY,
      width: bounds.width,
      height: Math.max(1, bounds.y + bounds.height - overlayY),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      resizable: false,
      fullscreenable: false,
      show: false,
      webPreferences: secureWebPreferences({ backgroundThrottling: false }),
    });
    lockDownWebContents(timerOverlay.webContents);
    timerOverlay.setAlwaysOnTop(true, 'floating');
    timerOverlay.loadFile(path.join(__dirname, 'timer-overlay.html'));
    timerOverlay.webContents.once('did-finish-load', () => {
      if (!timerOverlay || timerOverlay.isDestroyed()) return;
      const anchorX = Math.round(trayBounds.x + trayBounds.width / 2 - bounds.x);
      timerOverlay.webContents.send('init-anchor', { x: anchorX, y: -OVERLAY_TOP_CLEARANCE });
      timerOverlay.showInactive();
      startCursorTracking();
    });
    timerOverlay.on('closed', () => {
      timerOverlay = null;
      pendingTimerSelection = null;
      stopCursorTracking();
    });
  }

  function destroyTimerOverlay() {
    pendingTimerSelection = null;
    if (timerOverlay && !timerOverlay.isDestroyed()) timerOverlay.destroy();
    timerOverlay = null;
  }

  function minutesForDistance(distance) {
    const dist = Math.max(0, Number(distance) || 0);
    let minutes = 0;
    if (dist > 10 && dist < 300) minutes = Math.round((dist - 10) / 4.8);
    else if (dist >= 300 && dist < 500) minutes = 60 + Math.round((dist - 300) / 1.67);
    else if (dist >= 500 && dist < 700) minutes = 180 + Math.round((dist - 500) * 1.5);
    else if (dist >= 700) minutes = 480 + Math.round((dist - 700) * 3.2);
    return Math.max(0, Math.min(1440, minutes));
  }

  function beginTimerDrag() {
    if (!auth.isUnlocked()) {
      showMainWindow();
      return;
    }
    dragging = true;
    selectedMinutes = 0;
    const trayBounds = tray.getBounds();
    trayOriginY = trayBounds.y + trayBounds.height;
    configureTimerOverlay();
  }

  function startCursorTracking() {
    if (cursorTimer) clearInterval(cursorTimer);
    cursorTimer = setInterval(() => {
      if (!timerOverlay || timerOverlay.isDestroyed()) return;
      const cursor = screen.getCursorScreenPoint();
      const minutes = minutesForDistance(cursor.y - trayOriginY);
      selectedMinutes = minutes;
      const bounds = timerOverlay.getBounds();
      timerOverlay.webContents.send('timer-update', {
        dist: Math.max(0, cursor.y - trayOriginY),
        minutes,
        fireAt: minutes ? Date.now() + minutes * 60 * 1000 : 0,
        cursorXScreen: cursor.x - bounds.x,
        cursorYScreen: cursor.y - bounds.y,
      });
    }, 30);
  }

  function stopCursorTracking() {
    if (cursorTimer) clearInterval(cursorTimer);
    cursorTimer = null;
    dragging = false;
  }

  function releaseTimerDrag() {
    stopCursorTracking();
    const minutes = selectedMinutes;
    if (!timerOverlay || timerOverlay.isDestroyed()) return;
    if (!minutes) {
      destroyTimerOverlay();
      return;
    }
    const fireAt = freezeFireAt(minutes, Date.now());
    pendingTimerSelection = { minutes, fireAt, releasedAt: Date.now() };
    timerOverlay.webContents.send('timer-release', { minutes, fireAt });
    timerOverlay.show();
    timerOverlay.focus();
  }

  function configureAlarmWindow() {
    if (alarmWindow && !alarmWindow.isDestroyed()) return alarmWindow;
    alarmWindow = new BrowserWindow({
      width: 460,
      height: 510,
      minWidth: 380,
      minHeight: 440,
      show: false,
      frame: false,
      resizable: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      roundedCorners: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      webPreferences: secureWebPreferences({ backgroundThrottling: false }),
    });
    lockDownWebContents(alarmWindow.webContents);
    alarmWindow.setAlwaysOnTop(true, 'floating');
    alarmWindow.loadFile(path.join(__dirname, 'alarm-window.html'));
    alarmWindow.webContents.once('did-finish-load', sendAlarmWindowState);
    alarmWindow.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        alarmWindow.hide();
      }
    });
    alarmWindow.on('closed', () => { alarmWindow = null; });
    return alarmWindow;
  }

  function positionAlarmWindow() {
    if (!alarmWindow || alarmWindow.isDestroyed()) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const work = display.workArea;
    const bounds = alarmWindow.getBounds();
    alarmWindow.setPosition(
      Math.round(work.x + (work.width - bounds.width) / 2),
      Math.round(work.y + Math.max(22, (work.height - bounds.height) * 0.34)),
      false,
    );
  }

  function currentRingingAlarm(snapshot = getSnapshot()) {
    while (ringingQueue.length) {
      const key = ringingQueue[0];
      const alarm = snapshot.activeAlarms.find((item) => occurrenceKey(item) === key && item.status === 'ringing');
      if (alarm) return alarm;
      ringingQueue.shift();
    }
    return null;
  }

  function sendAlarmWindowState() {
    if (!alarmWindow || alarmWindow.isDestroyed()) return;
    const snapshot = getSnapshot();
    const alarm = currentRingingAlarm(snapshot);
    if (!alarm) {
      alarmWindow.hide();
      return;
    }
    const overdueMinutes = Math.max(0, Math.floor((Date.now() - Number(alarm.fireAt)) / 60000));
    alarmWindow.webContents.send('alarm-window-state', {
      alarm,
      queueCount: Math.max(0, ringingQueue.length - 1),
      overdueMinutes,
      privacyMode: !auth.isUnlocked(),
    });
  }

  function showAlarmWindowInactive() {
    const alarm = currentRingingAlarm();
    if (!alarm) return;
    configureAlarmWindow();
    positionAlarmWindow();
    sendAlarmWindowState();
    alarmWindow.showInactive();
  }

  function playAlarmSound(volume = 0.6) {
    if (!fs.existsSync(ALARM_SOUND_PATH)) return;
    try {
      const child = spawn('/usr/bin/afplay', ['-v', String(volume), ALARM_SOUND_PATH], { stdio: 'ignore' });
      soundPlayers.add(child);
      const remove = () => soundPlayers.delete(child);
      child.once('exit', remove);
      child.once('error', (error) => { remove(); logError('Alarm sesi çalınamadı', error); });
    } catch (error) {
      logError('Alarm sesi başlatılamadı', error);
    }
  }

  function stopAlarmCadence() {
    for (const timer of soundTimers) clearTimeout(timer);
    soundTimers.clear();
    for (const child of soundPlayers) {
      try { if (!child.killed) child.kill(); } catch (_) {}
    }
    soundPlayers.clear();
    soundingOccurrence = '';
  }

  function startAlarmCadence(alarm) {
    const key = occurrenceKey(alarm);
    if (soundingOccurrence === key || silencedOccurrences.has(key)) return;
    stopAlarmCadence();
    soundingOccurrence = key;
    const mode = settings.alarmMode || 'balanced';
    const cadence = mode === 'strong' ? STRONG_CADENCE_SECONDS : (mode === 'quiet' ? [0] : BALANCED_CADENCE_SECONDS);
    cadence.forEach((seconds, index) => {
      const timer = setTimeout(() => {
        soundTimers.delete(timer);
        const current = currentRingingAlarm();
        if (!current || occurrenceKey(current) !== key) return;
        const volume = mode === 'quiet' ? 0.28 : Math.min(1, 0.34 + index * (mode === 'strong' ? 0.09 : 0.11));
        playAlarmSound(volume);
      }, seconds * 1000);
      soundTimers.add(timer);
    });
    const stopTimer = setTimeout(() => {
      soundTimers.delete(stopTimer);
      if (soundingOccurrence === key) {
        silencedOccurrences.add(key);
        stopAlarmCadence();
      }
    }, ALARM_SOUND_LIMIT_MS);
    soundTimers.add(stopTimer);
  }

  function nativeNotificationBody(alarm) {
    return settings.notificationPrivacy === 'detailed' ? alarm.taskTitle : 'Bir alarmınız çalıyor.';
  }

  function showNativeAlarmNotification(alarm, followup = false) {
    if (!Notification.isSupported()) return;
    const key = occurrenceKey(alarm);
    try {
      const notification = new Notification({
        title: followup ? 'GuruTime alarmı hâlâ açık' : 'GuruTime alarmı',
        body: nativeNotificationBody(alarm),
        silent: true,
        timeoutType: 'never',
        actions: [
          { type: 'button', text: '10 dk ertele' },
          { type: 'button', text: 'Tamam' },
        ],
        closeButtonText: 'Gizle',
      });
      nativeNotifications.set(`${key}:${followup ? 'followup' : 'initial'}`, notification);
      notification.on('click', () => {
        showAlarmWindowInactive();
        if (alarmWindow && !alarmWindow.isDestroyed()) alarmWindow.show();
      });
      notification.on('action', (_event, index) => {
        if (index === 0) void snoozeAlarmOccurrence(alarm.id, alarm.occurrence, 10);
        if (index === 1) void dismissAlarmOccurrence(alarm.id, alarm.occurrence);
      });
      notification.on('close', () => nativeNotifications.delete(`${key}:${followup ? 'followup' : 'initial'}`));
      notification.show();
    } catch (error) {
      logError('Sistem bildirimi gösterilemedi', error);
    }
  }

  function ensureFollowupNotification(alarm) {
    const key = occurrenceKey(alarm);
    if (followupTimers.has(key)) return;
    const ringingAt = Date.parse(alarm.startedRingingAt || '') || Date.now();
    const delay = Math.max(0, ringingAt + FOLLOWUP_NOTIFICATION_MS - Date.now());
    const timer = setTimeout(() => {
      followupTimers.delete(key);
      const current = activeAlarmById(alarm.id);
      if (current?.status === 'ringing' && current.occurrence === alarm.occurrence) {
        showNativeAlarmNotification(current, true);
      }
    }, delay);
    followupTimers.set(key, timer);
  }

  function synchronizeRinging(snapshot = getSnapshot()) {
    const ringing = snapshot.activeAlarms
      .filter((alarm) => alarm.status === 'ringing')
      .sort((left, right) => {
        const leftStart = Date.parse(left.startedRingingAt || '') || left.fireAt;
        const rightStart = Date.parse(right.startedRingingAt || '') || right.fireAt;
        return leftStart - rightStart;
      });
    const validKeys = new Set(ringing.map(occurrenceKey));
    for (let index = ringingQueue.length - 1; index >= 0; index -= 1) {
      if (!validKeys.has(ringingQueue[index])) ringingQueue.splice(index, 1);
    }
    for (const alarm of ringing) {
      const key = occurrenceKey(alarm);
      if (!ringingQueue.includes(key)) ringingQueue.push(key);
      if (!notifiedOccurrences.has(key)) {
        notifiedOccurrences.add(key);
        showNativeAlarmNotification(alarm, false);
      }
      ensureFollowupNotification(alarm);
    }
    for (const [key, timer] of followupTimers) {
      if (!validKeys.has(key)) {
        clearTimeout(timer);
        followupTimers.delete(key);
      }
    }
    for (const key of silencedOccurrences) {
      if (!validKeys.has(key)) silencedOccurrences.delete(key);
    }
    for (const key of notifiedOccurrences) {
      if (!validKeys.has(key)) notifiedOccurrences.delete(key);
    }
    const current = currentRingingAlarm(snapshot);
    if (!current) {
      stopAlarmCadence();
      if (alarmWindow && !alarmWindow.isDestroyed()) alarmWindow.hide();
      return;
    }
    startAlarmCadence(current);
    showAlarmWindowInactive();
  }

  async function ringAlarmOccurrence(id, occurrence) {
    const result = await appState.ringAlarm(id, occurrence);
    return result.result;
  }

  async function dismissAlarmOccurrence(id, occurrence) {
    const result = await appState.dismissAlarm(id, occurrence);
    if (!result.result.applied) return result.result;
    return result.result;
  }

  async function snoozeAlarmOccurrence(id, occurrence, minutes) {
    validateMinutes(minutes);
    const result = await appState.snoozeAlarm(id, occurrence, minutes);
    return result.result;
  }

  async function completeAlarmOccurrence(id, occurrence) {
    const result = await appState.completeAlarm(id, occurrence);
    return result.result;
  }

  function clearScheduledAlarmTimers() {
    for (const timer of alarmScheduleTimers.values()) clearTimeout(timer);
    alarmScheduleTimers.clear();
  }

  function scheduleActiveAlarms(snapshot = getSnapshot()) {
    clearScheduledAlarmTimers();
    const now = Date.now();
    for (const alarm of snapshot.activeAlarms) {
      if (alarm.status !== 'scheduled') continue;
      const delay = Number(alarm.fireAt) - now;
      const key = occurrenceKey(alarm);
      if (delay <= 0) {
        queueMicrotask(() => void ringAlarmOccurrence(alarm.id, alarm.occurrence).catch(logError));
        continue;
      }
      const timer = setTimeout(() => {
        alarmScheduleTimers.delete(key);
        void ringAlarmOccurrence(alarm.id, alarm.occurrence).catch(logError);
      }, Math.min(delay, 2 ** 31 - 1));
      alarmScheduleTimers.set(key, timer);
    }
  }

  async function reconcileAlarmsAfterWake() {
    clearScheduledAlarmTimers();
    await appState.reconcileAlarms(Date.now());
    const snapshot = getSnapshot();
    scheduleActiveAlarms(snapshot);
    synchronizeRinging(snapshot);
  }

  function formatTrayDuration(minutes) {
    const value = Math.max(1, Math.round(Number(minutes) || 1));
    if (value >= 1440) return '24sa';
    if (value >= 60) {
      const hours = Math.floor(value / 60);
      const rest = value % 60;
      return rest ? `${hours}sa${rest}dk` : `${hours}sa`;
    }
    return `${value}dk`;
  }

  function updateTrayStatus(snapshot = getSnapshot()) {
    if (!tray || process.platform !== 'darwin') return;
    const alarms = snapshot.activeAlarms.slice().sort((left, right) => Number(left.fireAt) - Number(right.fireAt));
    const alarm = alarms[0];
    if (!alarm) {
      tray.setTitle('GuruTime');
      tray.setToolTip('GuruTime');
      return;
    }
    const title = String(alarm.taskTitle || 'Zaman doldu').replace(/\s+/g, ' ').trim();
    const compactTitle = title.length > 18 ? `${title.slice(0, 17)}…` : title;
    const suffix = alarms.length > 1 ? ` +${alarms.length - 1}` : '';
    tray.setTitle(alarm.status === 'ringing' ? `Çalıyor${suffix}` : `${compactTitle} ${formatTrayDuration(alarm.minutes)}${suffix}`);
    tray.setToolTip(alarm.status === 'ringing' ? `${title} alarmı çalıyor` : `${title}, ${formatTrayDuration(alarm.minutes)} sonra`);
  }

  function configureTray() {
    if (tray) return;
    const template2x = path.join(__dirname, '..', 'assets', 'tray-iconTemplate@2x.png');
    const template1x = path.join(__dirname, '..', 'assets', 'tray-iconTemplate.png');
    const source = fs.existsSync(template2x) ? template2x : template1x;
    if (fs.existsSync(source)) {
      const icon = nativeImage.createFromPath(source);
      icon.setTemplateImage(true);
      tray = new Tray(icon.resize({ width: 18, height: 18 }));
    } else {
      tray = new Tray(nativeImage.createEmpty());
      tray.setTitle('◷');
    }
    tray.setToolTip('GuruTime');
    tray.on('mouse-down', () => {
      mouseDownAt = Date.now();
      holdTimer = setTimeout(() => {
        if (mouseDownAt) beginTimerDrag();
      }, 250);
    });
    tray.on('mouse-up', () => {
      const heldFor = Date.now() - mouseDownAt;
      mouseDownAt = 0;
      clearTimeout(holdTimer);
      holdTimer = null;
      if (dragging) releaseTimerDrag();
      else if (heldFor < 250) toggleMainWindow();
    });
    trayStatusTimer = setInterval(updateTrayStatus, 30000);
    updateTrayStatus();
  }

  function applyLoginSetting() {
    if (process.platform !== 'darwin' || !app.isPackaged) return;
    try {
      app.setLoginItemSettings({
        openAtLogin: settings.launchAtLogin === true,
        openAsHidden: true,
      });
    } catch (error) {
      logError('Başlangıç ayarı uygulanamadı', error);
    }
  }

  async function checkForSignedUpdate() {
    if (!app.isPackaged || updateCheckBusy || !settings.downloadsOrigin) return;
    const publicKeyPath = path.join(__dirname, 'update-public-key.pem');
    if (!fs.existsSync(publicKeyPath)) {
      logError('İmzalı güncelleme anahtarı pakette bulunamadı; otomatik kontrol kapalı.');
      return;
    }
    updateCheckBusy = true;
    try {
      const client = new SignedUpdateClient({
        origin: settings.downloadsOrigin,
        channel: settings.updateChannel,
        currentVersion: app.getVersion(),
        publicKeyPath,
      });
      const available = await client.check();
      if (!available.available) return;
      const destination = path.join(app.getPath('temp'), 'gurutime-updates', available.version);
      const dmgPath = await client.download(available.artifact, destination);
      if (!Notification.isSupported()) return;
      const notification = new Notification({
        title: `GuruTime ${available.version} hazır`,
        body: 'İmzalı ve doğrulanmış güncellemeyi açmak için tıklayın.',
        silent: true,
      });
      notification.on('click', () => void shell.openPath(dmgPath));
      notification.show();
    } catch (error) {
      logError('İmzalı güncelleme kontrolü başarısız', error);
    } finally {
      updateCheckBusy = false;
    }
  }

  function scheduleUpdateChecks() {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
    if (!app.isPackaged || !settings.downloadsOrigin) return;
    setTimeout(() => void checkForSignedUpdate(), 45000);
    updateCheckTimer = setInterval(() => void checkForSignedUpdate(), 6 * 60 * 60 * 1000);
  }

  async function applyLocalServerSetting() {
    if (!localServer) {
      localServer = new LocalControlServer({
        port: DEFAULT_REMOTE_PORT,
        mobileFile: mobileClientPath,
        getSnapshot: async () => {
          requireUnlocked();
          const snapshot = getSnapshot();
          return { todos: snapshot.todos, activeAlarms: snapshot.activeAlarms, revision: snapshot.revision };
        },
        executeCommand: executeControllerCommand,
      });
    }
    try {
      if (settings.localNetworkEnabled) await localServer.start();
      else await localServer.stop();
      remoteInfo = { ...localServer.getInfo(), devices: localServer.listSessions(), error: '' };
    } catch (error) {
      remoteInfo = { enabled: false, port: 0, urls: [], primaryUrl: '', devices: [], error: error.message };
      logError('Yerel ağ sunucusu ayarlanamadı', error);
    }
    sendToMain('remote-updated', remoteInfo);
    return remoteInfo;
  }

  async function applyCloudSetting() {
    if (!CloudRelayClient) {
      cloudInfo = {
        enabled: settings.cloudEnabled,
        enrolled: false,
        connected: false,
        devices: [],
        lastError: settings.cloudEnabled ? 'Cloud relay modülü kullanılamıyor.' : '',
      };
      sendToMain('cloud-relay-updated', cloudInfo);
      return cloudInfo;
    }
    if (!cloudClient) {
      cloudClient = new CloudRelayClient({
        credentialsPath: cloudCredentialsPath,
        safeStorage,
        onCommand: executeControllerCommand,
        onInfo: (info) => {
          cloudInfo = { ...cloudInfo, ...info };
          sendToMain('cloud-relay-updated', cloudInfo);
        },
        onError: (error) => logError('Cloud relay', error),
      });
    }
    await cloudClient.configure({ enabled: settings.cloudEnabled, origin: settings.cloudOrigin });
    cloudInfo = cloudClient.getInfo();
    sendToMain('cloud-relay-updated', cloudInfo);
    if (settings.cloudEnabled) {
      const alarms = settings.phoneNotifications ? getSnapshot().activeAlarms : [];
      void cloudClient.syncAlarms(alarms).catch(logError);
    }
    return cloudInfo;
  }

  function actionForControllerCommand(command) {
    const type = String(command.type || command.kind || '').trim();
    const payload = command.payload && typeof command.payload === 'object' ? command.payload : command;
    if (type === 'task.add' || type === 'task.create') {
      return { type: ACTIONS.TODO_ADD, payload: { title: cleanTitle(payload.title), category: cleanCategory(payload.category), source: payload.source || 'phone' } };
    }
    if (type === 'task.update') {
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(payload, 'title')) patch.title = cleanTitle(payload.title);
      if (Object.prototype.hasOwnProperty.call(payload, 'category')) patch.category = cleanCategory(payload.category);
      if (Object.prototype.hasOwnProperty.call(payload, 'isDone')) patch.isDone = Boolean(payload.isDone);
      if (Object.prototype.hasOwnProperty.call(payload, 'isArchived')) patch.isArchived = Boolean(payload.isArchived);
      return { type: ACTIONS.TODO_UPDATE, payload: { id: cleanIdentifier(payload.taskId || payload.id, 'Görev kimliği'), patch } };
    }
    if (type === 'task.toggle') {
      const id = cleanIdentifier(payload.taskId || payload.id, 'Görev kimliği');
      const todo = getSnapshot().todos.find((item) => item.id === id);
      if (!todo) throw new Error('Görev bulunamadı.');
      return { type: ACTIONS.TODO_UPDATE, payload: { id, patch: { isDone: !todo.isDone } } };
    }
    if (type === 'task.delete') {
      return { type: ACTIONS.TODO_DELETE, payload: { id: cleanIdentifier(payload.taskId || payload.id, 'Görev kimliği') } };
    }
    if (type === 'alarm.add') {
      const taskId = cleanIdentifier(payload.taskId, 'Görev kimliği');
      const todo = getSnapshot().todos.find((item) => item.id === taskId);
      if (!todo) throw new Error('Görev bulunamadı.');
      const minutes = validateMinutes(payload.minutes);
      const fireAt = payload.fireAt == null ? freezeFireAt(minutes) : Number(payload.fireAt);
      return { type: ACTIONS.ALARM_ADD, payload: { taskId, taskTitle: todo.title, minutes, fireAt } };
    }
    if (type === 'alarm.create') {
      const title = cleanTitle(payload.title);
      const fireAt = Number(payload.fireAt);
      const remainingMs = fireAt - Date.now();
      const minutes = validateMinutes(Math.max(1, Math.ceil(remainingMs / 60000)));
      return {
        type: ACTIONS.TODO_ADD_WITH_ALARM,
        payload: {
          title,
          category: cleanCategory(payload.category),
          source: payload.source || 'phone',
          minutes,
          fireAt,
        },
      };
    }
    if (type === 'alarm.cancel') {
      const id = cleanIdentifier(payload.alarmId || payload.id, 'Alarm kimliği');
      return { type: ACTIONS.ALARM_CANCEL, payload: { id, occurrence: payload.occurrence } };
    }
    throw new Error('Desteklenmeyen telefon komutu.');
  }

  async function executeControllerCommand(command, context = {}) {
    requireUnlocked();
    if (!command || typeof command !== 'object') throw new Error('Komut geçersiz.');
    const commandId = cleanIdentifier(command.commandId, 'Komut kimliği');
    const action = actionForControllerCommand({ ...command, payload: { ...(command.payload || {}), source: context.source || 'cloud' } });
    const response = await appState.applyCommand(commandId, action);
    return { ok: true, duplicate: Boolean(response.result?.duplicate), result: response.result?.result || response.result };
  }

  function syncCloudAlarms(snapshot = getSnapshot()) {
    if (cloudClient && settings.cloudEnabled) {
      const alarms = settings.phoneNotifications ? snapshot.activeAlarms : [];
      void cloudClient.syncAlarms(alarms).catch((error) => logError('Alarm bulut senkronu', error));
    }
  }

  function onStateChanged(snapshot) {
    broadcastSnapshot(snapshot);
    scheduleActiveAlarms(snapshot);
    synchronizeRinging(snapshot);
    syncCloudAlarms(snapshot);
  }

  function mapTodoMutation(request) {
    const type = String(request?.type || '');
    if (type === 'add') return appState.addTodo({ title: cleanTitle(request.title), category: cleanCategory(request.category) });
    if (type === 'update') {
      const patch = request.patch && typeof request.patch === 'object' ? request.patch : {};
      const allowed = {};
      if (Object.prototype.hasOwnProperty.call(patch, 'title')) allowed.title = cleanTitle(patch.title);
      if (Object.prototype.hasOwnProperty.call(patch, 'category')) allowed.category = cleanCategory(patch.category);
      if (Object.prototype.hasOwnProperty.call(patch, 'isDone')) allowed.isDone = Boolean(patch.isDone);
      if (Object.prototype.hasOwnProperty.call(patch, 'isArchived')) allowed.isArchived = Boolean(patch.isArchived);
      return appState.updateTodo(cleanIdentifier(request.id, 'Görev kimliği'), allowed);
    }
    if (type === 'toggle') {
      const id = cleanIdentifier(request.id, 'Görev kimliği');
      const todo = getSnapshot().todos.find((item) => item.id === id);
      if (!todo) throw new Error('Görev bulunamadı.');
      return appState.updateTodo(id, { isDone: !todo.isDone });
    }
    if (type === 'delete') return appState.deleteTodo(cleanIdentifier(request.id, 'Görev kimliği'));
    throw new Error('Desteklenmeyen görev işlemi.');
  }

  async function createPairingInvite(options = {}) {
    requireUnlocked();
    const requirePin = options.requirePin === true;
    if (settings.cloudEnabled) {
      if (!settings.cloudOrigin) throw new Error('Önce Ayarlar bölümünde production origin girin.');
      if (!cloudClient) await applyCloudSetting();
      return cloudClient.createInvite({ requirePin });
    }
    if (!settings.localNetworkEnabled) throw new Error('Telefon bağlantısı kapalı. Ayarlardan Cloudflare relay veya yerel ağı açın.');
    if (requirePin) throw new Error('6 haneli paylaşım PIN’i için Cloudflare relay’i açın.');
    return localServer.createInvite();
  }

  async function revokePairedDevice(id) {
    requireUnlocked();
    if (cloudClient && settings.cloudEnabled) return cloudClient.revokeDevice(cleanIdentifier(id, 'Cihaz kimliği'));
    if (localServer?.revokeSession(id)) {
      remoteInfo = { ...localServer.getInfo(), devices: localServer.listSessions(), error: '' };
      sendToMain('remote-updated', remoteInfo);
      return { ok: true };
    }
    throw new Error('Cihaz bulunamadı.');
  }

  function registerIpc() {
    ipcMain.handle('get-auth-state', (event) => {
      requireMainSender(event);
      return auth.getState();
    });
    ipcMain.handle('verify-password', async (event, password) => {
      requireMainSender(event);
      const result = await auth.verify(typeof password === 'string' ? password : '');
      sendToMain('auth-state-changed', auth.getState());
      return result;
    });
    ipcMain.handle('load-todos', (event) => {
      requireMainSender(event);
      requireUnlocked();
      return getSnapshot().todos;
    });
    ipcMain.handle('mutate-todo', async (event, request) => {
      requireMainSender(event);
      requireUnlocked();
      const response = await mapTodoMutation(request);
      return response;
    });
    ipcMain.handle('get-settings', (event) => {
      requireMainSender(event);
      requireUnlocked();
      return settingsStore.get();
    });
    ipcMain.handle('update-settings', async (event, patch) => {
      requireMainSender(event);
      requireUnlocked();
      settings = settingsStore.update(patch);
      applyLoginSetting();
      scheduleUpdateChecks();
      await Promise.all([applyLocalServerSetting(), applyCloudSetting()]);
      sendToMain('settings-updated', settings);
      return settings;
    });
    ipcMain.handle('set-app-password', async (event, value = {}) => {
      requireMainSender(event);
      requireUnlocked();
      let result;
      if (auth.isEnabled()) result = await auth.changePassword(String(value.currentPassword || ''), String(value.newPassword || ''));
      else result = await auth.enable(String(value.newPassword || ''));
      if (!result.ok) {
        sendToMain('auth-state-changed', auth.getState());
        throw new Error('Mevcut parola doğrulanamadı.');
      }
      sendToMain('auth-state-changed', auth.getState());
      return auth.getState();
    });
    ipcMain.handle('disable-app-password', async (event, password) => {
      requireMainSender(event);
      requireUnlocked();
      const verified = await auth.verify(String(password || ''));
      if (!verified.ok) {
        sendToMain('auth-state-changed', auth.getState());
        throw new Error('Mevcut parola doğrulanamadı.');
      }
      const result = await auth.disable(String(password || ''));
      if (!result.ok) throw new Error('Uygulama kilidi kapatılamadı.');
      sendToMain('auth-state-changed', auth.getState());
      return auth.getState();
    });
    ipcMain.handle('get-alarm-history', (event) => {
      requireMainSender(event);
      requireUnlocked();
      return getSnapshot().alarmHistory;
    });
    ipcMain.handle('get-remote-info', (event) => {
      requireMainSender(event);
      requireUnlocked();
      return { ...remoteInfo, devices: localServer?.listSessions() || [] };
    });
    ipcMain.handle('get-cloud-relay-info', (event) => {
      requireMainSender(event);
      requireUnlocked();
      return cloudClient ? cloudClient.getInfo() : cloudInfo;
    });
    ipcMain.handle('create-pairing-invite', (event, options) => {
      requireMainSender(event);
      return createPairingInvite(options);
    });
    ipcMain.handle('revoke-paired-device', (event, id) => {
      requireMainSender(event);
      return revokePairedDevice(id);
    });
    ipcMain.handle('copy-text', (event, text) => {
      requireMainSender(event);
      requireUnlocked();
      const value = String(text || '');
      if (value.length > 8192) throw new Error('Kopyalanacak metin çok uzun.');
      clipboard.writeText(value);
      return true;
    });
    ipcMain.handle('qr-data-url', async (event, text, options = {}) => {
      requireMainSender(event);
      requireUnlocked();
      const value = String(text || '');
      if (!value || value.length > 8192) throw new Error('QR içeriği geçersiz.');
      return QRCode.toDataURL(value, {
        width: Math.max(128, Math.min(512, Number(options.width) || 220)),
        margin: Math.max(0, Math.min(4, Number(options.margin) || 1)),
        color: { dark: '#17202d', light: '#ffffff' },
      });
    });

    ipcMain.on('set-alarm', (event, payload = {}) => {
      if (!isSender(event, mainWindow) || !auth.isUnlocked()) return;
      try {
        const taskId = cleanIdentifier(payload.taskId, 'Görev kimliği');
        const todo = getSnapshot().todos.find((item) => item.id === taskId);
        if (!todo) return;
        const minutes = validateMinutes(payload.minutes);
        void appState.addAlarm({ taskId, taskTitle: todo.title, minutes }).catch(logError);
      } catch (error) { logError(error); }
    });
    ipcMain.on('cancel-alarm', (event, payload = {}) => {
      if (!isSender(event, mainWindow) || !auth.isUnlocked()) return;
      const alarm = activeAlarmById(payload.alarmId);
      if (!alarm) return;
      void appState.cancelAlarm(alarm.id, alarm.occurrence).catch(logError);
    });
    ipcMain.on('get-alarms', (event) => {
      if (!isSender(event, mainWindow) || !auth.isUnlocked()) return;
      event.sender.send('alarms-updated', getSnapshot().activeAlarms);
    });
    ipcMain.on('dismiss-alarm', (event) => {
      if (!isSender(event, mainWindow)) return;
      const alarm = currentRingingAlarm();
      if (alarm) void dismissAlarmOccurrence(alarm.id, alarm.occurrence).catch(logError);
    });
    ipcMain.on('quit-app', (event) => {
      if (isSender(event, mainWindow)) app.quit();
    });

    ipcMain.handle('timer-confirm', async (event, payload = {}) => {
      requireOverlaySender(event);
      requireUnlocked();
      const selection = pendingTimerSelection;
      if (!selection || selection.fireAt <= Date.now()) {
        const error = new Error('Seçilen saat geçti. Halatı yeniden çekin.');
        error.code = 'ALARM_TARGET_EXPIRED';
        throw error;
      }
      const title = cleanTitle(payload.title);
      const response = await appState.addTodoWithAlarm({
        title,
        category: cleanCategory(payload.category),
        minutes: selection.minutes,
        fireAt: selection.fireAt,
        source: 'rope',
      });
      destroyTimerOverlay();
      return response.result;
    });
    ipcMain.handle('timer-cancel', (event) => {
      requireOverlaySender(event);
      destroyTimerOverlay();
      return true;
    });

    ipcMain.handle('alarm-window-dismiss', async (event, payload = {}) => {
      requireAlarmSender(event);
      return dismissAlarmOccurrence(cleanIdentifier(payload.alarmId, 'Alarm kimliği'), Number(payload.occurrence));
    });
    ipcMain.handle('alarm-window-snooze', async (event, payload = {}) => {
      requireAlarmSender(event);
      return snoozeAlarmOccurrence(cleanIdentifier(payload.alarmId, 'Alarm kimliği'), Number(payload.occurrence), Number(payload.minutes));
    });
    ipcMain.handle('alarm-window-complete-task', async (event, payload = {}) => {
      requireAlarmSender(event);
      return completeAlarmOccurrence(cleanIdentifier(payload.alarmId, 'Alarm kimliği'), Number(payload.occurrence));
    });
    ipcMain.handle('alarm-window-hide', (event) => {
      requireAlarmSender(event);
      alarmWindow.hide();
      return true;
    });
  }

  function findCommandFileArg(argv = []) {
    const direct = argv.find((arg) => typeof arg === 'string' && arg.startsWith('--gurutime-command-file='));
    if (direct) return direct.slice(direct.indexOf('=') + 1);
    const index = argv.indexOf('--gurutime-command-file');
    return index >= 0 ? argv[index + 1] : '';
  }

  function writeCommandReply(replyPath, payload) {
    if (!replyPath) return;
    fs.mkdirSync(path.dirname(replyPath), { recursive: true, mode: 0o700 });
    const temp = `${replyPath}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(temp, replyPath);
  }

  async function processHermesCommand(command) {
    requireUnlocked();
    const action = String(command.action || '').toLowerCase();
    if (action === 'add-note' || action === 'add-todo' || action === 'note') {
      const response = await appState.addTodo({ title: cleanTitle(command.title), category: cleanCategory(command.category), source: 'hermes' });
      return { action: 'add-note', todo: response.result.todo };
    }
    if (action === 'add-alarm' || action === 'alarm') {
      const minutes = validateMinutes(Math.round(Number(command.minutes)));
      const response = await appState.addTodoWithAlarm({
        title: cleanTitle(command.title),
        category: cleanCategory(command.category),
        source: 'hermes',
        minutes,
        fireAt: freezeFireAt(minutes),
      });
      return { action: 'add-alarm', todo: response.result.todo, alarm: response.result.alarm };
    }
    if (action === 'list') {
      const snapshot = getSnapshot();
      return { action: 'list', todos: snapshot.todos, alarms: snapshot.activeAlarms };
    }
    if (action === 'delete-note' || action === 'delete-todo') {
      const response = await appState.deleteTodo(cleanIdentifier(command.id || command.todoId, 'Görev kimliği'));
      if (!response.result.deleted) throw new Error('Görev bulunamadı.');
      return { action: 'delete-note', todo: response.result.todo };
    }
    if (action === 'cancel-alarm') {
      const alarm = activeAlarmById(command.id || command.alarmId);
      if (!alarm) throw new Error('Alarm bulunamadı.');
      const response = await appState.cancelAlarm(alarm.id, alarm.occurrence);
      if (!response.result.applied) throw new Error('Alarm iptal edilemedi.');
      return { action: 'cancel-alarm', alarm };
    }
    throw new Error('Desteklenmeyen GuruTime komutu.');
  }

  async function handleHermesFile(filePath) {
    if (!filePath || hermesInFlight.has(filePath)) return;
    hermesInFlight.add(filePath);
    let command = null;
    try {
      command = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const result = await processHermesCommand(command);
      writeCommandReply(command.replyPath, { ok: true, ...result });
    } catch (error) {
      writeCommandReply(command?.replyPath, { ok: false, error: error.message });
    } finally {
      hermesInFlight.delete(filePath);
    }
  }

  function scanHermesCommands() {
    try {
      fs.mkdirSync(hermesCommandDir, { recursive: true, mode: 0o700 });
      fs.readdirSync(hermesCommandDir)
        .filter((name) => name.endsWith('.command.json'))
        .forEach((name) => void handleHermesFile(path.join(hermesCommandDir, name)));
    } catch (error) {
      logError('CLI komut dizini okunamadı', error);
    }
  }

  function scheduleHermesScan() {
    clearTimeout(hermesScanTimer);
    hermesScanTimer = setTimeout(scanHermesCommands, 120);
  }

  function startHermesWatcher() {
    fs.mkdirSync(hermesCommandDir, { recursive: true, mode: 0o700 });
    hermesWatcher = fs.watch(hermesCommandDir, scheduleHermesScan);
    scanHermesCommands();
  }

  function handleCommandLine(argv) {
    const filePath = findCommandFileArg(argv);
    if (!filePath) return false;
    void handleHermesFile(path.resolve(filePath));
    return true;
  }

  async function bootstrap() {
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    settingsStore = new SettingsStore(settingsPath);
    settings = settingsStore.load();
    [appState, auth] = await Promise.all([
      AppStateV2.open({ filePath: appStatePath, legacyTodosPath, legacyAlarmsPath }),
      LocalAuth.open({ filePath: authPath }),
    ]);
    appState.on('change', onStateChanged);

    if (process.platform === 'darwin') {
      try { app.setActivationPolicy('accessory'); } catch (_) {}
      try { app.dock?.hide(); } catch (_) {}
    }
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    registerIpc();
    configureMainWindow();
    configureTray();
    applyLoginSetting();
    scheduleUpdateChecks();
    await Promise.all([applyLocalServerSetting(), applyCloudSetting()]);
    startHermesWatcher();
    handleCommandLine(process.argv);
    await reconcileAlarmsAfterWake();
    broadcastSnapshot();

    powerMonitor.on('resume', () => void reconcileAlarmsAfterWake().catch(logError));
    powerMonitor.on('unlock-screen', () => void reconcileAlarmsAfterWake().catch(logError));
    powerMonitor.on('lock-screen', () => {
      if (!settings.appLock.lockOnScreenLock || !auth.isEnabled()) return;
      const next = auth.lock();
      sendToMain('auth-state-changed', next);
    });
  }

  app.on('second-instance', (_event, argv) => {
    if (!handleCommandLine(argv)) showMainWindow();
  });

  app.whenReady().then(bootstrap).catch((error) => {
    logError('Uygulama başlatılamadı', error);
    app.quit();
  });

  app.on('activate', () => {
    if (appState) configureMainWindow();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopCursorTracking();
    stopAlarmCadence();
    clearScheduledAlarmTimers();
    clearInterval(trayStatusTimer);
    clearInterval(updateCheckTimer);
    clearTimeout(holdTimer);
    clearTimeout(hermesScanTimer);
    for (const timer of followupTimers.values()) clearTimeout(timer);
    followupTimers.clear();
    if (hermesWatcher) hermesWatcher.close();
    hermesWatcher = null;
    if (localServer) void localServer.stop();
    if (cloudClient) void cloudClient.stop();
    if (alarmWindow && !alarmWindow.isDestroyed()) alarmWindow.destroy();
  });

  app.on('window-all-closed', (event) => event.preventDefault());
}
