/**
 * Gateway contracts for the small, safe Meta-model gateway.
 *
 * The gateway fronts five JSON routes (`POST /api/recommend`,
 * `POST /api/assistant`, `POST /api/render`, `POST /api/room/segment`,
 * `POST /api/room/label`) with one shared pipeline:
 * demo store, cache, caps, upstream, cache write, metering.
 *
 * Until the follow-up tasks define each route's real request, prompt and
 * schema, every route accepts `{ "prompt": string }` (render: at most 600
 * characters, recommend/assistant: at most 2000). The envelope below is
 * stable and will not change when the per-route bodies grow.
 */

export type GatewayRoute = "recommend" | "assistant" | "render" | "segment" | "label";

/** Where an answer came from. Only `upstream` costs money. */
export type GatewaySource = "upstream" | "cache" | "demo" | "mock";

export interface GatewayOk {
  status: "ok";
  source: GatewaySource;
  route: GatewayRoute;
  model: string;
  data: unknown;
}

export interface GatewayDemoMiss {
  status: "demo-miss";
  message: string;
}

export interface GatewayCapped {
  status: "capped";
  message: string;
}

export interface GatewayNotReady {
  status: "not-ready";
}

export interface GatewayError {
  status: "error";
  message: string;
}

export type GatewayResponse =
  GatewayOk | GatewayDemoMiss | GatewayCapped | GatewayNotReady | GatewayError;

/** Friendly, fixed copy for the capped and demo-miss envelopes. */
export const GATEWAY_CAPPED_MESSAGE = "The live AI is resting; try the demo room.";
export const GATEWAY_DEMO_MISS_MESSAGE =
  "This answer isn't in the demo yet. Reset to the demo room or turn on Live AI.";

/** Temporary request bodies until each route gets its real schema. */
export interface GatewayPromptRequest {
  prompt: string;
  /** Live mode when true; demo mode (the default) when absent. */
  live?: boolean;
}

export const MAX_RENDER_PROMPT_CHARS = 2000;
export const MAX_TEXT_PROMPT_CHARS = 2000;

export const gatewayPromptRequestSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "GatewayPromptRequest",
  type: "object",
  properties: {
    prompt: { type: "string", minLength: 1 },
    live: { type: "boolean" },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGatewayResponse(value: unknown): value is GatewayResponse {
  if (!isRecord(value)) return false;
  switch (value["status"]) {
    case "ok":
      return (
        typeof value["source"] === "string" &&
        typeof value["route"] === "string" &&
        typeof value["model"] === "string" &&
        "data" in value
      );
    case "demo-miss":
    case "capped":
    case "error":
      return typeof value["message"] === "string";
    case "not-ready":
      return true;
    default:
      return false;
  }
}

/** A stored demo answer: `server/data/demo/<route>/<key>.json`. */
export interface DemoStoreFile {
  route: GatewayRoute;
  model: string;
  /** The route's canonical key input (never image bytes). */
  input: unknown;
  response: unknown;
  time: string;
}

export function isDemoStoreFile(value: unknown): value is DemoStoreFile {
  if (!isRecord(value)) return false;
  return (
    typeof value["route"] === "string" &&
    typeof value["model"] === "string" &&
    "input" in value &&
    "response" in value &&
    typeof value["time"] === "string"
  );
}
