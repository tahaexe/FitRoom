/**
 * The shared tool executor: runs one assistant tool call on a draft
 * SceneState (a deep copy owned by the caller), followed by the fit engine.
 * Pure TypeScript, no three.js — the client, the demo recorder and the headless
 * check all run the same code.
 *
 * Shopper-facing text (wall names, issue messages) uses the display names the
 * app already shows ("Door wall", "Back wall (window)", ...), never ids like
 * `wall-1`; tool arguments keep the ids.
 */

import { analyzeFreeSpace, backToWallRotationY } from "../recommend/free-space.js";
import { wallDisplayName } from "../recommend/walls.js";
import {
  checkFit,
  footprintOf,
  orientedFootprint,
  swingDoorIds,
  triggeredWindowId,
} from "../fit.js";
import type { CatalogItem, FitIssue, RoomLayout, SceneItem, SceneState } from "../types.js";
import { wallLengthCm } from "../units.js";
import {
  briefPricedTotal,
  briefSeatCount,
  briefStyleMatches,
  formatUsd,
  overBudgetError,
  type AssistantBrief,
} from "./brief.js";
import { isAssistantToolName } from "./tools.js";

export interface AssistantContext {
  room: RoomLayout;
  catalog: CatalogItem[];
  byId: Map<string, CatalogItem>;
  /** Furnishing brief for this turn (budget and style checks). */
  brief?: AssistantBrief;
  /** Instance ids placed in this turn: the brief's new pieces. */
  briefNewIds: Set<string>;
}

export function createAssistantContext(
  room: RoomLayout,
  catalog: CatalogItem[],
  brief?: AssistantBrief,
): AssistantContext {
  return {
    room,
    catalog,
    byId: new Map(catalog.map((c) => [c.id, c])),
    ...(brief === undefined ? {} : { brief }),
    briefNewIds: new Set<string>(),
  };
}

/** Priced total of the turn's new pieces still on the draft. */
function briefNewTotal(ctx: AssistantContext, draft: SceneState): number {
  return briefPricedTotal(
    ctx.catalog,
    draft.items.filter((item) => ctx.briefNewIds.has(item.instanceId)),
  );
}

/**
 * Refusal when a new piece would push the turn's new pieces past the brief
 * budget. Nothing changes. Removing a new piece frees its price.
 */
function budgetRefusal(
  ctx: AssistantContext,
  draft: SceneState,
  entry: CatalogItem,
): Record<string, unknown> | null {
  if (ctx.brief === undefined) return null;
  const total = briefNewTotal(ctx, draft);
  if (total + entry.price <= ctx.brief.budget) return null;
  return {
    ok: false,
    overBudget: true,
    error: overBudgetError(entry.name, entry.price, total, ctx.brief.budget),
  };
}

/**
 * One status line for a brief turn: seats in the room against the brief,
 * the new pieces' total against the budget, which new pieces match the
 * style.
 */
export function briefStatusLine(ctx: AssistantContext, draft: SceneState): string | null {
  if (ctx.brief === undefined) return null;
  const brief = ctx.brief;
  const seats = briefSeatCount(ctx.catalog, draft.items);
  const fresh = draft.items.filter((item) => ctx.briefNewIds.has(item.instanceId));
  const total = briefPricedTotal(ctx.catalog, fresh);
  const matched = fresh
    .map((item) => ctx.byId.get(item.productId))
    .filter(
      (entry): entry is CatalogItem =>
        entry !== undefined && briefStyleMatches(brief.style, entry.styleTags),
    )
    .map((entry) => entry.name);
  const styleWord = brief.style.charAt(0).toUpperCase() + brief.style.slice(1);
  return (
    `Seats ${String(seats)} of ${String(brief.seats)} · ` +
    `${formatUsd(total)} of ${formatUsd(brief.budget)} · ` +
    `${styleWord} match: ${matched.length === 0 ? "none" : matched.join(", ")}`
  );
}

/** Deep copy of a scene: the draft a turn works on. */
export function cloneScene(scene: SceneState): SceneState {
  return JSON.parse(JSON.stringify(scene)) as SceneState;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function needString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" ? value : null;
}

