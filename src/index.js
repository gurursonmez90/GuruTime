const ipc = window.guruTime.ipc;

const state = {
  activeTab: 'tasks',
  todos: [],
  alarms: [],
  settings: null,
  auth: null,
  remote: null,
  cloud: null,
  selectedTaskId: null,
  metricDisplay: null,
  pendingNewTitle: null,
  updateCheck: null,
};

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const categories = [
  { id: 'important', label: 'Önemli' },
  { id: 'today', label: 'Bugün' },
  { id: 'later', label: 'Bir Ara' },
];

const app = document.getElementById('app');
const content = document.getElementById('content');
const quickAddForm = document.getElementById('quickAddForm');
const quickAddInput = document.getElementById('quickAddInput');
const quickAddCategory = document.getElementById('quickAddCategory');
const taskCount = document.getElementById('taskCount');
const headerStatus = document.getElementById('headerStatus');
const lockScreen = document.getElementById('lockScreen');
const unlockForm = document.getElementById('unlockForm');
const unlockPassword = document.getElementById('unlockPassword');
const unlockError = document.getElementById('unlockError');
const alarmDialog = document.getElementById('alarmDialog');
const alarmForm = document.getElementById('alarmForm');
const alarmMinutes = document.getElementById('alarmMinutes');
const alarmTaskTitle = document.getElementById('alarmTaskTitle');
const alarmError = document.getElementById('alarmError');
const pairingDialog = document.getElementById('pairingDialog');
const qrImage = document.getElementById('qrImage');
const pairingPinRow = document.getElementById('pairingPinRow');
const pairingPin = document.getElementById('pairingPin');
const pairingError = document.getElementById('pairingError');
const toast = document.getElementById('toast');

let toastTimer = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, action, id) {
  const node = element('button', className, text);
  node.type = 'button';
  if (action) node.dataset.action = action;
  if (id) node.dataset.id = id;
  return node;
}

// svgIcon renders TRUSTED, static markup only. Never pass user-supplied text here.
function svgIcon(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstChild;
}

function strokeIcon(paths, size = 16, stroke = 1.7) {
  const list = Array.isArray(paths) ? paths : [paths];
  const inner = list.map((d) => `<path d="${d}"/>`).join('');
  return svgIcon(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`,
  );
}

const ICON = {
  checkMark: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>',
  bell: ['M6 8a6 6 0 0 1 12 0c0 6 2.4 7 2.4 7H3.6S6 14 6 8', 'M10 20a2 2 0 0 0 4 0'],
  bellOff: ['M6 8a6 6 0 0 1 9.3-5M18 8c0 6 2.4 7 2.4 7H8', 'M10 20a2 2 0 0 0 4 0', 'M4 4l16 16'],
  archive: ['M4 6h16v3H4z', 'M6 9v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9', 'M10 13h4'],
  restore: ['M4 6h16v3H4z', 'M6 9v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9', 'M12 17v-5', 'M9.5 14.5 12 12l2.5 2.5'],
  trash: ['M4 7h16', 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12', 'M10 11v6', 'M14 11v6'],
  qr: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M14 14h2v2M20 14v6M14 20h6'],
  link: ['M9 15l6-6', 'M11 6l1-1a3.5 3.5 0 0 1 5 5l-1 1', 'M13 18l-1 1a3.5 3.5 0 0 1-5-5l1-1'],
  cloud: ['M7 18a4 4 0 0 1 0-8 5.2 5.2 0 0 1 9.9-1.4A3.6 3.6 0 0 1 17.5 18H7z'],
  broadcast: ['M8.8 8.8a4.5 4.5 0 0 0 0 6.4', 'M15.2 8.8a4.5 4.5 0 0 1 0 6.4', 'M6.3 6.3a8 8 0 0 0 0 11.4', 'M17.7 6.3a8 8 0 0 1 0 11.4'],
};

function categoryGlyph(id) {
  if (id === 'important') {
    return svgIcon('<svg width="13" height="13" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M12 2.5c1.3 3.4 4.4 4.6 4.4 8.6a4.4 4.4 0 0 1-8.8 0c0-1 .3-1.9.9-2.7.5 1.1 1.1 1.6 1.9 1.9-1-2.6-.2-5.6 1.6-7.8z"/></svg>');
  }
  if (id === 'today') {
    return svgIcon('<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/></svg>');
  }
  if (id === 'later') {
    return svgIcon('<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h13v4.5a4.5 4.5 0 0 1-4.5 4.5H8.5A4.5 4.5 0 0 1 4 13.5z"/><path d="M17 10h2a2 2 0 0 1 0 4h-2"/><path d="M8 3.5v2M11 3.5v2M14 3.5v2"/></svg>');
  }
  return svgIcon('<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16v3H4z"/><path d="M6 9v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/></svg>');
}

function iconButton(label, className, action, id, paths) {
  const node = button('', className, action, id);
  node.setAttribute('aria-label', label);
  node.title = label;
  node.append(strokeIcon(paths, 16, 1.7));
  return node;
}

function iconTextButton(label, className, action, paths) {
  const node = button('', className, action);
  node.append(strokeIcon(paths, 15, 1.8), element('span', '', label));
  return node;
}

let metricRaf = null;
function animateMetrics(nodes, from, to) {
  cancelAnimationFrame(metricRaf);
  if (prefersReducedMotion()) {
    nodes.forEach((node, i) => { node.textContent = String(to[i]); });
    return;
  }
  const start = performance.now();
  const duration = 520;
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    nodes.forEach((node, i) => {
      if (!node.isConnected) return;
      node.textContent = String(Math.round(from[i] + (to[i] - from[i]) * eased));
    });
    if (p < 1) metricRaf = requestAnimationFrame(step);
  };
  metricRaf = requestAnimationFrame(step);
}

function celebrate(originEl) {
  const layer = document.getElementById('burstLayer');
  if (!layer || !originEl || prefersReducedMotion()) return;
  const appRect = app.getBoundingClientRect();
  const rect = originEl.getBoundingClientRect();
  const x = rect.left + rect.width / 2 - appRect.left;
  const y = rect.top + rect.height / 2 - appRect.top;
  const burst = element('div', 'burst');
  burst.style.left = `${x}px`;
  burst.style.top = `${y}px`;
  burst.append(element('span', 'spark-ring'));
  const colors = ['#c33f31', '#d4674a', '#e0a24a', '#4f9d92', '#e08a5a'];
  for (let i = 0; i < 16; i += 1) {
    const angle = (Math.PI * 2 * i) / 16 + (Math.random() - 0.5);
    const dist = 34 + Math.random() * 40;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist - 10;
    const square = i % 2 === 0;
    const size = 5 + Math.random() * 4;
    const bit = element('span', 'confetti');
    bit.style.width = `${size}px`;
    bit.style.height = `${square ? size : size * 0.5}px`;
    bit.style.background = colors[i % colors.length];
    bit.style.borderRadius = square ? '2px' : '3px';
    bit.style.setProperty('--tx', `${tx}px`);
    bit.style.setProperty('--ty', `${ty}px`);
    bit.style.setProperty('--rot', `${Math.random() * 540 - 270}deg`);
    bit.style.setProperty('--dur', `${700 + Math.random() * 320}ms`);
    burst.append(bit);
  }
  layer.append(burst);
  setTimeout(() => burst.remove(), 1100);
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.remove('is-in');
  void toast.offsetWidth; // force reflow so the entrance animation restarts
  toast.classList.add('is-in');
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
}

function errorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : 'İşlem tamamlanamadı.';
}

function formatDuration(value) {
  const minutes = Math.max(1, Math.min(1440, Math.round(Number(value) || 1)));
  if (minutes === 1440) return '24 saat';
  if (minutes < 60) return `${minutes} dk`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} sa ${rest} dk` : `${hours} saat`;
}

function formatAlarmTime(fireAt) {
  const time = Number(fireAt);
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date(time));
}

