/**
 * One pipeline for every gateway call:
 * demo store, cache, caps, upstream, cache write, metering.
 *
 * - Demo mode (the default) answers only from the committed store; a miss
 *   returns HTTP 200 `{ status: "demo-miss", ... }`. In live mode a
 *   demo-store hit is used too (free).
 * - A cache hit makes no upstream call.
 * - Session caps count generations (upstream, or the mock fixture standing
 *   in for it); the global budget sums only `upstream` lines in costs.csv.
 */

import {
  GATEWAY_CAPPED_MESSAGE,
  GATEWAY_DEMO_MISS_MESSAGE,
  type GatewayResponse,
  type GatewayRoute,
} from "@fitroom/shared";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { GatewayConfig } from "../config.js";
import { readCache, writeCache } from "./cache.js";
import {
  SESSION_COOKIE,
  checkGenerationCap,
  checkRateLimit,
  noteGeneration,
  newSessionId,
} from "./caps.js";
import { readMockFixture, type UpstreamResult } from "./client.js";
import { readDemoStore, writeRecorded } from "./demo.js";
import { gatewayKey } from "./keys.js";
import { appendCostLine } from "./metering.js";
import { costUsd } from "./pricing.js";
import type { CapsState } from "./caps.js";

/**
 * Thrown by a route's upstream call when the model answer is unusable after
 * its retry: the pipeline answers HTTP 200 `{ status: "error", ... }` with
 * this friendly message instead of the generic "unavailable" 502.
 */
export class UpstreamFriendlyError extends Error {
  override name = "UpstreamFriendlyError";
}

export interface ParsedBody {
  /** The route's typed input (the live flag already stripped). */
  input: unknown;
}

export interface RouteDef {
  route: GatewayRoute;
  model: string;
  /** False until the route gets its real prompt: live answers 501. */
  liveReady: boolean;
  /**
   * Validate the raw JSON body: an error string, or the route's typed input
   * (without the `live` flag, so demo/live share one key).
   */
  parseBody(body: unknown): ParsedBody | { error: string };
  /** Route-specific key input (never image bytes). */
  keyInput(input: unknown): unknown;
  /** Real upstream call (never used in mock mode). */
  upstream(apiKey: string, input: unknown): Promise<UpstreamResult>;
}

export interface PipelineDeps {
  config: GatewayConfig;
  caps: CapsState;
}

function isLiveRequest(c: Context, body: unknown): boolean {
  const header = c.req.header("x-fitroom-live");
  if (header === "1" || header?.toLowerCase() === "true") return true;
  const query = new URL(c.req.url).searchParams.get("live");
  if (query === "1" || query?.toLowerCase() === "true") return true;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    if ((body as Record<string, unknown>)["live"] === true) return true;
  }
  return false;
}

function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined && forwarded.trim() !== "") {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  return "direct";
}

function ensureSession(c: Context): string {
  const existing = getCookie(c, SESSION_COOKIE);
  if (typeof existing === "string" && /^[0-9a-f]{32}$/.test(existing)) return existing;
  const fresh = newSessionId();
  setCookie(c, SESSION_COOKIE, fresh, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  });
  return fresh;
}

function capped(): GatewayResponse {
  return { status: "capped", message: GATEWAY_CAPPED_MESSAGE };
}

export function parsePrompt(
  body: unknown,
  maxChars: number,
): { prompt: string } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Expected a JSON object with a prompt string." };
  }
  const prompt = (body as Record<string, unknown>)["prompt"];
  if (typeof prompt !== "string" || prompt.length === 0) {
    return { error: "Expected a JSON object with a prompt string." };
  }
  if (prompt.length > maxChars) {
    return { error: `The prompt must be at most ${String(maxChars)} characters.` };
  }
  return { prompt };
}

