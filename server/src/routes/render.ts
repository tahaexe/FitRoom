/**
 * `POST /api/render` — thin route over the shared gateway pipeline.
 *
 * Takes `{ "prompt": string of at most 600 characters }` (text only, Muse
 * Image). A later task adds the scene-and-camera key input
 * (`POST /api/room/analyze` arrives separately).
 */

import { MAX_RENDER_PROMPT_CHARS } from "@fitroom/shared";
import { Hono } from "hono";
import { META_MODELS } from "../config.js";
import { callImage, type UpstreamResult } from "../meta/client.js";
import {
  parsePrompt,
  serveGatewayRequest,
  type PipelineDeps,
  type RouteDef,
} from "../meta/pipeline.js";

export const renderDef: RouteDef = {
  route: "render",
  model: META_MODELS.image,
  liveReady: true,
  parseBody: (body: unknown) => {
    const parsed = parsePrompt(body, MAX_RENDER_PROMPT_CHARS);
    if ("error" in parsed) return parsed;
    return { input: { prompt: parsed.prompt } };
  },
  keyInput: (input: unknown) => input,
  upstream: async (apiKey: string, input: unknown): Promise<UpstreamResult> =>
    callImage(apiKey, { prompt: (input as { prompt: string }).prompt }),
};

export function renderRoutes(deps: PipelineDeps): Hono {
  const app = new Hono();
  app.post("/render", (c) => serveGatewayRequest(c, deps, renderDef));
  return app;
}
