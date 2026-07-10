import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env as RelayEnv } from "../src/types";

const ORIGIN = "https://relay.test";
const relayEnv = env as unknown as RelayEnv;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  return SELF.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

async function jsonRequest(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return request(path, { ...init, method: init.method ?? "POST", headers, body: JSON.stringify(body) });
}

interface Enrollment {
  installationId: string;
  deviceSecret: string;
}

async function enroll(label: string = crypto.randomUUID()): Promise<Enrollment> {
  const response = await jsonRequest("/api/v1/installations/enroll", {}, {
    headers: { "cf-connecting-ip": `test-${label}` },
  });
  expect(response.status).toBe(201);
  return response.json<Enrollment>();
}

function deviceHeaders(enrollment: Enrollment): HeadersInit {
  return {
    "x-gurutime-installation": enrollment.installationId,
    authorization: `GuruTimeDevice ${enrollment.deviceSecret}`,
  };
}

interface Invite {
  inviteId: string;
  keyId: string;
  pairingKey: string;
  pin?: string;
}

async function createInvite(enrollment: Enrollment, requirePin: boolean): Promise<Invite> {
  const response = await jsonRequest(
    "/api/v1/controller/invites",
    { requirePin },
    { headers: deviceHeaders(enrollment) },
  );
  expect(response.status).toBe(200);
  return response.json<Invite>();
}

