import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventKind, EventRow, KeyRow, ProviderId, RemoteKey, TripMode, UsageBucket } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  mode TEXT NOT NULL,
  window_limit REAL NOT NULL,
  daily_limit REAL NOT NULL,
  count_from INTEGER NOT NULL DEFAULT 0,
  warned_for TEXT,
  gone INTEGER NOT NULL DEFAULT 0,
  reversible INTEGER NOT NULL DEFAULT 1,
  off_at INTEGER
);
CREATE TABLE IF NOT EXISTS samples (
  key_id TEXT NOT NULL,
  minute INTEGER NOT NULL,
  cost REAL NOT NULL,
  requests INTEGER,
  PRIMARY KEY (key_id, minute)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  key_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '',
  saved REAL
);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

const SAMPLE_RETENTION_MS = 8 * 24 * 60 * 60_000;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60_000;

type Row = Record<string, unknown>;

function toKey(r: Row): KeyRow {
  return {
    id: r.id as string,
    provider: r.provider as ProviderId,
    externalId: r.external_id as string,
    name: r.name as string,
    scope: (r.scope as string | null) ?? null,
    status: r.status as KeyRow["status"],
    mode: r.mode as TripMode,
    windowLimit: r.window_limit as number,
    dailyLimit: r.daily_limit as number,
    countFrom: r.count_from as number,
    warnedFor: (r.warned_for as KeyRow["warnedFor"]) ?? null,
    gone: r.gone === 1,
    reversible: r.reversible === 1,
    offAt: (r.off_at as number | null) ?? null
  };
}

