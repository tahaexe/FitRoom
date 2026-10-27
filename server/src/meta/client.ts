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

import { META_BASE_URL, META_MODELS } from "./models.js";
import { UpstreamFriendlyError } from "./errors.js";
import { base64ToBytes, bytesToBase64 } from "./base64.js";
import { usageFromUpstream, type TokenUsage } from "./pricing.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface UpstreamResult {
  /** The route's response payload (stored in cache/demo/recorded files). */
  data: unknown;
  usage: TokenUsage;
  /** The completion's finish reason (`length` when cut by `max_tokens`). */
  finishReason?: string | null;
}

export interface SparkCallOptions {
  messages: ChatMessage[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  tools?: unknown[];
  maxTokens?: number;
  /** Reasoning effort (`low` for the label call: fewer billed output tokens). */
  reasoningEffort?: string;
  /** JPEG data URLs, sent as `image_url` parts on the last user message. */
  images?: string[];
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

/** One tool call Muse Spark requested (OpenAI `tool_calls` shape). */
export interface SparkToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string (parsed by the route). */
  arguments: string;
}

function sparkToolCalls(message: Record<string, unknown>): SparkToolCall[] {
  const raw = message["tool_calls"];
  if (!Array.isArray(raw)) return [];
  const out: SparkToolCall[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const fn = (record["function"] ?? {}) as Record<string, unknown>;
    if (typeof record["id"] !== "string" || typeof fn["name"] !== "string") continue;
    out.push({
      id: record["id"],
      name: fn["name"],
      arguments: typeof fn["arguments"] === "string" ? fn["arguments"] : "{}",
    });
  }
  return out;
}

/** Muse Spark chat completion, parsed to the first message's text and tool calls. */
export async function callSpark(
  apiKey: string,
  options: SparkCallOptions,
): Promise<UpstreamResult> {
  const messages: unknown[] =
    options.images === undefined || options.images.length === 0
      ? options.messages
      : withImageParts(options.messages, options.images);
  const body: Record<string, unknown> = {
    model: META_MODELS.spark,
    messages,
    max_tokens: Math.max(options.maxTokens ?? 0, SPARK_MIN_MAX_TOKENS),
  };
  if (options.reasoningEffort !== undefined) {
    body["reasoning_effort"] = options.reasoningEffort;
  }
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
  const toolCalls = sparkToolCalls(message);
  const data: Record<string, unknown> = { text };
  if (toolCalls.length > 0) data["toolCalls"] = toolCalls;
  const finishReason = typeof first["finish_reason"] === "string" ? first["finish_reason"] : null;
  return { data, usage: usageFromUpstream(record["usage"], 0), finishReason };
}

/**
 * Attach JPEG data URLs as `image_url` parts to the last user message
 * (OpenAI chat shape). Text-only history keeps working: without images the
 * messages pass through untouched.
 */
function withImageParts(messages: ChatMessage[], images: string[]): unknown[] {
  const out: unknown[] = messages.map((message) => ({ ...message }));
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const message = out[i] as Record<string, unknown>;
    if (message["role"] !== "user") continue;
    const text = typeof message["content"] === "string" ? message["content"] : "";
    message["content"] = [
      { type: "text", text },
      ...images.map((image) => ({ type: "image_url", image_url: { url: image } })),
    ];
    break;
  }
  return out;
}

function dataUrlJpeg(bytes: Uint8Array): string {
  return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
}

export const IMAGE_FRIENDLY_ERROR =
  "The visualiser couldn't make an image just now. Please try again.";

/**
 * Read WebP width/height from the decoded bytes (VP8, VP8L or VP8X).
 * Returns null when the bytes are not a recognised WebP image.
 */
