/**
 * Turn driver pieces shared by the client panel, the demo recorder and the
 * headless check: executing one round's tool calls on a draft, the tool
 * messages for the next round, and the end-of-turn summary plus fit verdict.
 *
 * A turn's draft starts as a copy of the live scene. At most 8 rounds per
 * turn; at the limit the last fit-clean draft wins (or none when every draft
 * has errors). A draft with fit errors is never applied.
 */

import { checkFit, footprintOf } from "../fit.js";
import type { CatalogItem, FitIssue, RoomLayout, SceneItem, SceneState } from "../types.js";
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
    catalog.map((c) => [c.id, { size: { ...c.size }, category: c.category, name: c.name }]),
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
    catalog.map((c) => [c.id, { size: { ...c.size }, category: c.category, name: c.name }]),
  );
  return checkFit(room, scene, products).filter((issue) => issue.severity === "error");
}

/** Short fit verdict in shopper words. */
export function assistantFitVerdict(errors: FitIssue[]): string {
  if (errors.length === 0) return "Everything fits.";
  if (errors.length === 1) return "1 problem left.";
  return `${String(errors.length)} problems left.`;
}

function itemName(byId: Map<string, CatalogItem>, productId: string): string {
  return byId.get(productId)?.name ?? productId;
}

/** Compass word for a rotationY (0 faces north, 90 east, 180 south, 270 west). */
function compassFacing(degrees: number): string {
  const q = ((Math.round(degrees) % 360) + 360) % 360;
  if (q < 45 || q >= 315) return "north";
  if (q < 135) return "east";
  if (q < 225) return "south";
  return "west";
}

function pointSegmentDistance(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz || 1;
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/**
 * Shopper-words place for one item: under a window, against a wall, beside
 * the nearest piece, or in the middle of the room. Never coordinates. A wall
 * or window landmark only reads when the piece's back faces that wall (its
 * front points into the room) and the gap is at most 30 cm; otherwise the
 * next landmark rule applies (neighbouring piece, else the middle of the
 * room). Two pieces of one product are told apart ("the first one", "the new
 * one", "the other one").
 */
function describePlace(
  room: RoomLayout,
  scene: SceneState,
  item: SceneItem,
  byId: Map<string, CatalogItem>,
  addedIds: ReadonlySet<string> = new Set(),
): string {
  const entry = byId.get(item.productId);
  const size = entry === undefined ? { w: 60, d: 60, h: 60 } : entry.size;
  const box = footprintOf(size, item.position, item.rotationY);
  const corners = [
    { x: box.x0, z: box.z0 },
    { x: box.x1, z: box.z0 },
    { x: box.x1, z: box.z1 },
    { x: box.x0, z: box.z1 },
  ];
  let near: { wallId: string; offset: number } | null = null;
  let nearDist = Infinity;
  for (const wall of room.walls) {
    let dist = Infinity;
    for (const corner of corners) {
      dist = Math.min(
        dist,
        pointSegmentDistance(
          corner.x,
          corner.z,
          wall.start.x,
          wall.start.z,
          wall.end.x,
          wall.end.z,
        ),
      );
    }
    if (dist < nearDist) {
      nearDist = dist;
      const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z) || 1;
      near = {
        wallId: wall.id,
        offset:
          ((item.position.x - wall.start.x) * (wall.end.x - wall.start.x) +
            (item.position.z - wall.start.z) * (wall.end.z - wall.start.z)) /
          len,
      };
    }
  }
  // A wall or window landmark only reads when the piece's back faces that
  // wall (its front points into the room, within 60 degrees) with at most
  // 30 cm of gap; otherwise the neighbouring piece below wins.
  if (near !== null && nearDist <= 30) {
    const wallId: string = near.wallId;
    const offset: number = near.offset;
    const wall = room.walls.find((w) => w.id === wallId);
    if (wall !== undefined) {
      const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z) || 1;
      const ux = (wall.end.x - wall.start.x) / len;
      const uz = (wall.end.z - wall.start.z) / len;
      const mx = (wall.start.x + wall.end.x) / 2;
      const mz = (wall.start.z + wall.end.z) / 2;
      let cx = 0;
      let cz = 0;
      for (const w of room.walls) {
        cx += (w.start.x + w.end.x) / 2;
        cz += (w.start.z + w.end.z) / 2;
      }
      cx /= Math.max(1, room.walls.length);
      cz /= Math.max(1, room.walls.length);
      // One of the two wall perpendiculars points into the room (towards
      // the centroid); the piece's back faces the wall when its front
      // points that way.
      const towardX = cx - mx;
      const towardZ = cz - mz;
      const s = towardX * -uz + towardZ * ux >= 0 ? 1 : -1;
      const inwardX = -uz * s;
      const inwardZ = ux * s;
      const rad = (item.rotationY * Math.PI) / 180;
      const facingX = Math.sin(rad);
      const facingZ = Math.cos(rad);
      const backToWall = facingX * inwardX + facingZ * inwardZ >= 0.5;
      if (backToWall) {
        const name = wallDisplayName(room, wallId);
        const opening = room.openings.find(
          (candidate) =>
            candidate.wallId === wallId &&
            candidate.type === "window" &&
            offset >= candidate.offset &&
            offset <= candidate.offset + candidate.width,
        );
        if (opening !== undefined && opening.type === "window") {
          if (entry !== undefined && entry.size.h < opening.sillHeight) {
            return name.includes("window") ? "under the window" : `under the window on the ${name}`;
          }
          return `in front of the window on the ${name}`;
        }
        return `against the ${name}`;
      }
    }
  }
  let nearest: SceneItem | null = null;
  let nearestDist = 170;
  for (const other of scene.items) {
    if (other.instanceId === item.instanceId) continue;
    if (byId.get(other.productId) === undefined) continue;
    const dist = Math.hypot(other.position.x - item.position.x, other.position.z - item.position.z);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = other;
    }
  }
  if (nearest !== null) {
    const candidate = byId.get(nearest.productId);
    if (candidate !== undefined && nearest.productId === item.productId) {
      if (addedIds.has(item.instanceId)) return "beside the first one";
      if (addedIds.has(nearest.instanceId)) return "beside the new one";
      return "beside the other one";
    }
    if (candidate !== undefined) return `beside the ${candidate.name}`;
  }
  return "in the middle of the room";
}

