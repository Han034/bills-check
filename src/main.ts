import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManualClock, MINUTE, startOfDay, systemClock, type Clock } from "./clock.js";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { buildServer, type DemoControls } from "./http.js";
import { fanOut, notifiersFrom } from "./notify.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { DemoProvider } from "./providers/demo.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OpenAIProvider } from "./providers/openai.js";
import { loadPrices } from "./pricing.js";
import type { Provider } from "./types.js";
import { Watcher } from "./watcher.js";

const cfg = loadConfig();
const store = new Store(cfg.demo ? ":memory:" : path.join(cfg.dataDir, "bills-check.db"));
const prices = loadPrices(cfg.pricesFile);

/** The demo's day starts at 02:00 today, like the prototype. */
const demoStart = () => startOfDay(Date.now()) + 2 * 60 * MINUTE;
const demoClock = cfg.demo ? new ManualClock(demoStart()) : null;
const clock: Clock = demoClock ?? systemClock;

const demoProvider = demoClock ? new DemoProvider(demoClock) : null;
const providers: Provider[] = demoProvider ? [demoProvider] : [
  ...(cfg.openai ? [new OpenAIProvider(cfg.openai.adminKey, prices)] : []),
  ...(cfg.anthropic ? [new AnthropicProvider(cfg.anthropic.adminKey, prices)] : []),
  ...(cfg.gemini ? [new GeminiProvider(cfg.gemini.projectId, cfg.gemini.costPerRequest)] : [])
];

const channels = notifiersFrom(cfg);
let app: Awaited<ReturnType<typeof buildServer>> | null = null;
const notifier = fanOut(channels, e => app?.log.error({ err: e }, "notification failed"));
const watcher = new Watcher(cfg, store, clock, notifier, providers);

let timer: NodeJS.Timeout | undefined;
let demoSpeed = 1;

function schedule() {
  clearInterval(timer);
  if (demoClock) {
    timer = setInterval(() => { demoClock.advance(MINUTE); void watcher.tick(); }, cfg.demoMinuteMs / demoSpeed);
  } else {
    timer = setInterval(() => void watcher.tick(), cfg.pollIntervalSec * 1000);
  }
}

function logStart() {
  const names = providers.map(p => p.label).join(", ");
  const how = [cfg.dryRun ? "dry run: no key is ever disabled" : null, channels.length ? `${channels.length} notification channel(s)` : "no notification channel"]
    .filter(Boolean).join(" · ");
  store.log(clock.now(), "start", "Watcher started", `${names} · ${how}`);
}

const demo: DemoControls | null = demoProvider && demoClock ? {
  async scenario(name) {
    const s = demoProvider.startScenario(name);
    // the leak is only interesting if the key is allowed to be closed (the prototype did the same)
    if (name === "leak") watcher.updateSettings("demo:script", { mode: "kill" });
    // a key the scenario hits is turned back on first, so there is something to watch
    const key = store.key("demo:" + s.externalId);
    if (key?.status === "off") await watcher.restore(key.id);
    store.log(clock.now(), "scenario", s.title, s.meta, "demo:" + s.externalId);
  },
  async reset() {
    store.reset(); demoProvider.reset(); watcher.forget(); demoClock.set(demoStart());
    logStart();
    await watcher.tick();
  },
  setSpeed(x) { demoSpeed = x; schedule(); }
} : null;

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
app = await buildServer(cfg, store, watcher, demo, webDir);

logStart();
await watcher.tick();
schedule();
await app.listen({ host: cfg.host, port: cfg.port });
if (cfg.demo) app.log.info("DEMO mode: fake keys, no accounts are touched");
if (cfg.dryRun) app.log.warn("DRY_RUN: limits only alert, no key is disabled");
if (!channels.length) app.log.warn("No notification channel: set TELEGRAM_*, SLACK_WEBHOOK_URL or DISCORD_WEBHOOK_URL");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await app?.close();
    store.close();
    process.exit(0);
  });
}
