import fs from "node:fs";

/** USD per 1M tokens. Missing cache rates fall back to the input rate (an over- rather than under-estimate). */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Anthropic's 1-hour cache write; OpenAI's 12h write. */
  cacheWriteLong?: number;
}

export type PriceTable = Record<"openai" | "anthropic", Record<string, Price>>;

/**
 * List prices, standard tier, checked 2026-10-21 against the providers' pricing pages.
 * Keys are model-id prefixes: the longest prefix that matches a reported model wins, so dated snapshots
 * ("gpt-5.4-mini-2026-03-05") find their base. Batch discounts and long-context surcharges are ignored:
 * batch is over-estimated (safe for a brake), very long prompts are under-estimated.
 * Override or extend with PRICES_FILE (same shape, merged over this).
 */
export const DEFAULT_PRICES: PriceTable = {
  anthropic: {
    "claude-fable-5-1": { input: 10, cacheWrite: 12.5, cacheWriteLong: 20, cacheRead: 0.25, output: 50 },
    "claude-fable-5": { input: 10, cacheWrite: 12.5, cacheWriteLong: 20, cacheRead: 1, output: 50 },
    "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheWriteLong: 8, cacheRead: 0.2, output: 20 },
    "claude-opus-5": { input: 5, cacheWrite: 6.25, cacheWriteLong: 10, cacheRead: 0.5, output: 25 },
    "claude-opus-4": { input: 5, cacheWrite: 6.25, cacheWriteLong: 10, cacheRead: 0.5, output: 25 },
    "claude-sonnet-5-5": { input: 2, cacheWrite: 2.5, cacheWriteLong: 4, cacheRead: 0.1, output: 10 },
    "claude-sonnet-5": { input: 2, cacheWrite: 2.5, cacheWriteLong: 4, cacheRead: 0.2, output: 10 },
    "claude-sonnet-4": { input: 3, cacheWrite: 3.75, cacheWriteLong: 6, cacheRead: 0.3, output: 15 },
    // ≤100K-token prompts; longer prompts cost 5x
    "claude-haiku-5-5": { input: 0.1, cacheWrite: 0.125, cacheWriteLong: 0.2, cacheRead: 0.01, output: 0.5 },
    "claude-haiku-4-5": { input: 1, cacheWrite: 1.25, cacheWriteLong: 2, cacheRead: 0.1, output: 5 }
  },
  openai: {
    "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite: 12.5, cacheWriteLong: 25, output: 50 },
    "gpt-6.1-sol": { input: 2, cacheRead: 0.1, cacheWrite: 2.5, cacheWriteLong: 5, output: 10 },
    "gpt-6-sol": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, cacheWriteLong: 5, output: 10 },
    "gpt-6-luna": { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, cacheWriteLong: 0.25, output: 0.5 },
    "gpt-5.6-sol": { input: 4, cacheRead: 0.4, cacheWrite: 5, cacheWriteLong: 10, output: 20 },
    "gpt-5.6-terra": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, cacheWriteLong: 5, output: 12 },
    "gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, cacheWriteLong: 0.5, output: 1.2 },
    "gpt-5.5-pro": { input: 30, output: 180 },
    "gpt-5.5": { input: 5, cacheRead: 0.5, output: 30 },
    "gpt-5.4-pro": { input: 30, output: 180 },
    "gpt-5.4-mini": { input: 0.75, cacheRead: 0.075, output: 4.5 },
    "gpt-5.4-nano": { input: 0.2, cacheRead: 0.02, output: 1.25 },
    "gpt-5.4": { input: 2.5, cacheRead: 0.25, output: 15 },
    "gpt-5.2": { input: 1.75, cacheRead: 0.175, output: 14 },
    "gpt-5.1": { input: 1.25, cacheRead: 0.125, output: 10 },
    "gpt-5-mini": { input: 0.25, cacheRead: 0.025, output: 2 },
    "gpt-5-nano": { input: 0.05, cacheRead: 0.005, output: 0.4 },
    "gpt-5": { input: 1.25, cacheRead: 0.125, output: 10 },
    "gpt-4.1": { input: 2, cacheRead: 0.5, output: 8 },
    "gpt-4o-mini": { input: 0.15, cacheRead: 0.075, output: 0.6 },
    "gpt-4o": { input: 2.5, cacheRead: 1.25, output: 10 },
    "o4-mini": { input: 1.1, cacheRead: 0.275, output: 4.4 },
    "o3": { input: 2, cacheRead: 0.5, output: 8 }
  }
};

/** An unknown model is priced like the provider's most expensive one: better a false alarm than a missed runaway. */
const FALLBACK: Record<keyof PriceTable, Price> = {
  anthropic: DEFAULT_PRICES.anthropic["claude-fable-5-1"]!,
  openai: DEFAULT_PRICES.openai["gpt-6-astra"]!
};

export class Prices {
  constructor(private table: PriceTable = DEFAULT_PRICES) {}

  /** The price of a model, and whether it was a guess. */
  find(provider: keyof PriceTable, model: string | null | undefined): { price: Price; known: boolean } {
    const m = (model ?? "").toLowerCase();
    let best: string | null = null;
    for (const prefix of Object.keys(this.table[provider]))
      if (m.startsWith(prefix.toLowerCase()) && (!best || prefix.length > best.length)) best = prefix;
    return best ? { price: this.table[provider][best]!, known: true } : { price: FALLBACK[provider], known: false };
  }
}

export function loadPrices(file: string | null): Prices {
  if (!file) return new Prices();
  const extra = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PriceTable>;
  return new Prices({
    anthropic: { ...DEFAULT_PRICES.anthropic, ...extra.anthropic },
    openai: { ...DEFAULT_PRICES.openai, ...extra.openai }
  });
}

export const perToken = (usdPerMillion: number) => usdPerMillion / 1_000_000;
