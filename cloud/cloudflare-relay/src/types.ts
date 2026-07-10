export interface Env {
  REGISTRY: DurableObjectNamespace<import("./registry").Registry>;
  INSTALLATIONS: DurableObjectNamespace<import("./installation").Installation>;
  ASSETS: Fetcher;
  AUTH_PEPPER: string;
  INTERNAL_SECRET: string;
  ENVIRONMENT?: string;
  ENROLLMENT_LIMIT_PER_HOUR?: string;
  PUBLIC_APP_ORIGIN?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  VAPID_SUBJECT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}

export interface PairingClaim {
  inviteId: string;
  pairingSecret: string;
  pin?: string;
  deviceName?: string;
}

export interface CommandEnvelope {
  commandId: string;
  kind: string;
  ciphertext: string;
  fireAt?: number;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface ControllerAttachment {
  role: "controller";
  controllerId: string;
  connectedAt: number;
}
