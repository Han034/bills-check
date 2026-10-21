type Status = "ok" | "warn" | "off";
type Mode = "kill" | "warn";

interface KeyView {
  id: string; provider: string; providerLabel: string; name: string;
  status: Status; mode: Mode; windowLimit: number; dailyLimit: number;
  reversible: boolean; offAt: number | null; window: number; day: number; canRestore: boolean;
}
interface ProviderHealth { id: string; label: string; lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null }
interface State {
  now: number; windowMin: number; dryRun: boolean; demo: boolean; alertDelayMin: number;
  totals: { today: number; window: number; perMinute: number; offCount: number; savedToday: number; savedAll: number };
  bars: number[]; keys: KeyView[]; providers: ProviderHealth[]; eventCount: number;
}
interface EventView { id: number; at: number; keyId: string | null; kind: string; title: string; meta: string }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const usd = (v: number) => "$" + v.toFixed(2);
const usd0 = (v: number) => "$" + Math.round(v).toLocaleString("en-US");
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hhmm = (t: number) => new Date(t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });

/** Writes a dollar amount as "$" + whole part + decimals, the decimals and sign quieter. */
function setAmount(el: HTMLElement, v: number, decimals = 2) {
  const [whole, frac] = v.toFixed(decimals).split(".");
  const html = `<small>$</small>${Number(whole).toLocaleString("tr-TR")}${frac ? `<small>,${frac}</small>` : ""}`;
  if (el.innerHTML !== html) el.innerHTML = html;
}

function toast(msg: string, opts: { action?: string; onAction?: () => void; time?: number } = {}) {
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.append(msg);
  if (opts.action) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = opts.action;
    b.addEventListener("click", () => { t.remove(); opts.onAction?.(); });
    t.append(b);
  }
  $("toasts").append(t);
  setTimeout(() => t.remove(), opts.time ?? 3500);
}

const ICON: Record<string, [string, string?]> = {
  start: ["shield-check"], trip: ["lock", "is-neg"], warn: ["triangle-alert"], "kill-failed": ["triangle-alert", "is-neg"],
  restore: ["lock-open"], settings: ["bell"], "provider-error": ["triangle-alert", "is-neg"], scenario: ["zap", "is-neg"], info: ["shield-check"]
};

