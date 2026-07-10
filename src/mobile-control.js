(() => {
  'use strict';

  const sessionKey = 'gurutime-local-session';
  const status = document.getElementById('status');
  const pairingPanel = document.getElementById('pairingPanel');
  const pairingNotice = document.getElementById('pairingNotice');
  const addForm = document.getElementById('addForm');
  const titleInput = document.getElementById('title');
  const tasks = document.getElementById('tasks');
  const alarmDialog = document.getElementById('alarmDialog');
  const alarmTitle = document.getElementById('alarmTitle');
  const alarmForm = document.getElementById('alarmForm');
  const minutesInput = document.getElementById('minutes');
  let selectedTaskId = '';
  let token = sessionStorage.getItem(sessionKey) || '';

  function pairingCodeFromFragment() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const value = params.get('pair') || '';
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return value;
  }

  async function request(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(path, { ...options, headers, cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Bağlantı kurulamadı.');
    return body;
  }

  async function pair(code) {
    if (!code) return false;
    const result = await request('/api/session', { method: 'POST', body: JSON.stringify({ pairingCode: code }) });
    token = result.token;
    sessionStorage.setItem(sessionKey, token);
    return true;
  }

  function showConnected() {
    status.classList.add('online');
    pairingPanel.hidden = true;
    addForm.hidden = false;
    tasks.hidden = false;
  }

  function showError(message) {
    status.classList.remove('online');
    pairingPanel.hidden = false;
    pairingNotice.className = 'notice error';
    pairingNotice.textContent = message;
  }

  function taskRow(todo, alarm) {
    const row = document.createElement('article');
    row.className = `task${todo.isDone ? ' done' : ''}`;
    const check = document.createElement('button');
    check.className = 'check';
    check.type = 'button';
    check.textContent = todo.isDone ? '✓' : '';
    check.dataset.action = 'toggle';
    check.dataset.id = todo.id;
    check.setAttribute('aria-label', todo.isDone ? 'Görevi yeniden aç' : 'Görevi tamamla');
    const copy = document.createElement('div');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = todo.title || 'İsimsiz görev';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = alarm ? new Date(alarm.fireAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : 'Bu Mac’te';
    copy.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (!todo.isDone) actions.append(actionButton('Alarm', 'alarm', todo.id));
    actions.append(actionButton('Sil', 'delete', todo.id, 'danger'));
    row.append(check, copy, actions);
    return row;
  }

  function actionButton(text, action, id, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.dataset.action = action;
    button.dataset.id = id;
    button.className = className;
    return button;
  }

  async function refresh() {
    const snapshot = await request('/api/state');
    const todos = Array.isArray(snapshot.todos) ? snapshot.todos.filter((todo) => !todo.isArchived) : [];
    const alarms = Array.isArray(snapshot.activeAlarms) ? snapshot.activeAlarms : [];
    const fragment = document.createDocumentFragment();
    if (!todos.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Henüz görev yok.';
      fragment.append(empty);
    } else {
      todos.forEach((todo) => fragment.append(taskRow(todo, alarms.find((alarm) => alarm.taskId === todo.id))));
    }
    tasks.replaceChildren(fragment);
    showConnected();
  }

  async function command(type, payload) {
    await request('/api/commands', { method: 'POST', body: JSON.stringify({ type, payload, commandId: crypto.randomUUID() }) });
    await refresh();
  }

  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = titleInput.value.trim();
    if (!title) return;
    titleInput.value = '';
    try { await command('task.add', { title, category: 'today' }); }
    catch (error) { titleInput.value = title; showError(error.message); }
  });

  tasks.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const { action, id } = target.dataset;
    try {
      if (action === 'toggle') await command('task.toggle', { taskId: id });
      if (action === 'delete') await command('task.delete', { taskId: id });
      if (action === 'alarm') {
        const snapshot = await request('/api/state');
        const todo = snapshot.todos.find((item) => item.id === id);
        selectedTaskId = id;
        alarmTitle.textContent = todo?.title || '';
        alarmDialog.showModal();
      }
    } catch (error) { showError(error.message); }
  });

  alarmForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const minutes = Number(minutesInput.value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return;
    alarmDialog.close();
    try { await command('alarm.add', { taskId: selectedTaskId, minutes }); }
    catch (error) { showError(error.message); }
  });
  document.getElementById('cancelAlarm').addEventListener('click', () => alarmDialog.close());

  (async () => {
    try {
      const code = pairingCodeFromFragment();
      if (code) await pair(code);
      if (!token) throw new Error('Eşleştirme bağlantısı eksik veya süresi dolmuş. Mac’ten yeni bir QR oluşturun.');
      await refresh();
      setInterval(() => refresh().catch(() => {}), 15000);
    } catch (error) {
      sessionStorage.removeItem(sessionKey);
      token = '';
      showError(error.message);
    }
  })();
})();
