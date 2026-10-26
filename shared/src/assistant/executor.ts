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
import { checkFit, footprintOf } from "../fit.js";
import type { CatalogItem, FitIssue, RoomLayout, SceneItem, SceneState } from "../types.js";
import { wallLengthCm } from "../units.js";
import { isAssistantToolName } from "./tools.js";

export interface AssistantContext {
  room: RoomLayout;
  catalog: CatalogItem[];
  byId: Map<string, CatalogItem>;
}

export function createAssistantContext(room: RoomLayout, catalog: CatalogItem[]): AssistantContext {
  return { room, catalog, byId: new Map(catalog.map((c) => [c.id, c])) };
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
): Map<string, { size: { w: number; d: number; h: number }; category: string }> {
  return new Map(ctx.catalog.map((c) => [c.id, { size: { ...c.size }, category: c.category }]));
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

/** Fit issue in shopper words: display wall names, never opening ids. */
export function describeIssueForAssistant(ctx: AssistantContext, issue: FitIssue): string {
  if (issue.type === "door-swing") {
    const doorId = issue.message.match(/swing of (\S+)/)?.[1];
    const door = ctx.room.openings.find((o) => o.id === doorId);
    const wall = door === undefined ? "the door wall" : `the ${openingWallName(ctx, door.wallId)}`;
    return `Inside the swing of the door on ${wall}`;
  }
  if (issue.type === "window") {
    const windowId = issue.message.match(/close to (\S+)/)?.[1];
    const opening = ctx.room.openings.find((o) => o.id === windowId);
    const wall =
      opening === undefined ? "a window wall" : `the ${openingWallName(ctx, opening.wallId)}`;
    return `Too close to the window on ${wall}`;
  }
  return issue.message;
}

export interface AssistantIssueView {
  type: string;
  severity: string;
  itemIds: string[];
  message: string;
}

function issueView(ctx: AssistantContext, issue: FitIssue): AssistantIssueView {
  return {
    type: issue.type,
    severity: issue.severity,
    itemIds: [...issue.itemIds],
    message: describeIssueForAssistant(ctx, issue),
  };
}

function draftIssues(ctx: AssistantContext, draft: SceneState): AssistantIssueView[] {
  return checkFit(ctx.room, draft, productsOf(ctx)).map((issue) => issueView(ctx, issue));
}

function touching(
  ctx: AssistantContext,
  draft: SceneState,
  instanceId: string,
): AssistantIssueView[] {
  return draftIssues(ctx, draft).filter((issue) => issue.itemIds.includes(instanceId));
}

/**
 * One-line recovery hint per error touching the item, so the model can fix
 * the draft instead of stalling: fixture depth, door swing, seat approach.
 */
function hintFor(ctx: AssistantContext, draft: SceneState, instanceId: string): string | null {
  const issues = draftIssues(ctx, draft).filter((issue) => issue.itemIds.includes(instanceId));
  const hints: string[] = [];
  for (const issue of issues) {
    if (issue.severity !== "error") continue;
    if (issue.type === "overlap" && issue.message.includes("fixture")) {
      const depths = ctx.room.fixtures.map((f) => `${f.id} ${String(f.depth)} cm deep`).join(", ");
      hints.push(
        `Overlaps a wall fixture (${depths}): pull the piece off the wall by the fixture depth.`,
      );
    } else if (issue.type === "door-swing") {
      hints.push("Inside a door swing: move the piece clear of the swing area.");
    } else if (issue.type === "walkway" || issue.type === "walkway-entrance") {
      hints.push(
        "No walkway access to this seat: move this seat, or move the seat nearest the door aside, then check again.",
      );
    } else if (issue.type === "overlap") {
      hints.push("Pieces overlap: move the piece a few centimetres clear.");
    } else if (issue.type === "outside") {
      hints.push("Outside the room: move the piece back inside the walls.");
    }
  }
  return hints.length === 0 ? null : [...new Set(hints)].join(" ");
}

function withHint(
  ctx: AssistantContext,
  draft: SceneState,
  instanceId: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const hint = hintFor(ctx, draft, instanceId);
  return hint === null ? result : { ...result, hint };
}

/** Item view plus the issues touching it (and a recovery hint on errors). */
function touchedResult(
  ctx: AssistantContext,
  draft: SceneState,
  item: SceneItem,
): Record<string, unknown> {
  return withHint(ctx, draft, item.instanceId, {
    ok: true,
    ...itemView(ctx, item),
    issues: touching(ctx, draft, item.instanceId),
  });
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
      const item: SceneItem = {
        instanceId: nextInstanceId(draft, productId),
        productId,
        position: { x: round1(x), z: round1(z) },
        rotationY: normalizeRotation(rotationY),
        variant,
      };
      draft.items.push(item);
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
      return { ok: true, removed: instanceId };
    }
    case "check_fit": {
      const issues = draftIssues(ctx, draft);
      return {
        ok: true,
        fits: issues.every((i) => i.severity !== "error"),
        issues,
      };
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
        if (variant === "default" || variant === "")
          return { ok: true, instanceId, variant: item.variant };
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
      return { ok: true, instanceId, variant: matched };
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