export async function serveGatewayRequest(
  c: Context,
  deps: PipelineDeps,
  def: RouteDef,
): Promise<Response> {
  const { config, caps } = deps;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { status: "error", message: "Expected a JSON body." } satisfies GatewayResponse,
      400,
    );
  }

  const sessionId = ensureSession(c);
  if (!checkRateLimit(caps, config, clientIp(c), Date.now())) {
    return c.json(capped(), 429);
  }

  const live = isLiveRequest(c, body);
  const parsed = def.parseBody(body);
  if ("error" in parsed) {
    return c.json({ status: "error", message: parsed.error } satisfies GatewayResponse, 400);
  }
  const keyInput = def.keyInput(parsed.input);
  const key = gatewayKey(def.route, def.model, keyInput);

  // 1. Demo store (free in both modes).
  const demo = readDemoStore(config.dataDir, def.route, def.model, key);
  if (demo !== null) {
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 };
    appendCostLine(config.logsDir, {
      time: new Date().toISOString(),
      session: sessionId,
      route: def.route,
      model: def.model,
      source: "demo",
      usage,
      usd: 0,
    });
    return c.json(
      {
        status: "ok",
        source: "demo",
        route: def.route,
        model: def.model,
        data: demo.response,
      } satisfies GatewayResponse,
      200,
    );
  }

  // 2. Demo mode never goes further.
  if (!live) {
    return c.json(
      { status: "demo-miss", message: GATEWAY_DEMO_MISS_MESSAGE } satisfies GatewayResponse,
      200,
    );
  }

  // 3. Routes without their real prompt yet: live answers 501.
  if (!def.liveReady && !config.mock) {
    return c.json({ status: "not-ready" } satisfies GatewayResponse, 501);
  }

  // 4. Cache: a hit makes no upstream call.
  const cached = readCache(config.dataDir, def.route, def.model, key);
  if (cached !== null) {
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 };
    appendCostLine(config.logsDir, {
      time: new Date().toISOString(),
      session: sessionId,
      route: def.route,
      model: def.model,
      source: "cache",
      usage,
      usd: 0,
    });
    return c.json(
      {
        status: "ok",
        source: "cache",
        route: def.route,
        model: def.model,
        data: cached.data,
      } satisfies GatewayResponse,
      200,
    );
  }

  // 5. Caps before any generation.
  const isMock = config.mock;
  if (!checkGenerationCap(caps, config, sessionId, isMock).ok) {
    return c.json(capped(), 429);
  }

  // 6. Generation: fixture in mock mode, Meta upstream otherwise.
  let result: UpstreamResult;
  if (isMock) {
    try {
      const fixture = readMockFixture(config.dataDir, def.route);
      result = { data: fixture.data, usage: fixture.usage };
    } catch {
      return c.json(
        { status: "error", message: "The mock fixture is missing." } satisfies GatewayResponse,
        500,
      );
    }
  } else {
    if (config.apiKey === "") {
      return c.json(
        { status: "error", message: "The live AI needs a key." } satisfies GatewayResponse,
        500,
      );
    }
    try {
      result = await def.upstream(config.apiKey, parsed.input);
    } catch (error) {
      if (error instanceof UpstreamFriendlyError) {
        return c.json({ status: "error", message: error.message } satisfies GatewayResponse, 200);
      }
      return c.json(
        { status: "error", message: "The live AI is unavailable." } satisfies GatewayResponse,
        502,
      );
    }
  }
  const source = isMock ? "mock" : "upstream";
  const usd = costUsd(def.model, result.usage);

  // 7. Cache write, then (development only) the recorded copy of upstream.
  writeCache(config.dataDir, def.route, def.model, key, keyInput, result.data);
  if (config.record && source === "upstream") {
    writeRecorded(config.dataDir, def.route, def.model, key, keyInput, result.data);
  }

  // 8. Metering.
  noteGeneration(caps, sessionId, usd, source === "upstream");
  appendCostLine(config.logsDir, {
    time: new Date().toISOString(),
    session: sessionId,
    route: def.route,
    model: def.model,
    source,
    usage: result.usage,
    usd,
  });

  return c.json(
    {
      status: "ok",
      source,
      route: def.route,
      model: def.model,
      data: result.data,
    } satisfies GatewayResponse,
    200,
  );
}