function isActiveAlarm(alarm) {
  return alarm && (alarm.status === 'scheduled' || alarm.status === 'ringing' || !alarm.status);
}

function alarmForTask(taskId) {
  return state.alarms.find((alarm) => alarm.taskId === taskId && isActiveAlarm(alarm));
}

const TAB_ORDER = ['tasks', 'connections', 'settings'];

function updateChrome() {
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    const active = tab.dataset.tab === state.activeTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  const pill = document.querySelector('.tab-pill');
  if (pill) {
    const index = Math.max(0, TAB_ORDER.indexOf(state.activeTab));
    pill.style.transform = `translateX(calc((100% + 5px) * ${index}))`;
  }
  quickAddForm.hidden = state.activeTab !== 'tasks';
  const active = state.todos.filter((todo) => !todo.isArchived && !todo.isDone).length;
  taskCount.textContent = `${active} açık görev`;
  const cloudReady = Boolean(state.cloud?.connected);
  headerStatus.textContent = cloudReady ? 'Yerel ve telefon bağlı' : 'Yerel ve hazır';
}

function render() {
  updateChrome();
  if (state.activeTab === 'connections') renderConnections();
  else if (state.activeTab === 'settings') renderSettings();
  else renderTasks();
}

function renderContentHeader(title, subtitle) {
  const header = element('div', 'content-header');
  const copy = element('div');
  copy.append(element('h2', '', title), element('p', '', subtitle));
  header.append(copy);
  return header;
}

function categoryMark(id) {
  const mark = element('span', 'category-mark');
  mark.setAttribute('aria-hidden', 'true');
  mark.append(categoryGlyph(id));
  return mark;
}

