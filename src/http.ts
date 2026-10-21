import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import { HttpError, type Watcher } from "./watcher.js";

export interface DemoControls {
  scenario(name: "leak" | "loop"): Promise<void>;
  reset(): Promise<void>;
  setSpeed(x: number): void;
}

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Basic auth: any user name, the password is DASHBOARD_PASSWORD. */
function authorized(header: string | undefined, password: string) {
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  return sameSecret(decoded.slice(decoded.indexOf(":") + 1), password);
}

const settingsSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    mode: { type: "string", enum: ["kill", "warn"] },
    windowLimit: { type: "number", minimum: 0, maximum: 1_000_000 },
    dailyLimit: { type: "number", minimum: 0, maximum: 1_000_000 }
  }
} as const;

export async function buildServer(cfg: Config, store: Store, watcher: Watcher, demo: DemoControls | null, webDir: string | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  app.get("/healthz", async () => ({ ok: true }));

  if (cfg.dashboardPassword) {
    const pw = cfg.dashboardPassword;
    app.addHook("onRequest", async (req, reply) => {
      if (req.url === "/healthz") return;
      if (!authorized(req.headers.authorization, pw))
        return reply.code(401).header("www-authenticate", 'Basic realm="Bills Check", charset="UTF-8"').send({ error: "sign-in required" });
    });
  }

  app.setErrorHandler((err: Error & { validation?: unknown }, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.validation) return reply.code(400).send({ error: err.message });
    app.log.error(err);
    // anything else came from a provider call (restore, disable): the panel shows the message
    return reply.code(502).send({ error: err.message });
  });

  app.get("/api/state", async () => watcher.snapshot());

  app.get<{ Querystring: { limit?: number } }>("/api/events", {
    schema: { querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500 } } } }
  }, async req => store.events(req.query.limit ?? 50));

  app.patch<{ Params: { id: string }; Body: { mode?: "kill" | "warn"; windowLimit?: number; dailyLimit?: number } }>(
    "/api/keys/:id", { schema: { body: settingsSchema } },
    async req => { watcher.updateSettings(req.params.id, req.body); return { ok: true }; }
  );

  app.post<{ Params: { id: string } }>("/api/keys/:id/restore", async req => { await watcher.restore(req.params.id); return { ok: true }; });
  app.post<{ Params: { id: string } }>("/api/keys/:id/disable", async req => { await watcher.disableNow(req.params.id); return { ok: true }; });

  if (demo) {
    app.post<{ Body: { name: "leak" | "loop" | "reset" } }>("/api/demo/scenario", {
      schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string", enum: ["leak", "loop", "reset"] } } } }
    }, async req => {
      if (req.body.name === "reset") await demo.reset(); else await demo.scenario(req.body.name);
      return { ok: true };
    });
    app.post<{ Body: { speed: number } }>("/api/demo/speed", {
      schema: { body: { type: "object", required: ["speed"], properties: { speed: { type: "number", enum: [1, 3] } } } }
    }, async req => { demo.setSpeed(req.body.speed); return { ok: true }; });
  }

  if (webDir && fs.existsSync(path.join(webDir, "index.html"))) {
    await app.register(fastifyStatic, { root: webDir });
  } else {
    app.get("/", async (_req, reply) => reply.type("text/plain; charset=utf-8").send("Dashboard not built: run `npm run build`, or `npm run dev:web` for development (http://localhost:5173)."));
  }

  return app;
}
