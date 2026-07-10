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
};

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

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
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

function updateChrome() {
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    const active = tab.dataset.tab === state.activeTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
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

function renderTasks() {
  const fragment = document.createDocumentFragment();
  const current = state.todos.filter((todo) => !todo.isArchived);
  const active = current.filter((todo) => !todo.isDone).length;
  const done = current.filter((todo) => todo.isDone).length;
  const archived = state.todos.filter((todo) => todo.isArchived).length;

  fragment.append(renderContentHeader('Bugünün akışı', 'Alarm kurmak için görevdeki zil düğmesini kullanın.'));
  const summary = element('div', 'summary');
  [['Açık', active], ['Alarm', state.alarms.filter(isActiveAlarm).length], ['Arşiv', archived]].forEach(([label, value]) => {
    const metric = element('div', 'metric');
    metric.append(element('span', '', label), element('strong', '', String(value)));
    summary.append(metric);
  });
  fragment.append(summary);

  categories.forEach((category) => {
    const tasks = current.filter((todo) => todo.category === category.id);
    if (!tasks.length) return;
    const section = element('section', 'category');
    section.dataset.category = category.id;
    const heading = element('div', 'category-heading');
    heading.append(element('i', 'category-mark'), element('h3', '', category.label), element('span', '', String(tasks.length)));
    const list = element('div', 'task-list');
    tasks.sort((a, b) => Number(a.isDone) - Number(b.isDone)).forEach((todo) => list.append(renderTaskRow(todo)));
    section.append(heading, list);
    fragment.append(section);
  });

  if (!current.length) {
    const empty = element('div', 'empty-state');
    empty.append(element('strong', '', 'Liste boş'), document.createTextNode('Aşağıdaki alandan ilk görevinizi ekleyin.'));
    fragment.append(empty);
  }

  if (archived) {
    const section = element('section', 'category');
    const heading = element('div', 'category-heading');
    heading.append(element('i', 'category-mark'), element('h3', '', 'Arşiv'), element('span', '', String(archived)));
    const list = element('div', 'task-list');
    state.todos.filter((todo) => todo.isArchived).slice(-20).reverse().forEach((todo) => list.append(renderTaskRow(todo)));
    section.append(heading, list);
    fragment.append(section);
  }

  if (done && !archived) {
    const note = element('p', 'privacy-note', 'Tamamlanan görevleri satırdaki arşiv düğmesiyle kaldırabilirsiniz.');
    fragment.append(note);
  }
  content.replaceChildren(fragment);
}

function renderTaskRow(todo) {
  const row = element('article', `task-row${todo.isDone ? ' done' : ''}`);
  const check = button('✓', `check-button${todo.isDone ? ' checked' : ''}`, 'toggle', todo.id);
  check.setAttribute('aria-label', todo.isDone ? `${todo.title} görevini yeniden aç` : `${todo.title} görevini tamamla`);

  const copy = element('div', 'task-copy');
  copy.append(element('span', 'task-title', todo.title || 'İsimsiz görev'));
  const meta = element('span', 'task-meta');
  const alarm = alarmForTask(todo.id);
  if (alarm) {
    const occurrence = Number(alarm.occurrence) || 1;
    const label = alarm.status === 'ringing' ? 'Çalıyor' : `${formatAlarmTime(alarm.fireAt)} alarmı`;
    meta.append(element('span', '', occurrence > 1 ? `${label}, ${occurrence}. tekrar` : label));
  } else {
    meta.append(element('span', '', todo.isDone ? 'Tamamlandı' : 'Yerel görev'));
  }
  copy.append(meta);

  const actions = element('div', 'task-actions');
  if (!todo.isArchived && !todo.isDone) {
    const alarmButton = button('Alarm', 'task-action', 'alarm', todo.id);
    alarmButton.setAttribute('aria-label', `${todo.title} için alarm ayarla`);
    actions.append(alarmButton);
  }
  if (alarm) {
    const cancel = button('İptal', 'task-action danger', 'cancel-alarm', alarm.id || alarm.alarmId);
    cancel.setAttribute('aria-label', `${todo.title} alarmını iptal et`);
    actions.append(cancel);
  }
  const archive = button(todo.isArchived ? 'Geri' : 'Arşiv', 'task-action', todo.isArchived ? 'restore' : 'archive', todo.id);
  archive.setAttribute('aria-label', todo.isArchived ? `${todo.title} görevini geri getir` : `${todo.title} görevini arşivle`);
  const remove = button('Sil', 'task-action danger', 'delete', todo.id);
  remove.setAttribute('aria-label', `${todo.title} görevini sil`);
  actions.append(archive, remove);
  row.append(check, copy, actions);
  return row;
}

function renderConnections() {
  const fragment = document.createDocumentFragment();
  fragment.append(renderContentHeader('Telefon bağlantısı', 'İnternet kapansa da Mac görevleri ve alarmları çalışmaya devam eder.'));

  const hero = element('section', 'connection-hero');
  hero.append(element('h2', '', 'Telefon isteğe bağlıdır'));
  hero.append(element('p', '', 'Cloudflare eşleştirmesi uçtan uca şifreli komutlar ve ikincil Web Push bildirimi sağlar.'));
  const buttons = element('div', 'button-row');
  const qrButton = button('QR ile eşleştir', 'primary', 'pair-qr');
  qrButton.disabled = !state.settings?.cloudEnabled;
  const linkButton = button('Bağlantıyı kopyala', 'secondary', 'pair-link');
  linkButton.disabled = !state.settings?.cloudEnabled;
  buttons.append(qrButton, linkButton);
  hero.append(buttons);
  hero.append(element('p', 'privacy-note', 'QR 10 dakika geçerlidir. Kopyalanan bağlantıda 6 haneli PIN varsayılan olarak açıktır.'));
  fragment.append(hero);

  const cloudPanel = element('section', 'panel');
  const cloudHeading = element('div', 'panel-heading');
  const cloudCopy = element('div');
  cloudCopy.append(element('h3', '', 'Cloudflare relay'), element('p', '', cloudStatusText()));
  cloudHeading.append(cloudCopy, element('i', `status-dot${state.cloud?.connected ? ' online' : ''}`));
  cloudPanel.append(cloudHeading);
  fragment.append(cloudPanel);

  const localPanel = element('section', 'panel');
  const localHeading = element('div', 'panel-heading');
  const localCopy = element('div');
  localCopy.append(element('h3', '', 'Yerel ağ'), element('p', '', state.remote?.enabled ? `Bu Mac'te ${state.remote.port} portunda açık` : 'Varsayılan olarak kapalı'));
  localHeading.append(localCopy, element('i', `status-dot${state.remote?.enabled ? ' online' : ''}`));
  localPanel.append(localHeading);
  fragment.append(localPanel);

  const devicePanel = element('section', 'panel');
  const deviceHeading = element('div', 'panel-heading');
  const deviceCopy = element('div');
  const devices = Array.isArray(state.cloud?.devices) ? state.cloud.devices : [];
  deviceCopy.append(element('h3', '', `Bağlı cihazlar (${devices.length}/5)`), element('p', '', 'Her telefon ayrı ayrı iptal edilebilir.'));
  deviceHeading.append(deviceCopy);
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
  fragment.append(devicePanel);
  content.replaceChildren(fragment);
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

  content.replaceChildren(fragment);
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
  try {
    await mutateTodo('add', { title, category: quickAddCategory.value });
  } catch (error) {
    quickAddInput.value = title;
    showToast(errorMessage(error));
  }
});

content.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, id } = target.dataset;
  try {
    if (action === 'toggle') await mutateTodo('toggle', { id });
    else if (action === 'archive') await mutateTodo('update', { id, patch: { isArchived: true } });
    else if (action === 'restore') await mutateTodo('update', { id, patch: { isArchived: false } });
    else if (action === 'delete') await mutateTodo('delete', { id });
    else if (action === 'alarm') openAlarmDialog(id);
    else if (action === 'cancel-alarm') ipc.send('cancel-alarm', { alarmId: id });
    else if (action === 'pair-qr') await createPairing('qr');
    else if (action === 'pair-link') await createPairing('link');
    else if (action === 'revoke-device') await revokeDevice(id);
    else if (action === 'disable-lock') await disableLock();
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