function renderTasks() {
  const view = element('div', 'tab-view');
  const current = state.todos.filter((todo) => !todo.isArchived);
  const active = current.filter((todo) => !todo.isDone).length;
  const done = current.filter((todo) => todo.isDone).length;
  const archived = state.todos.filter((todo) => todo.isArchived).length;
  const alarmCount = state.alarms.filter(isActiveAlarm).length;

  view.append(renderContentHeader('Bugünün akışı', 'Alarm kurmak için görevdeki zil düğmesini kullanın.'));

  const targets = [active, alarmCount, archived];
  const previous = state.metricDisplay || targets.slice();
  const summary = element('div', 'summary');
  const metricNodes = [];
  ['Açık', 'Alarm', 'Arşiv'].forEach((label, i) => {
    const metric = element('div', 'metric');
    const strong = element('strong', '', String(previous[i]));
    metric.append(element('span', '', label), strong);
    metricNodes.push(strong);
    summary.append(metric);
  });
  view.append(summary);
  state.metricDisplay = targets.slice();

  categories.forEach((category) => {
    const tasks = current.filter((todo) => todo.category === category.id);
    if (!tasks.length) return;
    const section = element('section', 'category');
    section.dataset.category = category.id;
    const heading = element('div', 'category-heading');
    heading.append(categoryMark(category.id), element('h3', '', category.label), element('span', '', String(tasks.length)));
    const list = element('div', 'task-list');
    tasks.sort((a, b) => Number(a.isDone) - Number(b.isDone)).forEach((todo) => list.append(renderTaskRow(todo)));
    section.append(heading, list);
    view.append(section);
  });

  if (!current.length) {
    const empty = element('div', 'empty-state');
    empty.append(
      svgIcon('<svg class="empty-art" width="108" height="88" viewBox="0 0 108 88" fill="none" aria-hidden="true"><rect x="30" y="20" width="48" height="58" rx="8" fill="var(--surface-strong)" stroke="var(--line-strong)" stroke-width="1.6"/><rect x="42" y="14" width="24" height="12" rx="4" fill="var(--accent)" opacity="0.85"/><path d="M40 42l5 5 9-10" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M62 44h8" stroke="var(--line-strong)" stroke-width="2.4" stroke-linecap="round"/><path d="M40 60h30" stroke="var(--line)" stroke-width="2.4" stroke-linecap="round"/><circle cx="86" cy="26" r="3" fill="var(--accent-2)" opacity="0.8"/><circle cx="20" cy="40" r="2.4" fill="var(--accent)" opacity="0.7"/><circle cx="90" cy="60" r="2.2" fill="var(--accent)" opacity="0.6"/></svg>'),
      element('strong', '', 'Liste boş'),
      document.createTextNode('Aşağıdaki alandan ilk görevinizi ekleyin.'),
    );
    view.append(empty);
  }

  if (archived) {
    const section = element('section', 'category is-archive');
    const heading = element('div', 'category-heading');
    heading.append(categoryMark('archive'), element('h3', '', 'Arşiv'), element('span', '', String(archived)));
    const list = element('div', 'task-list');
    state.todos.filter((todo) => todo.isArchived).slice(-20).reverse().forEach((todo) => list.append(renderTaskRow(todo)));
    section.append(heading, list);
    view.append(section);
  }

  if (done && !archived) {
    const note = element('p', 'privacy-note', 'Tamamlanan görevleri satırdaki arşiv düğmesiyle kaldırabilirsiniz.');
    view.append(note);
  }
  content.replaceChildren(view);
  animateMetrics(metricNodes, previous, targets);
}

function renderTaskRow(todo) {
  const title = todo.title || 'İsimsiz görev';
  let rowClass = `task-row${todo.isDone ? ' done' : ''}`;
  if (state.pendingNewTitle && todo.title === state.pendingNewTitle && !todo.isArchived) {
    rowClass += ' is-new';
    state.pendingNewTitle = null;
  }
  const row = element('article', rowClass);

  const check = button('', `check-button${todo.isDone ? ' checked' : ''}`, 'toggle', todo.id);
  check.setAttribute('aria-label', todo.isDone ? `${title} görevini yeniden aç` : `${title} görevini tamamla`);
  if (todo.isDone) check.append(svgIcon(ICON.checkMark));

  const copy = element('div', 'task-copy');
  copy.append(element('span', 'task-title', title));
  const meta = element('span', 'task-meta');
  const alarm = alarmForTask(todo.id);
  if (alarm) {
    const occurrence = Number(alarm.occurrence) || 1;
    const label = alarm.status === 'ringing' ? 'Çalıyor' : `${formatAlarmTime(alarm.fireAt)} alarmı`;
    meta.append(strokeIcon(ICON.bell, 11, 1.9), element('span', '', occurrence > 1 ? `${label}, ${occurrence}. tekrar` : label));
  } else {
    meta.append(element('span', '', todo.isDone ? 'Tamamlandı' : 'Yerel görev'));
  }
  copy.append(meta);

  const actions = element('div', 'task-actions');
  if (!todo.isArchived && !todo.isDone) {
    actions.append(iconButton(`${title} için alarm ayarla`, 'task-action', 'alarm', todo.id, ICON.bell));
  }
  if (alarm) {
    actions.append(iconButton(`${title} alarmını iptal et`, 'task-action danger', 'cancel-alarm', alarm.id || alarm.alarmId, ICON.bellOff));
  }
  if (todo.isArchived) {
    actions.append(iconButton(`${title} görevini geri getir`, 'task-action', 'restore', todo.id, ICON.restore));
  } else {
    actions.append(iconButton(`${title} görevini arşivle`, 'task-action', 'archive', todo.id, ICON.archive));
  }
  actions.append(iconButton(`${title} görevini sil`, 'task-action danger', 'delete', todo.id, ICON.trash));
  row.append(check, copy, actions);
  return row;
}

function panelIconBadge(iconNode) {
  const badge = element('span', 'panel-icon');
  badge.setAttribute('aria-hidden', 'true');
  badge.append(iconNode);
  return badge;
}

function panelLead(iconNode, title, description) {
  const lead = element('div', 'panel-lead');
  const copy = element('div');
  copy.append(element('h3', '', title), element('p', '', description));
  lead.append(panelIconBadge(iconNode), copy);
  return lead;
}

