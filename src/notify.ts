import type { Config } from "./config.js";

export type Severity = "info" | "warn" | "critical";

export interface Notice {
  severity: Severity;
  title: string;
  body: string;
}

export interface Notifier {
  send(n: Notice): Promise<void>;
}

type Fetch = typeof fetch;

const ICON: Record<Severity, string> = { info: "🛡️", warn: "⚠️", critical: "🔒" };

async function post(f: Fetch, url: string, body: unknown, what: string) {
  const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${what} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export function telegram(botToken: string, chatId: string, f: Fetch = fetch): Notifier {
  return {
    send: n => post(f, `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text: `${ICON[n.severity]} ${n.title}\n${n.body}`, disable_web_page_preview: true }, "Telegram")
  };
}

export function slack(webhook: string, f: Fetch = fetch): Notifier {
  return { send: n => post(f, webhook, { text: `${ICON[n.severity]} *${n.title}*\n${n.body}` }, "Slack") };
}

export function discord(webhook: string, f: Fetch = fetch): Notifier {
  return { send: n => post(f, webhook, { content: `${ICON[n.severity]} **${n.title}**\n${n.body}`, allowed_mentions: { parse: [] } }, "Discord") };
}

/** Sends to every configured channel; one failing channel does not stop the others. Failures go to onError. */
export function fanOut(channels: Notifier[], onError: (e: unknown) => void): Notifier {
  return {
    async send(n) {
      const results = await Promise.allSettled(channels.map(c => c.send(n)));
      for (const r of results) if (r.status === "rejected") onError(r.reason);
    }
  };
}

export function notifiersFrom(cfg: Config): Notifier[] {
  const out: Notifier[] = [];
  if (cfg.telegram) out.push(telegram(cfg.telegram.botToken, cfg.telegram.chatId));
  if (cfg.slackWebhook) out.push(slack(cfg.slackWebhook));
  if (cfg.discordWebhook) out.push(discord(cfg.discordWebhook));
  return out;
}
