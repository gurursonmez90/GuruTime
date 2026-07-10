import { DurableObject } from "cloudflare:workers";
import {
  base64UrlEncode,
  clearSessionCookie,
  HttpError,
  json,
  randomToken,
  readJson,
  readSessionCookie,
  requireInternal,
  secretHash,
  sessionCookie,
  timingSafeEqual,
} from "./security";
import type {
  CommandEnvelope,
  ControllerAttachment,
  Env,
  PairingClaim,
  PushSubscriptionRecord,
} from "./types";
import { sendGenericAlarmPush, webPushConfigured } from "./webpush";

const INVITE_TTL_MS = 10 * 60 * 1000;
const PIN_LOCK_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WS_TICKET_TTL_MS = 60 * 1000;
const LEASE_MS = 30 * 1000;
const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PHONE_ALARM_DELAY_MS = 24 * 60 * 60 * 1000;
const ALARM_GRACE_MS = 15 * 60 * 1000;
const MAX_PHONES = 5;
const MAX_PENDING_COMMANDS = 100;
const MAX_COMMANDS_PER_MINUTE = 20;

interface ConfigRow {
  [key: string]: SqlStorageValue;
  value: string;
}

interface InviteRow {
  [key: string]: SqlStorageValue;
  invite_id: string;
  key_id: string;
  pairing_secret_hash: string;
  pin_hash: string | null;
  expires_at: number;
  failed_attempts: number;
  locked_until: number | null;
  used_at: number | null;
}

