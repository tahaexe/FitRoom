/**
 * Cloudflare Worker entry: the same Hono app as Node (`server/src/index.ts`)
 * served from one Worker on the free plan.
 *
 * - `/api/*` runs the gateway pipeline against the D1 store; every other
 *   path serves the built client through the `ASSETS` binding (with the
 *   single-page-application fallback configured in `wrangler.jsonc`).
 * - Gateway state (cache rows, cost lines, session and per-IP counters)
 *   lives in the `fitroom` D1 database; the demo store and mock fixtures
 *   are bundled at build time (no file reads at run time).
 * - The Meta key comes only from the `META_API_KEY` secret: never in
 *   `wrangler.jsonc`, the bundle, a log or a commit.
 * - Client IP is `CF-Connecting-IP` (set by Cloudflare); `X-Forwarded-For`
 *   is never trusted here.
 */

import { isHealthResponse, type HealthResponse } from "@fitroom/shared";
import { Hono } from "hono";
import type { GatewayConfig } from "./config.js";
import {
  BUNDLED_CATALOG,
  BUNDLED_DEMO,
  BUNDLED_MOCK,
  BUNDLED_VERSION,
} from "./meta/bundled-data.js";
import type { PipelineDeps } from "./meta/pipeline.js";
import { createD1Store, type D1DatabaseLike, type MockAnswer } from "./meta/store.js";
import { assistantRoutes, setAssistantCatalog } from "./routes/assistant.js";
import { recommendRoutes } from "./routes/recommend.js";
import { renderRoutes } from "./routes/render.js";

export interface WorkerEnv {
  DB: D1DatabaseLike;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  META_API_KEY?: string;
  META_MOCK?: string;
  META_SESSION_MAX_CALLS?: string;
  META_SESSION_MAX_USD?: string;
  META_BUDGET_USD?: string;
  META_RATE_PER_MIN?: string;
}

function numVar(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function workerClientIp(request: Request): string {
  // Cloudflare sets CF-Connecting-IP; X-Forwarded-For is never trusted here.
  const ip = request.headers.get("cf-connecting-ip");
  if (ip !== null && ip.trim() !== "") return ip.trim();
  return "direct";
}

setAssistantCatalog(BUNDLED_CATALOG);

function gatewayDeps(env: WorkerEnv): PipelineDeps {
  const config: GatewayConfig = {
    apiKey: env.META_API_KEY ?? "",
    mock: env.META_MOCK === "1",
    record: false,
    sessionMaxCalls: numVar(env.META_SESSION_MAX_CALLS, 20),
    sessionMaxUsd: numVar(env.META_SESSION_MAX_USD, 0.5),
    globalBudgetUsd: numVar(env.META_BUDGET_USD, 5),
    ratePerMinutePerIp: numVar(env.META_RATE_PER_MIN, 30),
    dataDir: "",
    logsDir: "",
  };
  return {
    config,
    store: createD1Store(env.DB, {
      demo: new Map(BUNDLED_DEMO),
      mock: new Map(Object.entries(BUNDLED_MOCK) as Array<[string, MockAnswer]>),
    }),
    clientIp: (c) => workerClientIp(c.req.raw),
  };
}

function healthJson(version: string): Response {
  const payload: HealthResponse = { ok: true, version };
  if (!isHealthResponse(payload)) {
    return Response.json({ ok: false, version: "unknown" }, { status: 500 });
  }
  return Response.json(payload);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    const deps = gatewayDeps(env);
    const app = new Hono();
    app.get("/api/health", () => healthJson(BUNDLED_VERSION));
    app.route("/api", recommendRoutes(deps));
    app.route("/api", assistantRoutes(deps));
    app.route("/api", renderRoutes(deps));
    return app.fetch(request, env);
  },
};
