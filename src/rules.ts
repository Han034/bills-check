import type { KeyRow } from "./types.js";

export interface Spend {
  /** USD in the rolling window (since countFrom). */
  window: number;
  /** USD since local midnight (since countFrom). */
  day: number;
}

export type Decision =
  | { kind: "none" }
  | { kind: "kill"; breach: "window" | "daily"; reason: string }
  | { kind: "warn"; breach: "window" | "daily"; reason: string }
  /** A warned key fell back under its limits: it can warn again next time. */
  | { kind: "rearm" };

const usd = (v: number) => "$" + v.toFixed(2);

/** A warned key re-arms once the window falls under this share of its limit, so one long breach is one message, not one a minute. */
export const REARM_SHARE = 0.5;

export function evaluate(key: KeyRow, spend: Spend, windowMin: number): Decision {
  if (key.status === "off" || key.gone) return { kind: "none" };

  const overWindow = key.windowLimit > 0 && spend.window > key.windowLimit;
  const overDay = key.dailyLimit > 0 && spend.day > key.dailyLimit;

  if (overWindow || overDay) {
    // the window breach is reported first; once it has been, a daily breach on top of it is news of its own
    const breach = overDay && (!overWindow || key.warnedFor === "window") ? "daily" : "window";
    const reason = breach === "window"
      ? `${windowMin} dk'da ${usd(spend.window)} (eşik ${usd(key.windowLimit)})`
      : `bugün ${usd(spend.day)} (günlük eşik ${usd(key.dailyLimit)})`;
    if (key.mode === "kill") return { kind: "kill", breach, reason };
    // warn once per breach; a daily breach stays until midnight, a window breach until the window calms down
    if (key.warnedFor === null || (key.warnedFor === "window" && breach === "daily")) return { kind: "warn", breach, reason };
    return { kind: "none" };
  }

  if (key.warnedFor === "window" && spend.window < key.windowLimit * REARM_SHARE) return { kind: "rearm" };
  if (key.warnedFor === "daily" && !overDay) return { kind: "rearm" };
  return { kind: "none" };
}

/** What a runaway key would have cost before anyone noticed: its current rate times the provider's alert lag. */
export function savedEstimate(windowSpend: number, windowMin: number, alertDelayMin: number): number {
  return (windowSpend / windowMin) * alertDelayMin;
}