interface PhoneRow {
  [key: string]: SqlStorageValue;
  phone_id: string;
  key_id: string;
  name: string;
  session_hash: string;
  session_expires_at: number;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

interface CommandRow {
  [key: string]: SqlStorageValue;
  command_id: string;
  phone_id: string;
  key_id: string;
  kind: string;
  ciphertext: string;
  state: "queued" | "leased" | "acked" | "expired";
  created_at: number;
  expires_at: number;
  leased_until: number | null;
  lease_token: string | null;
  controller_id: string | null;
  delivery_attempts: number;
  acked_at: number | null;
}

interface AlarmRow {
  [key: string]: SqlStorageValue;
  alarm_id: string;
  occurrence: number;
  fire_at: number;
  status: "pending" | "sent" | "cancelled";
  dispatched_at: number | null;
}

interface PushRow {
  [key: string]: SqlStorageValue;
  phone_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: number | null;
}

export class Installation extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ws_tickets (
          ticket_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          used_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS pairing_invites (
          invite_id TEXT PRIMARY KEY,
          key_id TEXT NOT NULL,
          pairing_secret_hash TEXT NOT NULL,
          pin_hash TEXT,
          expires_at INTEGER NOT NULL,
          failed_attempts INTEGER NOT NULL DEFAULT 0,
          locked_until INTEGER,
          used_at INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS phones (
          phone_id TEXT PRIMARY KEY,
          key_id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          session_hash TEXT NOT NULL,
          session_expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          phone_id TEXT PRIMARY KEY,
          endpoint TEXT NOT NULL,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          expiration_time INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(phone_id) REFERENCES phones(phone_id)
        );
        CREATE TABLE IF NOT EXISTS commands (
          command_id TEXT PRIMARY KEY,
          phone_id TEXT NOT NULL,
          key_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued', 'leased', 'acked', 'expired')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          leased_until INTEGER,
          lease_token TEXT,
          controller_id TEXT,
          delivery_attempts INTEGER NOT NULL DEFAULT 0,
          acked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS commands_delivery_idx
          ON commands(state, created_at);
        CREATE TABLE IF NOT EXISTS rate_limits (
          key TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          attempts INTEGER NOT NULL,
          PRIMARY KEY(key, window_start)
        );
        CREATE TABLE IF NOT EXISTS alarms (
          alarm_id TEXT NOT NULL,
          occurrence INTEGER NOT NULL,
          fire_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'cancelled')),
          dispatched_at INTEGER,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(alarm_id, occurrence)
        );
        CREATE INDEX IF NOT EXISTS alarms_due_idx
          ON alarms(status, fire_at);
      `);
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      requireInternal(request, this.env);
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/internal/initialize") return await this.initialize(request);
      if (request.method === "POST" && url.pathname === "/internal/revoke-installation") return await this.revokeInstallation();
      await this.requireActiveInstallation();

      if (request.method === "POST" && url.pathname === "/internal/controller-ticket") return await this.createControllerTicket(request);
      if (request.method === "GET" && url.pathname === "/internal/controller-socket") return await this.acceptController(request);
      if (request.method === "POST" && url.pathname === "/internal/invites") return await this.createInvite(request);
      if (request.method === "POST" && url.pathname === "/internal/pairing-claim") return await this.claimInvite(request);
      if (request.method === "GET" && url.pathname === "/internal/phones") return await this.listPhones(request);
      if (request.method === "DELETE" && url.pathname.startsWith("/internal/phones/")) {
        return await this.revokePhone(request, decodeURIComponent(url.pathname.slice("/internal/phones/".length)));
      }
      if (request.method === "POST" && url.pathname === "/internal/phone-command") return await this.enqueueCommand(request);
      if (request.method === "PUT" && url.pathname === "/internal/alarm") return await this.scheduleAlarm(request);
      if (request.method === "DELETE" && url.pathname === "/internal/alarm") return await this.cancelAlarm(request);
      if (request.method === "PUT" && url.pathname === "/internal/push-subscription") return await this.savePushSubscription(request);
      if (request.method === "DELETE" && url.pathname === "/internal/push-subscription") return await this.removePushSubscription(request);
      if (request.method === "POST" && url.pathname === "/internal/logout") return await this.logout(request);

      throw new HttpError(404, "not_found", "Bulunamadı.");
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: error.headers });
      }
      console.error("Installation error", error);
      return json({ error: { code: "installation_error", message: "Kurulum servisi hatası." } }, { status: 500 });
    }
  }

  private getConfig(key: string): string | null {
    return this.sql.exec<ConfigRow>("SELECT value FROM config WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  private setConfig(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private async initialize(request: Request): Promise<Response> {
    const body = await readJson<{ installationId?: string; deviceSecretHash?: string }>(request, 1024);
    if (!/^[0-9a-f-]{36}$/iu.test(body.installationId ?? "") || !/^[A-Za-z0-9_-]{40,}$/u.test(body.deviceSecretHash ?? "")) {
      throw new HttpError(400, "invalid_initialization", "Kurulum verisi geçersiz.");
    }
    const existingId = this.getConfig("installation_id");
    if (existingId && existingId !== body.installationId) {
      throw new HttpError(409, "already_initialized", "Kurulum zaten başlatılmış.");
    }
    this.setConfig("installation_id", body.installationId!);
    this.setConfig("device_secret_hash", body.deviceSecretHash!);
    this.setConfig("created_at", String(Date.now()));
    this.setConfig("revoked_at", "");
    return json({ initialized: true }, { status: 201 });
  }

  private async requireActiveInstallation(): Promise<void> {
    if (!this.getConfig("installation_id")) {
      throw new HttpError(404, "installation_not_found", "Kurulum bulunamadı.");
    }
    if (this.getConfig("revoked_at")) {
      throw new HttpError(410, "installation_revoked", "Kurulum iptal edilmiş.");
    }
  }

  private async requireDevice(request: Request): Promise<void> {
    const installationId = request.headers.get("x-gurutime-installation") ?? "";
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^GuruTimeDevice ([A-Za-z0-9_-]{40,})$/u.exec(authorization);
    if (!match || installationId !== this.getConfig("installation_id")) {
      throw new HttpError(401, "invalid_device_auth", "Cihaz kimlik doğrulaması başarısız.");
    }
    const candidate = await secretHash(this.env, `device:${installationId}`, match[1]!);
    if (!timingSafeEqual(candidate, this.getConfig("device_secret_hash") ?? "")) {
      throw new HttpError(401, "invalid_device_auth", "Cihaz kimlik doğrulaması başarısız.");
    }
  }

  private async requirePhone(request: Request): Promise<PhoneRow> {
    const session = readSessionCookie(request);
    if (session.installationId !== this.getConfig("installation_id")) {
      throw new HttpError(401, "invalid_phone_session", "Telefon oturumu geçersiz.");
    }
    const row = this.sql.exec<PhoneRow>("SELECT * FROM phones WHERE phone_id = ?", session.phoneId).toArray()[0];
    if (!row || row.revoked_at || row.session_expires_at <= Date.now()) {
      throw new HttpError(401, "expired_phone_session", "Telefon oturumu sona ermiş.");
    }
    const candidate = await secretHash(this.env, `session:${session.installationId}:${session.phoneId}`, session.token);
    if (!timingSafeEqual(candidate, row.session_hash)) {
      throw new HttpError(401, "invalid_phone_session", "Telefon oturumu geçersiz.");
    }
    this.sql.exec("UPDATE phones SET last_seen_at = ? WHERE phone_id = ?", Date.now(), row.phone_id);
    return row;
  }

  private async revokeInstallation(): Promise<Response> {
    const now = Date.now();
    this.setConfig("revoked_at", String(now));
    this.sql.exec("UPDATE phones SET revoked_at = ? WHERE revoked_at IS NULL", now);
    this.sql.exec("UPDATE commands SET state = 'expired', leased_until = NULL, lease_token = NULL, controller_id = NULL WHERE state IN ('queued', 'leased')");
    this.sql.exec("UPDATE alarms SET status = 'cancelled' WHERE status = 'pending'");
    this.sql.exec("DELETE FROM push_subscriptions");
    await this.ctx.storage.deleteAlarm();
    for (const socket of this.ctx.getWebSockets("controller")) socket.close(4003, "installation revoked");
    return new Response(null, { status: 204 });
  }

  private async createControllerTicket(request: Request): Promise<Response> {
    await this.requireDevice(request);
    const ticket = randomToken(32);
    const ticketHash = await secretHash(this.env, `ws-ticket:${this.getConfig("installation_id")}`, ticket);
    const now = Date.now();
    const expiresAt = now + WS_TICKET_TTL_MS;
    this.sql.exec("DELETE FROM ws_tickets WHERE expires_at <= ? OR used_at IS NOT NULL", now);
    this.sql.exec("INSERT INTO ws_tickets(ticket_hash, expires_at, used_at) VALUES (?, ?, NULL)", ticketHash, expiresAt);
    return json({ ticket, expiresAt });
  }

  private async acceptController(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new HttpError(426, "websocket_required", "WebSocket yükseltmesi gerekli.", { upgrade: "websocket" });
    }
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim());
    if (!protocols.includes("gurutime.v1")) {
      throw new HttpError(400, "unsupported_websocket_protocol", "gurutime.v1 alt protokolü gerekli.");
    }
    const ticket = protocols.find((value) => value.startsWith("ticket."))?.slice("ticket.".length) ?? "";
    if (!/^[A-Za-z0-9_-]{40,}$/u.test(ticket)) {
      throw new HttpError(401, "invalid_ws_ticket", "WebSocket bileti geçersiz.");
    }
    const now = Date.now();
    const ticketHash = await secretHash(this.env, `ws-ticket:${this.getConfig("installation_id")}`, ticket);
    const ticketRow = this.sql
      .exec<{ expires_at: number; used_at: number | null }>(
        "SELECT expires_at, used_at FROM ws_tickets WHERE ticket_hash = ?",
        ticketHash,
      )
      .toArray()[0];
    if (!ticketRow || ticketRow.used_at || ticketRow.expires_at <= now) {
      throw new HttpError(401, "expired_ws_ticket", "WebSocket bileti kullanılmış veya süresi dolmuş.");
    }
    this.sql.exec("UPDATE ws_tickets SET used_at = ? WHERE ticket_hash = ? AND used_at IS NULL", now, ticketHash);

    for (const existing of this.ctx.getWebSockets("controller")) {
      existing.close(4001, "replaced by a newer controller");
    }
    this.sql.exec(
      "UPDATE commands SET state = 'queued', leased_until = NULL, lease_token = NULL, controller_id = NULL WHERE state = 'leased'",
    );

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const controllerId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, ["controller"]);
    server.serializeAttachment({ role: "controller", controllerId, connectedAt: now } satisfies ControllerAttachment);
    server.send(JSON.stringify({ type: "hello", protocol: "gurutime.v1", serverTime: now, leaseMs: LEASE_MS }));
    await this.deliverQueued(server, controllerId, 3);
    await this.rescheduleSystemAlarm();
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "gurutime.v1" },
    });
  }

  private async createInvite(request: Request): Promise<Response> {
    await this.requireDevice(request);
    const body = await readJson<{ requirePin?: boolean }>(request, 512);
    const requirePin = body.requirePin !== false;
    const inviteId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    const pairingSecret = randomToken(32);
    const pin = requirePin ? String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0") : undefined;
    const now = Date.now();
    const expiresAt = now + INVITE_TTL_MS;
    const pairingSecretHash = await secretHash(this.env, `invite:${inviteId}`, pairingSecret);
    const pinHash = pin ? await secretHash(this.env, `pin:${inviteId}`, pin) : null;
    this.sql.exec("DELETE FROM pairing_invites WHERE expires_at < ?", now - PIN_LOCK_MS);
    this.sql.exec(
      `INSERT INTO pairing_invites(
        invite_id, key_id, pairing_secret_hash, pin_hash, expires_at, failed_attempts, locked_until, used_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?)`,
      inviteId,
      keyId,
      pairingSecretHash,
      pinHash,
      expiresAt,
      now,
    );
    const fragmentPayload = base64UrlEncode(
      JSON.stringify({ v: 1, i: this.getConfig("installation_id"), n: inviteId, x: keyId, k: pairingSecret }),
    );
    const origin = request.headers.get("x-gurutime-origin") ?? this.env.PUBLIC_APP_ORIGIN ?? "";
    if (!origin.startsWith("https://") && this.env.ENVIRONMENT === "production") {
      throw new Error("PUBLIC_APP_ORIGIN must use HTTPS in production");
    }
    return json({
      inviteId,
      keyId,
      pairingKey: pairingSecret,
      inviteUrl: `${origin.replace(/\/$/u, "")}/#pair=${fragmentPayload}`,
      pin,
      pinRequired: requirePin,
      expiresAt,
    });
  }

  private async claimInvite(request: Request): Promise<Response> {
    const body = await readJson<PairingClaim>(request, 4096);
    const inviteId = body.inviteId ?? "";
    if (!/^[0-9a-f-]{36}$/iu.test(inviteId) || !/^[A-Za-z0-9_-]{40,}$/u.test(body.pairingSecret ?? "")) {
      throw new HttpError(400, "invalid_invite", "Eşleştirme daveti geçersiz.");
    }
    const row = this.sql.exec<InviteRow>("SELECT * FROM pairing_invites WHERE invite_id = ?", inviteId).toArray()[0];
    const now = Date.now();
    if (!row) throw new HttpError(404, "invite_not_found", "Eşleştirme daveti bulunamadı.");
    if (row.used_at) throw new HttpError(409, "invite_already_used", "Eşleştirme daveti daha önce kullanılmış.");
    if (row.locked_until && row.locked_until > now) {
      throw new HttpError(429, "pin_locked", "Çok fazla hatalı PIN denemesi yapıldı.", {
        "retry-after": String(Math.ceil((row.locked_until - now) / 1000)),
      });
    }
    if (row.expires_at <= now) throw new HttpError(410, "invite_expired", "Eşleştirme davetinin süresi dolmuş.");
    const secretCandidate = await secretHash(this.env, `invite:${inviteId}`, body.pairingSecret);
    if (!timingSafeEqual(secretCandidate, row.pairing_secret_hash)) {
      throw new HttpError(401, "invalid_pairing_secret", "Eşleştirme anahtarı geçersiz.");
    }
    if (row.pin_hash) {
      const pinCandidate = await secretHash(this.env, `pin:${inviteId}`, body.pin ?? "");
      if (!/^\d{6}$/u.test(body.pin ?? "") || !timingSafeEqual(pinCandidate, row.pin_hash)) {
        const failedAttempts = row.failed_attempts + 1;
        const lockedUntil = failedAttempts >= 5 ? now + PIN_LOCK_MS : null;
        this.sql.exec(
          "UPDATE pairing_invites SET failed_attempts = ?, locked_until = ? WHERE invite_id = ?",
          failedAttempts,
          lockedUntil,
          inviteId,
        );
        if (lockedUntil) {
          throw new HttpError(429, "pin_locked", "Beş hatalı denemeden sonra PIN 15 dakika kilitlendi.", {
            "retry-after": "900",
          });
        }
        throw new HttpError(401, "invalid_pin", "PIN hatalı.");
      }
    }

    const activePhoneCount = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM phones WHERE revoked_at IS NULL")
      .one().count;
    if (activePhoneCount >= MAX_PHONES) {
      throw new HttpError(409, "phone_limit_reached", "En fazla beş telefon eşleştirilebilir.");
    }

    const installationId = this.getConfig("installation_id")!;
    const phoneId = crypto.randomUUID();
    const token = randomToken(32);
    const sessionHash = await secretHash(this.env, `session:${installationId}:${phoneId}`, token);
    const requestedName = typeof body.deviceName === "string" ? body.deviceName.trim() : "";
    const name = (requestedName || "Telefon").slice(0, 60);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE pairing_invites SET used_at = ? WHERE invite_id = ? AND used_at IS NULL", now, inviteId);
      this.sql.exec(
        `INSERT INTO phones(
          phone_id, key_id, name, session_hash, session_expires_at, created_at, last_seen_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        phoneId,
        row.key_id,
        name,
        sessionHash,
        now + SESSION_TTL_MS,
        now,
        now,
      );
    });
    return json(
      {
        paired: true,
        phone: { id: phoneId, keyId: row.key_id, name },
        installationId,
        vapidPublicKey: this.env.VAPID_PUBLIC_KEY ?? null,
      },
      { status: 201, headers: { "set-cookie": sessionCookie(installationId, phoneId, token) } },
    );
  }

  private async listPhones(request: Request): Promise<Response> {
    await this.requireDevice(request);
    const rows = this.sql
      .exec<PhoneRow & { push_enabled: number }>(
        `SELECT p.*, CASE WHEN s.phone_id IS NULL THEN 0 ELSE 1 END AS push_enabled
         FROM phones p LEFT JOIN push_subscriptions s ON s.phone_id = p.phone_id
         WHERE p.revoked_at IS NULL ORDER BY p.created_at ASC`,
      )
      .toArray();
    return json({
      phones: rows.map((row) => ({
        id: row.phone_id,
        keyId: row.key_id,
        name: row.name,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        pushEnabled: Boolean(row.push_enabled),
      })),
      maxPhones: MAX_PHONES,
    });
  }

  private async revokePhone(request: Request, phoneId: string): Promise<Response> {
    await this.requireDevice(request);
    if (!/^[0-9a-f-]{36}$/iu.test(phoneId)) throw new HttpError(400, "invalid_phone_id", "Telefon kimliği geçersiz.");
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE phones SET revoked_at = ? WHERE phone_id = ? AND revoked_at IS NULL", now, phoneId);
      this.sql.exec("DELETE FROM push_subscriptions WHERE phone_id = ?", phoneId);
    });
    return new Response(null, { status: 204 });
  }

  private validateCommand(body: CommandEnvelope): { expiresAt: number } {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(body.commandId ?? "")) {
      throw new HttpError(400, "invalid_command_id", "Komut kimliği 8-128 güvenli karakter olmalıdır.");
    }
    if (!/^(task|alarm)\.[a-z][a-z0-9_-]{1,31}$/u.test(body.kind ?? "")) {
      throw new HttpError(400, "invalid_command_kind", "Komut türü task.* veya alarm.* olmalıdır.");
    }
    if (!/^[A-Za-z0-9_-]{20,3800}$/u.test(body.ciphertext ?? "")) {
      throw new HttpError(400, "invalid_ciphertext", "AES-GCM şifreli komut zarfı geçersiz.");
    }
    const now = Date.now();
    if (body.kind.startsWith("alarm.")) {
      if (!Number.isSafeInteger(body.fireAt)) throw new HttpError(400, "fire_at_required", "Alarm komutu fireAt gerektirir.");
      if (body.fireAt! < now + 60_000 || body.fireAt! > now + MAX_PHONE_ALARM_DELAY_MS) {
        throw new HttpError(400, "alarm_out_of_range", "Telefon alarmı 1 dakika ile 24 saat arasında olmalıdır.");
      }
      const expiresAt = body.fireAt! + ALARM_GRACE_MS;
      if (expiresAt <= now) throw new HttpError(410, "alarm_command_expired", "Alarm komutunun süresi dolmuş.");
      return { expiresAt };
    }
    return { expiresAt: now + TASK_TTL_MS };
  }

  private consumeCommandRate(now: number): void {
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const row = this.sql
      .exec<{ attempts: number }>("SELECT attempts FROM rate_limits WHERE key = 'commands' AND window_start = ?", windowStart)
      .toArray()[0];
    if ((row?.attempts ?? 0) >= MAX_COMMANDS_PER_MINUTE) {
      throw new HttpError(429, "command_rate_limited", "Dakikada en fazla 20 komut gönderilebilir.", {
        "retry-after": String(Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000))),
      });
    }
    this.sql.exec(
      `INSERT INTO rate_limits(key, window_start, attempts) VALUES ('commands', ?, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET attempts = attempts + 1`,
      windowStart,
    );
    this.sql.exec("DELETE FROM rate_limits WHERE window_start < ?", windowStart - 3_600_000);
  }

  private async enqueueCommand(request: Request): Promise<Response> {
    const phone = await this.requirePhone(request);
    const body = await readJson<CommandEnvelope>(request, 4096);
    const { expiresAt } = this.validateCommand(body);
    const existing = this.sql.exec<CommandRow>("SELECT * FROM commands WHERE command_id = ?", body.commandId).toArray()[0];
    if (existing) {
      return json({ commandId: existing.command_id, state: existing.state, duplicate: true, expiresAt: existing.expires_at });
    }
    const now = Date.now();
    this.expireCommands(now);
    this.consumeCommandRate(now);
    const pending = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM commands WHERE state IN ('queued', 'leased')")
      .one().count;
    if (pending >= MAX_PENDING_COMMANDS) {
      throw new HttpError(409, "queue_full", "Bekleyen komut kuyruğu dolu.");
    }
    this.sql.exec(
      `INSERT INTO commands(
        command_id, phone_id, key_id, kind, ciphertext, state, created_at, expires_at,
        leased_until, lease_token, controller_id, delivery_attempts, acked_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, 0, NULL)`,
      body.commandId,
      phone.phone_id,
      phone.key_id,
      body.kind,
      body.ciphertext,
      now,
      expiresAt,
    );
    const controller = this.ctx.getWebSockets("controller")[0];
    if (controller) {
      const attachment = controller.deserializeAttachment() as ControllerAttachment | null;
      if (attachment?.controllerId) await this.deliverQueued(controller, attachment.controllerId, 1);
    }
    await this.rescheduleSystemAlarm();
    return json({ commandId: body.commandId, state: "queued", duplicate: false, expiresAt }, { status: 202 });
  }

  private expireCommands(now = Date.now()): void {
    this.sql.exec(
      `UPDATE commands SET state = 'expired', leased_until = NULL, lease_token = NULL, controller_id = NULL
       WHERE state IN ('queued', 'leased') AND expires_at <= ?`,
      now,
    );
  }

  private recoverExpiredLeases(now = Date.now()): void {
    this.sql.exec(
      `UPDATE commands SET state = 'queued', leased_until = NULL, lease_token = NULL, controller_id = NULL
       WHERE state = 'leased' AND leased_until <= ? AND expires_at > ?`,
      now,
      now,
    );
  }

  private async deliverQueued(socket: WebSocket, controllerId: string, limit: number): Promise<number> {
    const now = Date.now();
    this.expireCommands(now);
    this.recoverExpiredLeases(now);
    const commands = this.sql
      .exec<CommandRow>(
        "SELECT * FROM commands WHERE state = 'queued' AND expires_at > ? ORDER BY created_at ASC, command_id ASC LIMIT ?",
        now,
        limit,
      )
      .toArray();
    let delivered = 0;
    for (const command of commands) {
      const leaseToken = randomToken(18);
      const leasedUntil = now + LEASE_MS;
      this.sql.exec(
        `UPDATE commands SET state = 'leased', leased_until = ?, lease_token = ?, controller_id = ?,
          delivery_attempts = delivery_attempts + 1
         WHERE command_id = ? AND state = 'queued'`,
        leasedUntil,
        leaseToken,
        controllerId,
        command.command_id,
      );
      const frame = JSON.stringify({
        type: "command",
        commandId: command.command_id,
        phoneId: command.phone_id,
        keyId: command.key_id,
        kind: command.kind,
        ciphertext: command.ciphertext,
        leaseToken,
        leasedUntil,
        expiresAt: command.expires_at,
        attempt: command.delivery_attempts + 1,
      });
      if (this.sendWithImmediateRetries(socket, frame)) {
        delivered += 1;
      } else {
        this.sql.exec(
          `UPDATE commands SET state = 'queued', leased_until = NULL, lease_token = NULL, controller_id = NULL
           WHERE command_id = ? AND lease_token = ?`,
          command.command_id,
          leaseToken,
        );
        break;
      }
    }
    return delivered;
  }

  private sendWithImmediateRetries(socket: WebSocket, frame: string): boolean {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        socket.send(frame);
        return true;
      } catch (error) {
        if (attempt === 2) console.warn("WebSocket send failed after three immediate attempts", error);
      }
    }
    return false;
  }

  private acknowledge(commandId: string, leaseToken: string): "acked" | "already_acked" | "stale" | "missing" {
    const command = this.sql.exec<CommandRow>("SELECT * FROM commands WHERE command_id = ?", commandId).toArray()[0];
    if (!command) return "missing";
    if (command.state === "acked") return "already_acked";
    if (command.state !== "leased" || !command.lease_token || !timingSafeEqual(command.lease_token, leaseToken)) return "stale";
    this.sql.exec(
      `UPDATE commands SET state = 'acked', acked_at = ?, leased_until = NULL, lease_token = NULL, controller_id = NULL
       WHERE command_id = ? AND state = 'leased' AND lease_token = ?`,
      Date.now(),
      commandId,
      leaseToken,
    );
    return "acked";
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (new TextEncoder().encode(text).byteLength > 4096) {
      socket.close(1009, "message too large");
      return;
    }
    let frame: { type?: string; commandId?: string; leaseToken?: string };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      socket.send(JSON.stringify({ type: "error", code: "invalid_json" }));
      return;
    }
    const attachment = socket.deserializeAttachment() as ControllerAttachment | null;
    if (frame.type === "ready" && attachment?.controllerId) {
      await this.deliverQueued(socket, attachment.controllerId, 3);
    } else if (frame.type === "ack" && frame.commandId && frame.leaseToken) {
      const result = this.acknowledge(frame.commandId, frame.leaseToken);
      socket.send(JSON.stringify({ type: "ack-result", commandId: frame.commandId, result }));
      if (attachment?.controllerId && (result === "acked" || result === "already_acked")) {
        await this.deliverQueued(socket, attachment.controllerId, 1);
      }
    } else {
      socket.send(JSON.stringify({ type: "error", code: "unsupported_frame" }));
    }
    await this.rescheduleSystemAlarm();
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = socket.deserializeAttachment() as ControllerAttachment | null;
    if (attachment?.controllerId) {
      this.sql.exec(
        `UPDATE commands SET state = 'queued', leased_until = NULL, lease_token = NULL, controller_id = NULL
         WHERE state = 'leased' AND controller_id = ?`,
        attachment.controllerId,
      );
    }
    try {
      socket.close(code, reason);
    } catch {
      // The runtime may already have replied to the close frame.
    }
    await this.rescheduleSystemAlarm();
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as ControllerAttachment | null;
    if (attachment?.controllerId) {
      this.sql.exec(
        `UPDATE commands SET state = 'queued', leased_until = NULL, lease_token = NULL, controller_id = NULL
         WHERE state = 'leased' AND controller_id = ?`,
        attachment.controllerId,
      );
    }
    try {
      socket.close(1011, "controller error");
    } catch {
      // Socket is already closed.
    }
    await this.rescheduleSystemAlarm();
  }

  private async scheduleAlarm(request: Request): Promise<Response> {
    await this.requireDevice(request);
    const body = await readJson<{ alarmId?: string; occurrence?: number; fireAt?: number }>(request, 1024);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(body.alarmId ?? "")) {
      throw new HttpError(400, "invalid_alarm_id", "Alarm kimliği geçersiz.");
    }
    if (!Number.isSafeInteger(body.occurrence) || body.occurrence! < 0 || !Number.isSafeInteger(body.fireAt)) {
      throw new HttpError(400, "invalid_alarm_schedule", "Alarm occurrence ve fireAt değerleri geçersiz.");
    }
    const now = Date.now();
    if (body.fireAt! < now - ALARM_GRACE_MS || body.fireAt! > now + TASK_TTL_MS) {
      throw new HttpError(400, "alarm_out_of_range", "Alarm en fazla 7 gün ileriye planlanabilir.");
    }
    const count = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM alarms WHERE status = 'pending'").one().count;
    const existing = this.sql
      .exec<AlarmRow>("SELECT * FROM alarms WHERE alarm_id = ? AND occurrence = ?", body.alarmId, body.occurrence)
      .toArray()[0];
    if (!existing && count >= MAX_PENDING_COMMANDS) throw new HttpError(409, "alarm_queue_full", "Alarm kuyruğu dolu.");
    this.sql.exec(
      `INSERT INTO alarms(alarm_id, occurrence, fire_at, status, dispatched_at, created_at)
       VALUES (?, ?, ?, 'pending', NULL, ?)
       ON CONFLICT(alarm_id, occurrence) DO UPDATE SET fire_at = excluded.fire_at
       WHERE alarms.status = 'pending'`,
      body.alarmId,
      body.occurrence,
      body.fireAt,
      now,
    );
    await this.rescheduleSystemAlarm();
    return json({ alarmId: body.alarmId, occurrence: body.occurrence, fireAt: body.fireAt, state: existing?.status ?? "pending" });
  }

  private async cancelAlarm(request: Request): Promise<Response> {
    await this.requireDevice(request);
    const body = await readJson<{ alarmId?: string; occurrence?: number }>(request, 512);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(body.alarmId ?? "") || !Number.isSafeInteger(body.occurrence)) {
      throw new HttpError(400, "invalid_alarm_id", "Alarm kimliği geçersiz.");
    }
    this.sql.exec(
      "UPDATE alarms SET status = 'cancelled' WHERE alarm_id = ? AND occurrence = ? AND status = 'pending'",
      body.alarmId,
      body.occurrence,
    );
    await this.rescheduleSystemAlarm();
    return new Response(null, { status: 204 });
  }

  private validatePushSubscription(body: PushSubscriptionRecord): void {
    let endpoint: URL;
    try {
      endpoint = new URL(body.endpoint);
    } catch {
      throw new HttpError(400, "invalid_push_endpoint", "Push endpoint geçersiz.");
    }
    if (endpoint.protocol !== "https:" || body.endpoint.length > 2048) {
      throw new HttpError(400, "invalid_push_endpoint", "Push endpoint HTTPS olmalıdır.");
    }
    if (!/^[A-Za-z0-9_-]{40,200}$/u.test(body.keys?.p256dh ?? "") || !/^[A-Za-z0-9_-]{16,64}$/u.test(body.keys?.auth ?? "")) {
      throw new HttpError(400, "invalid_push_keys", "Push anahtarları geçersiz.");
    }
  }

  private async savePushSubscription(request: Request): Promise<Response> {
    const phone = await this.requirePhone(request);
    if (!webPushConfigured(this.env)) throw new HttpError(503, "push_not_configured", "Web Push henüz yapılandırılmadı.");
    const body = await readJson<PushSubscriptionRecord>(request, 4096);
    this.validatePushSubscription(body);
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO push_subscriptions(phone_id, endpoint, p256dh, auth, expiration_time, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(phone_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh,
         auth = excluded.auth, expiration_time = excluded.expiration_time, updated_at = excluded.updated_at`,
      phone.phone_id,
      body.endpoint,
      body.keys.p256dh,
      body.keys.auth,
      body.expirationTime,
      now,
      now,
    );
    return json({ subscribed: true });
  }

  private async removePushSubscription(request: Request): Promise<Response> {
    const phone = await this.requirePhone(request);
    this.sql.exec("DELETE FROM push_subscriptions WHERE phone_id = ?", phone.phone_id);
    return new Response(null, { status: 204 });
  }

  private async logout(request: Request): Promise<Response> {
    const phone = await this.requirePhone(request);
    this.sql.exec("UPDATE phones SET session_expires_at = ? WHERE phone_id = ?", Date.now(), phone.phone_id);
    return new Response(null, { status: 204, headers: { "set-cookie": clearSessionCookie() } });
  }

  private async dispatchDueAlarms(now: number): Promise<void> {
    const due = this.sql
      .exec<AlarmRow>(
        "SELECT * FROM alarms WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC, alarm_id ASC",
        now,
      )
      .toArray();
    if (due.length === 0) return;
    const subscriptions = this.sql
      .exec<PushRow>(
        `SELECT s.* FROM push_subscriptions s JOIN phones p ON p.phone_id = s.phone_id
         WHERE p.revoked_at IS NULL AND p.session_expires_at > ?`,
        now,
      )
      .toArray();

    for (const alarm of due) {
      // Persist the occurrence marker before the external side effect. A retried DO
      // alarm therefore cannot dispatch the same occurrence twice.
      this.sql.exec(
        "UPDATE alarms SET status = 'sent', dispatched_at = ? WHERE alarm_id = ? AND occurrence = ? AND status = 'pending'",
        now,
        alarm.alarm_id,
        alarm.occurrence,
      );
      const results = await Promise.allSettled(
        subscriptions.map(async (subscription) => {
          const response = await sendGenericAlarmPush(
            this.env,
            {
              endpoint: subscription.endpoint,
              expirationTime: subscription.expiration_time,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            alarm.alarm_id,
            alarm.occurrence,
          );
          if (response.status === 404 || response.status === 410) {
            this.sql.exec("DELETE FROM push_subscriptions WHERE phone_id = ?", subscription.phone_id);
          } else if (!response.ok) {
            console.warn("Web Push dispatch failed", response.status, alarm.alarm_id, alarm.occurrence);
          }
        }),
      );
      for (const result of results) {
        if (result.status === "rejected") console.warn("Web Push dispatch error", result.reason);
      }
    }
  }

  private async rescheduleSystemAlarm(): Promise<void> {
    const row = this.sql
      .exec<{ next_at: number | null }>(
        `SELECT MIN(next_at) AS next_at FROM (
           SELECT MIN(fire_at) AS next_at FROM alarms WHERE status = 'pending'
           UNION ALL
           SELECT MIN(leased_until) AS next_at FROM commands WHERE state = 'leased'
         )`,
      )
      .one();
    if (row.next_at == null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, row.next_at));
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.expireCommands(now);
    this.recoverExpiredLeases(now);
    await this.dispatchDueAlarms(now);
    const controller = this.ctx.getWebSockets("controller")[0];
    if (controller) {
      const attachment = controller.deserializeAttachment() as ControllerAttachment | null;
      if (attachment?.controllerId) await this.deliverQueued(controller, attachment.controllerId, 3);
    }
    this.sql.exec(
      "DELETE FROM commands WHERE state IN ('acked', 'expired') AND COALESCE(acked_at, expires_at) < ?",
      now - TASK_TTL_MS,
    );
    this.sql.exec(
      "DELETE FROM alarms WHERE status IN ('sent', 'cancelled') AND COALESCE(dispatched_at, created_at) < ?",
      now - TASK_TTL_MS,
    );
    await this.rescheduleSystemAlarm();
  }

  // Test-only RPC helpers. They are never routed by the public Worker and refuse
  // to run outside the test binding environment.
  async testingSnapshot(): Promise<{
    commands: CommandRow[];
    alarms: AlarmRow[];
    invites: InviteRow[];
    phones: PhoneRow[];
  }> {
    if (this.env.ENVIRONMENT !== "test") throw new Error("test helper disabled");
    return {
      commands: this.sql.exec<CommandRow>("SELECT * FROM commands ORDER BY created_at, command_id").toArray(),
      alarms: this.sql.exec<AlarmRow>("SELECT * FROM alarms ORDER BY fire_at, alarm_id").toArray(),
      invites: this.sql.exec<InviteRow>("SELECT * FROM pairing_invites ORDER BY created_at").toArray(),
      phones: this.sql.exec<PhoneRow>("SELECT * FROM phones ORDER BY created_at").toArray(),
    };
  }

  async testingLeaseNext(): Promise<{ commandId: string; leaseToken: string } | null> {
    if (this.env.ENVIRONMENT !== "test") throw new Error("test helper disabled");
    const row = this.sql
      .exec<CommandRow>("SELECT * FROM commands WHERE state = 'queued' ORDER BY created_at, command_id LIMIT 1")
      .toArray()[0];
    if (!row) return null;
    const leaseToken = randomToken(18);
    this.sql.exec(
      `UPDATE commands SET state = 'leased', leased_until = ?, lease_token = ?, controller_id = 'test',
       delivery_attempts = delivery_attempts + 1 WHERE command_id = ? AND state = 'queued'`,
      Date.now() + LEASE_MS,
      leaseToken,
      row.command_id,
    );
    await this.rescheduleSystemAlarm();
    return { commandId: row.command_id, leaseToken };
  }

  async testingAcknowledge(commandId: string, leaseToken: string): Promise<string> {
    if (this.env.ENVIRONMENT !== "test") throw new Error("test helper disabled");
    const result = this.acknowledge(commandId, leaseToken);
    await this.rescheduleSystemAlarm();
    return result;
  }

  async testingRunAlarm(): Promise<void> {
    if (this.env.ENVIRONMENT !== "test") throw new Error("test helper disabled");
    await this.alarm();
  }
}
