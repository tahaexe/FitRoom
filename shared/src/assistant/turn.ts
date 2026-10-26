/**
 * Turn driver pieces shared by the client panel, the demo recorder and the
 * headless check: executing one round's tool calls on a draft, the tool
 * messages for the next round, and the end-of-turn summary plus fit verdict.
 *
 * A turn's draft starts as a copy of the live scene. At most 8 rounds per
 * turn; at the limit the last fit-clean draft wins (or none when every draft
 * has errors). A draft with fit errors is never applied.
 */

import { checkFit } from "../fit.js";
import type { CatalogItem, FitIssue, RoomLayout, SceneState } from "../types.js";
import { wallDisplayName } from "../recommend/walls.js";
import { executeAssistantTool, type AssistantContext } from "./executor.js";
import type { AssistantMessage, AssistantToolCall } from "./types.js";

/** At most 8 model rounds per turn. */
export const ASSISTANT_MAX_ROUNDS = 8;

/** One executed call: name, arguments and the executor's result. */
export interface AssistantToolRecord {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

/** Execute one round's tool calls on the draft, in order. */
export function executeTurnRound(
  ctx: AssistantContext,
  draft: SceneState,
  toolCalls: AssistantToolCall[],
): AssistantToolRecord[] {
  return toolCalls.map((call) => ({
    name: call.name,
    args: call.arguments,
    result: executeAssistantTool(ctx, draft, call.name, call.arguments),
  }));
}

/** Tool messages carrying one round's results back to the model. */
export function assistantToolMessages(
  toolCalls: AssistantToolCall[],
  records: AssistantToolRecord[],
): AssistantMessage[] {
  return toolCalls.map((call, index) => ({
    role: "tool" as const,
    content: JSON.stringify(records[index]?.result ?? { ok: false, error: "No result." }),
    toolCallId: call.id,
    name: call.name,
  }));
}

/** True when the draft has no fit error (warnings are fine). */
export function isFitClean(room: RoomLayout, scene: SceneState, catalog: CatalogItem[]): boolean {
  const products = new Map(
    catalog.map((c) => [c.id, { size: { ...c.size }, category: c.category }]),
  );
  return checkFit(room, scene, products).every((issue) => issue.severity !== "error");
}

/** Fit errors of a scene (for the verdict). */
export function turnErrors(
  room: RoomLayout,
  scene: SceneState,
  catalog: CatalogItem[],
): FitIssue[] {
  const products = new Map(
    catalog.map((c) => [c.id, { size: { ...c.size }, category: c.category }]),
  );
  return checkFit(room, scene, products).filter((issue) => issue.severity === "error");
}

/** Short fit verdict in shopper words. */
export function assistantFitVerdict(errors: FitIssue[]): string {
  if (errors.length === 0) return "Everything fits.";
  if (errors.length === 1) return "1 problem left.";
  return `${String(errors.length)} problems left.`;
}

function itemName(catalog: CatalogItem[], productId: string): string {
  return catalog.find((c) => c.id === productId)?.name ?? productId;
}

/**
 * One-line summary of what changed between two scenes, plus the fit verdict.
 * Positions stay numeric; walls (when named) use shopper names.
 */
export function summarizeAssistantTurn(
  start: SceneState,
  end: SceneState,
  room: RoomLayout,
  catalog: CatalogItem[],
): string {
  void room;
  const parts: string[] = [];
  const before = new Map(start.items.map((i) => [i.instanceId, i]));
  const after = new Map(end.items.map((i) => [i.instanceId, i]));
  for (const item of end.items) {
    const prev = before.get(item.instanceId);
    if (prev === undefined) {
      parts.push(
        `Added ${itemName(catalog, item.productId)} at (${String(Math.round(item.position.x))}, ${String(Math.round(item.position.z))})`,
      );
    } else if (
      prev.position.x !== item.position.x ||
      prev.position.z !== item.position.z ||
      prev.rotationY !== item.rotationY
    ) {
      const moved = prev.position.x !== item.position.x || prev.position.z !== item.position.z;
      const turned = prev.rotationY !== item.rotationY;
      if (moved && turned) {
        parts.push(
          `Moved ${itemName(catalog, item.productId)} to (${String(Math.round(item.position.x))}, ${String(Math.round(item.position.z))}) facing ${String(Math.round(item.rotationY))}°`,
        );
      } else if (moved) {
        parts.push(
          `Moved ${itemName(catalog, item.productId)} to (${String(Math.round(item.position.x))}, ${String(Math.round(item.position.z))})`,
        );
      } else {
        parts.push(
          `Turned ${itemName(catalog, item.productId)} to ${String(Math.round(item.rotationY))}°`,
        );
      }
    } else if (prev.variant !== item.variant) {
      parts.push(`Set ${itemName(catalog, item.productId)} to ${item.variant}`);
    }
    if (prev !== undefined && prev.productId !== item.productId) {
      parts.push(
        `Swapped ${itemName(catalog, prev.productId)} for ${itemName(catalog, item.productId)}`,
      );
    }
  }
  for (const item of start.items) {
    if (!after.has(item.instanceId)) {
      parts.push(`Removed ${itemName(catalog, item.productId)}`);
    }
  }
  if (parts.length === 0)
    return `No changes. ${assistantFitVerdict(turnErrors(room, end, catalog))}`;
  return `${parts.join("; ")}. ${assistantFitVerdict(turnErrors(room, end, catalog))}`;
}

function displayValue(room: RoomLayout, value: unknown): string {
  if (typeof value === "string" && room.walls.some((w) => w.id === value)) {
    return `${value} (${wallDisplayName(room, value)})`;
  }
  if (typeof value === "string") {
    const opening = room.openings.find((o) => o.id === value);
    if (opening !== undefined) {
      return `${value} (${opening.type} on ${wallDisplayName(room, opening.wallId)})`;
    }
  }
  return JSON.stringify(value);
}

function shortResult(room: RoomLayout, result: Record<string, unknown>): string {
  if (result["ok"] === false) return `error: ${String(result["error"] ?? "failed")}`;
  const parts: string[] = [];
  if (typeof result["instanceId"] === "string") parts.push(`→ ${result["instanceId"] as string}`);
  const centre = result["centre"];
  if (
    typeof centre === "object" &&
    centre !== null &&
    typeof (centre as Record<string, unknown>)["x"] === "number"
  ) {
    const c = centre as Record<string, unknown>;
    parts.push(`at (${String(c["x"])}, ${String(c["z"])})`);
  }
  if (typeof result["rotationY"] === "number") parts.push(`facing ${String(result["rotationY"])}°`);
  if (typeof result["variant"] === "string") parts.push(`variant ${result["variant"] as string}`);
  if (result["removed"] !== undefined) parts.push(`removed ${String(result["removed"])}`);
  const issues = result["issues"];
  if (Array.isArray(issues)) {
    const errors = issues.filter(
      (i) =>
        typeof i === "object" &&
        i !== null &&
        (i as Record<string, unknown>)["severity"] === "error",
    ).length;
    parts.push(errors === 0 ? "fits" : `${String(errors)} issue(s)`);
  }
  if (typeof result["fits"] === "boolean") {
    const list = Array.isArray(result["issues"]) ? (result["issues"] as unknown[]) : [];
    const errors = list.filter(
      (i) =>
        typeof i === "object" &&
        i !== null &&
        (i as Record<string, unknown>)["severity"] === "error",
    ).length;
    parts.push((result["fits"] as boolean) ? "fits" : `${String(errors)} issue(s)`);
  }
  return parts.join(" ");
}

/**
 * One collapsible-list line per tool call: name, arguments, result — with
 * shopper wall names wherever an id appears.
 */
export function formatAssistantToolRecord(room: RoomLayout, record: AssistantToolRecord): string {
  const args = Object.entries(record.args)
    .map(([key, value]) => `${key}=${displayValue(room, value)}`)
    .join(", ");
  return `${record.name}(${args}) ${shortResult(room, record.result)}`;
}