/**
 * One-line summary of what changed between two scenes, plus the fit verdict.
 * Places are shopper words (walls, windows, neighbouring pieces) — never
 * coordinates. The collapsible "What I did" list keeps the exact tool calls.
 */
export function summarizeAssistantTurn(
  start: SceneState,
  end: SceneState,
  room: RoomLayout,
  catalog: CatalogItem[],
): string {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const parts: string[] = [];
  const before = new Map(start.items.map((i) => [i.instanceId, i]));
  const after = new Map(end.items.map((i) => [i.instanceId, i]));
  const addedIds = new Set<string>();
  const addedProducts = new Set<string>();
  const siblings = new Map<string, number>();
  for (const item of end.items) {
    siblings.set(item.productId, (siblings.get(item.productId) ?? 0) + 1);
    if (!before.has(item.instanceId)) {
      addedIds.add(item.instanceId);
      addedProducts.add(item.productId);
    }
  }
  // Two pieces of one product are told apart: the added one is "the new
  // X", a moved earlier one is "the first X" (or "the other X" when nothing
  // was added). Single pieces keep their plain name.
  const subjectName = (item: SceneItem, prev: SceneItem | undefined): string => {
    const name = itemName(byId, item.productId);
    if ((siblings.get(item.productId) ?? 0) < 2) return name;
    if (prev === undefined) return `the new ${name}`;
    if (addedProducts.has(item.productId)) return `the first ${name}`;
    return `the other ${name}`;
  };
  for (const item of end.items) {
    const prev = before.get(item.instanceId);
    if (prev === undefined) {
      parts.push(
        `Added ${subjectName(item, prev)} ${describePlace(room, end, item, byId, addedIds)} facing ${compassFacing(item.rotationY)}`,
      );
      continue;
    }
    const moved = prev.position.x !== item.position.x || prev.position.z !== item.position.z;
    const turned = prev.rotationY !== item.rotationY;
    if (prev.productId !== item.productId) {
      parts.push(
        `Swapped ${itemName(byId, prev.productId)} for ${itemName(byId, item.productId)} ${describePlace(room, end, item, byId, addedIds)}`,
      );
    } else if (moved && turned) {
      parts.push(
        `Moved ${subjectName(item, prev)} ${describePlace(room, end, item, byId, addedIds)}, facing ${compassFacing(item.rotationY)}`,
      );
    } else if (moved) {
      parts.push(
        `Moved ${subjectName(item, prev)} ${describePlace(room, end, item, byId, addedIds)}`,
      );
    } else if (turned) {
      parts.push(`Turned ${subjectName(item, prev)} to face ${compassFacing(item.rotationY)}`);
    } else if (prev.variant !== item.variant) {
      parts.push(`Changed ${subjectName(item, prev)} to ${item.variant}`);
    }
  }
  for (const item of start.items) {
    if (!after.has(item.instanceId)) {
      parts.push(`Removed ${itemName(byId, item.productId)}`);
    }
  }
  if (parts.length === 0)
    return `No changes. ${assistantFitVerdict(turnErrors(room, end, catalog))}`;
  // Every clause after a semicolon starts in lower case.
  const sentence = parts
    .map((part, index) => (index === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1)))
    .join("; ");
  return `${sentence}. ${assistantFitVerdict(turnErrors(room, end, catalog))}`;
}

