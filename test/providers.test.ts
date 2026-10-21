import { describe, expect, it } from "vitest";
import { Prices } from "../src/pricing.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { GeminiProvider } from "../src/providers/gemini.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import type { KeyRow } from "../src/types.js";

/** A fetch that answers from a list of [url pattern, body] and records every call. */
function fakeFetch(routes: [RegExp, unknown][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) return new Response(JSON.stringify({ error: { message: "no route " + url } }), { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

const T = Date.UTC(2026, 9, 21, 10, 0);

describe("Prices", () => {
  it("matches the longest prefix, so snapshots find their base", () => {
    const p = new Prices();
    expect(p.find("openai", "gpt-5.4-mini-2026-03-05").price.input).toBe(0.75);
    expect(p.find("openai", "gpt-5.4-2026-03-05").price.input).toBe(2.5);
    expect(p.find("anthropic", "claude-sonnet-5-5").price.cacheRead).toBe(0.1);
  });

  it("prices an unknown model at the most expensive rate and says so", () => {
    const r = new Prices().find("anthropic", "claude-mystery-9");
    expect(r.known).toBe(false);
    expect(r.price.output).toBe(50);
  });
});

describe("AnthropicProvider", () => {
  it("turns per-minute token usage into dollars per key", async () => {
    const { f, calls } = fakeFetch([[/usage_report\/messages/, {
      data: [{ starting_at: "2026-10-21T10:00:00Z", ending_at: "2026-10-21T10:01:00Z", results: [
        { api_key_id: "apikey_1", model: "claude-sonnet-5-5", uncached_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 100_000, server_tool_use: { web_search_requests: 2 } },
        { api_key_id: null, model: "claude-sonnet-5-5", uncached_input_tokens: 5, output_tokens: 5 }
      ] }], has_more: false, next_page: null
    }]]);
    const out = await new AnthropicProvider("sk-ant-admin", new Prices(), f).fetchUsage(T, T + 60_000);
    expect(out).toHaveLength(1);
    // 1M × $2 + 1M × $0.10 + 0.1M × $10 + 2 × $0.01
    expect(out[0]!.cost).toBeCloseTo(3.12, 6);
    expect(out[0]!.minute).toBe(T);
    expect(calls[0]!.url).toContain("group_by%5B%5D=api_key_id");
    expect(calls[0]!.url).toContain("bucket_width=1m");
    expect(new Headers(calls[0]!.init?.headers).get("anthropic-version")).toBe("2023-06-01");
  });

  it("disables by setting the key inactive, and enables it again", async () => {
    const { f, calls } = fakeFetch([[/api_keys\/apikey_1$/, { id: "apikey_1", status: "inactive" }]]);
    const p = new AnthropicProvider("k", new Prices(), f);
    expect(await p.disableKey({ externalId: "apikey_1" } as KeyRow)).toEqual({ reversible: true });
    await p.enableKey({ externalId: "apikey_1" } as KeyRow);
    expect(calls.map(c => JSON.parse(c.init!.body as string).status)).toEqual(["inactive", "active"]);
  });

  it("lists only usable keys and follows pages", async () => {
    let n = 0;
    const f = (async () => new Response(JSON.stringify(n++ === 0
      ? { data: [{ id: "a", name: "one", status: "active" }, { id: "b", name: "old", status: "archived" }], has_more: true, last_id: "b" }
      : { data: [{ id: "c", name: "two", status: "inactive" }], has_more: false, last_id: "c" }))) as typeof fetch;
    const keys = await new AnthropicProvider("k", new Prices(), f).listKeys();
    expect(keys).toEqual([{ externalId: "a", name: "one", active: true }, { externalId: "c", name: "two", active: false }]);
  });

  it("surfaces API errors with their message", async () => {
    const f = (async () => new Response(JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 })) as typeof fetch;
    await expect(new AnthropicProvider("k", new Prices(), f).listKeys()).rejects.toThrow("Anthropic 401: invalid x-api-key");
  });
});

describe("OpenAIProvider", () => {
  it("lists keys across projects with their project as scope", async () => {
    const { f } = fakeFetch([
      [/projects\/proj_1\/api_keys/, { data: [{ id: "key_1", name: "prod", redacted_value: "sk-...abc" }], has_more: false }],
      [/organization\/projects\?/, { data: [{ id: "proj_1", name: "P" }], has_more: false }]
    ]);
    expect(await new OpenAIProvider("a", new Prices(), f).listKeys()).toEqual([{ externalId: "key_1", name: "prod", scope: "proj_1", active: true }]);
  });

  it("prices completions with cache reads and writes", async () => {
    const { f, calls } = fakeFetch([
      [/usage\/completions/, { data: [{ start_time: T / 1000, end_time: T / 1000 + 60, results: [
        { api_key_id: "key_1", model: "gpt-5.4-2026-03-05", input_tokens: 2_000_000, input_cached_tokens: 1_000_000, output_tokens: 1_000_000, num_model_requests: 3 }
      ] }], has_more: false }],
      [/usage\/embeddings/, { data: [], has_more: false }]
    ]);
    const out = await new OpenAIProvider("a", new Prices(), f).fetchUsage(T, T + 60_000);
    // 1M uncached × $2.50 + 1M cached × $0.25 + 1M out × $15
    expect(out[0]!.cost).toBeCloseTo(17.75, 6);
    expect(calls[0]!.url).toContain("group_by=api_key_id&group_by=model");
  });

  it("disables by deleting the project key, which cannot be undone", async () => {
    const { f, calls } = fakeFetch([[/projects\/proj_1\/api_keys\/key_1$/, { deleted: true }]]);
    const r = await new OpenAIProvider("a", new Prices(), f).disableKey({ externalId: "key_1", scope: "proj_1" } as KeyRow);
    expect(r).toEqual({ reversible: false });
    expect(calls[0]!.init?.method).toBe("DELETE");
  });
});

describe("GeminiProvider", () => {
  it("reads request counts per API key from Cloud Monitoring", async () => {
    const { f, calls } = fakeFetch([[/monitoring\.googleapis\.com/, { timeSeries: [
      { resource: { labels: { credential_id: "apikey:uid-1" } }, points: [{ interval: { startTime: "2026-10-21T10:00:00Z", endTime: "2026-10-21T10:01:00Z" }, value: { int64Value: "250" } }] },
      { resource: { labels: { credential_id: "serviceaccount:123" } }, points: [{ interval: { startTime: "2026-10-21T10:00:00Z", endTime: "2026-10-21T10:01:00Z" }, value: { int64Value: "9" } }] }
    ] }]]);
    const out = await new GeminiProvider("my-proj", 0.002, f).fetchUsage(T, T + 60_000);
    expect(out).toEqual([{ externalId: "uid-1", minute: T, cost: 0.5, requests: 250 }]);
    expect(decodeURIComponent(calls[0]!.url)).toContain('resource.labels.service="generativelanguage.googleapis.com"');
  });

  it("skips keys restricted to other APIs and marks deleted ones inactive", async () => {
    const { f } = fakeFetch([[/apikeys\.googleapis\.com/, { keys: [
      { name: "projects/1/locations/global/keys/a", uid: "a", displayName: "gemini" },
      { name: "projects/1/locations/global/keys/b", uid: "b", displayName: "maps", restrictions: { apiTargets: [{ service: "maps.googleapis.com" }] } },
      { name: "projects/1/locations/global/keys/c", uid: "c", displayName: "old", deleteTime: "2026-10-20T00:00:00Z" }
    ] }]]);
    const keys = await new GeminiProvider("p", 0.002, f).listKeys();
    expect(keys.map(k => [k.externalId, k.active])).toEqual([["a", true], ["c", false]]);
  });

  it("disables by deleting (undeletable for 30 days) and enables by undeleting", async () => {
    const { f, calls } = fakeFetch([[/apikeys\.googleapis\.com/, { name: "operations/x" }]]);
    const p = new GeminiProvider("p", 0.002, f);
    const key = { scope: "projects/1/locations/global/keys/a" } as KeyRow;
    expect(await p.disableKey(key)).toEqual({ reversible: true });
    await p.enableKey(key);
    expect(calls.map(c => [c.init?.method, c.url.split("/v2/")[1]])).toEqual([["DELETE", "projects/1/locations/global/keys/a"], ["POST", "projects/1/locations/global/keys/a:undelete"]]);
  });
});
