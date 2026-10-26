/**
 * Friendly validators for the recommend request and answer: the server
 * answers HTTP 400 with the first problem when the request is invalid, and
 * retries the model once when the answer is invalid.
 */

import type { RecommendAnswer, RecommendRequest } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNumberPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

function isNumberTriple(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    typeof value[2] === "number"
  );
}

/** Friendly reason why a recommend request body is invalid, or null. */
export function recommendRequestError(body: unknown): string | null {
  if (!isRecord(body)) return "Expected a JSON object with room, request and candidates.";
  const room = body["room"];
  if (!isRecord(room)) return "Expected a JSON object with room, request and candidates.";
  if (typeof room["name"] !== "string" || room["name"].length === 0) {
    return "The room needs a name.";
  }
  if (!isNumberPair(room["size_cm"])) return "The room needs size_cm as [width, depth].";
  if (!isRecord(room["style"])) return "The room needs a style with tags and colors.";
  if (!isStringArray(room["style"]["tags"]) || !isStringArray(room["style"]["colors"])) {
    return "The room style needs tags and colors arrays.";
  }
  const placed = body["placed"];
  if (!Array.isArray(placed)) return "Expected a placed items array.";
  for (const entry of placed) {
    if (
      !isRecord(entry) ||
      typeof entry["productId"] !== "string" ||
      typeof entry["name"] !== "string" ||
      !isStringArray(entry["colors"])
    ) {
      return "Each placed item needs productId, name and colors.";
    }
  }
  const query = body["request"];
  if (!isRecord(query)) return "Expected a request with a category.";
  if (typeof query["category"] !== "string" || query["category"].length === 0) {
    return "The request needs a category.";
  }
  if (query["budget_usd"] !== undefined) {
    if (typeof query["budget_usd"] !== "number" || query["budget_usd"] < 0) {
      return "The budget_usd must be a number of at least 0.";
    }
  }
  if (query["spot"] !== undefined) {
    const spot = query["spot"];
    if (
      !isRecord(spot) ||
      typeof spot["wall"] !== "string" ||
      typeof spot["start_cm"] !== "number" ||
      typeof spot["end_cm"] !== "number"
    ) {
      return "The spot needs a wall, start_cm and end_cm.";
    }
  }
  const freeSpace = body["freeSpace"];
  if (
    !isRecord(freeSpace) ||
    !Array.isArray(freeSpace["runs"]) ||
    !Array.isArray(freeSpace["openAreas"])
  ) {
    return "Expected freeSpace with runs and openAreas arrays.";
  }
  const candidates = body["candidates"];
  if (!Array.isArray(candidates)) return "Expected a candidates array.";
  for (const entry of candidates) {
    if (
      !isRecord(entry) ||
      typeof entry["productId"] !== "string" ||
      typeof entry["name"] !== "string" ||
      !isNumberTriple(entry["size_cm"]) ||
      typeof entry["price_usd"] !== "number" ||
      !isStringArray(entry["styleTags"]) ||
      !isStringArray(entry["colors"]) ||
      !isRecord(entry["spot"])
    ) {
      return "Each candidate needs productId, name, size_cm, price_usd, styleTags, colors and a spot.";
    }
    const spot = entry["spot"] as Record<string, unknown>;
    if (spot["kind"] !== "run" && spot["kind"] !== "area") {
      return "Each candidate spot needs kind run or area.";
    }
    if (typeof spot["spare_cm"] !== "number" || !isNumberPair(spot["centre_cm"])) {
      return "Each candidate spot needs spare_cm and centre_cm.";
    }
    if (typeof spot["rotationY"] !== "number") {
      return "Each candidate spot needs a rotationY.";
    }
  }
  return null;
}

export function isRecommendRequest(body: unknown): body is RecommendRequest {
  return recommendRequestError(body) === null;
}

/** Friendly reason why a model answer is invalid, or null when it is fine. */
export function recommendAnswerError(data: unknown): string | null {
  if (!isRecord(data)) return "The answer is not a JSON object.";
  const list = data["recommendations"];
  if (!Array.isArray(list)) return "The answer needs a recommendations array.";
  if (list.length > 3) return "The answer ranks at most 3 candidates.";
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry["productId"] !== "string") {
      return "Each recommendation needs a productId.";
    }
    if (typeof entry["reason"] !== "string" || entry["reason"].length === 0) {
      return "Each recommendation needs a reason.";
    }
    if (entry["reason"].length > 140) {
      return "Each reason is at most 140 characters.";
    }
    if (
      typeof entry["styleMatch"] !== "number" ||
      !(entry["styleMatch"] >= 0 && entry["styleMatch"] <= 1)
    ) {
      return "Each styleMatch is a number from 0 to 1.";
    }
  }
  if (data["note"] !== undefined) {
    if (typeof data["note"] !== "string" || data["note"].length > 160) {
      return "The note is at most 160 characters.";
    }
  }
  return null;
}

export function isRecommendAnswer(data: unknown): data is RecommendAnswer {
  return recommendAnswerError(data) === null;
}

/** Parse model text (possibly fenced) to JSON, or null. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const raw = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
