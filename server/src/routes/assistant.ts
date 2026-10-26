/**
 * `POST /api/assistant` — thin route over the shared gateway pipeline.
 *
 * The next task gives this route its real request, prompt and schema. Until
 * then it answers only in mock and demo mode (live: HTTP 501
 * `{ status: "not-ready" }`).
 */

import { MAX_TEXT_PROMPT_CHARS } from "@fitroom/shared";
import { Hono } from "hono";
import { META_MODELS } from "../config.js";
import { callSpark, type UpstreamResult } from "../meta/client.js";
import {
  parsePrompt,
  serveGatewayRequest,
  type PipelineDeps,
  type RouteDef,
} from "../meta/pipeline.js";

export const assistantDef: RouteDef = {
  route: "assistant",
  model: META_MODELS.spark,
  liveReady: false,
  parseBody: (body: unknown) => {
    const parsed = parsePrompt(body, MAX_TEXT_PROMPT_CHARS);
    if ("error" in parsed) return parsed;
    return { input: { prompt: parsed.prompt } };
  },
  keyInput: (input: unknown) => input,
  upstream: async (apiKey: string, input: unknown): Promise<UpstreamResult> =>
    callSpark(apiKey, {
      messages: [{ role: "user", content: (input as { prompt: string }).prompt }],
    }),
};

export function assistantRoutes(deps: PipelineDeps): Hono {
  const app = new Hono();
  app.post("/assistant", (c) => serveGatewayRequest(c, deps, assistantDef));
  return app;
}