let state: State | null = null;
let openId: string | null = null;
/** The newest event id seen; null until the first load, whose history is not toasted. */
let seenEventId: number | null = null;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Fastify rejects a JSON content-type without a body, so only requests that carry one say so
  const res = await fetch(path, { ...init, headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

const share = (k: KeyView) => (k.windowLimit > 0 ? Math.min(100, (k.window / k.windowLimit) * 100) : 0);

function renderKeys(s: State) {
  $("keysEmpty").hidden = s.keys.length > 0;
  $("keys").innerHTML = s.keys.map(k => {
    const st = k.status === "off" ? ["is-neg", "Kapalı"] : k.status === "warn" ? ["is-warn", "Uyarıldı"] : ["is-pos", "Açık"];
    return `<li class="is-link" tabindex="0" role="button" data-key="${esc(k.id)}" aria-label="${esc(k.providerLabel + " " + k.name)}, ayarlar">`
      + `<span class="ico">${esc(k.providerLabel.charAt(0))}</span>`
      + `<div><b>${esc(k.name)}</b><span class="meta">${esc(k.providerLabel)} · ${usd(k.window)} / ${usd(k.windowLimit)}${k.mode === "warn" ? " · sadece uyar" : ""}</span>`
      + `<div class="progress"><i style="--v:${share(k).toFixed(0)}%"></i></div></div>`
      + `<span class="dot ${st[0]}">${st[1]}</span></li>`;
  }).join("");
}

function renderSheet() {
  const k = state?.keys.find(x => x.id === openId);
  if (!state || !k) return;
  $("shTitle").textContent = k.name;
  $("shMeta").textContent = `${k.providerLabel} · bugün ${usd(k.day)} / ${usd(k.dailyLimit)}`;
  setAmount($("shW"), k.window);
  const bar = $("shBar");
  bar.setAttribute("aria-valuenow", share(k).toFixed(0));
  (bar.firstElementChild as HTMLElement).style.setProperty("--v", share(k).toFixed(0) + "%");
  $("shRestore").hidden = !k.canRestore;
  $("shKill").hidden = k.status === "off";
  $("shGone").hidden = !(k.provider === "openai" || (k.status === "off" && !k.reversible));
}

function render(s: State) {
  state = s;
  const w = `Son ${s.windowMin} dk`;
  $("windowLabel").textContent = w; $("shWLabel").textContent = w; $("shWinLabel").textContent = `${s.windowMin} dk eşiği ($)`;
  $("headMeta").textContent = `${s.keys.length} anahtar · ${s.demo ? "demo" : s.providers.map(p => p.label).join(", ")}`;
  $("clock").textContent = hhmm(s.now);
  setAmount($("total"), s.totals.today);
  $("rateNow").textContent = `dakikada ${usd(s.totals.perMinute)} · son ${s.windowMin} dk ortalaması`;
  $("lastWindow").textContent = usd(s.totals.window);
  $("offCount").textContent = String(s.totals.offCount);
  $("savedSmall").textContent = usd0(s.totals.savedToday);
  $("savedBox").hidden = s.totals.savedToday === 0; $("savedEmpty").hidden = s.totals.savedToday > 0;
  setAmount($("saved"), s.totals.savedToday, 0);
  $("savedHow").textContent = `Kapatma anındaki hız × ${Math.round(s.alertDelayMin / 60)} sa uyarı gecikmesi`;
  const failing = s.providers.filter(p => p.lastError);
  $("mainState").textContent = s.totals.offCount ? `${s.totals.offCount} kapalı` : failing.length ? "Kısmen kör" : "Nöbette";
  $("dryNote").hidden = !s.dryRun;
  $("demoCard").hidden = !s.demo;
  $("provNotes").innerHTML = failing.map(p => `<div class="note is-neg"><span><b>${esc(p.label)}</b> okunamıyor: ${esc(p.lastError!)}</span></div>`).join("");
  $("footProviders").textContent = s.providers.map(p => `${p.label}: ${p.lastOkAt ? "son okuma " + hhmm(p.lastOkAt) : "henüz okunmadı"}`).join(" · ");
  const max = Math.max(0.1, ...s.bars);
  $("bars").innerHTML = s.bars.map((v, i) => `<i style="--v:${Math.max(4, Math.sqrt(v / max) * 100).toFixed(1)}%" title="${hhmm(s.now - (s.bars.length - 1 - i) * 60_000)} · ${usd(v)}"></i>`).join("");
  renderKeys(s);
  renderSheet();
}

function renderLog(events: EventView[], total: number) {
  $("log").innerHTML = events.map((e, i) => {
    const [icon, cls] = ICON[e.kind] ?? ["bell"];
    return `<li${i >= 10 ? ' class="extra"' : ""}><span class="ico"><svg class="i"><use href="#i-${icon}"></use></svg></span>`
      + `<div><b>${esc(e.title)}</b><span class="meta">${esc(e.meta)}</span></div><span class="val${cls ? " " + cls : ""}">${hhmm(e.at)}</span></li>`;
  }).join("");
  $("evCount").textContent = String(total);
  const extra = Math.max(0, events.length - 10);
  $("evMore").hidden = extra === 0; $("evMoreN").textContent = extra + " daha";
}

async function refresh() {
  try {
    const [s, events] = await Promise.all([api<State>("/api/state"), api<EventView[]>("/api/events?limit=30")]);
    $("connNote").hidden = true;
    // a new kill shows up as a toast too, like a notification would
    const fresh = seenEventId === null ? [] : events.filter(e => e.id > seenEventId! && e.kind === "trip");
    for (const e of fresh.reverse()) {
      const k = s.keys.find(x => x.id === e.keyId);
      toast(e.title, k?.canRestore ? { action: "Aç", onAction: () => void restore(k.id), time: 5000 } : { time: 4000 });
    }
    seenEventId = Math.max(seenEventId ?? 0, ...events.map(e => e.id));
    render(s);
    renderLog(events, s.eventCount);
  } catch (e) {
    $("connText").textContent = "Sunucuya ulaşılamıyor: " + (e as Error).message;
    $("connNote").hidden = false;
  }
}

async function act(fn: () => Promise<unknown>, ok?: string) {
  try { await fn(); if (ok) toast(ok, { time: 2500 }); } catch (e) { toast((e as Error).message, { time: 5000 }); }
  await refresh();
}

const restore = (id: string) => act(() => api(`/api/keys/${encodeURIComponent(id)}/restore`, { method: "POST" }));

// ---- the key sheet ----

function openKey(id: string) {
  const k = state?.keys.find(x => x.id === id);
  if (!k) return;
  openId = id;
  $<HTMLInputElement>("shWin").value = String(k.windowLimit);
  $<HTMLInputElement>("shDay").value = String(k.dailyLimit);
  $("shMode").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === k.mode)));
  renderSheet();
  const d = $<HTMLDialogElement>("keySheet");
  if (!d.open) d.showModal();
}

