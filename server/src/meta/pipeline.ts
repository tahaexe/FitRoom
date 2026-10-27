/**
 * One pipeline for every gateway call:
 * demo store, cache, caps, upstream, cache write, metering.
 *
 * - Demo mode (the default) answers only from the committed store; a miss
 *   returns HTTP 200 `{ status: "demo-miss", ... }`. In live mode a
 *   demo-store hit is used too (free).
 * - A cache hit makes no upstream call.
 * - Session caps count generations (upstream, or the mock fixture standing
 *   in for it); the global budget sums only `upstream` lines.
 *
 * All gateway state goes through the `GatewayStore`: files on Node, D1 in
 * the Worker. This module itself has no Node imports.
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
import { newSessionId } from "./caps.js";
import type { UpstreamResult } from "./client.js";
import { UpstreamFriendlyError } from "./errors.js";

export { UpstreamFriendlyError };
import { gatewayKey } from "./keys.js";
import { costUsd, emptyUsage } from "./pricing.js";
import type { GatewayStore } from "./store.js";

export const SESSION_COOKIE = "fitroom_sid";

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
   * Fractional cost of one generation toward the session call cap and the
   * per-IP rate limit (default 1). A SAM request weighs 0.2: a photo's five
   * concepts make one call. USD always counts in full.
   */
  callWeight?: number;
  /**
   * Whether an upstream answer may be cached (default true). A SAM text
   * over 512 KB is returned but not cached.
   */
  cacheable?: (data: unknown) => boolean;
  /**
   * Validate the raw JSON body: an error string, or the route's typed input
   * (without the `live` flag, so demo/live share one key).
   */
  parseBody(body: unknown): ParsedBody | { error: string };
  /**
   * Route-specific key input (never image bytes). May be async: the room
   * routes hash image strings with Web Crypto.
   */
  keyInput(input: unknown): unknown | Promise<unknown>;
  /** Real upstream call (never used in mock mode). */
  upstream(apiKey: string, input: unknown): Promise<UpstreamResult>;
}

export interface PipelineDeps {
  config: GatewayConfig;
  store: GatewayStore;
  /**
   * Client IP for the per-IP rate limit. Defaults to `x-forwarded-for`
   * (Node, local use); the Worker passes `CF-Connecting-IP` and never
   * trusts `X-Forwarded-For`.
   */
  clientIp?: (c: Context) => string;
  /**
   * Development-only recording of upstream answers (Node `META_RECORD=1`).
   * The Worker never records.
   */
  recordUpstream?: (
    route: string,
    model: string,
    key: string,
    keyInput: unknown,
    data: unknown,
  ) => void;
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

function nodeClientIp(c: Context): string {
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
  const { config, store } = deps;
  const clientIp = deps.clientIp ?? nodeClientIp;
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
  const live = isLiveRequest(c, body);
  const parsed = def.parseBody(body);
  if ("error" in parsed) {
    return c.json({ status: "error", message: parsed.error } satisfies GatewayResponse, 400);
  }
  const keyInput = await def.keyInput(parsed.input);
  const key = gatewayKey(def.route, def.model, keyInput);

  // 1. Demo store (free in both modes).
  const demo = await store.readDemo(def.route, def.model, key);
  if (demo !== null) {
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 };
    await store.appendCost({
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
  const cached = await store.readCache(def.route, def.model, key);
  if (cached !== null) {
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 };
    await store.appendCost({
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

  // 5. Rate limit plus caps before any generation. Demo-store and cache
  // hits are free and never count: only a live request that missed both may
  // go upstream, so replaying the demo chips never sees the capped message.
  const weight = def.callWeight ?? 1;
  if (!(await store.checkRateLimit(clientIp(c), config.ratePerMinutePerIp, Date.now(), weight))) {
    return c.json(capped(), 429);
  }
  const isMock = config.mock;
  const cap = await store.checkGenerationCap(
    sessionId,
    isMock,
    config.sessionMaxCalls,
    config.sessionMaxUsd,
    config.globalBudgetUsd,
    weight,
  );
  if (!cap.ok) {
    return c.json(capped(), 429);
  }

  // 6. Generation: fixture in mock mode, Meta upstream otherwise.
  let result: UpstreamResult;
  if (isMock) {
    const fixture = await store.readMock(def.route);
    if (fixture === null) {
      return c.json(
        { status: "error", message: "The mock fixture is missing." } satisfies GatewayResponse,
        500,
      );
    }
    result = { data: fixture.data, usage: fixture.usage };
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
        // The model answered but unusably (no image, invalid JSON after
        // the retry): Meta still billed the call, so its `upstream` line
        // — with the usage Meta reported — is still written.
        const usage = error.usage ?? emptyUsage();
        const failedUsd = costUsd(def.model, usage);
        await store.noteGeneration(sessionId, failedUsd, true, weight);
        await store.appendCost({
          time: new Date().toISOString(),
          session: sessionId,
          route: def.route,
          model: def.model,
          source: "upstream",
          usage,
          usd: failedUsd,
        });
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
  // A route may refuse the cache for some answers (a SAM text over 512 KB
  // is returned but not cached); the metering line below still records the
  // generation, so the missing cache row shows in the costs.
  if (def.cacheable === undefined || def.cacheable(result.data)) {
    await store.writeCache(def.route, def.model, key, keyInput, result.data);
  }
  if (config.record && source === "upstream" && deps.recordUpstream !== undefined) {
    deps.recordUpstream(def.route, def.model, key, keyInput, result.data);
  }

  // 8. Metering.
  await store.noteGeneration(sessionId, usd, source === "upstream", weight);
  await store.appendCost({
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