function displayValue(room: RoomLayout, value: unknown): string {
  // Shopper names only: a wall reads "Left wall", an opening "door on the
  // Door wall" — never ids like `wall-4` or `door-1`.
  if (typeof value === "string" && room.walls.some((w) => w.id === value)) {
    return wallDisplayName(room, value);
  }
  if (typeof value === "string") {
    const opening = room.openings.find((o) => o.id === value);
    if (opening !== undefined) {
      return `${opening.type} on ${wallDisplayName(room, opening.wallId)}`;
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
  // One verdict per line: `fits` already carries the issues count, so a
  // result holding both prints it only once.
  const issues = Array.isArray(result["issues"]) ? result["issues"] : null;
  const errorCount = (list: unknown[]): number =>
    list.filter(
      (i) =>
        typeof i === "object" &&
        i !== null &&
        (i as Record<string, unknown>)["severity"] === "error",
    ).length;
  if (typeof result["fits"] === "boolean") {
    if (result["fits"] === true) {
      parts.push("fits");
    } else {
      parts.push(`${String(errorCount(issues ?? []))} issue(s)`);
    }
  } else if (issues !== null) {
    const errors = errorCount(issues);
    parts.push(errors === 0 ? "fits" : `${String(errors)} issue(s)`);
  }
  return parts.join(" ");
}

/**
 * A placement refused because the item does not fit: the `doesNotFit` tool
 * result with both lengths (matched by marker, falling back to the
 * "does not fit" wording for older entries). The first such refusal of a
 * turn, or null when the turn has none.
 */
export interface DoesNotFitRefusal {
  error: string;
  /** Item length in cm, when the result carries it. */
  needCm: number | null;
  /** Free stretch length in cm, when the result carries it. */
  freeCm: number | null;
}

export function impossibleRefusal(records: AssistantToolRecord[]): DoesNotFitRefusal | null {
  for (const record of records) {
    const result = record.result;
    if (result["doesNotFit"] === true) {
      const need = result["needCm"];
      const free = result["freeCm"];
      return {
        error: String(result["error"] ?? "It does not fit there."),
        needCm: typeof need === "number" && Number.isFinite(need) ? need : null,
        freeCm: typeof free === "number" && Number.isFinite(free) ? free : null,
      };
    }
    if (
      result["ok"] === false &&
      typeof result["error"] === "string" &&
      /does not fit/i.test(result["error"])
    ) {
      return { error: result["error"], needCm: null, freeCm: null };
    }
  }
  return null;
}

/** Rounded integers naming a length, so "273.1 cm" still matches "273". */
function lengthNames(value: number): string[] {
  const names = new Set<string>([String(value), String(Math.round(value))]);
  return [...names];
}

/** True when the text names both refusal lengths (need and free). */
export function namesBothLengths(text: string, needCm: number, freeCm: number): boolean {
  const lower = text.toLowerCase();
  return (
    lengthNames(needCm).some((name) => lower.includes(name.toLowerCase())) &&
    lengthNames(freeCm).some((name) => lower.includes(name.toLowerCase()))
  );
}

/**
 * The shopper answer for a turn with a "does not fit" refusal: the model's
 * text when it names both lengths, else the refusal text followed by the
 * model's proposal. Null when the turn has no such refusal.
 */
export function impossibleAnswer(records: AssistantToolRecord[], modelText: string): string | null {
  const refusal = impossibleRefusal(records);
  if (refusal === null) return null;
  const proposal = modelText.trim();
  if (
    refusal.needCm !== null &&
    refusal.freeCm !== null &&
    namesBothLengths(proposal, refusal.needCm, refusal.freeCm)
  ) {
    return proposal;
  }
  return proposal === "" ? refusal.error : `${refusal.error} ${proposal}`;
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

/**
 * Free text with ids rewritten to shopper names: `wall-4` reads "Left
 * wall", "the door door-1" reads "the door", `window-2` reads "the window".
 * Display only — the executor's stored texts stay untouched, so demo keys
 * never change.
 */
export function withoutIds(room: RoomLayout, text: string): string {
  let out = text;
  for (const opening of room.openings) {
    if (opening.type === "door") {
      out = out.split(`the door ${opening.id}`).join("the door");
    } else {
      out = out.split(`window ${opening.id}`).join("the window");
    }
  }
  for (const wall of room.walls) {
    out = out.split(wall.id).join(wallDisplayName(room, wall.id));
  }
  for (const opening of room.openings) {
    out = out.split(opening.id).join(`${opening.type} on ${wallDisplayName(room, opening.wallId)}`);
  }
  return out;
}

function decapitalized(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

function round1Cm(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * One "Not placed" line per refused tool call (ok false: budget, wall
 * stretch, mount and "does not fit" refusals place nothing). A refusal with
 * both lengths reads them both ("Not placed: Heritage Grand Sofa, it needs
 * 273.1 cm but the free stretch is only 30 cm."). Placed calls return no
 * lines: their single short result above already carries the verdict.
 */
export function vetoLinesForRecord(
  room: RoomLayout,
  catalog: CatalogItem[],
  record: AssistantToolRecord,
): string[] {
  if (record.result["ok"] !== false) return [];
  const args = record.args;
  let name = "the piece";
  const productId = args["productId"];
  if (typeof productId === "string") {
    name = catalog.find((c) => c.id === productId)?.name ?? productId;
  }
  const need = record.result["needCm"];
  const free = record.result["freeCm"];
  if (
    record.result["doesNotFit"] === true &&
    typeof need === "number" &&
    Number.isFinite(need) &&
    typeof free === "number" &&
    Number.isFinite(free)
  ) {
    return [
      `Not placed: ${name}, it needs ${String(round1Cm(need))} cm ` +
        `but the free stretch is only ${String(round1Cm(free))} cm.`,
    ];
  }
  const raw =
    typeof record.result["error"] === "string" && record.result["error"].length > 0
      ? record.result["error"]
      : "it does not fit there.";
  return [`Not placed: ${name}, ${decapitalized(withoutIds(room, raw.trim()))}`];
}

/**
 * The answer card's paragraphs: the model's answer, plus the composed
 * summary — except at the round cap, where the answer already is the
 * summary and must read once, not twice.
 */
export function answerParagraphs(answer: string, summary: string): string[] {
  if (summary === answer) return [answer];
  return [answer, summary];
}
