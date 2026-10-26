import type {
  CatalogItem,
  FitIssue,
  FitProducts,
  PlanPoint,
  RoomLayout,
  SceneItem,
  SceneState,
} from "@fitroom/shared";
import { cmToMeters, wallLengthCm } from "@fitroom/shared";

export const AUTOSAVE_KEY = "fitroom.autosave.v1";
export const SNAP_CM = 5;
export const ROTATE_SNAP_DEG = 15;

/** Product sizes + categories for the shared fit engine. */
export function catalogProducts(catalog: Map<string, CatalogItem>): FitProducts {
  return new Map(
    [...catalog.values()].map((c) => [c.id, { size: { ...c.size }, category: c.category }]),
  );
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

export function emptyScene(roomId: string): SceneState {
  return {
    roomId,
    items: [],
    camera: {
      mode: "orbit",
      position: { x: 3.4, y: 3.1, z: 4.2 },
      target: { x: 2.1, y: 0, z: 1.8 },
    },
  };
}

export function loadAutosave(roomId: string): SceneState | null {
  try {
    const raw = window.localStorage.getItem(AUTOSAVE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const state = parsed as SceneState;
    if (state.roomId !== roomId || !Array.isArray(state.items)) return null;
    return state;
  } catch {
    return null;
  }
}

export function saveAutosave(state: SceneState): void {
  try {
    window.localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(state));
  } catch {
    // Storage may be unavailable; the app keeps working in memory.
  }
}

/** Store with undo (Ctrl+Z) and autosave. */
export class SceneStore {
  state: SceneState;
  private past: SceneState[] = [];
  private listeners = new Set<() => void>();

  constructor(roomId: string) {
    this.state = loadAutosave(roomId) ?? emptyScene(roomId);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    saveAutosave(this.state);
    for (const fn of this.listeners) fn();
  }

  private snapshot(): SceneState {
    return JSON.parse(JSON.stringify(this.state)) as SceneState;
  }

  commit(mutator: (draft: SceneState) => void): void {
    this.past.push(this.snapshot());
    if (this.past.length > 60) this.past.shift();
    mutator(this.state);
    this.emit();
  }

  /** Replace state without pushing undo (remote restore / undo itself). */
  replace(next: SceneState): void {
    this.state = next;
    this.emit();
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.state = prev;
    this.emit();
    return true;
  }

  /** Push the current state to the undo stack (start of a drag gesture). */
  checkpoint(): void {
    this.past.push(this.snapshot());
    if (this.past.length > 60) this.past.shift();
  }

  touch(): void {
    this.emit();
  }
}

/** Footprint corners of an item in plan cm (rotation about Y, centre-based). */
export function itemCorners(item: SceneItem, catalog: Map<string, CatalogItem>): PlanPoint[] {
  const entry = catalog.get(item.productId);
  const w = entry?.size.w ?? 60;
  const d = entry?.size.d ?? 60;
  const hw = w / 2;
  const hd = d / 2;
  const rad = (item.rotationY * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const local: PlanPoint[] = [
    { x: -hw, z: -hd },
    { x: hw, z: -hd },
    { x: hw, z: hd },
    { x: -hw, z: hd },
  ];
  return local.map((p) => ({
    x: item.position.x + p.x * cos + p.z * sin,
    z: item.position.z - p.x * sin + p.z * cos,
  }));
}

export function cornersOverlap(a: PlanPoint[], b: PlanPoint[]): boolean {
  // Separating-axis test on the two rectangles' edge normals. Touching
  // edges (within a micrometre) count as separated, so exact-pitch wall
  // slots are not rejected by float noise; the 5cm placement gap dwarfs this.
  const EPS = 1e-6;
  const axes: PlanPoint[] = [];
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i += 1) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      if (p === undefined || q === undefined) continue;
      const ex = q.x - p.x;
      const ez = q.z - p.z;
      const len = Math.hypot(ex, ez) || 1;
      axes.push({ x: -ez / len, z: ex / len });
    }
  }
  for (const ax of axes) {
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (const p of a) {
      const v = p.x * ax.x + p.z * ax.z;
      if (v < minA) minA = v;
      if (v > maxA) maxA = v;
    }
    for (const p of b) {
      const v = p.x * ax.x + p.z * ax.z;
      if (v < minB) minB = v;
      if (v > maxB) maxB = v;
    }
    if (maxA <= minB + EPS || maxB <= minA + EPS) return false;
  }
  return true;
}