export function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const ascii = (at: number, len: number): string => {
    let out = "";
    for (let i = 0; i < len; i += 1) out += String.fromCharCode(bytes[at + i] ?? 0);
    return out;
  };
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
  const u16 = (at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
  const u24 = (at: number): number =>
    (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
  const chunk = ascii(12, 4);
  if (chunk === "VP8 ") {
    // Lossy bitstream: frame tag (3) + start code (3) + 9D012A + w/h (14 bits each).
    if (bytes.length < 30) return null;
    const w = u16(26) & 0x3fff;
    const h = u16(28) & 0x3fff;
    if (w === 0 || h === 0) return null;
    return { width: w, height: h };
  }
  if (chunk === "VP8L") {
    // Lossless: signature 0x2F + 14-bit w-1 + 14-bit h-1 packed in 4 bytes.
    if (bytes.length < 25) return null;
    const b0 = bytes[21] ?? 0;
    const b1 = bytes[22] ?? 0;
    const b2 = bytes[23] ?? 0;
    const b3 = bytes[24] ?? 0;
    if (b0 !== 0x2f) return null;
    const bits = b1 | (b2 << 8) | (b3 << 16) | (0 << 24);
    const w = (bits & 0x3fff) + 1;
    const h = ((bits >> 14) & 0x3fff) + 1;
    void u24;
    if (w <= 0 || h <= 0 || w > 16384 || h > 16384) return null;
    return { width: w, height: h };
  }
  if (chunk === "VP8X") {
    if (bytes.length < 30) return null;
    const w = u24(24) + 1;
    const h = u24(27) + 1;
    if (w <= 0 || h <= 0 || w > 16384 || h > 16384) return null;
    return { width: w, height: h };
  }
  return null;
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
      if (typeof result === "string" && result.length > 0) imageBase64 = result;
    }
  }
  if (imageBase64 === null) {
    throw new UpstreamFriendlyError(IMAGE_FRIENDLY_ERROR, usageFromUpstream(record["usage"], 1));
  }
  let width = 0;
  let height = 0;
  try {
    const dims = webpDimensions(base64ToBytes(imageBase64));
    if (dims !== null) {
      width = dims.width;
      height = dims.height;
    }
  } catch {
    // Falls through to the friendly error below.
  }
  if (width === 0 || height === 0) {
    throw new UpstreamFriendlyError(IMAGE_FRIENDLY_ERROR, usageFromUpstream(record["usage"], 1));
  }
  return {
    data: { imageBase64, format: "webp", width, height },
    usage: usageFromUpstream(record["usage"], 1),
  };
}

export const SAM_FRIENDLY_ERROR =
  "The room scanner couldn't segment that photo just now. Please try again.";

export interface SamCallOptions {
  /** One short noun concept: wall, floor, ceiling, door or window. */
  concept: string;
  /** The room photo as a JPEG data URL. */
  imageDataUrl: string;
}

/**
 * Pull the segmentation output text out of a SAM 3.1 SSE stream.
 *
 * Only the `data` of `response.output_text.delta` events is JSON-parsed
 * (their `delta`s joined in order); every other event is picked by its
 * `event:` line alone and never parsed, since those carry full copies of
 * the same text. Requires a `response.completed` event: `response.failed`,
 * `response.incomplete` or `error` — or a missing completion — throws the
 * route's friendly error. The server never decodes masks.
 */
export function extractSamOutputText(raw: string): string {
  const billed = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 1 };
  const fail = (): never => {
    throw new UpstreamFriendlyError(SAM_FRIENDLY_ERROR, billed);
  };
  const chunks: string[] = [];
  let completed = false;
  for (const block of raw.split(/\r?\n\r?\n/)) {
    // The `event:` line first: every other event carries full copies of the
    // same text, so its `data:` line is never touched — only
    // `response.output_text.delta` payloads are read and JSON-parsed.
    const lines = block.split(/\r?\n/);
    let event: string | null = null;
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      }
    }
    if (event === null) continue;
    if (event === "response.completed") {
      completed = true;
      continue;
    }
    if (event === "response.failed" || event === "response.incomplete" || event === "error") {
      fail();
    }
    if (event !== "response.output_text.delta") continue;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLines.join("\n")) as unknown;
    } catch {
      fail();
    }
    const delta =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["delta"]
        : undefined;
    if (typeof delta !== "string") fail();
    chunks.push(delta as string);
  }
  if (!completed) fail();
  return chunks.join("");
}

/**
 * SAM 3.1 segmentation: one concept over one room photo, streamed.
 *
 * Facts checked with real calls: `POST /responses` with
 * `{ model: "sam-3.1", stream: true, input: [{ type: "message", role:
 * "user", content: [{ type: "input_text", text }, { type: "input_image",
 * image_url }] }] }` and `Accept: text/event-stream`. Billing is one
 * image per request.
 */
export async function callSam(apiKey: string, options: SamCallOptions): Promise<UpstreamResult> {
  const res = await fetch(`${META_BASE_URL}/responses`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), Accept: "text/event-stream" },
    body: JSON.stringify({
      model: META_MODELS.sam,
      stream: true,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: options.concept },
            { type: "input_image", image_url: options.imageDataUrl },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Meta API /responses answered HTTP ${String(res.status)}`);
  }
  const text = extractSamOutputText(await res.text());
  return {
    data: { concept: options.concept, text },
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 1 },
  };
}

// Mock fixtures live in `./fixtures.js` on Node and in the build-time
// bundle in the Worker; both are served through the gateway store.
