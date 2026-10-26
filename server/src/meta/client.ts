/**
 * Meta Model API client plus mock fixtures.
 *
 * Facts checked with real calls on 2026-10-26:
 * - base `https://api.meta.ai/v1`, header `Authorization: Bearer <key>`;
 * - Muse Spark (`muse-spark-1.3`): `POST /chat/completions` in OpenAI shape
 *   (`messages`, `image_url` parts, `response_format: {type: "json_schema",
 *   ...}`, `tools` with the function nested under `function`); it reasons
 *   at length, so `max_tokens` >= 8000 (reasoning is billed as output);
 *   usage in `usage.prompt_tokens`, `usage.completion_tokens`,
 *   `usage.prompt_tokens_details.cached_tokens` when present;
 * - Muse Image (`muse-image-1.0`): `POST /responses` with a plain string
 *   `input` (text only) or `input: [{role, content: [{type: input_text},
 *   {type: input_image, image_url: "data:image/jpeg;base64,..."}]}]`; the
 *   image is base64 WebP in `output[].image_generation_call.result`
 *   (about 2048 x 1152 for landscape); never send `size` or a `tools`
 *   array (rejected);
 * - SAM 3.1 (`sam-3.1`): `POST /responses` with `stream: true`.
 *
 * The key travels only in the Authorization header. It is never logged,
 * returned or written anywhere. In mock mode (`META_MOCK=1`) answers come
 * from `server/data/mock/` fixtures with realistic `usage` blocks instead
 * of calling upstream. No live Meta calls happen in mock mode.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { META_BASE_URL, META_MODELS } from "../config.js";
import { emptyUsage, usageFromUpstream, type TokenUsage } from "./pricing.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface UpstreamResult {
  /** The route's response payload (stored in cache/demo/recorded files). */
  data: unknown;
  usage: TokenUsage;
}

export interface SparkCallOptions {
  messages: ChatMessage[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  tools?: unknown[];
  maxTokens?: number;
}

export interface ImageCallOptions {
  /** Text prompt (text-only render). */
  prompt: string;
  /** Optional reference JPEG bytes for an edit with a reference image. */
  referenceJpeg?: Uint8Array;
}

/** Muse Spark reasons at length: always allow room for the reasoning. */
export const SPARK_MIN_MAX_TOKENS = 8000;

function authHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

async function postJson(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${META_BASE_URL}${path}`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Meta API ${path} answered HTTP ${tostr(res.status)}`);
  }
  return (await res.json()) as unknown;
}

function tostr(value: number): string {
  return String(value);
}

/** Muse Spark chat completion, parsed to the first message's text. */
export async function callSpark(
  apiKey: string,
  options: SparkCallOptions,
): Promise<UpstreamResult> {
  const body: Record<string, unknown> = {
    model: META_MODELS.spark,
    messages: options.messages,
    max_tokens: Math.max(options.maxTokens ?? 0, SPARK_MIN_MAX_TOKENS),
  };
  if (options.jsonSchema !== undefined) {
    body["response_format"] = {
      type: "json_schema",
      json_schema: { name: options.jsonSchema.name, schema: options.jsonSchema.schema },
    };
  }
  if (options.tools !== undefined) {
    body["tools"] = options.tools;
  }
  const raw = await postJson(apiKey, "/chat/completions", body);
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const choices = Array.isArray(record["choices"]) ? record["choices"] : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first["message"] ?? {}) as Record<string, unknown>;
  const text = typeof message["content"] === "string" ? message["content"] : "";
  return { data: { text }, usage: usageFromUpstream(record["usage"], 0) };
}

function dataUrlJpeg(bytes: Uint8Array): string {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Muse Image generation: text only, or an edit with a reference image. */
export async function callImage(
  apiKey: string,
  options: ImageCallOptions,
): Promise<UpstreamResult> {
  let input: unknown = options.prompt;
  if (options.referenceJpeg !== undefined) {
    input = [
      {
        role: "user",
        content: [
          { type: "input_text", text: options.prompt },
          { type: "input_image", image_url: dataUrlJpeg(options.referenceJpeg) },
        ],
      },
    ];
  }
  // NOTE: no `size` and no `tools` — the endpoint rejects both.
  const raw = await postJson(apiKey, "/responses", {
    model: META_MODELS.image,
    input,
  });
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const output = Array.isArray(record["output"]) ? record["output"] : [];
  let imageBase64: string | null = null;
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const type = (item as Record<string, unknown>)["type"];
    if (type === "image_generation_call") {
      const result = (item as Record<string, unknown>)["result"];
      if (typeof result === "string") imageBase64 = result;
    }
  }
  return {
    data: { imageBase64, format: "webp", width: 2048, height: 1152 },
    usage: usageFromUpstream(record["usage"], imageBase64 === null ? 0 : 1),
  };
}

// ---- mock fixtures -------------------------------------------------------

export interface MockFixture {
  data: unknown;
  usage: TokenUsage;
}

const fixtureCache = new Map<string, MockFixture>();

function fixtureUsage(raw: unknown): TokenUsage {
  if (typeof raw !== "object" || raw === null) return emptyUsage();
  const record = raw as Record<string, unknown>;
  const pick = (obj: Record<string, unknown>, key: string): number =>
    typeof obj[key] === "number" && Number.isFinite(obj[key]) ? (obj[key] as number) : 0;
  const details = record["prompt_tokens_details"];
  const nestedCached =
    typeof details === "object" && details !== null
      ? pick(details as Record<string, unknown>, "cached_tokens")
      : 0;
  return {
    inputTokens: pick(record, "prompt_tokens"),
    cachedInputTokens: nestedCached > 0 ? nestedCached : pick(record, "cached_tokens"),
    outputTokens: pick(record, "completion_tokens"),
    images: pick(record, "images"),
  };
}

/** Mock answer for a route, from `server/data/mock/<route>.json`. */
export function readMockFixture(dataDir: string, route: string): MockFixture {
  const cached = fixtureCache.get(`${dataDir}\n${route}`);
  if (cached !== undefined) return cached;
  const parsed: unknown = JSON.parse(readFileSync(join(dataDir, "mock", `${route}.json`), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Mock fixture for route ${route} is not an object`);
  }
  const record = parsed as Record<string, unknown>;
  const fixture: MockFixture = {
    data: "data" in record ? record["data"] : parsed,
    usage: fixtureUsage(record["usage"]),
  };
  fixtureCache.set(`${dataDir}\n${route}`, fixture);
  return fixture;
}

/** Test hook: drop cached fixtures (isolated check runs). */
export function clearMockFixtures(): void {
  fixtureCache.clear();
}
