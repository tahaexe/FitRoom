import { MAX_RENDER_PROMPT_CHARS } from "../schemas/api.js";
import type { SceneState } from "../types.js";

export interface RenderRequest {
  prompt: string;
  scene: SceneState;
  /** Base64 JPEG capture (bare base64 or a `data:image/...` URL). Optional. */
  referenceImage?: string;
  /** Preset view name (`dollhouse`, `eye-level`, `plan`); optional. */
  cameraPreset?: string;
}

export const renderRequestSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "RenderRequest",
  type: "object",
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: MAX_RENDER_PROMPT_CHARS },
    scene: {
      type: "object",
      properties: {
        roomId: { type: "string", minLength: 1 },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              instanceId: { type: "string", minLength: 1 },
              productId: { type: "string", minLength: 1 },
              position: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  z: { type: "number" },
                },
                required: ["x", "z"],
                additionalProperties: false,
              },
              rotationY: { type: "number" },
              variant: { type: "string" },
            },
            required: ["instanceId", "productId", "position", "rotationY", "variant"],
            additionalProperties: false,
          },
        },
        camera: {
          type: "object",
          properties: {
            mode: { enum: ["orbit", "plan"] },
            position: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                z: { type: "number" },
              },
              required: ["x", "y", "z"],
              additionalProperties: false,
            },
            target: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                z: { type: "number" },
              },
              required: ["x", "y", "z"],
              additionalProperties: false,
            },
          },
          required: ["mode", "position", "target"],
          additionalProperties: false,
        },
      },
      required: ["roomId", "items", "camera"],
      additionalProperties: false,
    },
    referenceImage: { type: "string", minLength: 16 },
    cameraPreset: { type: "string", minLength: 1, maxLength: 64 },
  },
  required: ["prompt", "scene"],
  additionalProperties: false,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Friendly validation error for a render body, or null when valid. */
export function renderRequestError(body: unknown): string | null {
  if (!isRecord(body)) return "Expected a JSON object with a prompt, a scene and a capture.";
  const prompt = body["prompt"];
  if (typeof prompt !== "string" || prompt.length === 0) {
    return "Expected a JSON object with a prompt, a scene and a capture.";
  }
  if (prompt.length > MAX_RENDER_PROMPT_CHARS) {
    return `The prompt must be at most ${String(MAX_RENDER_PROMPT_CHARS)} characters.`;
  }
  const scene = body["scene"];
  if (!isRecord(scene)) return "Expected a JSON object with a prompt, a scene and a capture.";
  if (typeof scene["roomId"] !== "string" || scene["roomId"] === "") {
    return "The scene needs a room id.";
  }
  if (!Array.isArray(scene["items"])) return "The scene needs an items list.";
  for (const item of scene["items"]) {
    if (!isRecord(item)) return "A scene item is malformed.";
    if (typeof item["instanceId"] !== "string" || typeof item["productId"] !== "string") {
      return "A scene item is malformed.";
    }
    const position = item["position"];
    if (!isRecord(position) || !isFiniteNumber(position["x"]) || !isFiniteNumber(position["z"])) {
      return "A scene item is malformed.";
    }
    if (!isFiniteNumber(item["rotationY"]) || typeof item["variant"] !== "string") {
      return "A scene item is malformed.";
    }
  }
  const camera = scene["camera"];
  if (!isRecord(camera)) return "The scene needs a camera.";
  if (camera["mode"] !== "orbit" && camera["mode"] !== "plan") {
    return "The scene needs a camera.";
  }
  for (const key of ["position", "target"]) {
    const vector = camera[key];
    if (
      !isRecord(vector) ||
      !isFiniteNumber(vector["x"]) ||
      !isFiniteNumber(vector["y"]) ||
      !isFiniteNumber(vector["z"])
    ) {
      return "The scene needs a camera.";
    }
  }
  if (body["referenceImage"] !== undefined && typeof body["referenceImage"] !== "string") {
    return "The capture must be base64 JPEG.";
  }
  if (typeof body["referenceImage"] === "string") {
    const bare = body["referenceImage"].includes(",")
      ? (body["referenceImage"].split(",").pop() ?? "")
      : body["referenceImage"];
    if (bare.length < 16) return "The capture must be base64 JPEG.";
    try {
      const bytes = Buffer.from(bare, "base64");
      if (bytes.length < 32) return "The capture must be base64 JPEG.";
    } catch {
      return "The capture must be base64 JPEG.";
    }
  }
  if (body["cameraPreset"] !== undefined && typeof body["cameraPreset"] !== "string") {
    return "The camera preset must be a string.";
  }
  return null;
}

export interface RenderImageData {
  imageBase64: string | null;
  format: string;
  width: number;
  height: number;
}

export function isRenderImageData(value: unknown): value is RenderImageData {
  if (!isRecord(value)) return false;
  return (
    (typeof value["imageBase64"] === "string" || value["imageBase64"] === null) &&
    typeof value["format"] === "string" &&
    typeof value["width"] === "number" &&
    typeof value["height"] === "number"
  );
}
