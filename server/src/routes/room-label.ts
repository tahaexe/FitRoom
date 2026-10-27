/**
 * `POST /api/room/label` — a room's photos labelled with Muse Spark, over
 * the shared gateway pipeline.
 *
 * Body: `{ photos: [{ wall, image }] }` with one to four photos, `wall` a
 * letter `A` to `D` (clockwise, `A` = the wall with the entrance door) and
 * `image` a JPEG data URL at most 640 px on the long side (the server
 * rejects a body over 1 MB). Spark labels from the photos alone and never
 * locates or measures anything.
 *
 * Answer: `{ style: { tags, dominantColors }, floor: { family, description
 * }, walls: { family, description }, photos: [{ wall, doors, openDoorways,
 * windows, glassDoors, lookalikes }], uncertain }`. The answer is normalized
 * (tag case, `#rgb` colours, long descriptions, an empty `uncertain`) and
 * only fails on a missing or wrong-typed field, a family outside its list,
 * or photos that don't match the request's letters; on failure the route
 * returns its friendly error (the client then uses defaults: no tags or
 * colours, families `other`, counts unknown). Retried only when cut off
 * (`finish_reason: "length"`) or not JSON; every attempt is metered.
 *
 * Key input: the photos' SHA-256s (Web Crypto digests of the image strings)
 * with their letters, never image bytes. Demo store, `demo:record` and
 * `demo:import` work for it like for the other routes.
 */

import {
  ROOM_LABEL_OUTPUT_SCHEMA,
  normalizeRoomLabelAnswer,
  parseModelJson,
} from "@fitroom/shared";
import { Hono } from "hono";
import { callSpark, type ChatMessage, type UpstreamResult } from "../meta/client.js";
import { UpstreamFriendlyError } from "../meta/errors.js";
import { jpegDataUrlSize } from "../meta/images.js";
import { sha256HexAsync } from "../meta/keys.js";
import { META_MODELS } from "../meta/models.js";
import { emptyUsage, type TokenUsage } from "../meta/pricing.js";
import {
  serveGatewayRequest,
  type ParsedBody,
  type PipelineDeps,
  type RouteDef,
} from "../meta/pipeline.js";

export const LABEL_FRIENDLY_ERROR = "The room labeller couldn't answer just now. Please try again.";

export const LABEL_MAX_PHOTOS = 4;

/** Rejected when the JSON body is bigger than this (bytes). */
export const LABEL_MAX_BODY_BYTES = 1024 * 1024;

/** Rejected when a photo decodes to more than this (bytes). */
export const LABEL_MAX_IMAGE_BYTES = 1024 * 1024;

export const LABEL_WALLS = ["A", "B", "C", "D"] as const;

export interface RoomLabelPhotoInput {
  wall: string;
  image: string;
}

export interface RoomLabelRouteInput {
  photos: RoomLabelPhotoInput[];
}

function parseRoomLabelBody(body: unknown): ParsedBody | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Expected a JSON object with one to four wall photos." };
  }
  if (JSON.stringify(body).length > LABEL_MAX_BODY_BYTES) {
    return { error: "The photos must fit in 1 MB." };
  }
  const photos = (body as Record<string, unknown>)["photos"];
  if (!Array.isArray(photos) || photos.length < 1 || photos.length > LABEL_MAX_PHOTOS) {
    return { error: "Expected one to four wall photos." };
  }
  const seen = new Set<string>();
  const input: RoomLabelRouteInput = { photos: [] };
  for (const entry of photos) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { error: "Each photo needs a wall letter and a JPEG image." };
    }
    const record = entry as Record<string, unknown>;
    const wall = record["wall"];
    if (typeof wall !== "string" || !(LABEL_WALLS as readonly string[]).includes(wall)) {
      return { error: "Each photo wall is a letter A to D." };
    }
    if (seen.has(wall)) {
      return { error: "Each wall letter appears once." };
    }
    seen.add(wall);
    const size = jpegDataUrlSize(record["image"]);
    if (size === null) {
      return { error: "Each photo must be a JPEG data URL." };
    }
    if (size > LABEL_MAX_IMAGE_BYTES) {
      return { error: "Each photo must decode to at most 1 MB." };
    }
    input.photos.push({ wall, image: record["image"] as string });
  }
  return { input };
}

