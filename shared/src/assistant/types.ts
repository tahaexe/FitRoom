/**
 * Assistant contracts: the `POST /api/assistant` body (one round of the
 * layout conversation), one model round's answer, and their validators.
 *
 * One `/api/assistant` call is one model round: the client sends the whole
 * conversation plus the current draft scene, the server adds the pasted
 * system prompt and the tool schemas and calls Muse Spark once with `tools`.
 * The answer either carries tool calls (the client executes them on a draft
 * copy and sends the results back as tool messages) or final text. The loop
 * runs at most 8 rounds per turn.
 */

import type { RoomLayout, SceneState } from "../types.js";
import { validateRoomLayout, validateSceneState } from "../validate.js";

/** One call the model wants executed on the draft scene. */
export interface AssistantToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** One conversation entry. Tool results travel as `tool` messages. */
export interface AssistantMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: AssistantToolCall[];
  toolCallId?: string;
  name?: string;
}

/** Canonical `POST /api/assistant` body (plus `live`). */
export interface AssistantRequest {
  /** The customer's plain-language request (stable across rounds). */
  request: string;
  /** The conversation so far (starts with the request as a user message). */
  messages: AssistantMessage[];
  /** The room the draft lives in. */
  room: RoomLayout;
  /** The current draft scene (evolves as tools run). */
  scene: SceneState;
}

/** One model round: final text, plus tool calls when the turn continues. */
export interface AssistantRoundData {
  text: string;
  toolCalls: AssistantToolCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolCall(value: unknown): value is AssistantToolCall {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["name"] === "string" &&
    isRecord(value["arguments"])
  );
}

function messageError(message: unknown): string | null {
  if (!isRecord(message)) return "Each message needs a role and content.";
  if (message["role"] !== "user" && message["role"] !== "assistant" && message["role"] !== "tool") {
    return "Each message role is user, assistant or tool.";
  }
  if (typeof message["content"] !== "string") return "Each message needs a string content.";
  if (message["toolCalls"] !== undefined) {
    if (!Array.isArray(message["toolCalls"]) || !message["toolCalls"].every(isToolCall)) {
      return "Message toolCalls must be tool calls with id, name and arguments.";
    }
  }
  if (message["toolCallId"] !== undefined && typeof message["toolCallId"] !== "string") {
    return "Message toolCallId must be a string.";
  }
  if (message["name"] !== undefined && typeof message["name"] !== "string") {
    return "Message name must be a string.";
  }
  return null;
}

/** Friendly reason why an assistant request body is invalid, or null. */
export function assistantRequestError(body: unknown): string | null {
  if (!isRecord(body)) return "Expected a JSON object with request, messages, room and scene.";
  if (typeof body["request"] !== "string" || body["request"].trim().length === 0) {
    return "The request needs the customer's text.";
  }
  if (body["request"].length > 2000) {
    return "The request must be at most 2000 characters.";
  }
  if (!Array.isArray(body["messages"]) || body["messages"].length === 0) {
    return "The conversation needs at least one message.";
  }
  for (const message of body["messages"]) {
    const problem = messageError(message);
    if (problem !== null) return problem;
  }
  const room = validateRoomLayout(body["room"]);
  if (!room.ok) return `The room is invalid: ${room.errors[0]?.message ?? "unknown problem"}.`;
  const scene = validateSceneState(body["scene"]);
  if (!scene.ok) return `The scene is invalid: ${scene.errors[0]?.message ?? "unknown problem"}.`;
  return null;
}

export function isAssistantRequest(body: unknown): body is AssistantRequest {
  return assistantRequestError(body) === null;
}

/** True for a well-formed model round (text, optional tool calls). */
export function isAssistantRoundData(data: unknown): data is AssistantRoundData {
  if (!isRecord(data)) return false;
  if (typeof data["text"] !== "string") return false;
  if (!Array.isArray(data["toolCalls"])) return false;
  return data["toolCalls"].every(isToolCall);
}
