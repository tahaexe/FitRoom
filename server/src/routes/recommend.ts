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
import { META_MODELS } from "../config.js";
import { callSpark, type ChatMessage, type UpstreamResult } from "../meta/client.js";
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

async function callAdvisor(apiKey: string, request: RecommendRequest): Promise<UpstreamResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: RECOMMEND_SYSTEM_PROMPT },
    { role: "user", content: userMessage(request) },
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await callSpark(apiKey, {
      messages,
      jsonSchema: { name: "recommend", schema: RECOMMEND_OUTPUT_SCHEMA },
      maxTokens: 8000,
    });
    const text =
      typeof result.data === "object" && result.data !== null
        ? String((result.data as Record<string, unknown>)["text"] ?? "")
        : "";
    const parsed = parseModelJson(text);
    if (parsed !== null && isRecommendAnswer(parsed)) {
      const cleaned = dropUnknownCandidates(parsed, request);
      if (cleaned.recommendations.length > 0 || request.candidates.length === 0) {
        return { data: cleaned, usage: result.usage };
      }
    }
  }
  throw new UpstreamFriendlyError(RECOMMEND_FRIENDLY_ERROR);
}

export const recommendDef: RouteDef = {
  route: "recommend",
  model: META_MODELS.spark,
  liveReady: true,
  parseBody: parseRecommendBody,
  keyInput: (input: unknown) => input,
  upstream: async (apiKey: string, input: unknown): Promise<UpstreamResult> =>
    callAdvisor(apiKey, input as RecommendRequest),
};

export function recommendRoutes(deps: PipelineDeps): Hono {
  const app = new Hono();
  app.post("/recommend", (c) => serveGatewayRequest(c, deps, recommendDef));
  return app;
}