/**
 * Key input for the demo store, cache and caps: the photos' SHA-256 hexes
 * (of the image strings) with their letters, sorted by letter so photo
 * order never changes the key. Exported so `check:room-api` can name the
 * same keys the pipeline reads.
 */
export async function roomLabelKeyInput(input: unknown): Promise<unknown> {
  const record = input as Partial<RoomLabelRouteInput>;
  const photos = Array.isArray(record["photos"]) ? record["photos"] : [];
  const hashed = await Promise.all(
    photos.map(async (photo) => ({
      wall: typeof photo["wall"] === "string" ? photo["wall"] : "",
      image: typeof photo["image"] === "string" ? await sha256HexAsync(photo["image"]) : "",
    })),
  );
  hashed.sort((a, b) => (a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : 0));
  return { photos: hashed };
}

const LABEL_SYSTEM_PROMPT = [
  "You label a room's photos for a furniture app.",
  "Each photo shows one wall: A is the wall with the entrance door, then B, C and D clockwise.",
  "Label only what the photos show: overall style, the floor and wall families, and per photo",
  "how many doors, open doorways, windows, glass doors and lookalikes are visible",
  "(lookalikes: mirrors, pictures or screens that could pass for an opening).",
  "Write each style tag as one to three lowercase words of at most 30 characters.",
  "Write each dominant colour as a 6-digit hex colour like #c8a27a.",
  "Keep the floor and wall descriptions each to one short phrase of at most 120 characters.",
  "End with one plain uncertain sentence, or Nothing. when nothing was uncertain.",
  "Never locate or measure anything: no positions, sizes, distances or coordinates.",
  "Answer with exactly the requested JSON object and nothing else.",
].join(" ");

function userText(photos: RoomLabelPhotoInput[]): string {
  const letters = photos.map((photo) => photo.wall).join(", ");
  return (
    `Label these ${String(photos.length)} room photo(s) (walls ${letters}; ` +
    "A is the wall with the entrance door, then clockwise). " +
    "Answer with exactly the requested JSON object."
  );
}

/** Sum of token usage over every attempt: every billed call is metered. */
function addUsage(first: TokenUsage, second: TokenUsage): TokenUsage {
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    cachedInputTokens: first.cachedInputTokens + second.cachedInputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    images: first.images + second.images,
  };
}

async function callLabeller(apiKey: string, input: RoomLabelRouteInput): Promise<UpstreamResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: LABEL_SYSTEM_PROMPT },
    { role: "user", content: userText(input.photos) },
  ];
  const walls = input.photos.map((photo) => photo.wall);
  let billed = emptyUsage();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await callSpark(apiKey, {
      messages,
      images: input.photos.map((photo) => photo.image),
      jsonSchema: {
        name: "room-label",
        schema: ROOM_LABEL_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      },
      maxTokens: 8000,
      reasoningEffort: "low",
    });
    billed = addUsage(billed, result.usage);
    const text =
      typeof result.data === "object" && result.data !== null
        ? String((result.data as Record<string, unknown>)["text"] ?? "")
        : "";
    const parsed = parseModelJson(text);
    if (parsed === null) {
      // Not JSON: retry once, then fail.
      if (attempt === 0) continue;
      break;
    }
    const normalized = normalizeRoomLabelAnswer(parsed, walls);
    if (normalized !== null) {
      return { data: normalized, usage: billed };
    }
    // Valid JSON but unusable: retry only when cut off by `max_tokens`.
    if (result.finishReason === "length" && attempt === 0) continue;
    break;
  }
  throw new UpstreamFriendlyError(LABEL_FRIENDLY_ERROR, billed);
}

export const labelDef: RouteDef = {
  route: "label",
  model: META_MODELS.spark,
  liveReady: true,
  parseBody: parseRoomLabelBody,
  keyInput: roomLabelKeyInput,
  upstream: async (apiKey: string, input: unknown): Promise<UpstreamResult> =>
    callLabeller(apiKey, input as RoomLabelRouteInput),
};

export function roomLabelRoutes(deps: PipelineDeps): Hono {
  const app = new Hono();
  app.post("/room/label", (c) => serveGatewayRequest(c, deps, labelDef));
  return app;
}