function connectionIllustration() {
  const wrap = element('div', 'conn-illustration');
  wrap.setAttribute('aria-hidden', 'true');
  wrap.append(svgIcon('<svg viewBox="0 0 300 96" width="100%" height="auto" aria-hidden="true"><rect x="20" y="20" width="78" height="50" rx="6" fill="none" stroke="var(--accent-2)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="28" y="28" width="62" height="34" rx="3" fill="var(--accent-soft)"/><path d="M10 78h98l-6-8H16z" fill="var(--surface-strong)" stroke="var(--accent-2)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="236" y="14" width="44" height="68" rx="9" fill="var(--surface-strong)" stroke="var(--accent-2)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="242" y="22" width="32" height="44" rx="4" fill="var(--accent-soft)"/><path d="M254 72h8" stroke="var(--accent-2)" stroke-width="2.4" stroke-linecap="round"/><path class="conn-arc" d="M100 46 C150 6, 196 6, 244 44" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-dasharray="5 8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="172" cy="20" r="12" fill="var(--accent)"/><g transform="translate(172,20)"><rect x="-4.5" y="-1" width="9" height="7" rx="1.4" fill="#fff"/><path d="M-2.6 -1v-1.6a2.6 2.6 0 0 1 5.2 0V-1" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g><path class="conn-wave" d="M292 30a10 10 0 0 1 0 12" stroke="var(--accent-2)" stroke-width="2" fill="none" stroke-linecap="round"/><path class="conn-wave-2" d="M296 25a16 16 0 0 1 0 22" stroke="var(--accent-2)" stroke-width="2" fill="none" stroke-linecap="round"/></svg>'));
  return wrap;
}

function renderConnections() {
  const view = element('div', 'tab-view');
  view.append(renderContentHeader('Telefon bağlantısı', 'İnternet kapansa da Mac görevleri ve alarmları çalışmaya devam eder.'));

  const hero = element('section', 'connection-hero');
  hero.append(connectionIllustration());
  hero.append(element('h2', '', 'Telefon isteğe bağlıdır'));
  hero.append(element('p', '', 'Cloudflare eşleştirmesi uçtan uca şifreli komutlar ve ikincil Web Push bildirimi sağlar.'));
  const buttons = element('div', 'button-row');
  const qrButton = iconTextButton('QR ile eşleştir', 'primary', 'pair-qr', ICON.qr);
  qrButton.disabled = !state.settings?.cloudEnabled;
  const linkButton = iconTextButton('Bağlantıyı kopyala', 'secondary', 'pair-link', ICON.link);
  linkButton.disabled = !state.settings?.cloudEnabled;
  buttons.append(qrButton, linkButton);
  hero.append(buttons);
  hero.append(element('p', 'privacy-note', 'QR 10 dakika geçerlidir. Kopyalanan bağlantıda 6 haneli PIN varsayılan olarak açıktır.'));
  view.append(hero);

  const cloudPanel = element('section', 'panel');
  const cloudHeading = element('div', 'panel-heading');
  cloudHeading.append(panelLead(strokeIcon(ICON.cloud, 18, 1.7), 'Cloudflare relay', cloudStatusText()), element('i', `status-dot${state.cloud?.connected ? ' online' : ''}`));
  cloudPanel.append(cloudHeading);
  view.append(cloudPanel);

  const localPanel = element('section', 'panel');
  const localHeading = element('div', 'panel-heading');
  localHeading.append(
    panelLead(strokeIcon(ICON.broadcast, 18, 1.7), 'Yerel ağ', state.remote?.enabled ? `Bu Mac'te ${state.remote.port} portunda açık` : 'Varsayılan olarak kapalı'),
    element('i', `status-dot${state.remote?.enabled ? ' online' : ''}`),
  );
  localPanel.append(localHeading);
  view.append(localPanel);

  const devicePanel = element('section', 'panel');
  const devices = Array.isArray(state.cloud?.devices) ? state.cloud.devices : [];
  const deviceHeading = element('div', 'panel-heading');
  const phoneIcon = svgIcon('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2.4"/><path d="M11 18h2"/></svg>');
  deviceHeading.append(panelLead(phoneIcon, `Bağlı cihazlar (${devices.length}/5)`, 'Her telefon ayrı ayrı iptal edilebilir.'));
  devicePanel.append(deviceHeading);
  const list = element('div', 'device-list');
  if (!devices.length) {
    const row = element('div', 'device-row');
    row.append(element('span', '', 'Henüz eşleştirilmiş telefon yok.'));
    list.append(row);
  } else {
    devices.forEach((device) => {
      const row = element('div', 'device-row');
      const copy = element('div');
      copy.append(element('strong', '', device.name || 'Telefon'), element('span', '', device.lastSeenAt ? `Son bağlantı ${new Date(device.lastSeenAt).toLocaleString('tr-TR')}` : 'Bağlı'));
      row.append(copy, button('İptal et', 'text-button', 'revoke-device', device.id));
      list.append(row);
    });
  }
  devicePanel.append(list);
  view.append(devicePanel);
  content.replaceChildren(view);
}