export function roomBounds(room: RoomLayout): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const wall of room.walls) {
    for (const p of [wall.start, wall.end]) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  return { minX, maxX, minZ, maxZ };
}

/** True when the item footprint lies fully inside the room polygon bounds. */
export function isInsideRoom(
  item: SceneItem,
  catalog: Map<string, CatalogItem>,
  room: RoomLayout,
): boolean {
  const bounds = roomBounds(room);
  for (const c of itemCorners(item, catalog)) {
    if (c.x < bounds.minX || c.x > bounds.maxX || c.z < bounds.minZ || c.z > bounds.maxZ) {
      return false;
    }
  }
  return true;
}

/** Clearance kept between a new piece and every placed piece, centimetres. */
export const PLACEMENT_GAP_CM = 5;

export interface FreeSpot extends PlanPoint {
  rotationY: number;
}

/** Distance from a plan point to the nearest room edge, centimetres. */
function edgeDist(
  x: number,
  z: number,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): number {
  return Math.min(x - bounds.minX, bounds.maxX - x, z - bounds.minZ, bounds.maxZ - z);
}

/**
 * Nearest free placement for a new item.
 *
 * - Searches from `start` (the current view centre), nearest first.
 * - The footprint must sit inside the room and overlap no placed item, with
 *   a 5cm gap between footprints.
 * - Wall-backed candidates come first: sofas, TV units and shelves prefer a
 *   spot with their back to a wall (back facing the wall); other large
 *   pieces (max side >= 120cm) join them, so big pieces pack to the edges
 *   while small pieces appear near the view. Wall slots fill from the
 *   corners (view breaks ties) so consecutive pieces pack instead of
 *   stranding each other mid-wall.
 * - When no spot keeps the full gap, exact-fit phases (no overlap, gap
 *   dropped) run before the final non-stacking fallback, so items never stack
 *   on one point.
 */
/** Stable key for comparing fit issues across candidate placements. */
function issueKey(issue: FitIssue): string {
  return `${issue.type}|${[...issue.itemIds].sort().join(",")}`;
}

