import { floorMinute, MINUTE, type Clock } from "../clock.js";
import type { DisableResult, KeyRow, Provider, RemoteKey, UsageBucket } from "../types.js";

interface DemoKey extends RemoteKey {
  label: string;
  /** USD per minute in normal use. */
  base: number;
  /** [from, to) ranges in which the key was off: it spends nothing then (to is null while it is still off). */
  off: [number, number | null][];
}

/** A runaway key: spend climbs to `peak` per minute over `ramp` minutes, from `start` until `end` (null: still running). */
interface Spike { externalId: string; start: number; end: number | null; peak: number; ramp: number }

const KEYS: Omit<DemoKey, "active" | "off">[] = [
  { externalId: "chat", name: "prod-chatbot", label: "OpenAI", base: 0.018, preset: { mode: "kill", windowLimit: 4, dailyLimit: 60 } },
  { externalId: "agent", name: "ajan-deneme", label: "Anthropic", base: 0.03, preset: { mode: "kill", windowLimit: 6, dailyLimit: 40 } },
  { externalId: "script", name: "sheets-script", label: "Gemini", base: 0.006, preset: { mode: "warn", windowLimit: 3, dailyLimit: 25 } }
];

export const SCENARIOS = {
  leak: { externalId: "script", peak: 7, ramp: 6, title: "sheets-script sızdı", meta: "herkese açık dosyada, yabancı istekler" },
  loop: { externalId: "agent", peak: 1.4, ramp: 4, title: "ajan-deneme döngüde", meta: "aynı hatayı tekrar tekrar düzeltiyor" }
} as const;
export type ScenarioName = keyof typeof SCENARIOS;

/** A small deterministic noise in [0.6, 1.4): the same minute always gets the same value, however often it is re-read. */
function noise(seed: string, minute: number): number {
  let h = 2166136261;
  for (const c of seed + minute) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return 0.6 + ((h >>> 0) % 10_000) / 10_000 * 0.8;
}

/** Simulated keys with made-up spend, so the panel can be tried without any provider account. */
export class DemoProvider implements Provider {
  readonly id = "demo" as const;
  readonly label = "Demo";
  private keys: DemoKey[] = [];
  private spikes: Spike[] = [];

  constructor(private clock: Clock) { this.reset(); }

  reset() {
    this.keys = KEYS.map(k => ({ ...k, active: true, off: [] }));
    this.spikes = [];
  }

  /** Each demo key shows the provider it stands for. */
  keyLabel(externalId: string) { return this.keys.find(k => k.externalId === externalId)?.label ?? "Demo"; }

  startScenario(name: ScenarioName) {
    const s = SCENARIOS[name];
    const start = floorMinute(this.clock.now()) + MINUTE;
    this.endSpikes(s.externalId, start);
    this.spikes.push({ externalId: s.externalId, start, end: null, peak: s.peak, ramp: s.ramp });
    return s;
  }

  async listKeys(): Promise<RemoteKey[]> {
    return this.keys.map(({ externalId, name, active, preset }) => ({ externalId, name, active, preset }));
  }

  async fetchUsage(from: number, to: number): Promise<UsageBucket[]> {
    const out: UsageBucket[] = [];
    const end = Math.min(to, floorMinute(this.clock.now()) + MINUTE);
    for (let m = floorMinute(from); m < end; m += MINUTE) {
      for (const k of this.keys) {
        if (k.off.some(([a, b]) => m >= a && (b === null || m < b))) continue;
        let cost = k.base * noise(k.externalId, m);
        for (const s of this.spikes) {
          if (s.externalId !== k.externalId || m < s.start || (s.end !== null && m >= s.end)) continue;
          const n = (m - s.start) / MINUTE + 1;
          cost += Math.min(s.peak, (s.peak * n) / s.ramp) * (0.85 + (noise(k.externalId + "s", m) - 0.6) * 0.375);
        }
        out.push({ externalId: k.externalId, minute: m, cost });
      }
    }
    return out;
  }

  async disableKey(key: KeyRow): Promise<DisableResult> {
    const k = this.find(key.externalId);
    k.active = false;
    const from = floorMinute(this.clock.now()) + MINUTE;
    k.off.push([from, null]);
    this.endSpikes(k.externalId, from); // whatever ran away stops with the key
    return { reversible: true };
  }

  async enableKey(key: KeyRow): Promise<void> {
    const k = this.find(key.externalId);
    k.active = true;
    const open = k.off.find(r => r[1] === null);
    if (open) open[1] = floorMinute(this.clock.now()) + MINUTE;
  }

  private endSpikes(externalId: string, at: number) {
    for (const s of this.spikes) if (s.externalId === externalId && s.end === null) s.end = at;
  }

  private find(externalId: string) {
    const k = this.keys.find(x => x.externalId === externalId);
    if (!k) throw new Error("demo anahtarı yok: " + externalId);
    return k;
  }
}