function cloudStatusText() {
  if (!state.settings?.cloudEnabled) return 'Ayarlar bölümünden etkinleştirin.';
  if (state.cloud?.connected) return 'Canlı bağlantı hazır.';
  if (state.cloud?.lastError) return `Bağlantı bekliyor: ${state.cloud.lastError}`;
  if (state.cloud?.enrolled) return 'Yeniden bağlanıyor.';
  return 'Kurulum eşleştirme için hazırlanıyor.';
}

function renderSettings() {
  const settings = state.settings || {};
  const fragment = document.createDocumentFragment();
  fragment.append(renderContentHeader('Ayarlar', 'Güvenli varsayılanları ihtiyacınıza göre değiştirebilirsiniz.'));

  fragment.append(settingsGroup('Alarm', [
    selectSetting('Alarm modu', 'Dengeli mod yükselen sesleri 0, 8, 20, 40, 70 ve 100. saniyelerde çalar.', 'alarmMode', [
      ['quiet', 'Sessiz'], ['balanced', 'Dengeli'], ['strong', 'Güçlü'],
    ], settings.alarmMode || 'balanced'),
    selectSetting('Bildirim gizliliği', 'Genel seçenek görev adını kilit ekranında göstermez.', 'notificationPrivacy', [
      ['generic', 'Genel'], ['detailed', 'Ayrıntılı'],
    ], settings.notificationPrivacy || 'generic'),
    switchSetting('Telefon bildirimi', 'Mac alarmı birincildir. Web Push yalnız ikincil kanaldır.', 'phoneNotifications', settings.phoneNotifications),
  ]));

  fragment.append(settingsGroup('Başlangıç ve ağ', [
    switchSetting('Başlangıçta aç', 'GuruTime Mac oturumu açıldığında menü çubuğunda hazır olur.', 'launchAtLogin', settings.launchAtLogin),
    switchSetting('Yerel ağ sunucusu', 'Yalnız aynı ağdaki telefonlar için açın. Oturumlar iptal edilebilir.', 'localNetworkEnabled', settings.localNetworkEnabled),
    switchSetting('Cloudflare relay', 'Hibernating WebSocket ile düşük maliyetli telefon bağlantısını açar.', 'cloudEnabled', settings.cloudEnabled),
  ]));

  const cloudGroup = settingsGroup('Bulut adresi', []);
  const originForm = element('form', 'inline-form');
  originForm.id = 'cloudOriginForm';
  const originLabel = element('label', '', 'Production origin');
  originLabel.htmlFor = 'cloudOrigin';
  const originInput = element('input');
  originInput.id = 'cloudOrigin';
  originInput.type = 'url';
  originInput.placeholder = 'https://app.alan-adiniz.com';
  originInput.value = settings.cloudOrigin || '';
  const originActions = element('div', 'button-row');
  const saveOrigin = element('button', 'primary', 'Adresi kaydet');
  saveOrigin.type = 'submit';
  originActions.append(saveOrigin);
  originForm.append(originLabel, originInput, element('p', 'form-hint', 'Üretimde kalıcı HTTPS alan adı kullanın. r2.dev yalnız geliştirme içindir.'), originActions);
  cloudGroup.append(originForm);
  fragment.append(cloudGroup);

  const updateGroup = settingsGroup('Güncelleme', [
    selectSetting('Yayın kanalı', 'Stable genel sürümleri, beta ise erken sürümleri alır.', 'updateChannel', [
      ['stable', 'Stable'], ['beta', 'Beta'],
    ], settings.updateChannel || 'stable'),
  ]);
  const updateStatusRow = element('div', 'setting-row');
  let updateDescription = 'Yeni sürümler açılışta ve her 6 saatte bir GitHub üzerinden denetlenir.';
  if (state.updateCheck?.status === 'checking') updateDescription = 'Yeni sürüm denetleniyor…';
  else if (state.updateCheck?.status === 'current') updateDescription = `GuruTime ${state.updateCheck.currentVersion} güncel.`;
  else if (state.updateCheck?.status === 'available') updateDescription = `GuruTime ${state.updateCheck.version} hazır; macOS bildirimi gönderildi.`;
  else if (state.updateCheck?.status === 'error') updateDescription = state.updateCheck.message || 'Güncelleme denetlenemedi.';
  updateStatusRow.append(settingCopy('Otomatik sürüm denetimi', updateDescription));
  const checkUpdateButton = button(
    state.updateCheck?.status === 'checking' ? 'Denetleniyor…' : 'Şimdi denetle',
    'secondary',
    'check-update',
  );
  checkUpdateButton.disabled = state.updateCheck?.status === 'checking';
  updateStatusRow.append(checkUpdateButton);
  updateGroup.querySelector('.panel').append(updateStatusRow);
  const downloadsForm = element('form', 'inline-form');
  downloadsForm.id = 'downloadsOriginForm';
  const downloadsLabel = element('label', '', 'İndirme origin');
  downloadsLabel.htmlFor = 'downloadsOrigin';
  const downloadsInput = element('input');
  downloadsInput.id = 'downloadsOrigin';
  downloadsInput.type = 'url';
  downloadsInput.placeholder = 'https://downloads.alan-adiniz.com';
  downloadsInput.value = settings.downloadsOrigin || '';
  const downloadsActions = element('div', 'button-row');
  const saveDownloads = element('button', 'primary', 'İndirme adresini kaydet');
  saveDownloads.type = 'submit';
  downloadsActions.append(saveDownloads);
  downloadsForm.append(downloadsLabel, downloadsInput, element('p', 'form-hint', 'İmzalı manifest ve immutable DMG sürümleri bu özel R2 alan adından alınır.'), downloadsActions);
  updateGroup.append(downloadsForm);
  fragment.append(updateGroup);
  fragment.insertBefore(updateGroup, fragment.firstChild.nextSibling);

  fragment.append(settingsGroup('Paylaşım', [
    switchSetting('Bağlantıda PIN', 'Kopyalanan eşleştirme bağlantısına rastgele 6 haneli PIN ekler.', 'sharing.linkPinByDefault', settings.sharing?.linkPinByDefault !== false),
    switchSetting('Doğrudan QR’da PIN', 'Ekranınız güvende değilse QR eşleştirmesinde de PIN isteyin.', 'sharing.directQrPinByDefault', settings.sharing?.directQrPinByDefault === true),
  ]));

  const lockGroup = settingsGroup('Uygulama kilidi', [
    switchSetting('Ekran kilidinde kilitle', 'Mac ekranı kilitlendiğinde GuruTime yeniden parola ister.', 'appLock.lockOnScreenLock', settings.appLock?.lockOnScreenLock !== false),
  ]);
  const passwordForm = element('form', 'inline-form');
  passwordForm.id = 'passwordForm';
  const authEnabled = state.auth?.enabled === true;
  passwordForm.append(element('p', 'form-hint', 'Bu yalnız yerel gizlilik kilididir; disk verilerini şifrelemez. Parola düz metin olarak saklanmaz.'));
  const grid = element('div', 'form-grid');
  if (authEnabled) {
    const current = passwordInput('currentPassword', 'Mevcut parola');
    grid.append(current);
  }
  grid.append(passwordInput('newPassword', authEnabled ? 'Yeni parola' : 'Yeni parola'));
  grid.append(passwordInput('confirmPassword', 'Parolayı doğrula'));
  passwordForm.append(grid);
  const passwordError = element('p', 'form-error');
  passwordError.id = 'passwordError';
  passwordError.setAttribute('role', 'alert');
  passwordForm.append(passwordError);
  const passwordActions = element('div', 'button-row');
  const submit = element('button', 'primary', authEnabled ? 'Parolayı değiştir' : 'Kilidi etkinleştir');
  submit.type = 'submit';
  passwordActions.append(submit);
  if (authEnabled) passwordActions.append(button('Kilidi kapat', 'danger-button', 'disable-lock'));
  passwordForm.append(passwordActions);
  lockGroup.append(passwordForm);
  fragment.append(lockGroup);

  const view = element('div', 'tab-view');
  view.append(fragment);
  content.replaceChildren(view);
  document.getElementById('cloudOriginForm')?.addEventListener('submit', saveCloudOrigin);
  document.getElementById('downloadsOriginForm')?.addEventListener('submit', saveDownloadsOrigin);
  document.getElementById('passwordForm')?.addEventListener('submit', savePassword);
}

