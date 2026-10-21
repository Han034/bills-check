export type Fetch = typeof fetch;

export class ProviderError extends Error {
  constructor(readonly provider: string, readonly status: number, message: string) { super(message); }
}

/** One JSON request with a timeout; a non-2xx answer becomes a ProviderError that carries the start of the body. */
export async function requestJson<T>(f: Fetch, provider: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = j.error?.message ?? j.error ?? msg; } catch { /* not JSON */ }
    throw new ProviderError(provider, res.status, `${provider} ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Builds a query string; array values repeat the key (`k=a&k=b`), as the APIs here expect. */
export function query(params: Record<string, string | number | boolean | undefined | (string | number)[]>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) q.append(k, String(x));
    else q.append(k, String(v));
  }
  return q.toString();
}
