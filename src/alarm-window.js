(function initGuruTimeAlarmWindow(factory) {
  const alarmView = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = alarmView;
  }

  if (typeof window !== 'undefined') {
    window.GuruTimeAlarmView = alarmView;

    const mount = () => alarmView.mountAlarmWindow(document, window);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
      mount();
    }
  }
})(function createGuruTimeAlarmWindow() {
  'use strict';

  function toNonNegativeInteger(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.floor(parsed);
  }

  function formatOverdue(value) {
    const minutes = toNonNegativeInteger(value);
    if (minutes === 0) return 'Tam zamanında';
    return `${minutes} dakika gecikti`;
  }

  function formatQueueCount(value) {
    const count = toNonNegativeInteger(value);
    if (count === 0) return 'Başka alarm yok';
    return `Sırada ${count} alarm daha var`;
  }

  function cleanTitle(value) {
    return String(value || '').replace(/\s+/g, ' ').trim() || 'Zaman doldu';
  }

  function normalizeAlarmState(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const alarm = source.alarm && typeof source.alarm === 'object' ? source.alarm : {};
    const privacyMode = Boolean(source.privacyMode);
    const alarmId = cleanTitle(alarm.id || alarm.alarmId || '');
    const hasAlarm = Boolean(alarm.id || alarm.alarmId);
    const occurrence = toNonNegativeInteger(alarm.occurrence);
    const title = privacyMode
      ? 'Zaman doldu'
      : cleanTitle(alarm.taskTitle || alarm.title || 'Zaman doldu');

    return Object.freeze({
      alarmId: hasAlarm ? alarmId : '',
      occurrence,
      taskId: String(alarm.taskId || ''),
      title,
      privacyMode,
      queueCount: toNonNegativeInteger(source.queueCount),
      overdueMinutes: toNonNegativeInteger(source.overdueMinutes),
      canCompleteTask: Boolean(alarm.taskId),
      description: privacyMode
        ? 'Görev ayrıntıları gizlendi.'
        : 'Ayarladığınız süre tamamlandı.',
    });
  }

  function buildActionPayload(state, extra) {
    const source = state || {};
    return Object.assign({
      alarmId: String(source.alarmId || ''),
      occurrence: toNonNegativeInteger(source.occurrence),
    }, extra || {});
  }

  function mountAlarmWindow(doc, win) {
    if (!doc || !win || doc.documentElement.dataset.alarmWindowMounted === 'true') return null;

    const panel = doc.getElementById('alarmPanel');
    const title = doc.getElementById('alarmTitle');
    const description = doc.getElementById('alarmDescription');
    const latenessText = doc.getElementById('latenessText');
    const queueText = doc.getElementById('queueText');
    const snoozeOptions = doc.getElementById('snoozeOptions');
    const dismissButton = doc.getElementById('dismissButton');
    const completeButton = doc.getElementById('completeButton');
    const hideButton = doc.getElementById('hideButton');
    const status = doc.getElementById('alarmStatus');
    const liveRegion = doc.getElementById('alarmLive');

    if (!panel || !title || !dismissButton || !completeButton || !snoozeOptions) return null;
    doc.documentElement.dataset.alarmWindowMounted = 'true';

    const api = win.guruTimeAlarm;
    let current = null;
    let busy = false;
    let busyTimer = 0;

    function getActionButtons() {
      return [
        dismissButton,
        completeButton,
        ...Array.from(snoozeOptions.querySelectorAll('[data-snooze]')),
      ];
    }

    function updateDisabledState() {
      const ready = Boolean(current && current.alarmId);
      getActionButtons().forEach((button) => {
        button.disabled = busy || !ready;
      });
      completeButton.disabled = busy || !ready || !current.canCompleteTask;
      completeButton.title = ready && !current.canCompleteTask ? 'Bağlı görev bulunamadı' : '';
    }

    function setBusy(nextBusy, message) {
      busy = Boolean(nextBusy);
      status.textContent = message || '';
      updateDisabledState();
    }

    function render(payload) {
      current = normalizeAlarmState(payload);
      win.clearTimeout(busyTimer);
      busyTimer = 0;
      setBusy(false, '');

      title.textContent = current.title;
      description.textContent = current.description;
      latenessText.textContent = formatOverdue(current.overdueMinutes);
      queueText.textContent = formatQueueCount(current.queueCount);
      panel.dataset.privacyMode = String(current.privacyMode);

      const announcement = [
        'Alarm çalıyor.',
        current.title,
        formatOverdue(current.overdueMinutes),
        formatQueueCount(current.queueCount),
      ].join(' ');
      liveRegion.textContent = announcement;
      updateDisabledState();
    }

    async function runAction(method, extra, progressMessage) {
      if (busy || !current || !current.alarmId) return;
      if (!api || typeof api[method] !== 'function') {
        status.textContent = 'Alarm işlemi kullanılamıyor.';
        return;
      }

      setBusy(true, progressMessage);
      try {
        await Promise.resolve(api[method](buildActionPayload(current, extra)));
        busyTimer = win.setTimeout(() => setBusy(false, ''), 2500);
      } catch (error) {
        setBusy(false, 'İşlem tamamlanamadı. Yeniden deneyin.');
      }
    }

    function hideWindow() {
      if (api && typeof api.hide === 'function') api.hide();
    }

    dismissButton.addEventListener('click', () => {
      runAction('dismiss', null, 'Alarm kapatılıyor.');
    });

    completeButton.addEventListener('click', () => {
      runAction('completeTask', null, 'Görev tamamlanıyor.');
    });

    snoozeOptions.addEventListener('click', (event) => {
      const button = event.target.closest('[data-snooze]');
      if (!button) return;
      const minutes = toNonNegativeInteger(button.dataset.snooze);
      if (![5, 10, 15, 30].includes(minutes)) return;
      runAction('snooze', { minutes }, `Alarm ${minutes} dakika erteleniyor.`);
    });

    hideButton.addEventListener('click', hideWindow);
    doc.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      hideWindow();
    });

    let unsubscribe = null;
    if (api && typeof api.onState === 'function') {
      const candidate = api.onState(render);
      if (typeof candidate === 'function') unsubscribe = candidate;
    } else {
      status.textContent = 'Alarm bağlantısı kurulamadı.';
    }

    updateDisabledState();
    win.addEventListener('beforeunload', () => {
      win.clearTimeout(busyTimer);
      if (unsubscribe) unsubscribe();
    }, { once: true });

    return Object.freeze({ render, hideWindow });
  }

  return Object.freeze({
    toNonNegativeInteger,
    formatOverdue,
    formatQueueCount,
    normalizeAlarmState,
    buildActionPayload,
    mountAlarmWindow,
  });
});
