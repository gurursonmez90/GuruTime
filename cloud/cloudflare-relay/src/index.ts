import { Installation } from "./installation";
import { Registry } from "./registry";
import {
  applySecurityHeaders,
  deviceCredentials,
  errorResponse,
  HttpError,
  internalHeaders,
  json,
  readJson,
  readSessionCookie,
  requireSameOrigin,
  secretHash,
} from "./security";
import type { Env, PairingClaim } from "./types";
import { webPushConfigured } from "./webpush";

export { Installation, Registry };

async function verifyTurnstile(request: Request, env: Env, token: string | undefined, ip: string): Promise<void> {
  if (!env.TURNSTILE_SECRET) {
    if (env.ENVIRONMENT === "production") {
      throw new HttpError(503, "turnstile_not_configured", "Enrollment geçici olarak kullanılamıyor.");
    }
    return;
  }
  if (!token || token.length > 2048) {
    throw new HttpError(400, "turnstile_required", "Turnstile doğrulaması gerekli.");
  }
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip });
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) throw new HttpError(503, "turnstile_unavailable", "Turnstile doğrulanamadı; daha sonra tekrar deneyin.");
  const result = (await response.json()) as { success?: boolean };
  if (!result.success) throw new HttpError(403, "turnstile_failed", "Turnstile doğrulaması başarısız.");
}

function installationStub(env: Env, installationId: string): DurableObjectStub<Installation> {
  if (!/^[0-9a-f-]{36}$/iu.test(installationId)) {
    throw new HttpError(400, "invalid_installation_id", "Kurulum kimliği geçersiz.");
  }
  return env.INSTALLATIONS.getByName(installationId);
}

async function proxyToInstallation(
  request: Request,
  env: Env,
  installationId: string,
  internalPath: string,
  body?: BodyInit | null,
): Promise<Response> {
  const headers = internalHeaders(env, request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("x-gurutime-origin", env.PUBLIC_APP_ORIGIN ?? new URL(request.url).origin);
  const methodHasBody = request.method !== "GET" && request.method !== "HEAD";
  const forwardedBody = body !== undefined ? body : methodHasBody ? await request.arrayBuffer() : undefined;
  return installationStub(env, installationId).fetch(`https://installation.internal${internalPath}`, {
    method: request.method,
    headers,
    body: forwardedBody,
  });
}

async function enroll(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ turnstileToken?: string }>(request, 3072);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  await verifyTurnstile(request, env, body.turnstileToken, ip);
  const ipHash = await secretHash(env, "enrollment-ip", ip);
  const registry = env.REGISTRY.getByName("global-registry-v1");
  return registry.fetch("https://registry.internal/internal/enroll", {
    method: "POST",
    headers: internalHeaders(env),
    body: JSON.stringify({ ipHash }),
  });
}

async function routeApi(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    return json({ ok: true, service: "gurutime-relay", version: 1 });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/config") {
    return json({
      vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
      pushConfigured: webPushConfigured(env),
      turnstileRequired: Boolean(env.TURNSTILE_SECRET),
      turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
      limits: { phones: 5, commandBytes: 4096, pendingCommands: 100, commandsPerMinute: 20 },
    });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/installations/enroll") {
    return enroll(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/controller/ticket") {
    const credentials = deviceCredentials(request);
    return proxyToInstallation(request, env, credentials.installationId, "/internal/controller-ticket", "{}");
  }
  const socketMatch = /^\/api\/v1\/controller\/socket\/([0-9a-f-]{36})$/iu.exec(url.pathname);
  if (request.method === "GET" && socketMatch) {
    return proxyToInstallation(request, env, socketMatch[1]!, "/internal/controller-socket");
  }
  if (request.method === "POST" && url.pathname === "/api/v1/controller/invites") {
    const credentials = deviceCredentials(request);
    return proxyToInstallation(request, env, credentials.installationId, "/internal/invites");
  }
  if (request.method === "GET" && url.pathname === "/api/v1/controller/phones") {
    const credentials = deviceCredentials(request);
    return proxyToInstallation(request, env, credentials.installationId, "/internal/phones");
  }
  const phoneMatch = /^\/api\/v1\/controller\/phones\/([0-9a-f-]{36})$/iu.exec(url.pathname);
  if (request.method === "DELETE" && phoneMatch) {
    const credentials = deviceCredentials(request);
    return proxyToInstallation(request, env, credentials.installationId, `/internal/phones/${phoneMatch[1]!}`, null);
  }
  if ((request.method === "PUT" || request.method === "DELETE") && url.pathname === "/api/v1/controller/alarms") {
    const credentials = deviceCredentials(request);
    return proxyToInstallation(request, env, credentials.installationId, "/internal/alarm");
  }

  if (request.method === "POST" && url.pathname === "/api/v1/pairing/claim") {
    const body = await readJson<PairingClaim & { installationId?: string }>(request, 4096);
    const installationId = body.installationId ?? "";
    const forwarded = JSON.stringify({
      inviteId: body.inviteId,
      pairingSecret: body.pairingSecret,
      pin: body.pin,
      deviceName: body.deviceName,
    });
    return proxyToInstallation(request, env, installationId, "/internal/pairing-claim", forwarded);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/commands") {
    const session = readSessionCookie(request);
    return proxyToInstallation(request, env, session.installationId, "/internal/phone-command");
  }
  if ((request.method === "PUT" || request.method === "DELETE") && url.pathname === "/api/v1/push/subscription") {
    const session = readSessionCookie(request);
    return proxyToInstallation(request, env, session.installationId, "/internal/push-subscription");
  }
  if (request.method === "POST" && url.pathname === "/api/v1/session/logout") {
    const session = readSessionCookie(request);
    return proxyToInstallation(request, env, session.installationId, "/internal/logout", "{}");
  }

  throw new HttpError(404, "api_not_found", "API yolu bulunamadı.");
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return routeApi(request, env);
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "method_not_allowed", "Bu kaynak yalnız GET ve HEAD destekler.", { allow: "GET, HEAD" });
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const response = await handle(request, env);
      // Reconstructing a 101 response would detach its WebSocket.
      if (response.status === 101) return response;
      return applySecurityHeaders(response);
    } catch (error) {
      return applySecurityHeaders(errorResponse(error));
    }
  },
} satisfies ExportedHandler<Env>;
