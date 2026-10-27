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
 * on its draft copy, else the final answer text. A round cut by `max_tokens`
 * (finish reason `length`) is retried once, as is an empty round, then a
 * friendly error.
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
import { Hono } from "hono";
import { META_MODELS } from "../meta/models.js";
import {
  callSpark,
  type ChatMessage,
  type SparkToolCall,
  type UpstreamResult,
} from "../meta/client.js";
import { emptyUsage } from "../meta/pricing.js";
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

/** The product catalog, loaded from disk on Node and from the build-time bundle in the Worker. */
export let assistantCatalog: CatalogItem[] = [];

/** Set the catalog the assistant upstream calls rank against. */
export function setAssistantCatalog(catalog: CatalogItem[]): void {
  assistantCatalog = catalog;
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
  const messages: ChatMessage[] = buildAssistantUpstreamMessages(input, assistantCatalog);
  let lengthRetried = false;
  let emptyRetried = false;
  const attempts: UpstreamResult["usage"][] = [];
  for (;;) {
    const result = await callSpark(apiKey, {
      messages,
      tools: ASSISTANT_TOOLS,
      maxTokens: ASSISTANT_MAX_TOKENS,
    });
    attempts.push(result.usage);
    if (result.finishReason === "length" && !lengthRetried) {
      lengthRetried = true;
      continue;
    }
    const round = parseRound(result.data);
    if (round !== null && (round.text.trim() !== "" || round.toolCalls.length > 0)) {
      return { data: round, usage: result.usage };
    }
    if (emptyRetried) break;
    emptyRetried = true;
  }
  const billed = attempts[attempts.length - 1] ?? emptyUsage();
  throw new UpstreamFriendlyError(ASSISTANT_FRIENDLY_ERROR, billed);
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

/**
 * Key input for the demo store, cache and caps: the canonical request with
 * the advisory `ready` line stripped from tool results, so a turn recorded
 * before that line existed still replays (the line never changes the draft),
 * and with the `seats`/`styleTags` display fields stripped from
 * `list_catalog` results, so turns recorded before those fields existed
 * still replay. The brief itself stays in the key like the other fields.
 * Exported so `check:assistant` can name the same keys the pipeline reads.
 */
export function assistantKeyInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record["messages"])) return input;
  const messages = (record["messages"] as unknown[]).map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
    const message = entry as Record<string, unknown>;
    if (message["role"] !== "tool" || typeof message["content"] !== "string") return entry;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message["content"]) as unknown;
    } catch {
      return entry;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return entry;
    const result = parsed as Record<string, unknown>;
    const stripped = { ...result };
    delete stripped["ready"];
    if (message["name"] === "list_catalog" && Array.isArray(stripped["products"])) {
      stripped["products"] = (stripped["products"] as unknown[]).map((product) => {
        if (typeof product !== "object" || product === null || Array.isArray(product)) {
          return product;
        }
        const view = { ...(product as Record<string, unknown>) };
        delete view["seats"];
        delete view["styleTags"];
        return view;
      });
    }
    return { ...message, content: JSON.stringify(stripped) };
  });
  return { ...record, messages };
}

export const assistantDef: RouteDef = {
  route: "assistant",
  model: META_MODELS.spark,
  liveReady: true,
  parseBody: parseAssistantBody,
  keyInput: assistantKeyInput,
  upstream: async (apiKey: string, input: unknown): Promise<UpstreamResult> =>
    callAssistantRound(apiKey, input as AssistantRequest),
};

export function assistantRoutes(deps: PipelineDeps): Hono {
  const app = new Hono();
  app.post("/assistant", (c) => serveGatewayRequest(c, deps, assistantDef));
  app.get("/assistant/demo-chips", async (c) => {
    // The stored first rounds (single-message turns) name the demo chips.
    const seen = new Set<string>();
    const requests: string[] = [];
    for (const file of await deps.store.listDemo(assistantDef.route)) {
      const input = file.input as { request?: unknown; messages?: unknown } | null | undefined;
      if (
        typeof input?.request === "string" &&
        Array.isArray(input.messages) &&
        input.messages.length === 1 &&
        !seen.has(input.request)
      ) {
        seen.add(input.request);
        requests.push(input.request);
      }
    }
    return c.json({ status: "ok", requests });
  });
  return app;
}