$("keys").addEventListener("click", e => { const r = (e.target as Element).closest<HTMLElement>("[data-key]"); if (r) openKey(r.dataset.key!); });
$("keys").addEventListener("keydown", e => {
  const r = (e.target as Element).closest<HTMLElement>("[data-key]");
  if (r && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openKey(r.dataset.key!); }
});
$("keySheet").addEventListener("close", () => { openId = null; });

function saveLimit(input: HTMLInputElement, field: "windowLimit" | "dailyLimit") {
  const v = Number(input.value);
  if (!openId || input.value === "" || !Number.isFinite(v) || v < 0) { input.setAttribute("aria-invalid", "true"); return; }
  input.removeAttribute("aria-invalid");
  const id = openId;
  void act(() => api(`/api/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ [field]: v }) }), "Eşik kaydedildi");
}
$("shWin").addEventListener("change", e => saveLimit(e.target as HTMLInputElement, "windowLimit"));
$("shDay").addEventListener("change", e => saveLimit(e.target as HTMLInputElement, "dailyLimit"));

$("shMode").addEventListener("click", e => {
  const b = (e.target as Element).closest<HTMLButtonElement>("button");
  if (!b || !openId) return;
  const k = state?.keys.find(x => x.id === openId);
  if (b.dataset.v === "kill" && k?.provider === "openai" && !confirm("OpenAI anahtarları kapatılırken SİLİNİR ve geri getirilemez. Bu anahtar için açılsın mı?")) return;
  $("shMode").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  const id = openId;
  void act(() => api(`/api/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ mode: b.dataset.v }) }));
});

$("shRestore").addEventListener("click", () => { if (openId) void restore(openId); });
$("shKill").addEventListener("click", () => {
  const k = state?.keys.find(x => x.id === openId);
  if (!k) return;
  const warn = k.provider === "openai" ? "\n\nOpenAI anahtarı SİLİNECEK, geri getirilemez." : "";
  if (!confirm(`${k.name} şimdi kapatılsın mı?${warn}`)) return;
  void act(() => api(`/api/keys/${encodeURIComponent(k.id)}/disable`, { method: "POST" }), `${k.name} kapatıldı`);
});

$("keySheet").addEventListener("click", e => { if (e.target === e.currentTarget) $<HTMLDialogElement>("keySheet").close(); }); // a click on the backdrop
$("evMore").addEventListener("click", () => {
  const open = $("evBox").classList.toggle("is-open");
  $("evMore").setAttribute("aria-expanded", String(open));
});

// ---- demo controls ----

document.querySelectorAll<HTMLButtonElement>("[data-scenario]").forEach(b =>
  b.addEventListener("click", () => void act(() => api("/api/demo/scenario", { method: "POST", body: JSON.stringify({ name: b.dataset.scenario }) }))));
$("speed").addEventListener("click", e => {
  const b = (e.target as Element).closest<HTMLButtonElement>("button");
  if (!b) return;
  $("speed").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  void act(() => api("/api/demo/speed", { method: "POST", body: JSON.stringify({ speed: Number(b.dataset.v) }) }));
});

void refresh();
setInterval(() => void refresh(), 2000);

export {};
