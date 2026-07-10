import { DurableObject } from "cloudflare:workers";
import { HttpError, internalHeaders, json, randomToken, readJson, requireInternal, secretHash, timingSafeEqual } from "./security";
import type { Env } from "./types";

interface EnrollRequest {
  ipHash: string;
}

interface InstallationRow {
  [key: string]: SqlStorageValue;
  installation_id: string;
  device_secret_hash: string;
  created_at: number;
  revoked_at: number | null;
}

export class Registry extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS installations (
          installation_id TEXT PRIMARY KEY,
          device_secret_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS enrollment_windows (
          ip_hash TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          attempts INTEGER NOT NULL,
          PRIMARY KEY (ip_hash, window_start)
        );
        CREATE INDEX IF NOT EXISTS installations_created_at_idx
          ON installations(created_at);
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      requireInternal(request, this.env);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/internal/enroll") {
        return await this.enroll(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/revoke") {
        return await this.revoke(request);
      }
      throw new HttpError(404, "not_found", "Bulunamadı.");
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: error.headers });
      }
      console.error("Registry error", error);
      return json({ error: { code: "registry_error", message: "Kayıt servisi hatası." } }, { status: 500 });
    }
  }

  private async enroll(request: Request): Promise<Response> {
    const body = await readJson<EnrollRequest>(request, 1024);
    if (!/^[A-Za-z0-9_-]{40,}$/u.test(body.ipHash ?? "")) {
      throw new HttpError(400, "invalid_ip_hash", "IP özeti geçersiz.");
    }

    const now = Date.now();
    const windowStart = Math.floor(now / 3_600_000) * 3_600_000;
    const configuredLimit = Number.parseInt(this.env.ENROLLMENT_LIMIT_PER_HOUR ?? "5", 10);
    const limit = Number.isFinite(configuredLimit) ? Math.min(Math.max(configuredLimit, 1), 100) : 5;
    const row = this.sql
      .exec<{ attempts: number }>(
        "SELECT attempts FROM enrollment_windows WHERE ip_hash = ? AND window_start = ?",
        body.ipHash,
        windowStart,
      )
      .toArray()[0];

    if ((row?.attempts ?? 0) >= limit) {
      const retryAfter = Math.max(1, Math.ceil((windowStart + 3_600_000 - now) / 1000));
      throw new HttpError(429, "enrollment_rate_limited", "Bu ağdan çok fazla kurulum kaydı denendi.", {
        "retry-after": String(retryAfter),
      });
    }

    this.sql.exec(
      `INSERT INTO enrollment_windows(ip_hash, window_start, attempts) VALUES (?, ?, 1)
       ON CONFLICT(ip_hash, window_start) DO UPDATE SET attempts = attempts + 1`,
      body.ipHash,
      windowStart,
    );
    this.sql.exec("DELETE FROM enrollment_windows WHERE window_start < ?", windowStart - 86_400_000);

    const installationId = crypto.randomUUID();
    const deviceSecret = randomToken(32);
    const deviceSecretHash = await secretHash(this.env, `device:${installationId}`, deviceSecret);
    this.sql.exec(
      "INSERT INTO installations(installation_id, device_secret_hash, created_at, revoked_at) VALUES (?, ?, ?, NULL)",
      installationId,
      deviceSecretHash,
      now,
    );

    const installation = this.env.INSTALLATIONS.getByName(installationId);
    const initialized = await installation.fetch("https://installation.internal/internal/initialize", {
      method: "POST",
      headers: internalHeaders(this.env),
      body: JSON.stringify({ installationId, deviceSecretHash }),
    });
    if (!initialized.ok) {
      this.sql.exec("DELETE FROM installations WHERE installation_id = ?", installationId);
      throw new Error(`Installation initialization failed with ${initialized.status}`);
    }

    return json(
      {
        installationId,
        deviceSecret,
        createdAt: now,
      },
      { status: 201 },
    );
  }

  private async revoke(request: Request): Promise<Response> {
    const body = await readJson<{ installationId?: string; deviceSecret?: string }>(request, 1024);
    const installationId = body.installationId ?? "";
    const existing = this.sql
      .exec<InstallationRow>("SELECT * FROM installations WHERE installation_id = ?", installationId)
      .toArray()[0];
    if (!existing || existing.revoked_at) {
      throw new HttpError(404, "installation_not_found", "Kurulum bulunamadı.");
    }
    const candidate = await secretHash(this.env, `device:${installationId}`, body.deviceSecret ?? "");
    if (!timingSafeEqual(candidate, existing.device_secret_hash)) {
      throw new HttpError(401, "invalid_device_secret", "Cihaz anahtarı geçersiz.");
    }
    const now = Date.now();
    this.sql.exec("UPDATE installations SET revoked_at = ? WHERE installation_id = ?", now, installationId);
    const installation = this.env.INSTALLATIONS.getByName(installationId);
    await installation.fetch("https://installation.internal/internal/revoke-installation", {
      method: "POST",
      headers: internalHeaders(this.env),
      body: "{}",
    });
    return new Response(null, { status: 204 });
  }
}