export const keyId = (provider: ProviderId, externalId: string) => `${provider}:${externalId}`;

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  // ---- keys ----

  keys(opts: { includeGone?: boolean } = {}): KeyRow[] {
    const sql = "SELECT * FROM keys" + (opts.includeGone ? "" : " WHERE gone = 0") + " ORDER BY provider, name";
    return (this.db.prepare(sql).all() as Row[]).map(toKey);
  }

  key(id: string): KeyRow | null {
    const r = this.db.prepare("SELECT * FROM keys WHERE id = ?").get(id) as Row | undefined;
    return r ? toKey(r) : null;
  }

  /** Adds keys the provider lists for the first time (with the default limits) and marks the ones it no longer lists as gone. Returns the new ones. */
  syncKeys(provider: ProviderId, remote: RemoteKey[], defaults: { mode: TripMode; windowLimit: number; dailyLimit: number }): KeyRow[] {
    return this.tx(() => {
      const added: KeyRow[] = [];
      const seen = new Set<string>();
      const insert = this.db.prepare(`INSERT INTO keys (id, provider, external_id, name, scope, mode, window_limit, daily_limit, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const update = this.db.prepare("UPDATE keys SET name = ?, scope = ?, gone = 0 WHERE id = ?");
      for (const k of remote) {
        const id = keyId(provider, k.externalId);
        seen.add(id);
        if (this.key(id)) update.run(k.name, k.scope ?? null, id);
        else {
          // a key that is already inactive at the provider (someone turned it off by hand) starts as off, so it is not "restored" by mistake
          const d = k.preset ?? defaults;
          insert.run(id, provider, k.externalId, k.name, k.scope ?? null, d.mode, d.windowLimit, d.dailyLimit, k.active ? "ok" : "off");
          added.push(this.key(id)!);
        }
      }
      const markGone = this.db.prepare("UPDATE keys SET gone = 1 WHERE id = ?");
      for (const k of this.keys()) if (k.provider === provider && !seen.has(k.id)) markGone.run(k.id);
      return added;
    });
  }

  updateKey(id: string, patch: Partial<Pick<KeyRow, "status" | "mode" | "windowLimit" | "dailyLimit" | "countFrom" | "warnedFor" | "reversible" | "offAt" | "gone">>) {
    const cols: Record<string, string> = {
      status: "status", mode: "mode", windowLimit: "window_limit", dailyLimit: "daily_limit", countFrom: "count_from",
      warnedFor: "warned_for", reversible: "reversible", offAt: "off_at", gone: "gone"
    };
    const sets: string[] = [], vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      vals.push(typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null));
    }
    if (sets.length) this.db.prepare(`UPDATE keys SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  // ---- samples ----

  upsertSamples(provider: ProviderId, buckets: UsageBucket[]) {
    if (!buckets.length) return;
    // several buckets can land on the same key and minute (one per model): add them up before writing
    const merged = new Map<string, { keyId: string; minute: number; cost: number; requests: number | null }>();
    for (const b of buckets) {
      const id = keyId(provider, b.externalId), k = id + "@" + b.minute;
      const m = merged.get(k);
      if (m) { m.cost += b.cost; if (b.requests != null) m.requests = (m.requests ?? 0) + b.requests; }
      else merged.set(k, { keyId: id, minute: b.minute, cost: b.cost, requests: b.requests ?? null });
    }
    const st = this.db.prepare(`INSERT INTO samples (key_id, minute, cost, requests) VALUES (?, ?, ?, ?)
      ON CONFLICT (key_id, minute) DO UPDATE SET cost = excluded.cost, requests = excluded.requests`);
    this.tx(() => { for (const m of merged.values()) st.run(m.keyId, m.minute, m.cost, m.requests); });
  }

  /** Total spend of one key for minutes in [from, to). */
  spend(keyId: string, from: number, to: number): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(cost), 0) AS s FROM samples WHERE key_id = ? AND minute >= ? AND minute < ?").get(keyId, from, to) as Row;
    return r.s as number;
  }

  /** Spend of every watched key per minute, for minutes in [from, to). */
  series(from: number, to: number, keyIds?: string[]): { keyId: string; minute: number; cost: number }[] {
    const rows = this.db.prepare("SELECT key_id, minute, cost FROM samples WHERE minute >= ? AND minute < ? ORDER BY minute").all(from, to) as Row[];
    const only = keyIds ? new Set(keyIds) : null;
    return rows.filter(r => !only || only.has(r.key_id as string)).map(r => ({ keyId: r.key_id as string, minute: r.minute as number, cost: r.cost as number }));
  }

  // ---- events ----

  log(at: number, kind: EventKind, title: string, meta = "", keyId: string | null = null, saved: number | null = null): EventRow {
    const r = this.db.prepare("INSERT INTO events (at, key_id, kind, title, meta, saved) VALUES (?, ?, ?, ?, ?, ?)").run(at, keyId, kind, title, meta, saved);
    return { id: Number(r.lastInsertRowid), at, keyId, kind, title, meta };
  }

  events(limit = 50): EventRow[] {
    const rows = this.db.prepare("SELECT id, at, key_id, kind, title, meta FROM events ORDER BY id DESC LIMIT ?").all(limit) as Row[];
    return rows.map(r => ({ id: r.id as number, at: r.at as number, keyId: (r.key_id as string | null) ?? null, kind: r.kind as EventKind, title: r.title as string, meta: r.meta as string }));
  }

  eventCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as Row).n as number;
  }

  /** The estimated spend avoided by kills since `from`. */
  saved(from: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(saved), 0) AS s FROM events WHERE at >= ?").get(from) as Row).s as number;
  }

  // ---- meta ----

  getMeta(k: string): string | null {
    const r = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as Row | undefined;
    return r ? (r.v as string) : null;
  }

  setMeta(k: string, v: string) {
    this.db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  prune(now: number) {
    this.db.prepare("DELETE FROM samples WHERE minute < ?").run(now - SAMPLE_RETENTION_MS);
    this.db.prepare("DELETE FROM events WHERE at < ?").run(now - EVENT_RETENTION_MS);
  }

  /** Wipes everything: the demo's "start over". */
  reset() {
    this.db.exec("DELETE FROM keys; DELETE FROM samples; DELETE FROM events; DELETE FROM meta;");
  }
}
