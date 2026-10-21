import { perToken, type Prices } from "../pricing.js";
import type { DisableResult, KeyRow, Provider, RemoteKey, UsageBucket } from "../types.js";
import { query, requestJson, type Fetch } from "./request.js";

const BASE = "https://api.anthropic.com/v1/organizations";

interface ApiKey { id: string; name: string; status: "active" | "inactive" | "archived" | "expired"; partial_key_hint?: string }
interface List<T> { data: T[]; has_more: boolean; last_id?: string | null }
interface UsageResult {
  api_key_id: string | null;
  model: string | null;
  uncached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  output_tokens?: number;
  server_tool_use?: { web_search_requests?: number } | null;
}
interface UsagePage { data: { starting_at: string; ending_at: string; results: UsageResult[] }[]; has_more: boolean; next_page?: string | null }

/** $10 per 1000 web searches. */
const WEB_SEARCH_USD = 0.01;

/**
 * Anthropic through the Admin API (an `sk-ant-admin...` key). Per-minute usage by key and model; a kill sets the
 * key to inactive, which can be undone.
 */
export class AnthropicProvider implements Provider {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic";

  constructor(private adminKey: string, private prices: Prices, private f: Fetch = fetch) {}

  private req<T>(path: string, init: RequestInit = {}) {
    return requestJson<T>(this.f, "Anthropic", BASE + path, {
      ...init,
      headers: { "x-api-key": this.adminKey, "anthropic-version": "2023-06-01", "content-type": "application/json", "user-agent": "bills-check/0.1" }
    });
  }

  async listKeys(): Promise<RemoteKey[]> {
    const out: RemoteKey[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.req<List<ApiKey>>(`/api_keys?${query({ limit: 1000, after_id: after })}`);
      for (const k of page.data)
        if (k.status === "active" || k.status === "inactive") out.push({ externalId: k.id, name: k.name || k.partial_key_hint || k.id, active: k.status === "active" });
      if (!page.has_more || !page.last_id) return out;
      after = page.last_id;
    }
  }

  async fetchUsage(from: number, to: number): Promise<UsageBucket[]> {
    const out: UsageBucket[] = [];
    let page: string | undefined;
    for (;;) {
      const params = query({
        starting_at: new Date(from).toISOString(), ending_at: new Date(to).toISOString(), bucket_width: "1m",
        "group_by[]": ["api_key_id", "model"], limit: 1440, page
      });
      const res = await this.req<UsagePage>(`/usage_report/messages?${params}`);
      for (const b of res.data) {
        const minute = Date.parse(b.starting_at);
        for (const r of b.results) {
          if (!r.api_key_id) continue; // Console / workbench usage has no key
          const { price, known } = this.prices.find("anthropic", r.model);
          const cost = (r.uncached_input_tokens ?? 0) * perToken(price.input)
            + (r.cache_read_input_tokens ?? 0) * perToken(price.cacheRead ?? price.input)
            + (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) * perToken(price.cacheWrite ?? price.input)
            + (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) * perToken(price.cacheWriteLong ?? price.cacheWrite ?? price.input)
            + (r.output_tokens ?? 0) * perToken(price.output)
            + (r.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
          out.push({ externalId: r.api_key_id, minute, cost, unpriced: known ? undefined : [r.model ?? "?"] });
        }
      }
      if (!res.has_more || !res.next_page) return out;
      page = res.next_page;
    }
  }

  private setStatus(key: KeyRow, status: "active" | "inactive") {
    return this.req(`/api_keys/${encodeURIComponent(key.externalId)}`, { method: "POST", body: JSON.stringify({ status }) });
  }

  async disableKey(key: KeyRow): Promise<DisableResult> {
    await this.setStatus(key, "inactive");
    return { reversible: true };
  }

  async enableKey(key: KeyRow): Promise<void> {
    await this.setStatus(key, "active");
  }
}
