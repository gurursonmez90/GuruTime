import type { Env } from "./types";

const encoder = new TextEncoder();

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers?: HeadersInit,
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: error.headers },
    );
  }
  console.error("Unhandled relay error", error);
  return json(
    { error: { code: "internal_error", message: "Beklenmeyen bir sunucu hatası oluştu." } },
    { status: 500 },
  );
}

export async function readJson<T>(request: Request, maxBytes = 4096): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "json_required", "Content-Type application/json olmalıdır.");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) {
    throw new HttpError(413, "payload_too_large", `İstek en fazla ${maxBytes} bayt olabilir.`);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new HttpError(413, "payload_too_large", `İstek en fazla ${maxBytes} bayt olabilir.`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Geçerli bir JSON gövdesi gönderilmelidir.");
  }
}

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64UrlEncode(buffer);
}

export function base64UrlEncode(value: Uint8Array | ArrayBuffer | string): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function secretHash(env: Env, purpose: string, secret: string): Promise<string> {
  if (!env.AUTH_PEPPER || env.AUTH_PEPPER.length < 32) {
    throw new Error("AUTH_PEPPER must contain at least 32 characters");
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.AUTH_PEPPER), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}\u0000${secret}`));
  return base64UrlEncode(digest);
}

export function timingSafeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function requireInternal(request: Request, env: Env): void {
  const provided = request.headers.get("x-gurutime-internal") ?? "";
  if (!env.INTERNAL_SECRET || !timingSafeEqual(provided, env.INTERNAL_SECRET)) {
    throw new HttpError(404, "not_found", "Bulunamadı.");
  }
}

export function requireSameOrigin(request: Request): void {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin && origin !== url.origin) {
    throw new HttpError(403, "cross_origin_denied", "Çapraz kaynak isteği reddedildi.");
  }
  if (fetchSite === "cross-site") {
    throw new HttpError(403, "cross_site_denied", "Çapraz site isteği reddedildi.");
  }
}

export function deviceCredentials(request: Request): { installationId: string; secret: string } {
  const installationId = request.headers.get("x-gurutime-installation") ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^GuruTimeDevice ([A-Za-z0-9_-]{40,})$/u.exec(authorization);
  if (!/^[0-9a-f-]{36}$/iu.test(installationId) || !match) {
    throw new HttpError(401, "device_auth_required", "Geçerli cihaz kimlik bilgileri gerekli.");
  }
  return { installationId, secret: match[1]! };
}

export const SESSION_COOKIE = "__Host-gurutime_session";

export function readSessionCookie(request: Request): { installationId: string; phoneId: string; token: string } {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookies = cookieHeader.split(";").map((part) => part.trim());
  const encoded = cookies.find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) ?? "";
  const [installationId = "", phoneId = "", token = ""] = encoded.split(".");
  if (!/^[0-9a-f-]{36}$/iu.test(installationId) || !/^[0-9a-f-]{36}$/iu.test(phoneId) || !/^[A-Za-z0-9_-]{40,}$/u.test(token)) {
    throw new HttpError(401, "phone_session_required", "Geçerli telefon oturumu gerekli.");
  }
  return { installationId, phoneId, token };
}

export function sessionCookie(installationId: string, phoneId: string, token: string): string {
  return `${SESSION_COOKIE}=${installationId}.${phoneId}.${token}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function internalHeaders(env: Env, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("x-gurutime-internal", env.INTERNAL_SECRET);
  headers.set("content-type", "application/json");
  return headers;
}
