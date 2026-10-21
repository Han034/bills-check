export type ProviderId = "openai" | "anthropic" | "gemini" | "demo";

/** What a provider does when a key trips: "kill" disables the key, "warn" only notifies. */
export type TripMode = "kill" | "warn";

/** ok: watched and under its limits; warn: over a limit in warn mode; off: disabled by the watcher. */
export type KeyStatus = "ok" | "warn" | "off";

/** A key as the provider reports it. */
export interface RemoteKey {
  externalId: string;
  name: string;
  /** OpenAI project id, Google Cloud project, ... - whatever the provider needs to act on the key. */
  scope?: string;
  active: boolean;
  /** Settings for a key seen for the first time, instead of the configured defaults (the demo uses it). */
  preset?: { mode: TripMode; windowLimit: number; dailyLimit: number };
}

/** Spend of one key in one minute, in USD. Providers revise recent buckets, so samples are upserted. */
export interface UsageBucket {
  externalId: string;
  /** Start of the minute, epoch ms. */
  minute: number;
  cost: number;
  requests?: number;
  /** Models seen in this bucket that had no price; their cost is a fallback estimate. */
  unpriced?: string[];
}

export interface DisableResult {
  /** false when the provider can only delete the key (OpenAI): it cannot be turned back on. */
  reversible: boolean;
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  listKeys(): Promise<RemoteKey[]>;
  /** Per-minute, per-key spend for minutes in [from, to). */
  fetchUsage(from: number, to: number): Promise<UsageBucket[]>;
  disableKey(key: KeyRow): Promise<DisableResult>;
  /** Present only when a disabled key can be turned back on. */
  enableKey?(key: KeyRow): Promise<void>;
  /** The provider name to show for one key, when it differs from `label` (the demo stands in for several). */
  keyLabel?(externalId: string): string;
}

export interface KeyRow {
  id: string;
  provider: ProviderId;
  externalId: string;
  name: string;
  scope: string | null;
  status: KeyStatus;
  mode: TripMode;
  /** USD allowed in the rolling window. */
  windowLimit: number;
  /** USD allowed since local midnight. */
  dailyLimit: number;
  /** Samples before this time (epoch ms) are ignored by the rules: set when a key is turned back on. */
  countFrom: number;
  /** What the current warning is about, so the same breach is not announced every minute. */
  warnedFor: "window" | "daily" | null;
  /** The key is no longer listed by the provider (deleted, or killed on OpenAI). */
  gone: boolean;
  /** false when a killed key cannot be turned back on. */
  reversible: boolean;
  offAt: number | null;
}

export type EventKind = "start" | "trip" | "warn" | "kill-failed" | "restore" | "settings" | "provider-error" | "scenario" | "info";

export interface EventRow {
  id: number;
  at: number;
  keyId: string | null;
  kind: EventKind;
  title: string;
  meta: string;
}
