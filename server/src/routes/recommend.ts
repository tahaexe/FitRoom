/**
 * `POST /api/recommend` — structured furniture advice over the shared
 * gateway pipeline.
 *
 * Body: the canonical recommend request (room, style, placed items, query,
 * free space and size-fitting candidates with proposed spots; see
 * `shared/src/recommend/`), validated against its schema (HTTP 400 with a
 * friendly message when invalid). The canonical request is the key input.
 *
 * Upstream: the pasted system prompt plus the request JSON go to Muse Spark
 * with `response_format` json_schema (the pasted output schema) and
 * `max_tokens` 8000. The answer is validated against the schema and against
 * the candidates (unknown products dropped); one retry on invalid JSON,
 * then a friendly error.
 */

import {
  RECOMMEND_OUTPUT_SCHEMA,
  RECOMMEND_SYSTEM_PROMPT,
  isRecommendAnswer,
  parseModelJson,
  recommendRequestError,
  type RecommendAnswer,
  type RecommendRequest,
} from "@fitroom/shared";
import { Hono } from "hono";
import { META_MODELS } from "../meta/models.js";
import { callSpark, type ChatMessage, type UpstreamResult } from "../meta/client.js";
import { emptyUsage, type TokenUsage } from "../meta/pricing.js";
import {
  UpstreamFriendlyError,
  serveGatewayRequest,
  type ParsedBody,
  type PipelineDeps,
  type RouteDef,
} from "../meta/pipeline.js";

export const RECOMMEND_FRIENDLY_ERROR = "The advisor couldn't answer just now. Please try again.";

function parseRecommendBody(body: unknown): ParsedBody | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Expected a JSON object with room, request and candidates." };
  }
  const problem = recommendRequestError(body);
  if (problem !== null) return { error: problem };
  const input = { ...(body as Record<string, unknown>) };
  delete input["live"];
  return { input };
}

function userMessage(request: RecommendRequest): string {
  return (
    "Rank candidates for this customer request. " +
    "Every figure ending in 'cm' in a reason must match a number from the input JSON " +
    "(copy sizes, run lengths and spare centimetres exactly, up to whole-cm rounding). " +
    "Walls are named as seen from the doorway (door wall, back wall, left wall, " +
    "right wall, with ' (window)' when a window is on that wall): cite those exact " +
    "names in reasons and never write ids like 'wall-1'. " +
    "Seat-front and seat-side spots name their seat: mention it with the gap. " +
    'When candidates is empty, answer {"recommendations": []} with a short note.\n' +
    JSON.stringify(request)
  );
}

function dropUnknownCandidates(
  answer: RecommendAnswer,
  request: RecommendRequest,
): RecommendAnswer {
  const known = new Set(request.candidates.map((c) => c.productId));
  const recommendations = answer.recommendations.filter((r) => known.has(r.productId)).slice(0, 3);
  return answer.note === undefined ? { recommendations } : { recommendations, note: answer.note };
}

function sumUsage(usages: TokenUsage[]): TokenUsage {
  const total = emptyUsage();
  for (const usage of usages) {
    total.inputTokens += usage.inputTokens;
    total.cachedInputTokens += usage.cachedInputTokens;
    total.outputTokens += usage.outputTokens;
    total.images += usage.images;
  }
  return total;
}

async function callAdvisor(apiKey: string, request: RecommendRequest): Promise<UpstreamResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: RECOMMEND_SYSTEM_PROMPT },
    { role: "user", content: userMessage(request) },
  ];
  // Every billed try reaches the costs table: both attempts' usage is
  // carried on the one line (summed), so the judging-window cap adds up
  // the first try that was billed too.
  const usages: TokenUsage[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await callSpark(apiKey, {
      messages,
      jsonSchema: { name: "recommend", schema: RECOMMEND_OUTPUT_SCHEMA },
      maxTokens: 8000,
    });
    usages.push(result.usage);
    const text =
      typeof result.data === "object" && result.data !== null
        ? String((result.data as Record<string, unknown>)["text"] ?? "")
        : "";
    const parsed = parseModelJson(text);
    if (parsed !== null && isRecommendAnswer(parsed)) {
      const cleaned = dropUnknownCandidates(parsed, request);
      if (cleaned.recommendations.length > 0 || request.candidates.length === 0) {
        return { data: cleaned, usage: sumUsage(usages) };
      }
    }
  }
  throw new UpstreamFriendlyError(
    RECOMMEND_FRIENDLY_ERROR,
    usages.length > 0 ? sumUsage(usages) : emptyUsage(),
  );
}

/**
 * Key input for the demo store, cache and caps: the canonical request with
 * the pixel-blended `surfaces.wallTint` stripped from the room, so the
 * example room replays whatever the photo pixels blended to (JPEG decoders
 * differ by a step or two). Rooms without a tint key exactly as before.
 */
export function recommendKeyInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (typeof record["room"] !== "object" || record["room"] === null) return input;
  const room = record["room"] as Record<string, unknown>;
  if (
    typeof room["surfaces"] !== "object" ||
    room["surfaces"] === null ||
    !("wallTint" in (room["surfaces"] as Record<string, unknown>))
  ) {
    return input;
  }
  const surfaces = { ...(room["surfaces"] as Record<string, unknown>) };
  delete surfaces["wallTint"];
  return { ...record, room: { ...room, surfaces } };
}

export const recommendDef: RouteDef = {
  route: "recommend",
  model: META_MODELS.spark,
  liveReady: true,
  parseBody: parseRecommendBody,
  keyInput: recommendKeyInput,
  upstream: async (apiKey: string, input: unknown): Promise<UpstreamResult> =>
    callAdvisor(apiKey, input as RecommendRequest),
};

export function recommendRoutes(deps: PipelineDeps): Hono {
  const app = new Hono();
  app.post("/recommend", (c) => serveGatewayRequest(c, deps, recommendDef));
  app.get("/recommend/demo-spots", async (c) => {
    const spots: Array<{ wall: string; start_cm: number; end_cm: number }> = [];
    for (const file of await deps.store.listDemo(recommendDef.route)) {
      const input = file.input as {
        request?: {
          category?: unknown;
          spot?: { wall?: unknown; start_cm?: unknown; end_cm?: unknown };
        };
      };
      const spot = input.request?.spot;
      if (
        input.request?.category === "any" &&
        typeof spot?.wall === "string" &&
        typeof spot?.start_cm === "number" &&
        typeof spot?.end_cm === "number"
      ) {
        spots.push({ wall: spot.wall, start_cm: spot.start_cm, end_cm: spot.end_cm });
      }
    }
    return c.json({ status: "ok", spots });
  });
  return app;
}
