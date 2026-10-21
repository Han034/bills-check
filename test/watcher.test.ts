import { beforeEach, describe, expect, it } from "vitest";
import { ManualClock, MINUTE } from "../src/clock.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import type { Notice } from "../src/notify.js";
import { DemoProvider } from "../src/providers/demo.js";
import type { DisableResult, KeyRow, Provider, RemoteKey, UsageBucket } from "../src/types.js";
import { Watcher } from "../src/watcher.js";

/** A provider whose spend per minute the test sets. */
class FakeProvider implements Provider {
  readonly id = "anthropic" as const;
  readonly label = "Fake";
  rate = 0.1;
  disabled: string[] = [];
  failDisable = false;
  failUsage = false;
  constructor(private clock: ManualClock) {}
  async listKeys(): Promise<RemoteKey[]> { return [{ externalId: "k1", name: "key-one", active: true }]; }
  async fetchUsage(from: number, to: number): Promise<UsageBucket[]> {
    if (this.failUsage) throw new Error("401 bad admin key");
    const out: UsageBucket[] = [];
    for (let m = from; m < Math.min(to, this.clock.now() + MINUTE); m += MINUTE)
      if (!this.disabled.includes("k1")) out.push({ externalId: "k1", minute: m, cost: this.rate });
    return out;
  }
  async disableKey(k: KeyRow): Promise<DisableResult> {
    if (this.failDisable) throw new Error("403 forbidden");
    this.disabled.push(k.externalId);
    return { reversible: true };
  }
  async enableKey(k: KeyRow) { this.disabled = this.disabled.filter(x => x !== k.externalId); }
}

const cfg = (extra: Record<string, string> = {}) =>
  loadConfig({ ANTHROPIC_ADMIN_KEY: "x", DEFAULT_MODE: "kill", DEFAULT_WINDOW_USD: "5", DEFAULT_DAILY_USD: "1000", ...extra });

describe("Watcher", () => {
  let clock: ManualClock, store: Store, provider: FakeProvider, sent: Notice[];
  const make = (env?: Record<string, string>) =>
    new Watcher(cfg(env), store, clock, { send: async n => { sent.push(n); } }, [provider]);

  beforeEach(() => {
    clock = new ManualClock(new Date(2026, 9, 21, 10, 0).getTime());
    store = new Store(":memory:");
    provider = new FakeProvider(clock);
    sent = [];
  });

  async function minutes(w: Watcher, n: number) {
    for (let i = 0; i < n; i++) { clock.advance(MINUTE); await w.tick(); }
  }

  it("picks up keys with the default settings", async () => {
    await make().tick();
    expect(store.keys()).toMatchObject([{ id: "anthropic:k1", mode: "kill", windowLimit: 5, status: "ok" }]);
  });

  it("kills a runaway key once, records the estimate and notifies", async () => {
    const w = make();
    await w.tick();
    provider.rate = 1; // $15 in 15 minutes against a $5 limit
    await minutes(w, 5);
    const k = store.key("anthropic:k1")!;
    expect(k.status).toBe("off");
    expect(provider.disabled).toEqual(["k1"]);
    expect(sent.filter(n => n.severity === "critical")).toHaveLength(1);
    expect(store.saved(0)).toBeGreaterThan(0);
  });

  it("restore turns the key back on and starts counting afresh", async () => {
    const w = make();
    await w.tick();
    provider.rate = 1;
    await minutes(w, 6);
    await w.restore("anthropic:k1");
    provider.rate = 0.1;
    await minutes(w, 3);
    expect(store.key("anthropic:k1")!.status).toBe("ok");
    expect(provider.disabled).toEqual([]);
  });

  it("in dry-run it warns once and never disables", async () => {
    const w = make({ DRY_RUN: "1" });
    await w.tick();
    provider.rate = 1;
    await minutes(w, 10);
    expect(provider.disabled).toEqual([]);
    expect(store.key("anthropic:k1")!.status).toBe("warn");
    expect(sent.filter(n => n.severity === "warn")).toHaveLength(1);
  });

  it("a failed kill is reported and retried", async () => {
    const w = make();
    await w.tick();
    provider.rate = 1; provider.failDisable = true;
    await minutes(w, 6);
    expect(store.events().some(e => e.kind === "kill-failed")).toBe(true);
    provider.failDisable = false;
    await minutes(w, 1);
    expect(store.key("anthropic:k1")!.status).toBe("off");
  });

  it("reports a provider that cannot be read, once an hour", async () => {
    const w = make();
    provider.failUsage = true;
    await minutes(w, 5);
    expect(store.events().filter(e => e.kind === "provider-error")).toHaveLength(1);
    expect(w.snapshot().providers[0]!.lastError).toContain("401");
  });
});

describe("DemoProvider", () => {
  it("re-reading a minute gives the same spend, also after a kill", async () => {
    const clock = new ManualClock(new Date(2026, 9, 21, 2, 0).getTime());
    const p = new DemoProvider(clock);
    p.startScenario("leak");
    clock.advance(10 * MINUTE);
    const before = await p.fetchUsage(clock.now() - 10 * MINUTE, clock.now());
    await p.disableKey({ externalId: "script" } as KeyRow);
    clock.advance(5 * MINUTE);
    const after = await p.fetchUsage(clock.now() - 15 * MINUTE, clock.now() - 5 * MINUTE);
    expect(after).toEqual(before);
  });
});