function settingsGroup(title, rows) {
  const group = element('section', 'settings-group');
  group.append(element('h3', '', title));
  const panel = element('div', 'panel');
  rows.forEach((row) => panel.append(row));
  group.append(panel);
  return group;
}

function settingCopy(title, description) {
  const copy = element('div', 'setting-copy');
  copy.append(element('strong', '', title), element('p', '', description));
  return copy;
}

function switchSetting(title, description, key, checked) {
  const row = element('div', 'setting-row');
  const control = element('label', 'switch');
  const input = element('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  input.dataset.setting = key;
  input.setAttribute('aria-label', title);
  control.append(input, element('span'));
  row.append(settingCopy(title, description), control);
  return row;
}

function selectSetting(title, description, key, options, value) {
  const row = element('div', 'setting-row');
  const select = element('select');
  select.dataset.setting = key;
  select.setAttribute('aria-label', title);
  options.forEach(([id, label]) => {
    const option = element('option', '', label);
    option.value = id;
    option.selected = id === value;
    select.append(option);
  });
  row.append(settingCopy(title, description), select);
  return row;
}

function passwordInput(id, placeholder) {
  const input = element('input');
  input.id = id;
  input.name = id;
  input.type = 'password';
  input.autocomplete = id === 'currentPassword' ? 'current-password' : 'new-password';
  input.placeholder = placeholder;
  input.minLength = 6;
  input.required = true;
  return input;
}

function patchForSetting(path, value) {
  if (!path.includes('.')) return { [path]: value };
  const [parent, child] = path.split('.');
  return { [parent]: { [child]: value } };
}

async function updateSetting(target) {
  const value = target.type === 'checkbox' ? target.checked : target.value;
  try {
    state.settings = await ipc.invoke('update-settings', patchForSetting(target.dataset.setting, value));
    showToast('Ayar kaydedildi');
    if (target.dataset.setting === 'cloudEnabled' || target.dataset.setting === 'localNetworkEnabled') {
      await refreshConnections();
    }
  } catch (error) {
    showToast(errorMessage(error));
    await refreshSettings();
    render();
  }
}

async function saveCloudOrigin(event) {
  event.preventDefault();
  const input = document.getElementById('cloudOrigin');
  try {
    state.settings = await ipc.invoke('update-settings', { cloudOrigin: input.value });
    input.value = state.settings.cloudOrigin || '';
    showToast('Bulut adresi kaydedildi');
    await refreshConnections();
  } catch (error) {
    showToast(errorMessage(error));
  }
}

async function saveDownloadsOrigin(event) {
  event.preventDefault();
  const input = document.getElementById('downloadsOrigin');
  try {
    state.settings = await ipc.invoke('update-settings', { downloadsOrigin: input.value });
    input.value = state.settings.downloadsOrigin || '';
    showToast('İndirme adresi kaydedildi');
  } catch (error) {
    showToast(errorMessage(error));
  }
}

async function checkForUpdate() {
  state.updateCheck = { status: 'checking' };
  renderSettings();
  try {
    state.updateCheck = await ipc.invoke('check-for-update');
    if (state.updateCheck.status === 'available') showToast(`GuruTime ${state.updateCheck.version} hazır`);
    else if (state.updateCheck.status === 'current') showToast('GuruTime güncel');
    else showToast('Güncelleme denetimi sürüyor');
  } catch (error) {
    state.updateCheck = { status: 'error', message: errorMessage(error) };
    showToast(errorMessage(error));
  }
  renderSettings();
}

async function savePassword(event) {
  event.preventDefault();
  const error = document.getElementById('passwordError');
  const currentPassword = document.getElementById('currentPassword')?.value || '';
  const newPassword = document.getElementById('newPassword').value;
  const confirmation = document.getElementById('confirmPassword').value;
  error.textContent = '';
  if (newPassword.length < 6) {
    error.textContent = 'Parola en az 6 karakter olmalı.';
    return;
  }
  if (newPassword !== confirmation) {
    error.textContent = 'Parolalar eşleşmiyor.';
    return;
  }
  try {
    const wasEnabled = state.auth?.enabled === true;
    state.auth = await ipc.invoke('set-app-password', { currentPassword, newPassword });
    showToast(wasEnabled ? 'Parola güncellendi' : 'Uygulama kilidi etkin');
    renderSettings();
  } catch (err) {
    error.textContent = errorMessage(err);
  }
}

async function disableLock() {
  const currentPassword = document.getElementById('currentPassword')?.value || '';
  const error = document.getElementById('passwordError');
  if (!currentPassword) {
    error.textContent = 'Kilidi kapatmak için mevcut parolayı girin.';
    return;
  }
  try {
    state.auth = await ipc.invoke('disable-app-password', currentPassword);
    showToast('Uygulama kilidi kapatıldı');
    renderSettings();
  } catch (err) {
    error.textContent = errorMessage(err);
  }
}

async function mutateTodo(type, payload = {}) {
  const response = await ipc.invoke('mutate-todo', { type, ...payload });
  if (Array.isArray(response)) state.todos = response;
  else if (response?.state?.todos) state.todos = response.state.todos;
  else await refreshTodos();
  render();
}

function openAlarmDialog(taskId) {
  const todo = state.todos.find((item) => item.id === taskId);
  if (!todo) return;
  state.selectedTaskId = taskId;
  alarmTaskTitle.textContent = todo.title;
  alarmMinutes.value = '10';
  alarmError.textContent = '';
  alarmDialog.showModal();
  setTimeout(() => alarmMinutes.select(), 30);
}

async function submitAlarm(event) {
  event.preventDefault();
  const todo = state.todos.find((item) => item.id === state.selectedTaskId);
  const minutes = Number(alarmMinutes.value);
  if (!todo || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    alarmError.textContent = '1 ile 1440 dakika arasında bir tam sayı girin.';
    return;
  }
  ipc.send('set-alarm', { taskId: todo.id, taskTitle: todo.title, minutes });
  alarmDialog.close();
  showToast(`${formatDuration(minutes)} için alarm kuruldu`);
}

async function createPairing(kind) {
  const requirePin = kind === 'link'
    ? state.settings?.sharing?.linkPinByDefault !== false
    : state.settings?.sharing?.directQrPinByDefault === true;
  pairingError.textContent = '';
  pairingPinRow.hidden = true;
  try {
    const invite = await ipc.invoke('create-pairing-invite', { kind, requirePin });
    if (!invite?.inviteUrl) throw new Error('Eşleştirme bağlantısı oluşturulamadı.');
    if (kind === 'link') {
      await ipc.invoke('copy-text', invite.inviteUrl);
      showToast(invite.pin ? `Bağlantı kopyalandı. PIN: ${invite.pin}` : 'Bağlantı kopyalandı');
      return;
    }
    qrImage.removeAttribute('src');
    qrImage.src = await window.guruTime.qrDataUrl(invite.inviteUrl, { width: 220, margin: 1 });
    if (invite.pin) {
      pairingPin.textContent = invite.pin;
      pairingPinRow.hidden = false;
    }
    pairingDialog.showModal();
  } catch (error) {
    if (kind === 'link') showToast(errorMessage(error));
    else {
      pairingDialog.showModal();
      pairingError.textContent = errorMessage(error);
    }
  }
}

async function revokeDevice(id) {
  try {
    await ipc.invoke('revoke-paired-device', id);
    await refreshConnections();
    renderConnections();
    showToast('Telefon bağlantısı iptal edildi');
  } catch (error) {
    showToast(errorMessage(error));
  }
}

async function refreshTodos() {
  state.todos = await ipc.invoke('load-todos') || [];
}

async function refreshSettings() {
  state.settings = await ipc.invoke('get-settings');
}

async function refreshConnections() {
  [state.remote, state.cloud] = await Promise.all([
    ipc.invoke('get-remote-info'),
    ipc.invoke('get-cloud-relay-info'),
  ]);
}

async function refreshAll() {
  state.auth = await ipc.invoke('get-auth-state');
  updateLock();
  if (state.auth?.enabled && !state.auth?.unlocked) return;
  await Promise.all([refreshTodos(), refreshSettings(), refreshConnections()]);
  render();
  ipc.send('get-alarms');
}

function updateLock() {
  const locked = state.auth?.enabled === true && state.auth?.unlocked !== true;
  lockScreen.hidden = !locked;
  app.setAttribute('aria-hidden', String(locked));
  if (locked) setTimeout(() => unlockPassword.focus(), 20);
  else unlockError.textContent = '';
}

async function unlock(event) {
  event.preventDefault();
  unlockError.textContent = '';
  try {
    state.auth = await ipc.invoke('verify-password', unlockPassword.value);
    unlockPassword.value = '';
    if (!state.auth?.unlocked) {
      unlockError.textContent = 'Parola hatalı.';
      return;
    }
    updateLock();
    await refreshAll();
    showToast('Kilit açıldı');
  } catch (error) {
    unlockPassword.value = '';
    unlockError.textContent = errorMessage(error);
  }
}

document.querySelector('.tabs').addEventListener('click', async (event) => {
  const tab = event.target.closest('[data-tab]');
  if (!tab) return;
  state.activeTab = tab.dataset.tab;
  if (state.activeTab === 'connections') await refreshConnections();
  if (state.activeTab === 'settings') await refreshSettings();
  render();
  content.focus({ preventScroll: true });
});

quickAddForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = quickAddInput.value.trim();
  if (!title) return;
  quickAddInput.value = '';
  state.pendingNewTitle = title;
  try {
    await mutateTodo('add', { title, category: quickAddCategory.value });
  } catch (error) {
    state.pendingNewTitle = null;
    quickAddInput.value = title;
    showToast(errorMessage(error));
  }
});

