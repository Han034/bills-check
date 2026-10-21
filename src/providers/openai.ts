import { perToken, type Prices } from "../pricing.js";
import type { DisableResult, KeyRow, Provider, RemoteKey, UsageBucket } from "../types.js";
import { query, requestJson, type Fetch } from "./request.js";

const BASE = "https://api.openai.com/v1";

interface List<T> { data: T[]; has_more: boolean; last_id?: string | null }
interface Page<T> { data: T[]; has_more: boolean; next_page?: string | null }
interface Project { id: string; name: string; status?: string }
interface ApiKey { id: string; name?: string | null; redacted_value?: string; owner_project_access?: string }
interface Bucket<R> { start_time: number; end_time: number; results: R[] }
interface CompletionsResult {
  api_key_id: string | null;
  model: string | null;
  input_tokens?: number;
  input_cached_tokens?: number;
  input_uncached_tokens?: number | null;
  input_cache_write_tokens?: number | null;
  input_cache_write_12h_tokens?: number | null;
  output_tokens?: number;
  num_model_requests?: number;
}
interface EmbeddingsResult { api_key_id: string | null; model: string | null; input_tokens?: number; num_model_requests?: number }

/**
 * OpenAI through the organization Admin API (an `sk-admin-...` key).
 * Spend is computed from the per-minute token usage (the Costs API only has daily buckets).
 * OpenAI has no way to switch a key off and on again: a kill deletes the project key for good.
 */
export class OpenAIProvider implements Provider {
  readonly id = "openai" as const;
  readonly label = "OpenAI";

  constructor(private adminKey: string, private prices: Prices, private f: Fetch = fetch) {}

  private get<T>(path: string) {
    return requestJson<T>(this.f, "OpenAI", BASE + path, { headers: { authorization: `Bearer ${this.adminKey}` } });
  }

  private async listAll<T>(path: string, params: Record<string, string | number>) {
    const out: T[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.get<List<T>>(`${path}?${query({ ...params, limit: 100, after })}`);
      out.push(...page.data);
      if (!page.has_more || !page.last_id) return out;
      after = page.last_id;
    }
  }

  async listKeys(): Promise<RemoteKey[]> {
    const projects = await this.listAll<Project>("/organization/projects", {});
    const out: RemoteKey[] = [];
    for (const p of projects) {
      const keys = await this.listAll<ApiKey>(`/organization/projects/${encodeURIComponent(p.id)}/api_keys`, {});
      for (const k of keys)
        out.push({ externalId: k.id, name: k.name || k.redacted_value || k.id, scope: p.id, active: k.owner_project_access !== "inactive" });
    }
    return out;
  }

  private async usage<R>(kind: string, from: number, to: number): Promise<Bucket<R>[]> {
    const out: Bucket<R>[] = [];
    let page: string | undefined;
    for (;;) {
      const params = query({
        start_time: Math.floor(from / 1000), end_time: Math.floor(to / 1000), bucket_width: "1m",
        group_by: ["api_key_id", "model"], limit: 1440, page
      });
      const res = await this.get<Page<Bucket<R>>>(`/organization/usage/${kind}?${params}`);
      out.push(...res.data);
      if (!res.has_more || !res.next_page) return out;
      page = res.next_page;
    }
  }

  async fetchUsage(from: number, to: number): Promise<UsageBucket[]> {
    const [completions, embeddings] = await Promise.all([
      this.usage<CompletionsResult>("completions", from, to),
      this.usage<EmbeddingsResult>("embeddings", from, to)
    ]);
    const out: UsageBucket[] = [];
    for (const b of completions) for (const r of b.results) {
      if (!r.api_key_id) continue;
      const { price, known } = this.prices.find("openai", r.model);
      const cached = r.input_cached_tokens ?? 0;
      const write = r.input_cache_write_tokens ?? 0, writeLong = r.input_cache_write_12h_tokens ?? 0;
      const uncached = r.input_uncached_tokens ?? Math.max(0, (r.input_tokens ?? 0) - cached - write);
      const cost = uncached * perToken(price.input)
        + cached * perToken(price.cacheRead ?? price.input)
        + (write - writeLong) * perToken(price.cacheWrite ?? price.input)
        + writeLong * perToken(price.cacheWriteLong ?? price.cacheWrite ?? price.input)
        + (r.output_tokens ?? 0) * perToken(price.output);
      out.push({ externalId: r.api_key_id, minute: b.start_time * 1000, cost, requests: r.num_model_requests, unpriced: known ? undefined : [r.model ?? "?"] });
    }
    for (const b of embeddings) for (const r of b.results) {
      if (!r.api_key_id) continue;
      // embedding models are not in the table; price them at a generous $0.13/M (text-embedding-3-large)
      out.push({ externalId: r.api_key_id, minute: b.start_time * 1000, cost: (r.input_tokens ?? 0) * perToken(0.13), requests: r.num_model_requests });
    }
    return out;
  }

  async disableKey(key: KeyRow): Promise<DisableResult> {
    if (!key.scope) throw new Error("the key's project is unknown");
    await requestJson(this.f, "OpenAI", `${BASE}/organization/projects/${encodeURIComponent(key.scope)}/api_keys/${encodeURIComponent(key.externalId)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${this.adminKey}` } });
    return { reversible: false };
  }
}
