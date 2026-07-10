const elements = {
  installCard: document.querySelector("#install-card"),
  installButton: document.querySelector("#install-button"),
  pairCard: document.querySelector("#pair-card"),
  pairForm: document.querySelector("#pair-form"),
  pinField: document.querySelector("#pin-field"),
  controlCard: document.querySelector("#control-card"),
  commandForm: document.querySelector("#command-form"),
  alarmOptions: document.querySelector("#alarm-options"),
  pushCard: document.querySelector("#push-card"),
  pushButton: document.querySelector("#push-button"),
  iosHint: document.querySelector("#ios-hint"),
  status: document.querySelector("#status"),
  activityList: document.querySelector("#activity-list"),
};

let deferredInstallPrompt;
let invite;
let configuration;
let statusTimer;

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function showStatus(message, isError = false) {
  clearTimeout(statusTimer);
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
  elements.status.hidden = false;
  statusTimer = setTimeout(() => { elements.status.hidden = true; }, 4500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error?.message ?? `İstek başarısız (${response.status})`);
    error.code = payload.error?.code;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("gurutime-pwa", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function savePairingKey(data) {
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("keys", "readwrite");
    transaction.objectStore("keys").put(data, "active");
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function loadPairingKey() {
  const database = await openDatabase();
  const result = await new Promise((resolve, reject) => {
    const request = database.transaction("keys").objectStore("keys").get("active");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return result;
}

async function encryptCommand(pairingKey, value) {
  const key = await crypto.subtle.importKey("raw", decodeBase64Url(pairingKey), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const envelope = new Uint8Array(iv.byteLength + encrypted.byteLength);
  envelope.set(iv, 0);
  envelope.set(encrypted, iv.byteLength);
  return encodeBase64Url(envelope);
}

function parseInvite() {
  const params = new URLSearchParams(location.hash.slice(1));
  const encoded = params.get("pair");
  if (!encoded) return;
  try {
    const decoded = new TextDecoder().decode(decodeBase64Url(encoded));
    const candidate = JSON.parse(decoded);
    if (candidate.v !== 1 || !candidate.i || !candidate.n || !candidate.x || !candidate.k) throw new Error("bad invite");
    invite = candidate;
    elements.pairCard.hidden = false;
    document.querySelector("#pin").focus();
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  } catch {
    showStatus("Eşleştirme bağlantısı geçersiz.", true);
  }
}

function addActivity(message) {
  elements.activityList.querySelector(".empty")?.remove();
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })} · ${message}`;
  elements.activityList.prepend(item);
}

async function enableControlIfPaired() {
  const stored = await loadPairingKey();
  if (!stored?.pairingKey || !stored?.installationId) return;
  elements.controlCard.hidden = false;
  elements.pushCard.hidden = false;
  return stored;
}

elements.pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!invite) return;
  const submit = elements.pairForm.querySelector("button[type=submit]");
  submit.disabled = true;
  const form = new FormData(elements.pairForm);
  try {
    const result = await api("/api/v1/pairing/claim", {
      method: "POST",
      body: JSON.stringify({
        installationId: invite.i,
        inviteId: invite.n,
        pairingSecret: invite.k,
        pin: form.get("pin") || undefined,
        deviceName: form.get("deviceName"),
      }),
    });
    await savePairingKey({ installationId: invite.i, pairingKey: invite.k, keyId: invite.x, phoneId: result.phone.id });
    elements.pairCard.hidden = true;
    elements.controlCard.hidden = false;
    elements.pushCard.hidden = false;
    addActivity("Telefon güvenle eşleştirildi");
    showStatus("Telefon eşleştirildi.");
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

elements.commandForm.addEventListener("change", () => {
  const kind = new FormData(elements.commandForm).get("kind");
  elements.alarmOptions.hidden = kind !== "alarm";
});

elements.commandForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const stored = await loadPairingKey();
  if (!stored) return showStatus("Yeniden eşleştirme gerekli.", true);
  const form = new FormData(elements.commandForm);
  const mode = form.get("kind");
  const title = String(form.get("title") ?? "").trim();
  if (!title) return;
  const fireAt = mode === "alarm" ? Date.now() + Number(form.get("minutes")) * 60_000 : undefined;
  const kind = mode === "alarm" ? "alarm.create" : "task.create";
  const plaintext = { v: 1, kind, createdAt: Date.now(), payload: { title, fireAt } };
  const submit = elements.commandForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const ciphertext = await encryptCommand(stored.pairingKey, plaintext);
    await api("/api/v1/commands", {
      method: "POST",
      body: JSON.stringify({
        commandId: `phone-${crypto.randomUUID()}`,
        kind,
        ciphertext,
        ...(fireAt ? { fireAt } : {}),
      }),
    });
    addActivity(mode === "alarm" ? "Şifreli alarm komutu kuyruğa alındı" : "Şifreli görev komutu kuyruğa alındı");
    elements.commandForm.reset();
    elements.alarmOptions.hidden = true;
    showStatus("Komut Mac’e gönderildi.");
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

elements.pushButton.addEventListener("click", async () => {
  if (!configuration?.pushConfigured || !configuration.vapidPublicKey) {
    return showStatus("Sunucuda Web Push henüz yapılandırılmadı.", true);
  }
  elements.pushButton.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Bildirim izni verilmedi.");
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(configuration.vapidPublicKey),
    });
    await api("/api/v1/push/subscription", { method: "PUT", body: JSON.stringify(subscription.toJSON()) });
    elements.pushButton.textContent = "Bildirimler açık";
    addActivity("Telefon bildirimleri açıldı");
    showStatus("Alarm bildirimleri açıldı.");
  } catch (error) {
    showStatus(error.message, true);
    elements.pushButton.disabled = false;
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  elements.installCard.hidden = false;
});

elements.installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  await deferredInstallPrompt.prompt();
  deferredInstallPrompt = undefined;
  elements.installCard.hidden = true;
});

async function start() {
  if ("serviceWorker" in navigator) await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  configuration = await api("/api/v1/config");
  parseInvite();
  await enableControlIfPaired();
  const isIos = /iphone|ipad|ipod/iu.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  elements.iosHint.hidden = !(isIos && !isStandalone);
}

start().catch((error) => showStatus(error.message, true));