function needNumber(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function productsOf(
  ctx: AssistantContext,
): Map<string, { size: { w: number; d: number; h: number }; category: string; name: string }> {
  return new Map(
    ctx.catalog.map((c) => [c.id, { size: { ...c.size }, category: c.category, name: c.name }]),
  );
}

/** Exact cos/sin at multiples of 90° (mirrors the fit engine). */
function angleTrig(degrees: number): { cos: number; sin: number } {
  const q = ((degrees % 360) + 360) % 360;
  if (q === 0) return { cos: 1, sin: 0 };
  if (q === 90) return { cos: 0, sin: 1 };
  if (q === 180) return { cos: -1, sin: 0 };
  if (q === 270) return { cos: 0, sin: -1 };
  const rad = (degrees * Math.PI) / 180;
  return { cos: Math.cos(rad), sin: Math.sin(rad) };
}

function normalizeRotation(degrees: number): number {
  return round1(((degrees % 360) + 360) % 360);
}

/** Display name of the wall an opening/fixture sits on. */
function openingWallName(ctx: AssistantContext, wallId: string): string {
  return wallDisplayName(ctx.room, wallId);
}

/**
 * Short line ending every modifying tool result once the draft is fit-clean
 * (warnings are fine): the model's cue to answer when the request is done.
 * Advisory only — the gateway key strips it, so older demo-store entries
 * still match.
 */
export const ASSISTANT_READY_LINE =
  "No fit errors. If the request is done, answer the customer now.";

/**
 * Fit issue in shopper words: display wall names, never opening ids. Walkway
 * issues name the item blocking the way plus the push that frees it (found by
 * trying the check without each item); pass the draft for that detail, or
 * omit it for the generic text.
 */
/**
 * Footprint of a draft item for door/window lookups (null when unknown).
 */
function draftFootprint(
  ctx: AssistantContext,
  draft: SceneState,
  instanceId: string,
): { rect: ReturnType<typeof orientedFootprint>; height: number } | null {
  const item = draft.items.find((i) => i.instanceId === instanceId);
  if (item === undefined) return null;
  const entry = ctx.byId.get(item.productId);
  const size = entry?.size ?? { w: 60, d: 60, h: 60 };
  return { rect: orientedFootprint(size, item.position, item.rotationY), height: size.h };
}

export function describeIssueForAssistant(
  ctx: AssistantContext,
  issue: FitIssue,
  draft?: SceneState,
): string {
  // The verdict text carries measurements, never ids: resolve doors and
  // windows geometrically (first hit in room order, like the engine) so the
  // assistant names walls exactly as before.
  const firstId = issue.itemIds[0];
  const placed =
    draft !== undefined && firstId !== undefined ? draftFootprint(ctx, draft, firstId) : null;
  if (issue.type === "door-swing") {
    const inSwing = ctx.room.openings.filter((o) => o.type === "door" && o.swing === "in");
    const hit = placed === null ? null : swingDoorIds(ctx.room, placed.rect)[0];
    const doorId = hit ?? (inSwing.length === 1 ? inSwing[0]?.id : undefined);
    const door = ctx.room.openings.find((o) => o.id === doorId);
    const wall = door === undefined ? "the door wall" : `the ${openingWallName(ctx, door.wallId)}`;
    return `Inside the swing of the door on ${wall}`;
  }
  if (issue.type === "window") {
    const hit = placed === null ? null : triggeredWindowId(ctx.room, placed.rect, placed.height);
    const alone = ctx.room.openings.filter((o) => o.type === "window");
    const windowId = hit ?? (alone.length === 1 ? alone[0]?.id : undefined);
    const opening = ctx.room.openings.find((o) => o.id === windowId);
    const wall =
      opening === undefined ? "a window wall" : `the ${openingWallName(ctx, opening.wallId)}`;
    return `Too close to the window on ${wall}`;
  }
  if ((issue.type === "walkway" || issue.type === "walkway-entrance") && draft !== undefined) {
    const view: AssistantIssueView = {
      type: issue.type,
      severity: issue.severity,
      itemIds: [...issue.itemIds],
      message: issue.message,
    };
    const fallback =
      issue.type === "walkway" ? "No walkway access to this seat" : "Entrance is blocked";
    return walkwayDetail(ctx, draft, view) ?? fallback;
  }
  if (issue.type === "overlap") {
    return issue.itemIds.length > 1 ? "Pieces overlap" : "Piece overlaps a fixed fixture";
  }
  if (issue.type === "outside") {
    return "Piece extends outside the room";
  }
  return issue.message;
}

export interface AssistantIssueView {
  type: string;
  severity: string;
  itemIds: string[];
  message: string;
}

function issueView(ctx: AssistantContext, draft: SceneState, issue: FitIssue): AssistantIssueView {
  return {
    type: issue.type,
    severity: issue.severity,
    itemIds: [...issue.itemIds],
    message: describeIssueForAssistant(ctx, issue, draft),
  };
}

function draftIssues(ctx: AssistantContext, draft: SceneState): AssistantIssueView[] {
  return checkFit(ctx.room, draft, productsOf(ctx)).map((issue) => issueView(ctx, draft, issue));
}

/** True when the draft has no fit error (warnings are fine). */
function isDraftClean(ctx: AssistantContext, draft: SceneState): boolean {
  return checkFit(ctx.room, draft, productsOf(ctx)).every((issue) => issue.severity !== "error");
}

/**
 * One-line recovery hint per error touching the item, so the model can fix
 * the draft instead of stalling: fixture depth, door swing, seat approach
 * (walkway hints reuse the enriched issue text: blocker, push direction and
 * distance).
 */
function hintFor(
  ctx: AssistantContext,
  draft: SceneState,
  fit: FitIssue[],
  instanceId: string,
): string | null {
  const hints: string[] = [];
  for (const issue of fit) {
    if (issue.severity !== "error" || !issue.itemIds.includes(instanceId)) continue;
    if (issue.type === "overlap" && issue.itemIds.length === 1) {
      const depths = ctx.room.fixtures.map((f) => `${f.id} ${String(f.depth)} cm deep`).join(", ");
      hints.push(
        `Overlaps a wall fixture (${depths}): pull the piece off the wall by the fixture depth.`,
      );
    } else if (issue.type === "door-swing") {
      hints.push("Inside a door swing: move the piece clear of the swing area.");
    } else if (issue.type === "walkway" || issue.type === "walkway-entrance") {
      hints.push(describeIssueForAssistant(ctx, issue, draft));
    } else if (issue.type === "overlap") {
      hints.push("Pieces overlap: move the piece a few centimetres clear.");
    } else if (issue.type === "outside") {
      hints.push("Outside the room: move the piece back inside the walls.");
    }
  }
  return hints.length === 0 ? null : [...new Set(hints)].join(" ");
}

/**
 * Item view plus the issues touching it: a recovery hint on errors, and the
 * ready line once the draft is fit-clean (a draft with errors never reports
 * ready).
 */
function touchedResult(
  ctx: AssistantContext,
  draft: SceneState,
  item: SceneItem,
): Record<string, unknown> {
  const fit = checkFit(ctx.room, draft, productsOf(ctx));
  const mine = fit
    .map((issue) => issueView(ctx, draft, issue))
    .filter((view) => view.itemIds.includes(item.instanceId));
  const base: Record<string, unknown> = {
    ok: true,
    ...itemView(ctx, item),
    issues: mine,
  };
  const hint = hintFor(ctx, draft, fit, item.instanceId);
  const result = hint === null ? base : { ...base, hint };
  return fit.every((issue) => issue.severity !== "error")
    ? { ...result, ready: ASSISTANT_READY_LINE }
    : result;
}

function itemView(ctx: AssistantContext, item: SceneItem): Record<string, unknown> {
  const entry = ctx.byId.get(item.productId);
  const size = entry?.size ?? { w: 60, d: 60, h: 60 };
  const box = footprintOf(size, item.position, item.rotationY);
  return {
    instanceId: item.instanceId,
    productId: item.productId,
    name: entry?.name ?? item.productId,
    centre: { x: round1(item.position.x), z: round1(item.position.z) },
    rotationY: round1(item.rotationY),
    footprint: { x0: round1(box.x0), z0: round1(box.z0), x1: round1(box.x1), z1: round1(box.z1) },
    variant: item.variant,
  };
}

// ---- walkway blocker detail -----------------------------------------------

function fitSignature(issue: FitIssue): string {
  return `${issue.type}|${[...issue.itemIds].sort().join(",")}`;
}

/** True when the walkway issue is gone from a re-check (seat or entrance). */
function walkwayGone(issues: FitIssue[], issue: AssistantIssueView): boolean {
  if (issue.type === "walkway-entrance") {
    return !issues.some((checked) => checked.type === "walkway-entrance");
  }
  const target = issue.itemIds[0];
  if (target === undefined) return true;
  return !issues.some((checked) => checked.type === "walkway" && checked.itemIds.includes(target));
}

function distPointSegment(
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

/** Shopper-words name of the nearest wall ("door wall", ...). */
function nearestWallName(ctx: AssistantContext, x: number, z: number): string {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const wall of ctx.room.walls) {
    const dist = distPointSegment(x, z, wall.start.x, wall.start.z, wall.end.x, wall.end.z);
    if (dist < bestDist) {
      bestDist = dist;
      best = wall.id;
    }
  }
  if (best === null) return "wall";
  const name = wallDisplayName(ctx.room, best);
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}

const BLOCKER_PUSH_DIRECTIONS = [
  { dx: 1, dz: 0, label: "east" },
  { dx: -1, dz: 0, label: "west" },
  { dx: 0, dz: 1, label: "north" },
  { dx: 0, dz: -1, label: "south" },
] as const;

function blockerName(ctx: AssistantContext, draft: SceneState, instanceId: string): string {
  const item = draft.items.find((i) => i.instanceId === instanceId);
  if (item === undefined) return instanceId;
  return ctx.byId.get(item.productId)?.name ?? instanceId;
}

/**
 * Walkway detail for one issue: the item blocking the way (found by trying
 * the check without each item) plus the shortest cardinal push, in 20 cm
 * steps, that frees it without breaking anything else. Null when no single
 * item's removal restores the walkway.
 */
function walkwayDetail(
  ctx: AssistantContext,
  draft: SceneState,
  issue: AssistantIssueView,
): string | null {
  const target = issue.type === "walkway" ? (issue.itemIds[0] ?? null) : null;
  if (issue.type === "walkway" && target === null) return null;
  const products = productsOf(ctx);
  const baseSignatures = new Set(
    checkFit(ctx.room, draft, products).map((checked) => fitSignature(checked)),
  );
  const named = issue.itemIds.filter((id) => id !== target);
  const rest = draft.items
    .map((item) => item.instanceId)
    .filter((id) => id !== target && !named.includes(id));
  let blocker: string | null = null;
  for (const candidate of [...named, ...rest]) {
    const trial: SceneState = {
      ...draft,
      items: draft.items.filter((item) => item.instanceId !== candidate),
    };
    if (walkwayGone(checkFit(ctx.room, trial, products), issue)) {
      blocker = candidate;
      break;
    }
  }
  if (blocker === null) return null;
  const blockerId: string = blocker;
  const placed = draft.items.find((item) => item.instanceId === blockerId);
  if (placed === undefined) return null;
  const name = blockerName(ctx, draft, blockerId);
  const wall = nearestWallName(ctx, placed.position.x, placed.position.z);
  for (let dist = 20; dist <= 300; dist += 20) {
    for (const dir of BLOCKER_PUSH_DIRECTIONS) {
      const trial: SceneState = {
        ...draft,
        items: draft.items.map((item) =>
          item.instanceId === blockerId
            ? {
                ...item,
                position: {
                  x: round1(item.position.x + dir.dx * dist),
                  z: round1(item.position.z + dir.dz * dist),
                },
              }
            : item,
        ),
      };
      const issues = checkFit(ctx.room, trial, products);
      if (!walkwayGone(issues, issue)) continue;
      if (!issues.every((checked) => baseSignatures.has(fitSignature(checked)))) continue;
      if (target === null) {
        return (
          `The entrance is blocked: the ${name} by the ${wall} blocks the way in; ` +
          `moving it about ${String(dist)} cm ${dir.label} clears it.`
        );
      }
      return (
        `No walkway access to the ${blockerName(ctx, draft, target)}: ` +
        `the ${name} by the ${wall} blocks the way; ` +
        `moving it about ${String(dist)} cm ${dir.label} clears it.`
      );
    }
  }
  return null;
}

// ---- wall-stretch fit -------------------------------------------------------

interface StretchMount {
  from: number;
  to: number;
  label: string;
}

interface FreeStretch {
  start: number;
  end: number;
  length: number;
  before: string;
  after: string;
}

/**
 * Floor-blocking mounts on a wall: doors and fixtures. Windows never block
 * the floor (a low piece under a window is placed with centred_on; the fit
 * engine checks sill height).
 */
function stretchMounts(ctx: AssistantContext, wallId: string): StretchMount[] {
  const mounts: StretchMount[] = [];
  for (const opening of ctx.room.openings) {
    if (opening.wallId !== wallId || opening.type !== "door") continue;
    mounts.push({
      from: opening.offset,
      to: opening.offset + opening.width,
      label: `the door ${opening.id}`,
    });
  }
  for (const fixture of ctx.room.fixtures) {
    if (fixture.wallId !== wallId) continue;
    mounts.push({
      from: fixture.offset,
      to: fixture.offset + fixture.width,
      label: `the ${fixture.type} ${fixture.id}`,
    });
  }
  mounts.sort((a, b) => a.from - b.from);
  return mounts;
}

/** Free wall stretches between openings, fixtures and corners, in order. */
function freeStretches(ctx: AssistantContext, wallId: string, wallLen: number): FreeStretch[] {
  const gaps: FreeStretch[] = [];
  let cursor = 0;
  let cursorLabel = "the corner";
  for (const mount of stretchMounts(ctx, wallId)) {
    if (mount.from > cursor) {
      gaps.push({
        start: cursor,
        end: mount.from,
        length: mount.from - cursor,
        before: cursorLabel,
        after: mount.label,
      });
    }
    if (mount.to > cursor) {
      cursor = mount.to;
      cursorLabel = mount.label;
    }
  }
  if (wallLen > cursor) {
    gaps.push({
      start: cursor,
      end: wallLen,
      length: wallLen - cursor,
      before: cursorLabel,
      after: "the corner",
    });
  }
  return gaps;
}

function stretchContaining(stretches: FreeStretch[], offset: number): FreeStretch | null {
  for (const stretch of stretches) {
    if (offset >= stretch.start && offset <= stretch.end) return stretch;
  }
  return null;
}

function mountAtOffset(mounts: StretchMount[], offset: number): StretchMount | null {
  for (const mount of mounts) {
    if (offset >= mount.from && offset < mount.to) return mount;
  }
  return null;
}

/** Item extent along a wall unit vector at a rotation (exact on axis walls). */
function alongWallLength(
  size: { w: number; d: number; h: number },
  rotationY: number,
  ux: number,
  uz: number,
): number {
  const { cos, sin } = angleTrig(rotationY);
  return size.w * Math.abs(cos * ux + -sin * uz) + size.d * Math.abs(sin * ux + cos * uz);
}

/**
 * Refusal when a piece cannot fit the requested wall stretch: both lengths
 * plus the stretch's ends, and an instruction to explain and propose an
 * alternative in words instead of placing anything else. Nothing is placed.
 *
 * The `doesNotFit` marker (with both lengths as numbers) lets the turn loop
 * enforce the refusal: a turn containing it applies no change at all.
 */
function tooLongRefusal(
  ctx: AssistantContext,
  productName: string,
  needCm: number,
  stretch: FreeStretch,
  wallId: string,
): Record<string, unknown> {
  const wall = wallDisplayName(ctx.room, wallId);
  return {
    ok: false,
    doesNotFit: true,
    needCm: round1(needCm),
    freeCm: round1(stretch.length),
    error:
      `The ${productName} is ${String(round1(needCm))} cm; the free stretch between ` +
      `${stretch.before} and ${stretch.after} on the ${wall} is only ` +
      `${String(round1(stretch.length))} cm ` +
      `(${String(round1(stretch.start))}–${String(round1(stretch.end))} cm from the wall start). ` +
      `It does not fit there. Explain why it does not fit, with both lengths, and propose the ` +
      `closest alternative in words; do not place anything else in this turn.`,
  };
}

/** Refusal when the requested offset lands on a door or fixture, not a free stretch. */
function mountRefusal(
  ctx: AssistantContext,
  productName: string,
  offsetCm: number,
  mount: StretchMount,
  wallId: string,
  stretches: FreeStretch[],
): Record<string, unknown> {
  const wall = wallDisplayName(ctx.room, wallId);
  const free =
    stretches
      .map((stretch) => `${String(round1(stretch.start))}–${String(round1(stretch.end))} cm`)
      .join(", ") || "none";
  return {
    ok: false,
    error:
      `Offset ${String(round1(offsetCm))} cm on the ${wall} is on ${mount.label} ` +
      `(${String(round1(mount.from))}–${String(round1(mount.to))} cm), not a free stretch, ` +
      `so the ${productName} was not placed. Pick an offset inside a free stretch ` +
      `(${free}), or centre under a window with centred_on.`,
  };
}

/**
 * Wall-stretch guard for a new piece at a centre with a rotation: every wall
 * the piece sits against must offer a free stretch its along-wall extent
 * fits, or the placement is refused before anything changes. Returns the
 * refusal, or null when placement may proceed.
 */
function wallStretchRefusal(
  ctx: AssistantContext,
  productName: string,
  size: { w: number; d: number; h: number },
  x: number,
  z: number,
  rotationY: number,
): Record<string, unknown> | null {
  const { cos, sin } = angleTrig(rotationY);
  let mountHit: Record<string, unknown> | null = null;
  for (const wall of ctx.room.walls) {
    const frame = frameOfWall(ctx.room, wall.id);
    if (frame === null) continue;
    const along = (x - frame.start.x) * frame.ux + (z - frame.start.z) * frame.uz;
    const perp = (x - frame.start.x) * frame.nx + (z - frame.start.z) * frame.nz;
    if (along < 0 || along > frame.len || perp < 0) continue;
    const perpExtent =
      (size.w / 2) * Math.abs(cos * frame.nx + -sin * frame.nz) +
      (size.d / 2) * Math.abs(sin * frame.nx + cos * frame.nz);
    if (perp > perpExtent + 1) continue;
    const mounts = stretchMounts(ctx, wall.id);
    const stretches = freeStretches(ctx, wall.id, frame.len);
    const mount = mountAtOffset(mounts, along);
    if (mount !== null) {
      mountHit ??= mountRefusal(ctx, productName, along, mount, wall.id, stretches);
      continue;
    }
    const stretch = stretchContaining(stretches, along);
    if (stretch === null) continue;
    const need = alongWallLength(size, rotationY, frame.ux, frame.uz);
    if (need > stretch.length + 1e-9) {
      return tooLongRefusal(ctx, productName, need, stretch, wall.id);
    }
  }
  return mountHit;
}

/** Deterministic instance id: productId, then productId-2, ... */
function nextInstanceId(draft: SceneState, productId: string): string {
  const taken = new Set(draft.items.map((i) => i.instanceId));
  if (!taken.has(productId)) return productId;
  let n = 2;
  while (taken.has(`${productId}-${String(n)}`)) n += 1;
  return `${productId}-${String(n)}`;
}

function defaultVariant(entry: CatalogItem): string {
  return entry.variants[0]?.name ?? "default";
}

function matchVariant(entry: CatalogItem, variant: string): string | null {
  if (entry.variants.some((v) => v.name === variant)) return variant;
  const lower = variant.toLowerCase();
  const found = entry.variants.find((v) => v.name.toLowerCase() === lower);
  if (found !== undefined) return found.name;
  if (variant === "default" || variant === "") return defaultVariant(entry);
  return null;
}

interface WallFrame {
  ux: number;
  uz: number;
  len: number;
  nx: number;
  nz: number;
}

function roomCentroid(room: RoomLayout): { x: number; z: number } {
  let x = 0;
  let z = 0;
  const n = Math.max(1, room.walls.length * 2);
  for (const wall of room.walls) {
    x += wall.start.x + wall.end.x;
    z += wall.start.z + wall.end.z;
  }
  return { x: x / n, z: z / n };
}

function frameOfWall(
  room: RoomLayout,
  wallId: string,
): (WallFrame & { start: { x: number; z: number } }) | null {
  const wall = room.walls.find((w) => w.id === wallId);
  if (wall === undefined) return null;
  const len = wallLengthCm(wall.start, wall.end) || 1;
  const ux = (wall.end.x - wall.start.x) / len;
  const uz = (wall.end.z - wall.start.z) / len;
  const centroid = roomCentroid(room);
  const mx = (wall.start.x + wall.end.x) / 2;
  const mz = (wall.start.z + wall.end.z) / 2;
  const cx = centroid.x - mx;
  const cz = centroid.z - mz;
  const nx = cx * -uz + cz * ux >= 0 ? -uz : uz;
  const nz = cx * -uz + cz * ux >= 0 ? ux : -uz;
  return { ux, uz, len, nx, nz, start: { ...wall.start } };
}

function roomDescription(ctx: AssistantContext, draft: SceneState): Record<string, unknown> {
  const { room } = ctx;
  const walls = room.walls.map((wall) => ({
    id: wall.id,
    name: wallDisplayName(room, wall.id),
    start: { x: round1(wall.start.x), z: round1(wall.start.z) },
    end: { x: round1(wall.end.x), z: round1(wall.end.z) },
    length_cm: round1(wallLengthCm(wall.start, wall.end)),
  }));
  const openings = room.openings.map((opening) => {
    const base: Record<string, unknown> = {
      id: opening.id,
      wallId: opening.wallId,
      wall: wallDisplayName(room, opening.wallId),
      type: opening.type,
      span_cm: [round1(opening.offset), round1(opening.offset + opening.width)],
      sill_cm: round1(opening.sillHeight),
    };
    if (opening.type === "door") {
      base["hinge"] = opening.hinge;
      base["swing"] = opening.swing;
    }
    return base;
  });
  const fixtures = room.fixtures.map((fixture) => ({
    id: fixture.id,
    type: fixture.type,
    wallId: fixture.wallId,
    wall: wallDisplayName(room, fixture.wallId),
    span_cm: [round1(fixture.offset), round1(fixture.offset + fixture.width)],
    depth_cm: round1(fixture.depth),
  }));
  const free = analyzeFreeSpace(room, draft, ctx.byId);
  const freeRuns = free.runs.map((run) => ({
    wallId: run.wall,
    wall: wallDisplayName(room, run.wall),
    start_cm: round1(run.start_cm),
    end_cm: round1(run.end_cm),
    length_cm: round1(run.length_cm),
    depth_cm: round1(run.depth_cm),
  }));
  return {
    name: room.name,
    walls,
    openings,
    fixtures,
    freeRuns,
  };
}

/**
 * Run one tool call on the draft (mutating it for place/move/rotate/remove/
 * variant/wall calls). Always returns plain JSON for the model; mutating
 * calls include the fit issues touching the item.
 */
export function executeAssistantTool(
  ctx: AssistantContext,
  draft: SceneState,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!isAssistantToolName(name)) {
    return { ok: false, error: `Unknown tool "${name}".` };
  }
  switch (name) {
    case "get_room":
      return { ok: true, room: roomDescription(ctx, draft) };
    case "list_items":
      return { ok: true, items: draft.items.map((item) => itemView(ctx, item)) };
    case "list_catalog": {
      const category = args["category"];
      if (category !== undefined && typeof category !== "string") {
        return { ok: false, error: "category must be a string." };
      }
      const known = [...new Set(ctx.catalog.map((c) => c.category))];
      if (typeof category === "string" && !(known as string[]).includes(category)) {
        return { ok: false, error: `Unknown category "${category}".`, categories: known };
      }
      const products = ctx.catalog
        .filter((c) => category === undefined || c.category === category)
        .map((c) => ({
          id: c.id,
          name: c.name,
          category: c.category,
          size: { w: round1(c.size.w), d: round1(c.size.d), h: round1(c.size.h) },
          price_usd: c.price,
          seats: c.seats ?? 0,
          styleTags: [...c.styleTags],
          variants: c.variants.map((v) => v.name),
        }));
      return { ok: true, products };
    }
    case "place_item": {
      const productId = needString(args, "productId");
      const x = needNumber(args, "x");
      const z = needNumber(args, "z");
      const rotationY = needNumber(args, "rotationY");
      if (productId === null || x === null || z === null || rotationY === null) {
        return { ok: false, error: "place_item needs productId, x, z and rotationY." };
      }
      const entry = ctx.byId.get(productId);
      if (entry === undefined) {
        return { ok: false, error: `Unknown productId "${productId}".` };
      }
      const variantArg = args["variant"];
      let variant = defaultVariant(entry);
      if (variantArg !== undefined) {
        if (typeof variantArg !== "string")
          return { ok: false, error: "variant must be a string." };
        const matched = matchVariant(entry, variantArg);
        if (matched === null) {
          return {
            ok: false,
            error: `"${variantArg}" is not a variant of ${entry.name}.`,
            allowed: entry.variants.map((v) => v.name),
          };
        }
        variant = matched;
      }
      const budgeted = budgetRefusal(ctx, draft, entry);
      if (budgeted !== null) return budgeted;
      const refusal = wallStretchRefusal(
        ctx,
        entry.name,
        entry.size,
        x,
        z,
        normalizeRotation(rotationY),
      );
      if (refusal !== null) return refusal;
      const item: SceneItem = {
        instanceId: nextInstanceId(draft, productId),
        productId,
        position: { x: round1(x), z: round1(z) },
        rotationY: normalizeRotation(rotationY),
        variant,
      };
      draft.items.push(item);
      ctx.briefNewIds.add(item.instanceId);
      return touchedResult(ctx, draft, item);
    }
    case "move_item": {
      const instanceId = needString(args, "instanceId");
      const x = needNumber(args, "x");
      const z = needNumber(args, "z");
      if (instanceId === null || x === null || z === null) {
        return { ok: false, error: "move_item needs instanceId, x and z." };
      }
      const item = draft.items.find((i) => i.instanceId === instanceId);
      if (item === undefined) {
        return {
          ok: false,
          error: `Unknown instanceId "${instanceId}".`,
          placed: draft.items.map((i) => i.instanceId),
        };
      }
      item.position = { x: round1(x), z: round1(z) };
      return touchedResult(ctx, draft, item);
    }
    case "rotate_item": {
      const instanceId = needString(args, "instanceId");
      const rotationY = needNumber(args, "rotationY");
      if (instanceId === null || rotationY === null) {
        return { ok: false, error: "rotate_item needs instanceId and rotationY." };
      }
      const item = draft.items.find((i) => i.instanceId === instanceId);
      if (item === undefined) {
        return {
          ok: false,
          error: `Unknown instanceId "${instanceId}".`,
          placed: draft.items.map((i) => i.instanceId),
        };
      }
      item.rotationY = normalizeRotation(rotationY);
      return touchedResult(ctx, draft, item);
    }
    case "remove_item": {
      const instanceId = needString(args, "instanceId");
      if (instanceId === null) return { ok: false, error: "remove_item needs instanceId." };
      const before = draft.items.length;
      draft.items = draft.items.filter((i) => i.instanceId !== instanceId);
      if (draft.items.length === before) {
        return {
          ok: false,
          error: `Unknown instanceId "${instanceId}".`,
          placed: draft.items.map((i) => i.instanceId),
        };
      }
      ctx.briefNewIds.delete(instanceId);
      const removed: Record<string, unknown> = { ok: true, removed: instanceId };
      return isDraftClean(ctx, draft) ? { ...removed, ready: ASSISTANT_READY_LINE } : removed;
    }
    case "check_fit": {
      const issues = draftIssues(ctx, draft);
      const base: Record<string, unknown> = {
        ok: true,
        fits: issues.every((i) => i.severity !== "error"),
        issues,
      };
      const status = briefStatusLine(ctx, draft);
      return status === null ? base : { ...base, brief: status };
    }
    case "set_variant": {
      const instanceId = needString(args, "instanceId");
      const variant = needString(args, "variant");
      if (instanceId === null || variant === null) {
        return { ok: false, error: "set_variant needs instanceId and variant." };
      }
      const item = draft.items.find((i) => i.instanceId === instanceId);
      if (item === undefined) {
        return {
          ok: false,
          error: `Unknown instanceId "${instanceId}".`,
          placed: draft.items.map((i) => i.instanceId),
        };
      }
      const entry = ctx.byId.get(item.productId);
      if (entry === undefined)
        return { ok: false, error: `Unknown productId "${item.productId}".` };
      if (entry.variants.length === 0) {
        if (variant === "default" || variant === "") {
          const kept: Record<string, unknown> = { ok: true, instanceId, variant: item.variant };
          return isDraftClean(ctx, draft) ? { ...kept, ready: ASSISTANT_READY_LINE } : kept;
        }
        return { ok: false, error: `${entry.name} has no variants.` };
      }
      const matched = matchVariant(entry, variant);
      if (matched === null) {
        return {
          ok: false,
          error: `"${variant}" is not a variant of ${entry.name}.`,
          allowed: entry.variants.map((v) => v.name),
        };
      }
      item.variant = matched;
      const varied: Record<string, unknown> = { ok: true, instanceId, variant: matched };
      return isDraftClean(ctx, draft) ? { ...varied, ready: ASSISTANT_READY_LINE } : varied;
    }
    case "place_against_wall": {
      const wallId = needString(args, "wallId");
      const offset = needNumber(args, "offset_cm");
      const centredOn = needString(args, "centred_on");
      if (wallId === null || (offset === null && centredOn === null)) {
        return { ok: false, error: "place_against_wall needs wallId and offset_cm or centred_on." };
      }
      const frame = frameOfWall(ctx.room, wallId);
      if (frame === null) {
        return {
          ok: false,
          error: `Unknown wallId "${wallId}".`,
          walls: ctx.room.walls.map((w) => w.id),
        };
      }
      const productId = needString(args, "productId");
      const instanceArg = needString(args, "instanceId");
      if ((productId === null) === (instanceArg === null)) {
        return {
          ok: false,
          error: "Pass exactly one of productId (new piece) or instanceId (existing piece).",
        };
      }
      let size = { w: 60, d: 60, h: 60 };
      let item: SceneItem | null = null;
      if (instanceArg !== null) {
        const found = draft.items.find((i) => i.instanceId === instanceArg);
        if (found === undefined) {
          return {
            ok: false,
            error: `Unknown instanceId "${instanceArg}".`,
            placed: draft.items.map((i) => i.instanceId),
          };
        }
        item = found;
        const entry = ctx.byId.get(item.productId);
        if (entry !== undefined) size = { ...entry.size };
      } else if (productId !== null) {
        const entry = ctx.byId.get(productId);
        if (entry === undefined) return { ok: false, error: `Unknown productId "${productId}".` };
        const budgeted = budgetRefusal(ctx, draft, entry);
        if (budgeted !== null) return budgeted;
        size = { ...entry.size };
      }
      let dist = offset ?? 0;
      if (centredOn !== null) {
        const opening = ctx.room.openings.find((o) => o.id === centredOn);
        if (opening === undefined) {
          return {
            ok: false,
            error: `Unknown opening "${centredOn}".`,
            openings: ctx.room.openings.map((o) => o.id),
          };
        }
        if (opening.wallId !== wallId) {
          return { ok: false, error: `"${centredOn}" is not on wall "${wallId}".` };
        }
        dist = opening.offset + opening.width / 2;
      }
      const rotationY = backToWallRotationY(-frame.nx, -frame.nz);
      if (centredOn === null && offset !== null) {
        const mounts = stretchMounts(ctx, wallId);
        const stretches = freeStretches(ctx, wallId, frame.len);
        const productName =
          item !== null
            ? (ctx.byId.get(item.productId)?.name ?? item.productId)
            : productId !== null
              ? (ctx.byId.get(productId)?.name ?? productId)
              : "the piece";
        const mount = mountAtOffset(mounts, offset);
        if (mount !== null) {
          return mountRefusal(ctx, productName, offset, mount, wallId, stretches);
        }
        const stretch = stretchContaining(stretches, offset);
        if (stretch !== null) {
          const need = alongWallLength(size, rotationY, frame.ux, frame.uz);
          if (need > stretch.length + 1e-9) {
            return tooLongRefusal(ctx, productName, need, stretch, wallId);
          }
        }
      }
      const { cos, sin } = angleTrig(rotationY);
      // Local axes in world plan (matches the fit engine mapping).
      const lxX = cos;
      const lxZ = -sin;
      const lzX = sin;
      const lzZ = cos;
      const gap =
        (size.w / 2) * Math.abs(lxX * frame.nx + lxZ * frame.nz) +
        (size.d / 2) * Math.abs(lzX * frame.nx + lzZ * frame.nz);
      const cx = frame.start.x + frame.ux * dist + frame.nx * gap;
      const cz = frame.start.z + frame.uz * dist + frame.nz * gap;
      if (item === null && productId !== null) {
        const entry = ctx.byId.get(productId) as CatalogItem;
        const created: SceneItem = {
          instanceId: nextInstanceId(draft, productId),
          productId,
          position: { x: round1(cx), z: round1(cz) },
          rotationY,
          variant: defaultVariant(entry),
        };
        draft.items.push(created);
        ctx.briefNewIds.add(created.instanceId);
        item = created;
      } else if (item !== null) {
        item.position = { x: round1(cx), z: round1(cz) };
        item.rotationY = rotationY;
      }
      if (item === null)
        return { ok: false, error: "Place_against_wall needs a product or an item." };
      return {
        ...touchedResult(ctx, draft, item),
        wall: wallDisplayName(ctx.room, wallId),
      };
    }
  }
}