export function nearestFreeSpot(
  productId: string,
  catalog: Map<string, CatalogItem>,
  room: RoomLayout,
  state: SceneState,
  start?: PlanPoint,
  fitCheck?: (items: SceneItem[]) => FitIssue[],
): FreeSpot {
  const bounds = roomBounds(room);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const origin = {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, start?.x ?? cx)),
    z: Math.min(bounds.maxZ, Math.max(bounds.minZ, start?.z ?? cz)),
  };
  const entry = catalog.get(productId);

  const probe: SceneItem = {
    instanceId: "probe",
    productId,
    position: { x: origin.x, z: origin.z },
    rotationY: 0,
    variant: "",
  };
  /**
   * True when the footprint sits inside the room and overlaps no placed
   * item; with `gapCm > 0` the probe footprint grows by the gap on every
   * side, enforcing that clearance to every placed piece.
   */
  const fits = (x: number, z: number, rotationY: number, gapCm: number): boolean => {
    probe.position = { x, z };
    probe.rotationY = rotationY;
    if (!isInsideRoom(probe, catalog, room)) return false;
    const pc = gapCm > 0 ? inflatedCorners(probe, catalog, gapCm) : itemCorners(probe, catalog);
    for (const other of state.items) {
      if (cornersOverlap(pc, itemCorners(other, catalog))) return false;
    }
    return true;
  };
  const dist2 = (x: number, z: number): number =>
    (x - origin.x) * (x - origin.x) + (z - origin.z) * (z - origin.z);

  interface Candidate {
    x: number;
    z: number;
    rotationY: number;
    /** Distance along the wall to the nearer end (wall slots only). */
    end: number;
  }
  const byView = (list: Candidate[]): Candidate[] =>
    [...list].sort((a, b) => dist2(a.x, a.z) - dist2(b.x, b.z));
  /**
   * Wall slots, ends first: filling from the corners packs pieces along the
   * wall instead of stranding one piece mid-wall where it blocks both sides.
   * View distance breaks ties, so the nearest corner still wins.
   */
  const byEndThenView = (list: Candidate[]): Candidate[] =>
    [...list].sort((a, b) => a.end - b.end || dist2(a.x, a.z) - dist2(b.x, b.z));

  // Wall-adjacent candidates (back facing the wall). Sofas, TV units and
  // shelves always try these first; other pieces join them only when they
  // are large (max side >= 120cm), so big pieces pack to the edges while
  // small pieces appear near the view.
  const w = entry?.size.w ?? 60;
  const d = entry?.size.d ?? 60;
  const prefersWall =
    entry?.category === "sofa" || entry?.category === "tv-unit" || entry?.category === "shelf"
      ? true
      : Math.max(w, d) >= 120;
  const backed = wallBackedCandidates(room, bounds, w, d);
  // Dense grid over the room interior.
  const step = 10;
  const grid: Candidate[] = [];
  for (let x = bounds.minX; x <= bounds.maxX; x += step) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += step) {
      grid.push({ x, z, rotationY: 0, end: Number.POSITIVE_INFINITY });
    }
  }
  const orderedGrid = byView(grid);
  const orderedAll = byView([...backed, ...grid]);
  /**
   * Interior cells, room edges first: once the walls are lined, the leftover
   * middle packs best from its own edges inward (two 167cm sofas fit stacked
   * at z≈108/252, never side by side). View distance breaks ties.
   */
  const byEdgeThenView = [...grid].sort(
    (a, b) =>
      edgeDist(a.x, a.z, bounds) - edgeDist(b.x, b.z, bounds) || dist2(a.x, a.z) - dist2(b.x, b.z),
  );

  // Fit-engine gate: a candidate passes when it introduces no new error
  // (no overlap, outside, door-swing, entrance or walkway error), so nothing
  // lands in the door's swing or the entrance. Errors already in the scene
  // do not block placement; when no spot passes, the spot with the fewest
  // new errors wins so the problem stays visible.
  const baseKeys = new Set<string>();
  if (fitCheck !== undefined) {
    for (const issue of fitCheck(state.items)) {
      if (issue.severity === "error") baseKeys.add(issueKey(issue));
    }
  }
  interface Score {
    fresh: number;
    swing: number;
    total: number;
  }
  const bestHolder: { current: { spot: FreeSpot; score: Score } | null } = { current: null };
  const evaluated = new Map<string, Score>();
  const isBetter = (a: Score, b: Score): boolean =>
    a.fresh < b.fresh ||
    (a.fresh === b.fresh && a.swing < b.swing) ||
    (a.fresh === b.fresh && a.swing === b.swing && a.total < b.total);
  const consider = (rawX: number, rawZ: number, rotationY: number): FreeSpot | null => {
    // The item lands on rounded centimetres (see addItem), so the engine
    // must judge the rounded spot.
    const x = Math.round(rawX);
    const z = Math.round(rawZ);
    if (fitCheck === undefined) return { x, z, rotationY };
    const cacheKey = `${x}|${z}|${rotationY}`;
    let score = evaluated.get(cacheKey);
    if (score === undefined) {
      const probe: SceneItem = {
        instanceId: "placement-probe",
        productId,
        position: { x, z },
        rotationY,
        variant: "",
      };
      const errors = fitCheck([...state.items, probe]).filter((i) => i.severity === "error");
      score = { fresh: 0, swing: 0, total: errors.length };
      for (const issue of errors) {
        if (baseKeys.has(issueKey(issue))) continue;
        score.fresh += 1;
        // Fresh probe issues always involve the probe (its id is unique), so
        // these are exactly the spots landing in the swing or the entrance.
        if (issue.type === "door-swing" || issue.type === "walkway-entrance") {
          score.swing += 1;
        }
      }
      evaluated.set(cacheKey, score);
    }
    if (score.fresh === 0) return { x, z, rotationY };
    const prev = bestHolder.current;
    if (prev === null || isBetter(score, prev.score)) {
      bestHolder.current = { spot: { x, z, rotationY }, score };
    }
    return null;
  };

  // Phases 1-2: full 5cm gap. Wall-preferring pieces try the wall slots
  // corners-first (view breaks ties) before the open floor, so consecutive
  // pieces pack instead of stranding each other mid-wall; everything else
  // scans nearest-first from the view.
  const first = prefersWall ? byEndThenView(backed) : orderedAll;
  for (const c of first) {
    if (fits(c.x, c.z, c.rotationY, PLACEMENT_GAP_CM)) {
      const spot = consider(c.x, c.z, c.rotationY);
      if (spot !== null) return spot;
    }
  }
  if (prefersWall) {
    for (const c of byEdgeThenView) {
      if (fits(c.x, c.z, 0, PLACEMENT_GAP_CM)) {
        const spot = consider(c.x, c.z, 0);
        if (spot !== null) return spot;
      }
    }
  }
  // Phases 3-4: exact fit (gap dropped) before giving up on overlaps.
  for (const c of byView(backed)) {
    if (fits(c.x, c.z, c.rotationY, 0)) {
      const spot = consider(c.x, c.z, c.rotationY);
      if (spot !== null) return spot;
    }
  }
  for (const c of prefersWall ? byEdgeThenView : orderedGrid) {
    if (fits(c.x, c.z, 0, 0)) {
      const spot = consider(c.x, c.z, 0);
      if (spot !== null) return spot;
    }
  }

  // Phase 5 (room genuinely full): deterministic micro-spiral around the view
  // centre so the new piece never lands exactly on another piece's point.
  for (let ring = 1; ring <= 40; ring += 1) {
    const r = ring * 5;
    const n = 8;
    for (let k = 0; k < n; k += 1) {
      const a = (k / n) * Math.PI * 2 + ring;
      const x = Math.round((origin.x + Math.cos(a) * r) * 10) / 10 + ring * 0.1;
      const z = Math.round((origin.z + Math.sin(a) * r) * 10) / 10;
      let stacked = false;
      for (const other of state.items) {
        if (Math.abs(other.position.x - x) < 0.05 && Math.abs(other.position.z - z) < 0.05) {
          stacked = true;
          break;
        }
      }
      if (!stacked) {
        const spot = consider(x, z, 0);
        if (spot !== null) return spot;
      }
    }
  }
  return bestHolder.current?.spot ?? { x: origin.x + 0.5, z: origin.z, rotationY: 0 };
}

