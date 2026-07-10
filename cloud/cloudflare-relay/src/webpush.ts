import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";
import { base64UrlEncode } from "./security";
import type { Env, PushSubscriptionRecord } from "./types";

export function webPushConfigured(env: Env): boolean {
  return Boolean(env.VAPID_SUBJECT && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export async function sendGenericAlarmPush(
  env: Env,
  subscription: PushSubscriptionRecord,
  alarmId: string,
  occurrence: number,
): Promise<Response> {
  if (!webPushConfigured(env)) {
    return new Response(null, { status: 503 });
  }
  const topic = base64UrlEncode(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${alarmId}:${occurrence}`)),
  ).slice(0, 32);
  const payload = await buildPushPayload(
    {
      data: {
        title: "GuruTime",
        body: "Bir zamanlayıcınız sona erdi.",
        tag: `gurutime-${alarmId}-${occurrence}`,
        url: "/",
      },
      options: { ttl: 300, urgency: "high", topic },
    },
    subscription as PushSubscription,
    {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    },
  );
  return fetch(subscription.endpoint, {
    ...payload,
    body: new Uint8Array(payload.body).buffer as ArrayBuffer,
  });
}
