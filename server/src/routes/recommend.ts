/**
 * `POST /api/recommend` — thin route over the shared gateway pipeline.
 *
 * The next task gives this route its real request, prompt and schema. Until
 * then it answers only in mock and demo mode (live: HTTP 501
 * `{ status: "not-ready" }`).
 */

import { MAX_TEXT_PROMPT_CHARS } from "@fitroom/shared";
import { Hono } from "hono";
import { META_MODELS } from "../config.js";
import { callSpark, type UpstreamResult } from "../meta/client.js";
import { serveGatewayRequest, type PipelineDeps, type RouteDef } from "../meta/pipeline.js";

export const recommendDef: RouteDef = {
  route: "recommend",
  model: META_MODELS.spark,
  maxPromptChars: MAX_TEXT_PROMPT_CHARS,
  liveReady: false,
  keyInput: (prompt: string) => ({ prompt }),
  upstream: async (apiKey: string, prompt: string): Promise<UpstreamResult> =>
    callSpark(apiKey, {
      messages: [{ role: "user", content: prompt }],
    }),
};

export function recommendRoutes(deps: PipelineDeps): Hono {
  const app = new Hono();
  app.post("/recommend", (c) => serveGatewayRequest(c, deps, recommendDef));
  return app;
}
