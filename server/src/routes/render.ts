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
import { base64ToBytes } from "../meta/base64.js";
import { META_MODELS } from "../meta/models.js";
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
    const bytes = base64ToBytes(bare);
    if (bytes.length < 32) return null;
    return bytes;
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

function isKeySceneItem(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const position = item["position"] as Record<string, unknown> | undefined;
  return (
    typeof item["instanceId"] === "string" &&
    typeof item["productId"] === "string" &&
    typeof position?.["x"] === "number" &&
    typeof position?.["z"] === "number" &&
    typeof item["rotationY"] === "number" &&
    typeof item["variant"] === "string"
  );
}

/**
 * The committed demo store's key input for a render: `{ prompt,
 * scene: { roomId, items }, camera: { preset } }` — the scene carries no
 * camera because the preset names the view. Accepts it (plus an optional
 * reference image) as a replayable input; anything else returns null so the
 * strict request validation still applies.
 */
function parseStoredKeyInput(record: Record<string, unknown>): RenderRouteInput | null {
  if (typeof record["prompt"] !== "string" || record["prompt"] === "") return null;
  const scene = record["scene"];
  if (typeof scene !== "object" || scene === null || Array.isArray(scene)) return null;
  const sceneRecord = scene as Record<string, unknown>;
  if (typeof sceneRecord["roomId"] !== "string" || sceneRecord["roomId"] === "") return null;
  if (!Array.isArray(sceneRecord["items"]) || !sceneRecord["items"].every(isKeySceneItem)) {
    return null;
  }
  // A full live body (with a scene camera) is not a stored key input.
  if (typeof sceneRecord["camera"] === "object" && sceneRecord["camera"] !== null) return null;
  const nested =
    typeof record["camera"] === "object" && record["camera"] !== null
      ? ((record["camera"] as Record<string, unknown>)["preset"] as unknown)
      : undefined;
  const preset =
    typeof record["cameraPreset"] === "string" && record["cameraPreset"] !== ""
      ? (record["cameraPreset"] as string)
      : typeof nested === "string" && nested !== ""
        ? nested
        : undefined;
  if (preset === undefined) return null;
  const input: RenderRouteInput = {
    prompt: record["prompt"] as string,
    scene: sceneRecord,
    cameraPreset: preset,
  };
  if (typeof record["referenceImage"] === "string" && record["referenceImage"] !== "") {
    const decoded = decodeJpegBase64(record["referenceImage"] as string);
    if (decoded === null) return null;
    input.referenceJpeg = decoded;
  }
  return input;
}

export function parseRenderBody(body: unknown): { input: RenderRouteInput } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Expected a JSON object with a prompt, a scene and a capture." };
  }
  const record = body as Record<string, unknown>;
  // Legacy text-only body: `{ prompt }` (gateway check).
  if (record["scene"] === undefined && record["referenceImage"] === undefined) {
    const parsed = parsePrompt(body, MAX_RENDER_PROMPT_CHARS);
    if ("error" in parsed) return parsed;
    return { input: { prompt: parsed.prompt } };
  }
  // Stored demo key-input shape: the normalised scene (room id + items, no
  // camera) beside `camera: { preset }` (or top-level `cameraPreset`). The
  // app always sends a full scene camera; this shape only replays what the
  // demo store recorded, so it validates to the same key without weakening
  // the live contract.
  const stored = parseStoredKeyInput(record);
  if (stored !== null) return { input: stored };
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
        // Stored key inputs carry no scene camera (the preset names the
        // view); the preset branch of the key builder never reads the pose,
        // so a dummy camera keys them exactly like the live request.
        const keyScene =
          typeof (scene as { camera?: unknown })["camera"] === "object" &&
          (scene as { camera?: unknown })["camera"] !== null
            ? scene
            : {
                ...(scene as Record<string, unknown>),
                camera: {
                  mode: "orbit",
                  position: { x: 0, y: 0, z: 0 },
                  target: { x: 0, y: 0, z: 0 },
                },
              };
        return buildRenderKeyInput(
          keyScene as Parameters<typeof buildRenderKeyInput>[0],
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