content.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, id } = target.dataset;
  try {
    if (action === 'toggle') {
      const todo = state.todos.find((item) => item.id === id);
      if (todo && !todo.isDone) celebrate(target);
      await mutateTodo('toggle', { id });
    }
    else if (action === 'archive') await mutateTodo('update', { id, patch: { isArchived: true } });
    else if (action === 'restore') await mutateTodo('update', { id, patch: { isArchived: false } });
    else if (action === 'delete') await mutateTodo('delete', { id });
    else if (action === 'alarm') openAlarmDialog(id);
    else if (action === 'cancel-alarm') ipc.send('cancel-alarm', { alarmId: id });
    else if (action === 'pair-qr') await createPairing('qr');
    else if (action === 'pair-link') await createPairing('link');
    else if (action === 'revoke-device') await revokeDevice(id);
    else if (action === 'disable-lock') await disableLock();
    else if (action === 'check-update') await checkForUpdate();
  } catch (error) {
    showToast(errorMessage(error));
  }
});

content.addEventListener('change', (event) => {
  const target = event.target.closest('[data-setting]');
  if (target) updateSetting(target);
});

alarmForm.addEventListener('submit', submitAlarm);
document.querySelector('.duration-presets').addEventListener('click', (event) => {
  const preset = event.target.closest('[data-minutes]');
  if (preset) alarmMinutes.value = preset.dataset.minutes;
});

