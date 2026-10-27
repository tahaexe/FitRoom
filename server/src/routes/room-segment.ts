/**
 * `POST /api/room/segment` — one room photo segmented with SAM 3.1, one
 * concept per request, over the shared gateway pipeline.
 *
 * Body: `{ image, concept }` with `image` a JPEG data URL (the client sends
 * at most 1280 px on the long side; the server rejects anything that is not
 * JPEG or decodes to over 1 MB) and `concept` one of `wall`, `floor`,
 * `ceiling`, `door`, `window`. The server makes one SAM request and answers
 * `data: { concept, text }`, where `text` is the segmentation output text.
 * The server never decodes masks (the Worker has 10 ms of CPU per request):
 * the client turns the text into instances with `@meta-sam/parser`.
 *
 * Cost and caps: one metering line per SAM request (`images: 1`, USD from
 * the pricing table). A SAM request weighs 0.2 of a call toward the
 * session call cap and the per-IP rate limit (a photo's five concepts make
 * one call); its USD counts in full toward the session and global USD caps.
 * Cache is per key; a text over 512 KB is returned but not cached. Segment
 * answers are never added to the bundled demo store (size): in demo mode
 * the route answers `demo-miss` like any unknown request.
 */

import { Hono } from "hono";
import { callSam, extractSamOutputText, type UpstreamResult } from "../meta/client.js";
import { UpstreamFriendlyError } from "../meta/errors.js";
import { decodeJpegDataUrl } from "../meta/images.js";
import { sha256Hex } from "../meta/keys.js";
import { META_MODELS } from "../meta/models.js";
import {
  serveGatewayRequest,
  type ParsedBody,
  type PipelineDeps,
  type RouteDef,
} from "../meta/pipeline.js";

export { extractSamOutputText };

export const SEGMENT_FRIENDLY_ERROR =
  "The room scanner couldn't segment that photo just now. Please try again.";

export const ROOM_SEGMENT_CONCEPTS = ["wall", "floor", "ceiling", "door", "window"] as const;

export type RoomSegmentConcept = (typeof ROOM_SEGMENT_CONCEPTS)[number];

/** Rejected when the decoded JPEG is bigger than this (bytes). */
export const SEGMENT_MAX_IMAGE_BYTES = 1024 * 1024;

/** A longer text is returned but not cached (bytes). */
export const SEGMENT_MAX_CACHED_TEXT_BYTES = 512 * 1024;

/** A SAM request weighs this much of a call toward the caps. */
export const SEGMENT_CALL_WEIGHT = 0.2;

export interface RoomSegmentInput {
  concept: string;
  imageDataUrl: string;
}

function parseRoomSegmentBody(body: unknown): ParsedBody | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Expected a JSON object with an image and a concept." };
  }
  const record = body as Record<string, unknown>;
  const concept = record["concept"];
  if (
    typeof concept !== "string" ||
    !(ROOM_SEGMENT_CONCEPTS as readonly string[]).includes(concept)
  ) {
    return { error: "The concept is wall, floor, ceiling, door or window." };
  }
  const bytes = decodeJpegDataUrl(record["image"]);
  if (bytes === null) {
    return { error: "The image must be a JPEG data URL." };
  }
  if (bytes.length > SEGMENT_MAX_IMAGE_BYTES) {
    return { error: "The image must decode to at most 1 MB." };
  }
  const input: RoomSegmentInput = {
    concept,
    imageDataUrl: record["image"] as string,
  };
  return { input };
}

/**
 * Key input for the demo store, cache and caps: the concept plus the
 * SHA-256 hex of the image string (Web Crypto digest), never image bytes.
 * Exported so `check:room-api` can name the same keys the pipeline reads.
 */
export function roomSegmentKeyInput(input: unknown): unknown {
  const record = input as Partial<RoomSegmentInput>;
  return {
    concept: typeof record["concept"] === "string" ? record["concept"] : "",
    image: typeof record["imageDataUrl"] === "string" ? sha256Hex(record["imageDataUrl"]) : "",
  };
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export const segmentDef: RouteDef = {
  route: "segment",
  model: META_MODELS.sam,
  liveReady: true,
  callWeight: SEGMENT_CALL_WEIGHT,
  parseBody: parseRoomSegmentBody,
  keyInput: roomSegmentKeyInput,
  cacheable: (data: unknown) => {
    if (typeof data !== "object" || data === null) return false;
    const text = (data as Record<string, unknown>)["text"];
    return typeof text === "string" && utf8Length(text) <= SEGMENT_MAX_CACHED_TEXT_BYTES;
  },
  upstream: async (apiKey: string, input: unknown): Promise<UpstreamResult> => {
    const record = input as Partial<RoomSegmentInput>;
    const concept = typeof record["concept"] === "string" ? record["concept"] : "";
    const imageDataUrl = typeof record["imageDataUrl"] === "string" ? record["imageDataUrl"] : "";
    if (concept === "" || imageDataUrl === "") {
      throw new UpstreamFriendlyError(SEGMENT_FRIENDLY_ERROR, {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        images: 1,
      });
    }
    return callSam(apiKey, { concept, imageDataUrl });
  },
};

export function roomSegmentRoutes(deps: PipelineDeps): Hono {
  const app = new Hono();
  app.post("/room/segment", (c) => serveGatewayRequest(c, deps, segmentDef));
  return app;
}
