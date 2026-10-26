/**
 * `POST /api/assistant` — one layout-conversation round over the shared
 * gateway pipeline.
 *
 * Body: the canonical assistant request (customer text, the conversation so
 * far, the room and the current draft scene), validated with a friendly
 * message (HTTP 400 when invalid). The canonical request is the key input, so
 * every round of a turn has its own demo-store entry.
 *
 * Upstream: the pasted system prompt plus the room description go to Muse
 * Spark with the pasted `tools` and `max_tokens` 8000. The answer is one
 * round: `{ text, toolCalls }` — tool calls (if any) for the client to run
 * on its draft copy, else the final answer text. One retry on an empty
 * round, then a friendly error.
 */

import {
  ASSISTANT_TOOLS,
  assistantRequestError,
  buildAssistantUpstreamMessages,
  isAssistantRoundData,
  type AssistantRequest,
  type AssistantToolCall,
  type CatalogItem,
} from "@fitroom/shared";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { META_MODELS } from "../config.js";
import {
  callSpark,
  type ChatMessage,
  type SparkToolCall,
  type UpstreamResult,
} from "../meta/client.js";
import {
  UpstreamFriendlyError,
  serveGatewayRequest,
  type ParsedBody,
  type PipelineDeps,
  type RouteDef,
} from "../meta/pipeline.js";

export const ASSISTANT_FRIENDLY_ERROR =
  "The layout assistant couldn't answer just now. Please try again.";

export const ASSISTANT_MAX_TOKENS = 8000;

let catalogCache: CatalogItem[] | null = null;

function loadCatalog(): CatalogItem[] {
  if (catalogCache !== null) return catalogCache;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "shared");
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(root, "catalog", "catalog.json"), "utf8"),
  );
  if (!Array.isArray(parsed)) throw new Error("Catalog is not an array.");
  catalogCache = parsed as CatalogItem[];
  return catalogCache;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Falls through to the empty arguments below.
  }
  return {};
}

function toToolCalls(calls: SparkToolCall[]): AssistantToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: parseToolArguments(call.arguments),
  }));
}

function parseRound(data: unknown): { text: string; toolCalls: AssistantToolCall[] } | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const text = typeof record["text"] === "string" ? record["text"] : "";
  const rawCalls = Array.isArray(record["toolCalls"]) ? record["toolCalls"] : [];
  const toolCalls = toToolCalls(rawCalls as SparkToolCall[]);
  const round = { text, toolCalls };
  return isAssistantRoundData(round) ? round : null;
}

async function callAssistantRound(
  apiKey: string,
  input: AssistantRequest,
): Promise<UpstreamResult> {
  const messages: ChatMessage[] = buildAssistantUpstreamMessages(input, loadCatalog());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await callSpark(apiKey, {
      messages,
      tools: ASSISTANT_TOOLS,
      maxTokens: ASSISTANT_MAX_TOKENS,
    });
    const round = parseRound(result.data);
    if (round !== null && (round.text.trim() !== "" || round.toolCalls.length > 0)) {
      return { data: round, usage: result.usage };
    }
  }
  throw new UpstreamFriendlyError(ASSISTANT_FRIENDLY_ERROR);
}

function parseAssistantBody(body: unknown): ParsedBody | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Expected a JSON object with request, messages, room and scene." };
  }
  const problem = assistantRequestError(body);
  if (problem !== null) return { error: problem };
  const input = { ...(body as Record<string, unknown>) };
  delete input["live"];
  return { input };
}

export const assistantDef: RouteDef = {
  route: "assistant",
  model: META_MODELS.spark,
  liveReady: true,
  parseBody: parseAssistantBody,
  keyInput: (input: unknown) => input,
  upstream: async (apiKey: string, input: unknown): Promise<UpstreamResult> =>
    callAssistantRound(apiKey, input as AssistantRequest),
};

export function assistantRoutes(deps: PipelineDeps): Hono {
  const app = new Hono();
  app.post("/assistant", (c) => serveGatewayRequest(c, deps, assistantDef));
  return app;
}
