import { describe, expect, it } from "vitest";
import { evaluate, savedEstimate } from "../src/rules.js";
import type { KeyRow } from "../src/types.js";

const key = (over: Partial<KeyRow> = {}): KeyRow => ({
  id: "x:1", provider: "anthropic", externalId: "1", name: "k", scope: null, status: "ok", mode: "kill",
  windowLimit: 5, dailyLimit: 50, countFrom: 0, warnedFor: null, gone: false, reversible: true, offAt: null, ...over
});

describe("evaluate", () => {
  it("does nothing under the limits", () => {
    expect(evaluate(key(), { window: 4.9, day: 49 }, 15).kind).toBe("none");
  });

  it("kills a kill-mode key over the window limit", () => {
    const d = evaluate(key(), { window: 5.01, day: 10 }, 15);
    expect(d).toMatchObject({ kind: "kill", breach: "window" });
  });

  it("kills over the daily limit", () => {
    expect(evaluate(key(), { window: 1, day: 51 }, 15)).toMatchObject({ kind: "kill", breach: "daily" });
  });

  it("warns once per breach in warn mode", () => {
    expect(evaluate(key({ mode: "warn" }), { window: 6, day: 6 }, 15)).toMatchObject({ kind: "warn", breach: "window" });
    expect(evaluate(key({ mode: "warn", warnedFor: "window", status: "warn" }), { window: 6, day: 6 }, 15).kind).toBe("none");
  });

  it("escalates a window warning to a daily one", () => {
    expect(evaluate(key({ mode: "warn", warnedFor: "window" }), { window: 6, day: 60 }, 15)).toMatchObject({ kind: "warn", breach: "daily" });
  });

  it("re-arms a window warning only after the window calms down", () => {
    const k = key({ mode: "warn", warnedFor: "window", status: "warn" });
    expect(evaluate(k, { window: 3, day: 6 }, 15).kind).toBe("none");
    expect(evaluate(k, { window: 2, day: 6 }, 15).kind).toBe("rearm");
  });

  it("ignores keys that are off or gone, and limits set to 0", () => {
    expect(evaluate(key({ status: "off" }), { window: 99, day: 99 }, 15).kind).toBe("none");
    expect(evaluate(key({ gone: true }), { window: 99, day: 99 }, 15).kind).toBe("none");
    expect(evaluate(key({ windowLimit: 0, dailyLimit: 0 }), { window: 99, day: 99 }, 15).kind).toBe("none");
  });
});

describe("savedEstimate", () => {
  it("is the window rate times the alert delay", () => {
    expect(savedEstimate(15, 15, 360)).toBe(360);
  });
});
