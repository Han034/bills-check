import path from "node:path";
import type { TripMode } from "./types.js";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dashboardPassword: string | null;
  pollIntervalSec: number;
  windowMin: number;
  defaults: { mode: TripMode; windowLimit: number; dailyLimit: number };
  /** How long a runaway key would have run unnoticed without the watcher (the provider's own budget alert lag). Feeds the "saved" estimate. */
  alertDelayMin: number;
  dryRun: boolean;
  demo: boolean;
  /** Real milliseconds per simulated minute in demo mode. */
  demoMinuteMs: number;
  pricesFile: string | null;
  openai: { adminKey: string } | null;
  anthropic: { adminKey: string } | null;
  gemini: { projectId: string; costPerRequest: number } | null;
  telegram: { botToken: string; chatId: string } | null;
  slackWebhook: string | null;
  discordWebhook: string | null;
}

type Env = Record<string, string | undefined>;

const str = (env: Env, k: string) => env[k]?.trim() || null;

function num(env: Env, k: string, def: number, min = 0): number {
  const raw = str(env, k);
  if (raw === null) return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) throw new Error(`${k} geçerli bir sayı olmalı (>= ${min}), gelen: ${raw}`);
  return v;
}

function bool(env: Env, k: string): boolean {
  return /^(1|true|yes|evet)$/i.test(str(env, k) ?? "");
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function loadConfig(env: Env = process.env): Config {
  const mode = str(env, "DEFAULT_MODE") ?? "warn";
  if (mode !== "warn" && mode !== "kill") throw new Error(`DEFAULT_MODE "warn" ya da "kill" olmalı, gelen: ${mode}`);

  const telegramToken = str(env, "TELEGRAM_BOT_TOKEN"), telegramChat = str(env, "TELEGRAM_CHAT_ID");
  if (!!telegramToken !== !!telegramChat) throw new Error("Telegram için TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID birlikte verilmeli");

  const geminiProject = str(env, "GEMINI_PROJECT_ID");

  const cfg: Config = {
    host: str(env, "HOST") ?? "127.0.0.1",
    port: num(env, "PORT", 8787, 1),
    dataDir: path.resolve(str(env, "DATA_DIR") ?? "data"),
    dashboardPassword: str(env, "DASHBOARD_PASSWORD"),
    pollIntervalSec: num(env, "POLL_INTERVAL_SEC", 60, 15),
    windowMin: num(env, "WINDOW_MIN", 15, 1),
    defaults: {
      mode,
      windowLimit: num(env, "DEFAULT_WINDOW_USD", 5),
      dailyLimit: num(env, "DEFAULT_DAILY_USD", 50)
    },
    alertDelayMin: num(env, "ALERT_DELAY_MIN", 360),
    dryRun: bool(env, "DRY_RUN"),
    demo: bool(env, "DEMO"),
    demoMinuteMs: num(env, "DEMO_MINUTE_MS", 1000, 100),
    pricesFile: str(env, "PRICES_FILE"),
    openai: str(env, "OPENAI_ADMIN_KEY") ? { adminKey: str(env, "OPENAI_ADMIN_KEY")! } : null,
    anthropic: str(env, "ANTHROPIC_ADMIN_KEY") ? { adminKey: str(env, "ANTHROPIC_ADMIN_KEY")! } : null,
    gemini: geminiProject ? { projectId: geminiProject, costPerRequest: num(env, "GEMINI_COST_PER_REQUEST", 0.002) } : null,
    telegram: telegramToken && telegramChat ? { botToken: telegramToken, chatId: telegramChat } : null,
    slackWebhook: str(env, "SLACK_WEBHOOK_URL"),
    discordWebhook: str(env, "DISCORD_WEBHOOK_URL")
  };

  if (!LOOPBACK.has(cfg.host) && !cfg.dashboardPassword)
    throw new Error(`HOST=${cfg.host} dışarıya açık; panelde yönetici anahtarlarıyla iş yapılabildiği için DASHBOARD_PASSWORD zorunlu`);
  if (!cfg.demo && !cfg.openai && !cfg.anthropic && !cfg.gemini)
    throw new Error("İzlenecek sağlayıcı yok: OPENAI_ADMIN_KEY, ANTHROPIC_ADMIN_KEY ya da GEMINI_PROJECT_ID ver (ya da denemek için DEMO=1)");
  return cfg;
}
