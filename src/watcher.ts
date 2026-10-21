import { floorMinute, MINUTE, startOfDay, type Clock } from "./clock.js";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import type { Notifier } from "./notify.js";
import { evaluate, savedEstimate } from "./rules.js";
import type { KeyRow, Provider, ProviderId } from "./types.js";

/** Providers revise the last buckets for a while, so every poll reads this far back again. */
const LOOKBACK_MS = 60 * MINUTE;
const KEY_REFRESH_MS = 10 * MINUTE;
const ERROR_NOTIFY_EVERY_MS = 60 * MINUTE;
const BARS = 30;

export interface ProviderHealth {
  id: ProviderId;
  label: string;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

const usd = (v: number) => "$" + v.toFixed(2);
const usd0 = (v: number) => "$" + Math.round(v).toLocaleString("en-US");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export class Watcher {
  readonly providers = new Map<ProviderId, Provider>();
  private health = new Map<ProviderId, ProviderHealth>();
  private keysRefreshedAt = new Map<ProviderId, number>();
  private fetchedTo = new Map<ProviderId, number>();
  private lastErrorNotice = new Map<string, number>();
  private unpriced = new Set<string>();
  private running: Promise<void> | null = null;

  constructor(
    private cfg: Config,
    private store: Store,
    private clock: Clock,
    private notifier: Notifier,
    providers: Provider[]
  ) {
    for (const p of providers) {
      this.providers.set(p.id, p);
      this.health.set(p.id, { id: p.id, label: p.label, lastOkAt: null, lastError: null, lastErrorAt: null });
    }
  }

  /** Drops what the watcher remembers between polls: after the store is wiped (the demo's "start over"). */
  forget() {
    this.keysRefreshedAt.clear(); this.fetchedTo.clear(); this.lastErrorNotice.clear();
    for (const h of this.health.values()) { h.lastOkAt = null; h.lastError = null; h.lastErrorAt = null; }
  }

  /** One poll: refresh key lists, read usage, apply the rules. Overlapping calls share the running one. */
  tick(): Promise<void> {
    this.running ??= this.runTick().finally(() => { this.running = null; });
    return this.running;
  }

  private async runTick() {
    const now = this.clock.now();
    await Promise.all([...this.providers.values()].map(p => this.poll(p, now)));
    for (const key of this.store.keys()) await this.check(key, now);
    this.store.prune(now);
  }

  private async poll(p: Provider, now: number) {
    const h = this.health.get(p.id)!;
    try {
      if (now - (this.keysRefreshedAt.get(p.id) ?? -Infinity) >= KEY_REFRESH_MS) {
        const added = this.store.syncKeys(p.id, await p.listKeys(), this.cfg.defaults);
        this.keysRefreshedAt.set(p.id, now);
        for (const k of added) this.store.log(now, "info", `Watching ${k.name}`, `${this.labelOf(k)} · ${k.mode === "kill" ? "alert + disable" : "alert only"}`, k.id);
      }
      const to = floorMinute(now) + MINUTE;
      const last = this.fetchedTo.get(p.id);
      const from = last === undefined ? startOfDay(now) : Math.max(startOfDay(now), last - LOOKBACK_MS);
      const buckets = await p.fetchUsage(from, to);
      this.store.upsertSamples(p.id, buckets);
      for (const m of new Set(buckets.flatMap(b => b.unpriced ?? []))) {
        if (this.unpriced.has(p.id + ":" + m)) continue;
        this.unpriced.add(p.id + ":" + m);
        this.store.log(now, "info", `Unknown model price: ${m}`, `${p.label} · priced as the most expensive model; add it with PRICES_FILE`);
      }
      this.fetchedTo.set(p.id, to);
      h.lastOkAt = now; h.lastError = null; h.lastErrorAt = null;
    } catch (e) {
      h.lastError = errText(e); h.lastErrorAt = now;
      const k = "provider:" + p.id;
      if (now - (this.lastErrorNotice.get(k) ?? -Infinity) >= ERROR_NOTIFY_EVERY_MS) {
        this.lastErrorNotice.set(k, now);
        this.store.log(now, "provider-error", `Cannot read ${p.label}`, h.lastError);
        await this.notifier.send({ severity: "warn", title: `Cannot read ${p.label}`, body: `${h.lastError}\nThis provider is not being watched until it recovers.` });
      }
    }
  }

  spendOf(key: KeyRow, now: number) {
    const to = floorMinute(now) + MINUTE;
    const windowFrom = Math.max(key.countFrom, to - this.cfg.windowMin * MINUTE);
    const dayFrom = Math.max(key.countFrom, startOfDay(now));
    return { window: this.store.spend(key.id, windowFrom, to), day: this.store.spend(key.id, dayFrom, to) };
  }

  private async check(key: KeyRow, now: number) {
    const spend = this.spendOf(key, now);
    const d = evaluate(key, spend, this.cfg.windowMin);
    const label = this.labelOf(key);

    if (d.kind === "rearm") { this.store.updateKey(key.id, { status: "ok", warnedFor: null }); return; }
    if (d.kind === "none") return;

    if (d.kind === "warn" || this.cfg.dryRun) {
      const dry = d.kind === "kill";
      // a kill rule fires every poll while over the limit; in dry-run it is announced once per breach, like a warning
      if (dry && (key.warnedFor === d.breach || key.warnedFor === "daily")) return;
      this.store.updateKey(key.id, { status: "warn", warnedFor: d.breach });
      const meta = dry ? `${d.reason} · dry run, not disabled` : `${d.reason} · still enabled`;
      this.store.log(now, "warn", `${key.name} over its limit`, meta, key.id);
      await this.notifier.send({ severity: "warn", title: `${key.name} is over its limit`, body: `${label} · ${meta}` });
      return;
    }

    // kill
    const p = this.providers.get(key.provider);
    try {
      if (!p) throw new Error("provider not configured");
      const res = await p.disableKey(key);
      const saved = savedEstimate(spend.window, this.cfg.windowMin, this.cfg.alertDelayMin);
      this.store.updateKey(key.id, { status: "off", offAt: now, reversible: res.reversible, warnedFor: null });
      const how = res.reversible ? "Re-enable it from the dashboard" : "This provider can only delete keys; create a new one";
      this.store.log(now, "trip", `${key.name} disabled`, d.reason, key.id, saved);
      await this.notifier.send({
        severity: "critical",
        title: `${key.name} disabled`,
        body: `${label} · ${d.reason}\nAt this rate it would have burned ~${usd0(saved)} in ${Math.round(this.cfg.alertDelayMin / 60)} hours. ${how}.`
      });
    } catch (e) {
      // stays on: the next poll tries again; the alarm repeats at most every ERROR_NOTIFY_EVERY_MS
      this.store.updateKey(key.id, { status: "warn", warnedFor: d.breach });
      const k = "kill:" + key.id;
      if (now - (this.lastErrorNotice.get(k) ?? -Infinity) >= ERROR_NOTIFY_EVERY_MS) {
        this.lastErrorNotice.set(k, now);
        this.store.log(now, "kill-failed", `${key.name} COULD NOT BE DISABLED`, `${d.reason} · ${errText(e)}`, key.id);
        await this.notifier.send({ severity: "critical", title: `${key.name} could not be disabled — disable it by hand`, body: `${label} · ${d.reason}\n${errText(e)}` });
      }
    }
  }

  private labelOf(k: KeyRow) {
    const p = this.providers.get(k.provider);
    return p?.keyLabel?.(k.externalId) ?? p?.label ?? k.provider;
  }

  /** Turns a key the watcher disabled back on. Its earlier spend no longer counts, so it does not trip again at once. */
  async restore(id: string) {
    const key = this.store.key(id);
    if (!key) throw new HttpError(404, "no such key");
    if (key.status !== "off") throw new HttpError(409, "key is already enabled");
    if (!key.reversible) throw new HttpError(409, "this key was deleted; create a new one at the provider");
    const p = this.providers.get(key.provider);
    if (!p?.enableKey) throw new HttpError(409, "this provider cannot re-enable keys");
    await p.enableKey(key);
    const now = this.clock.now();
    this.store.updateKey(id, { status: "ok", offAt: null, warnedFor: null, countFrom: floorMinute(now) + MINUTE });
    this.store.log(now, "restore", `${key.name} re-enabled`, "from the dashboard", id);
    await this.notifier.send({ severity: "info", title: `${key.name} re-enabled`, body: "Re-enabled from the dashboard; its spend counter starts over." });
  }

  /** Disables a key right now, whatever its spend: the panel's emergency brake. */
  async disableNow(id: string) {
    const key = this.store.key(id);
    if (!key) throw new HttpError(404, "no such key");
    if (key.status === "off") throw new HttpError(409, "key is already disabled");
    const p = this.providers.get(key.provider);
    if (!p) throw new HttpError(409, "provider not configured");
    const res = await p.disableKey(key);
    const now = this.clock.now();
    this.store.updateKey(id, { status: "off", offAt: now, reversible: res.reversible, warnedFor: null });
    this.store.log(now, "trip", `${key.name} disabled`, "by hand, from the dashboard", id);
    await this.notifier.send({ severity: "critical", title: `${key.name} disabled by hand`, body: "Disabled from the dashboard." });
  }

  updateSettings(id: string, patch: { mode?: KeyRow["mode"]; windowLimit?: number; dailyLimit?: number }) {
    const key = this.store.key(id);
    if (!key) throw new HttpError(404, "no such key");
    this.store.updateKey(id, patch);
    const parts: string[] = [];
    if (patch.mode && patch.mode !== key.mode) parts.push(patch.mode === "kill" ? "alert + disable" : "alert only");
    if (patch.windowLimit !== undefined && patch.windowLimit !== key.windowLimit) parts.push(`${this.cfg.windowMin}-min limit ${usd(patch.windowLimit)}`);
    if (patch.dailyLimit !== undefined && patch.dailyLimit !== key.dailyLimit) parts.push(`daily limit ${usd(patch.dailyLimit)}`);
    if (parts.length) this.store.log(this.clock.now(), "settings", `${key.name} settings changed`, parts.join(" · "), id);
  }

  /** Everything the panel shows, in one read. */
  snapshot() {
    const now = this.clock.now();
    const to = floorMinute(now) + MINUTE, day = startOfDay(now);
    const keys = this.store.keys();
    const rows = keys.map(k => {
      const s = this.spendOf(k, now);
      return {
        id: k.id, provider: k.provider, providerLabel: this.labelOf(k), name: k.name,
        status: k.status, mode: k.mode, windowLimit: k.windowLimit, dailyLimit: k.dailyLimit, reversible: k.reversible, offAt: k.offAt,
        window: s.window, day: s.day,
        canRestore: k.status === "off" && k.reversible && !!this.providers.get(k.provider)?.enableKey
      };
    });
    const bars = new Array<number>(BARS).fill(0);
    let today = 0, windowTotal = 0;
    const windowFrom = to - this.cfg.windowMin * MINUTE;
    for (const s of this.store.series(Math.min(day, to - BARS * MINUTE), to)) {
      if (s.minute >= day) today += s.cost;
      if (s.minute >= windowFrom) windowTotal += s.cost;
      const i = BARS - (to - s.minute) / MINUTE;
      if (i >= 0 && i < BARS) bars[i]! += s.cost;
    }
    return {
      now, windowMin: this.cfg.windowMin, dryRun: this.cfg.dryRun, demo: this.cfg.demo, alertDelayMin: this.cfg.alertDelayMin,
      totals: {
        today, window: windowTotal, perMinute: windowTotal / this.cfg.windowMin,
        offCount: keys.filter(k => k.status === "off").length,
        savedToday: this.store.saved(day), savedAll: this.store.saved(0)
      },
      bars,
      keys: rows,
      providers: [...this.health.values()],
      eventCount: this.store.eventCount()
    };
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