/** Footprint corners inflated by `gapCm` on every side (plan cm). */
function inflatedCorners(
  item: SceneItem,
  catalog: Map<string, CatalogItem>,
  gapCm: number,
): PlanPoint[] {
  const entry = catalog.get(item.productId);
  const w = (entry?.size.w ?? 60) + gapCm * 2;
  const d = (entry?.size.d ?? 60) + gapCm * 2;
  const hw = w / 2;
  const hd = d / 2;
  const rad = (item.rotationY * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const local: PlanPoint[] = [
    { x: -hw, z: -hd },
    { x: hw, z: -hd },
    { x: hw, z: hd },
    { x: -hw, z: hd },
  ];
  return local.map((p) => ({
    x: item.position.x + p.x * cos + p.z * sin,
    z: item.position.z - p.x * sin + p.z * cos,
  }));
}

/**
 * Candidate spots with the piece's back against each wall: positions along
 * every wall at 10cm spacing, rotated so local -Z (the back) faces the wall
 * with a small stand-off. Each candidate carries `end`, its distance along
 * the wall to the nearer end, so callers can fill from the corners.
 */
function wallBackedCandidates(
  room: RoomLayout,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  w: number,
  d: number,
): Array<{ x: number; z: number; rotationY: number; end: number }> {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const out: Array<{ x: number; z: number; rotationY: number; end: number }> = [];
  for (const wall of room.walls) {
    const len = wallLengthCm(wall.start, wall.end) || 1;
    const dirX = (wall.end.x - wall.start.x) / len;
    const dirZ = (wall.end.z - wall.start.z) / len;
    // Outward side, centre-based (robust for any winding).
    const midX = (wall.start.x + wall.end.x) / 2;
    const midZ = (wall.start.z + wall.end.z) / 2;
    let outX = midX - cx;
    let outZ = midZ - cz;
    const outLen = Math.hypot(outX, outZ) || 1;
    outX /= outLen;
    outZ /= outLen;
    // Yaw whose local -Z (back) points along `outward`.
    const rad = Math.atan2(-outX, -outZ);
    const rotationY = (rad * 180) / Math.PI;
    // Rotated half-extents, so the centre stands off the wall correctly.
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const hx = (w / 2) * cos + (d / 2) * sin;
    const hz = (w / 2) * sin + (d / 2) * cos;
    const alongOut = hx * Math.abs(outX) + hz * Math.abs(outZ);
    const alongWall = hx * Math.abs(dirX) + hz * Math.abs(dirZ);
    const standOff = 4;
    const place = (s: number): void => {
      const px = wall.start.x + dirX * s - outX * (alongOut + standOff);
      const pz = wall.start.z + dirZ * s - outZ * (alongOut + standOff);
      out.push({
        x: px,
        z: pz,
        rotationY: Math.round(rotationY * 10) / 10,
        end: Math.min(s, len - s),
      });
    };
    // Pitch-exact slots anchored to both ends: neighbours tile with exactly
    // the placement gap between them (a 10cm grid cannot hit that pitch).
    const pitch = alongWall * 2 + PLACEMENT_GAP_CM;
    for (let s = alongWall + 2; s <= len - alongWall - 2 + 1e-6; s += pitch) {
      place(s);
    }
    for (let s = len - alongWall - 2; s >= alongWall + 2 - 1e-6; s -= pitch) {
      place(s);
    }
    // Fine 10cm spacing for leftover holes between pitched neighbours.
    for (let s = alongWall + 2; s <= len - alongWall - 2; s += 10) {
      place(s);
    }
  }
  return out;
}

export function snapToGrid(valueCm: number, stepCm = SNAP_CM): number {
  return Math.round(valueCm / stepCm) * stepCm;
}

/** Distance from a plan point to the room boundary (metres, for readout). */
export function distanceToWallM(point: PlanPoint, room: RoomLayout): number {
  let best = Infinity;
  for (const wall of room.walls) {
    const dx = wall.end.x - wall.start.x;
    const dz = wall.end.z - wall.start.z;
    const lenSq = dx * dx + dz * dz || 1;
    const t = Math.min(
      1,
      Math.max(0, ((point.x - wall.start.x) * dx + (point.z - wall.start.z) * dz) / lenSq),
    );
    const px = wall.start.x + dx * t;
    const pz = wall.start.z + dz * t;
    const dist = Math.hypot(point.x - px, point.z - pz);
    if (dist < best) best = dist;
  }
  return cmToMeters(best);
}

export function makeInstanceId(productId: string): string {
  return uid(productId);
}