async function claimInvite(
  enrollment: Enrollment,
  invite: Invite,
  pin = invite.pin,
  deviceName = "Test phone",
): Promise<{ response: Response; cookie: string }> {
  const response = await jsonRequest("/api/v1/pairing/claim", {
    installationId: enrollment.installationId,
    inviteId: invite.inviteId,
    pairingSecret: invite.pairingKey,
    pin,
    deviceName,
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  return { response, cookie };
}

function ciphertext(seed: string): string {
  return btoa(seed.repeat(32)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function queueCommand(cookie: string, commandId: string, seed = "x"): Promise<Response> {
  return jsonRequest(
    "/api/v1/commands",
    { commandId, kind: "task.create", ciphertext: ciphertext(seed) },
    { headers: { cookie } },
  );
}

describe("GuruTime Cloudflare relay", () => {
  it("rate-limits enrollment by hashed Cloudflare client IP", async () => {
    const headers = { "cf-connecting-ip": "rate-limit-source" };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await jsonRequest("/api/v1/installations/enroll", {}, { headers })).status).toBe(201);
    }
    const limited = await jsonRequest("/api/v1/installations/enroll", {}, { headers });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("isolates installations and assigns every phone a distinct E2EE key id", async () => {
    const first = await enroll("isolation-a");
    const second = await enroll("isolation-b");
    const inviteA1 = await createInvite(first, false);
    const inviteA2 = await createInvite(first, false);
    const inviteB = await createInvite(second, false);

    expect(inviteA1.keyId).not.toBe(inviteA2.keyId);
    expect(inviteA1.pairingKey).not.toBe(inviteA2.pairingKey);

    const pairedA1 = await claimInvite(first, inviteA1, undefined, "A1");
    const pairedA2 = await claimInvite(first, inviteA2, undefined, "A2");
    const pairedB = await claimInvite(second, inviteB, undefined, "B");
    expect(pairedA1.response.status).toBe(201);
    expect(pairedA2.response.status).toBe(201);
    expect(pairedB.response.status).toBe(201);

    await queueCommand(pairedA1.cookie, `task-${crypto.randomUUID()}`, "a");
    await queueCommand(pairedA2.cookie, `task-${crypto.randomUUID()}`, "b");

    const firstSnapshot = await relayEnv.INSTALLATIONS.getByName(first.installationId).testingSnapshot();
    const secondSnapshot = await relayEnv.INSTALLATIONS.getByName(second.installationId).testingSnapshot();
    expect(firstSnapshot.commands).toHaveLength(2);
    expect(new Set(firstSnapshot.commands.map((command) => command.key_id))).toEqual(new Set([inviteA1.keyId, inviteA2.keyId]));
    expect(firstSnapshot.commands.map((command) => command.phone_id).every(Boolean)).toBe(true);
    expect(secondSnapshot.commands).toHaveLength(0);
  });

  it("consumes pairing invites exactly once", async () => {
    const enrollment = await enroll("replay");
    const invite = await createInvite(enrollment, false);
    const first = await claimInvite(enrollment, invite);
    expect(first.response.status).toBe(201);
    const replay = await claimInvite(enrollment, invite);
    expect(replay.response.status).toBe(409);
    expect((await replay.response.json<{ error: { code: string } }>()).error.code).toBe("invite_already_used");
  });

  it("locks a PIN-protected invite for 15 minutes after five failures", async () => {
    const enrollment = await enroll("pin-lock");
    const invite = await createInvite(enrollment, true);
    const wrongPin = invite.pin === "000000" ? "000001" : "000000";
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await claimInvite(enrollment, invite, wrongPin);
      expect(result.response.status).toBe(attempt === 5 ? 429 : 401);
    }
    const locked = await claimInvite(enrollment, invite, invite.pin);
    expect(locked.response.status).toBe(429);
    expect(locked.response.headers.get("retry-after")).toBeTruthy();
  });

  it("keeps queue inserts and ACK transitions idempotent", async () => {
    const enrollment = await enroll("lease-ack");
    const invite = await createInvite(enrollment, false);
    const paired = await claimInvite(enrollment, invite);
    const commandId = `task-${crypto.randomUUID()}`;
    const first = await queueCommand(paired.cookie, commandId);
    const duplicate = await queueCommand(paired.cookie, commandId);
    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json<{ duplicate: boolean }>()).duplicate).toBe(true);

    const stub = relayEnv.INSTALLATIONS.getByName(enrollment.installationId);
    const lease = await stub.testingLeaseNext();
    expect(lease?.commandId).toBe(commandId);
    expect(await stub.testingAcknowledge(commandId, "stale-token")).toBe("stale");
    expect(await stub.testingAcknowledge(commandId, lease!.leaseToken)).toBe("acked");
    expect(await stub.testingAcknowledge(commandId, lease!.leaseToken)).toBe("already_acked");
    expect((await stub.testingSnapshot()).commands[0]?.state).toBe("acked");
  });

  it("delivers phoneId and keyId in the authenticated controller frame", async () => {
    const enrollment = await enroll("websocket-key-routing");
    const invite = await createInvite(enrollment, false);
    const paired = await claimInvite(enrollment, invite, undefined, "Keyed phone");
    const claim = await paired.response.clone().json<{ phone: { id: string; keyId: string } }>();
    const commandId = `task-${crypto.randomUUID()}`;
    expect((await queueCommand(paired.cookie, commandId, "k")).status).toBe(202);

    const ticketResponse = await jsonRequest("/api/v1/controller/ticket", {}, { headers: deviceHeaders(enrollment) });
    const ticket = await ticketResponse.json<{ ticket: string }>();
    const socketResponse = await SELF.fetch(
      `${ORIGIN}/api/v1/controller/socket/${enrollment.installationId}`,
      {
        headers: {
          origin: ORIGIN,
          upgrade: "websocket",
          "sec-websocket-protocol": `gurutime.v1, ticket.${ticket.ticket}`,
        },
      },
    );
    expect(socketResponse.status).toBe(101);
    const socket = socketResponse.webSocket!;
    socket.accept();
    const frames: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("command WebSocket frame timed out")), 1000);
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === "command") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const command = frames.find((frame) => frame.type === "command");
    expect(command).toMatchObject({
      commandId,
      phoneId: claim.phone.id,
      keyId: invite.keyId,
      kind: "task.create",
    });
    expect(claim.phone.keyId).toBe(invite.keyId);
    socket.close(1000, "test complete");

    const replay = await SELF.fetch(
      `${ORIGIN}/api/v1/controller/socket/${enrollment.installationId}`,
      {
        headers: {
          origin: ORIGIN,
          upgrade: "websocket",
          "sec-websocket-protocol": `gurutime.v1, ticket.${ticket.ticket}`,
        },
      },
    );
    expect(replay.status).toBe(401);
  });

  it("dispatches each alarm occurrence once even when schedule input is replayed", async () => {
    const enrollment = await enroll("alarm-dedupe");
    const alarmId = `alarm-${crypto.randomUUID()}`;
    const schedule = { alarmId, occurrence: 3, fireAt: Date.now() - 10 };
    const first = await jsonRequest("/api/v1/controller/alarms", schedule, {
      method: "PUT",
      headers: deviceHeaders(enrollment),
    });
    expect(first.status).toBe(200);

    const stub = relayEnv.INSTALLATIONS.getByName(enrollment.installationId);
    await stub.testingRunAlarm();
    const dispatched = (await stub.testingSnapshot()).alarms[0];
    expect(dispatched?.status).toBe("sent");
    expect(dispatched?.dispatched_at).toBeTypeOf("number");

    const replay = await jsonRequest("/api/v1/controller/alarms", schedule, {
      method: "PUT",
      headers: deviceHeaders(enrollment),
    });
    expect(replay.status).toBe(200);
    const afterReplay = (await stub.testingSnapshot()).alarms;
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0]?.dispatched_at).toBe(dispatched?.dispatched_at);
    await stub.testingRunAlarm();
    expect((await stub.testingSnapshot()).alarms).toHaveLength(1);
  });

  it("rejects cross-origin API calls and emits strict security headers", async () => {
    const crossOrigin = await SELF.fetch(`${ORIGIN}/api/v1/config`, { headers: { origin: "https://evil.example" } });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("access-control-allow-origin")).toBeNull();
    expect(crossOrigin.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
