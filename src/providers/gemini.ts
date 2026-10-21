import { GoogleAuth } from "google-auth-library";
import { floorMinute } from "../clock.js";
import type { DisableResult, KeyRow, Provider, RemoteKey, UsageBucket } from "../types.js";
import { query, requestJson, type Fetch } from "./request.js";

const SERVICE = "generativelanguage.googleapis.com";

interface ApiKey {
  name: string; // projects/N/locations/global/keys/ID
  uid: string;
  displayName?: string;
  deleteTime?: string;
  restrictions?: { apiTargets?: { service: string }[] };
}
interface TimeSeries {
  resource: { labels: Record<string, string> };
  points: { interval: { startTime: string; endTime: string }; value: { int64Value?: string; doubleValue?: number } }[];
}

/** Signs requests with Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS, or the metadata server on GCP). */
export function googleFetch(): Fetch {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return async (url, init) => {
    const token = await auth.getAccessToken();
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  };
}

/**
 * Gemini API keys of one Google Cloud project, through Cloud Monitoring and the API Keys API.
 * Google reports requests per key, not tokens, so spend is requests × GEMINI_COST_PER_REQUEST, and the numbers
 * can be up to ~30 minutes late. A kill deletes the key, which Google can undelete for 30 days.
 */
export class GeminiProvider implements Provider {
  readonly id = "gemini" as const;
  readonly label = "Gemini";

  constructor(private projectId: string, private costPerRequest: number, private f: Fetch = googleFetch()) {}

  async listKeys(): Promise<RemoteKey[]> {
    const out: RemoteKey[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const url = `https://apikeys.googleapis.com/v2/projects/${encodeURIComponent(this.projectId)}/locations/global/keys?${query({ pageSize: 300, pageToken, showDeleted: true })}`;
      const res = await requestJson<{ keys?: ApiKey[]; nextPageToken?: string }>(this.f, "Gemini", url);
      for (const k of res.keys ?? []) {
        const targets = k.restrictions?.apiTargets;
        // a key restricted to other APIs cannot spend on Gemini
        if (targets?.length && !targets.some(t => t.service === SERVICE)) continue;
        out.push({ externalId: k.uid, name: k.displayName || k.uid, scope: k.name, active: !k.deleteTime });
      }
      if (!res.nextPageToken) return out;
      pageToken = res.nextPageToken;
    }
  }

  async fetchUsage(from: number, to: number): Promise<UsageBucket[]> {
    const out: UsageBucket[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const params = query({
        filter: `metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.type="consumed_api" AND resource.labels.service="${SERVICE}"`,
        "interval.startTime": new Date(from).toISOString(),
        "interval.endTime": new Date(to).toISOString(),
        "aggregation.alignmentPeriod": "60s",
        "aggregation.perSeriesAligner": "ALIGN_DELTA",
        "aggregation.crossSeriesReducer": "REDUCE_SUM",
        "aggregation.groupByFields": "resource.labels.credential_id",
        view: "FULL",
        pageToken
      });
      const res = await requestJson<{ timeSeries?: TimeSeries[]; nextPageToken?: string }>(this.f, "Gemini",
        `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(this.projectId)}/timeSeries?${params}`);
      for (const ts of res.timeSeries ?? []) {
        // "apikey:<uid>" for API keys; OAuth clients and service accounts are not keys we can act on
        const cred = ts.resource.labels.credential_id ?? "";
        if (!cred.startsWith("apikey:")) continue;
        const uid = cred.slice("apikey:".length);
        for (const p of ts.points) {
          const n = Number(p.value.int64Value ?? p.value.doubleValue ?? 0);
          if (n > 0) out.push({ externalId: uid, minute: floorMinute(Date.parse(p.interval.startTime)), cost: n * this.costPerRequest, requests: n });
        }
      }
      if (!res.nextPageToken) return out;
      pageToken = res.nextPageToken;
    }
  }

  async disableKey(key: KeyRow): Promise<DisableResult> {
    if (!key.scope) throw new Error("the key's resource name is unknown");
    await requestJson(this.f, "Gemini", `https://apikeys.googleapis.com/v2/${key.scope}`, { method: "DELETE" });
    return { reversible: true };
  }

  async enableKey(key: KeyRow): Promise<void> {
    if (!key.scope) throw new Error("the key's resource name is unknown");
    await requestJson(this.f, "Gemini", `https://apikeys.googleapis.com/v2/${key.scope}:undelete`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  }
}