document.querySelectorAll('[data-close]').forEach((target) => {
  target.addEventListener('click', () => document.getElementById(target.dataset.close)?.close());
});

unlockForm.addEventListener('submit', unlock);
document.getElementById('quitButton').addEventListener('click', () => ipc.send('quit-app'));

ipc.on('alarms-updated', (_event, alarms) => {
  state.alarms = Array.isArray(alarms) ? alarms : [];
  render();
});
ipc.on('reload-todos', async () => { await refreshTodos(); render(); });
ipc.on('remote-updated', (_event, info) => { state.remote = info; if (state.activeTab === 'connections') render(); });
ipc.on('cloud-relay-updated', (_event, info) => { state.cloud = info; if (state.activeTab === 'connections') render(); });
ipc.on('auth-state-changed', (_event, auth) => { state.auth = auth; updateLock(); });
ipc.on('settings-updated', (_event, settings) => { state.settings = settings; render(); });
ipc.on('popover-opened', async () => { state.auth = await ipc.invoke('get-auth-state'); updateLock(); });
ipc.on('set-mode', (_event, mode, data) => {
  if (mode === 'pick' && data?.taskId) openAlarmDialog(data.taskId);
  else if (mode === 'todo') { state.activeTab = 'tasks'; render(); }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (pairingDialog.open) pairingDialog.close();
  if (alarmDialog.open) alarmDialog.close();
});

window.addEventListener('DOMContentLoaded', () => {
  refreshAll().catch((error) => {
    content.replaceChildren(element('div', 'empty-state', errorMessage(error)));
  });
});
