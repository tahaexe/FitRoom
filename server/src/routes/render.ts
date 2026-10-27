/**
 * `POST /api/render` — photoreal visualisation over the shared gateway
 * pipeline (Muse Image edit with the 3D capture as the reference image).
 *
 * New body: `{ prompt, scene, referenceImage?, cameraPreset?, live? }`.
 * The prompt is built client-side with the shared prompt builder; the key
 * input is the normalised scene + camera + prompt (never image bytes), so
 * moving a piece changes the key while the capture bytes never do. Upstream
 * sends the prompt as `input_text` and the capture as an `input_image` JPEG
 * data URL. A legacy `{ prompt }` body still answers (text-only render) so
 * older checks keep passing.
 */

import { MAX_RENDER_PROMPT_CHARS, buildRenderKeyInput, renderRequestError } from "@fitroom/shared";
import { Hono } from "hono";
import { META_MODELS } from "../config.js";
import { callImage, type UpstreamResult } from "../meta/client.js";
import { UpstreamFriendlyError } from "../meta/errors.js";
import {
  parsePrompt,
  serveGatewayRequest,
  type PipelineDeps,
  type RouteDef,
} from "../meta/pipeline.js";

export const RENDER_FRIENDLY_ERROR =
  "The visualiser couldn't make an image just now. Please try again.";

function stripDataUrl(value: string): string {
  const comma = value.indexOf(",");
  if (value.startsWith("data:") && comma >= 0) {
    return value.slice(comma + 1);
  }
  return value;
}

function decodeJpegBase64(value: string): Uint8Array | null {
  try {
    const bare = stripDataUrl(value).trim();
    if (bare.length < 16) return null;
    const bytes = Buffer.from(bare, "base64");
    if (bytes.length < 32) return null;
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

export interface RenderRouteInput {
  prompt: string;
  scene?: unknown;
  cameraPreset?: string;
  referenceJpeg?: Uint8Array;
}

export function parseRenderBody(body: unknown): { input: RenderRouteInput } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Expected a JSON object with a prompt, a scene and a capture." };
  }
  const record = body as Record<string, unknown>;
  // Legacy text-only body: `{ prompt }` (gateway check + old demo entry).
  if (record["scene"] === undefined && record["referenceImage"] === undefined) {
    const parsed = parsePrompt(body, MAX_RENDER_PROMPT_CHARS);
    if ("error" in parsed) return parsed;
    return { input: { prompt: parsed.prompt } };
  }
  const problem = renderRequestError(body);
  if (problem !== null) return { error: problem };
  const typed = body as {
    prompt: string;
    scene: unknown;
    referenceImage?: string;
    cameraPreset?: string;
    live?: unknown;
  };
  let referenceJpeg: Uint8Array | undefined;
  if (typeof typed.referenceImage === "string" && typed.referenceImage !== "") {
    const decoded = decodeJpegBase64(typed.referenceImage);
    if (decoded === null) return { error: "The capture must be base64 JPEG." };
    referenceJpeg = decoded;
  }
  const input: RenderRouteInput = { prompt: typed.prompt, scene: typed.scene };
  if (typeof typed.cameraPreset === "string" && typed.cameraPreset !== "") {
    input.cameraPreset = typed.cameraPreset;
  }
  if (referenceJpeg !== undefined) input.referenceJpeg = referenceJpeg;
  return { input };
}

export const renderDef: RouteDef = {
  route: "render",
  model: META_MODELS.image,
  liveReady: true,
  parseBody: parseRenderBody,
  keyInput: (input: unknown) => {
    const record = input as Partial<RenderRouteInput> & {
      camera?: { preset?: unknown };
    };
    const prompt = typeof record["prompt"] === "string" ? record["prompt"] : "";
    const scene = record["scene"] as
      { roomId?: unknown; items?: unknown; camera?: unknown } | undefined;
    // The preset travels top-level (`cameraPreset`) on live requests; the
    // stored demo inputs carry it nested under `camera.preset`. Both name
    // the same preset view, so both key the same way.
    const preset =
      typeof record["cameraPreset"] === "string" && record["cameraPreset"] !== ""
        ? record["cameraPreset"]
        : typeof record["camera"] === "object" &&
            record["camera"] !== null &&
            typeof (record["camera"] as { preset?: unknown })["preset"] === "string"
          ? ((record["camera"] as { preset?: unknown })["preset"] as string)
          : undefined;
    if (
      typeof scene === "object" &&
      scene !== null &&
      typeof (scene as { roomId?: unknown })["roomId"] === "string"
    ) {
      try {
        return buildRenderKeyInput(
          scene as Parameters<typeof buildRenderKeyInput>[0],
          prompt,
          preset,
        );
      } catch {
        return { prompt };
      }
    }
    // Legacy prompt-only input.
    return { prompt };
  },
  upstream: async (apiKey: string, input: unknown): Promise<UpstreamResult> => {
    const record = input as Partial<RenderRouteInput>;
    const prompt = typeof record["prompt"] === "string" ? record["prompt"] : "";
    if (prompt === "") {
      throw new UpstreamFriendlyError(RENDER_FRIENDLY_ERROR);
    }
    const referenceJpeg = record["referenceJpeg"] as Uint8Array | undefined;
    return callImage(apiKey, { prompt, referenceJpeg });
  },
};

export function renderRoutes(deps: PipelineDeps): Hono {
  const app = new Hono();
  app.post("/render", (c) => serveGatewayRequest(c, deps, renderDef));
  return app;
}
