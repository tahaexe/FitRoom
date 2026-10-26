/**
 * Pure fit engine: RoomLayout + SceneState + product sizes in, FitIssue[] out.
 *
 * The rules below mirror the customer-facing fit contract exactly:
 * - Footprints are axis-aligned W x D rectangles (W along local X), swapped
 *   at rotationY 90/270, centred on the item position (plan centimetres).
 * - overlap: two footprints, or a footprint and a fixture, intersect by more
 *   than 0.01 cm on both axes. Rugs never fail overlap.
 * - outside: a footprint passes a wall's inner face by more than 1 cm.
 * - door-swing: a footprint intersects the door's quarter disc (centre =
 *   hinge point, radius = door width, on the swing side).
 * - walkway, two tiers on a 1 cm grid (cell centres at x + 0.5, z + 0.5,
 *   4-neighbours): circulation cells blocked closer than 39.5 cm to a
 *   footprint, fixture or wall; approach cells open at 22 cm or more; the
 *   approach area is the circulation area plus approach-open cells reachable
 *   from it in at most 60 steps. Every seat (sofa, armchair) needs an
 *   approach-area cell strictly inside one of its three 45 cm access strips
 *   (front, left, right). A blocked entrance start yields a single
 *   walkway-entrance issue instead of one error per seat.
 * - window (warning): an item taller than the sill whose footprint reaches
 *   within 30 cm of that window's wall and overlaps its span.
 *
 * No DOM, no three.js: safe to run in the client, the server and node.
 */

import type {
  DoorOpening,
  FitIssue,
  Fixture,
  Opening,
  PlanPoint,
  RoomLayout,
  SceneState,
  SizeCm,
  Wall,
} from "./types.js";

/** Product size plus the category bits the rules need (seats, rugs). */
export interface FitProduct {
  size: SizeCm;
  category: string;
}

export type FitProducts = ReadonlyMap<string, FitProduct>;

/** Axis-aligned rectangle in plan centimetres. */
export interface FitRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** A door's swing sector, for checks and for drawing the floor arc. */
export interface DoorSector {
  doorId: string;
  /** Hinge point (plan cm). */
  hx: number;
  hz: number;
  /** Swing radius = door width (cm). */
  radius: number;
  /** Unit vector along the wall, hinge towards latch. */
  ax: number;
  az: number;
  /** Unit inward normal (into the room). */
  nx: number;
  nz: number;
  /** Door centre pushed into the room (walkway start seed, plan cm). */
  startX: number;
  startZ: number;
}

/** Overlap tolerance: intersection must exceed 0.01 cm on both axes. */
const OVERLAP_EPS_CM = 0.01;
/** A footprint may pass the inner wall face by at most 1 cm. */
const OUTSIDE_TOL_CM = 1;
/** Circulation growth: blocked closer than 39.5 cm. */
const CIRC_GROWTH_CM = 39.5;
/** Approach growth: open at 22 cm or more. */
const APPROACH_GROWTH_CM = 22;
/** Approach BFS depth cap from the circulation area. */
const APPROACH_STEPS = 60;
/** Access strip depth for seats. */
const STRIP_CM = 45;
/** Walkway start: door centre this far into the room. */
const START_IN_CM = 45;
/** Window warning reach. */
const WINDOW_REACH_CM = 30;
/** Float noise guard for exact-threshold comparisons. */
const SLACK = 1e-9;

function normQuarter(rotationY: number): 0 | 1 | 2 | 3 {
  const q = ((Math.round(rotationY / 90) % 4) + 4) % 4;
  return (q === 0 ? 0 : q === 1 ? 1 : q === 2 ? 2 : 3) as 0 | 1 | 2 | 3;
}

export function isSeatCategory(category: string): boolean {
  return category === "sofa" || category === "armchair";
}

function isRug(productId: string, category: string): boolean {
  return category === "rug" || productId.toLowerCase().includes("rug");
}

/** Axis-aligned footprint of a product at a plan position. */
export function footprintOf(size: SizeCm, position: PlanPoint, rotationY: number): FitRect {
  const swapped = normQuarter(rotationY) % 2 === 1;
  const w = swapped ? size.d : size.w;
  const d = swapped ? size.w : size.d;
  return {
    x0: position.x - w / 2,
    z0: position.z - d / 2,
    x1: position.x + w / 2,
    z1: position.z + d / 2,
  };
}

function roomBounds(room: RoomLayout): FitRect {
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
  return { x0: minX, z0: minZ, x1: maxX, z1: maxZ };
}

function roomCentroid(room: RoomLayout): PlanPoint {
  let x = 0;
  let z = 0;
  const n = Math.max(1, room.walls.length * 2);
  for (const wall of room.walls) {
    x += wall.start.x + wall.end.x;
    z += wall.start.z + wall.end.z;
  }
  return { x: x / n, z: z / n };
}

function wallUnit(wall: Wall): { ux: number; uz: number; len: number } {
  const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z) || 1;
  return { ux: (wall.end.x - wall.start.x) / len, uz: (wall.end.z - wall.start.z) / len, len };
}

/** Unit normal of the wall pointing towards the room interior. */
function inwardNormal(wall: Wall, centroid: PlanPoint): { nx: number; nz: number } {
  const { ux, uz } = wallUnit(wall);
  const mx = (wall.start.x + wall.end.x) / 2;
  const mz = (wall.start.z + wall.end.z) / 2;
  // Two perpendiculars; the one towards the centroid points inside.
  const cx = centroid.x - mx;
  const cz = centroid.z - mz;
  if (cx * -uz + cz * ux >= 0) {
    return { nx: -uz, nz: ux };
  }
  return { nx: uz, nz: -ux };
}

/** Axis-aligned footprint of a wall-mounted fixture (exact for axis walls). */
export function fixtureRect(
  fixture: Fixture,
  room: RoomLayout,
  centroid: PlanPoint,
): FitRect | null {
  const wall = room.walls.find((w) => w.id === fixture.wallId);
  if (wall === undefined) return null;
  const { ux, uz } = wallUnit(wall);
  const { nx, nz } = inwardNormal(wall, centroid);
  const ax = wall.start.x + ux * fixture.offset;
  const az = wall.start.z + uz * fixture.offset;
  const bx = wall.start.x + ux * (fixture.offset + fixture.width);
  const bz = wall.start.z + uz * (fixture.offset + fixture.width);
  const cx = ax + nx * fixture.depth;
  const cz = az + nz * fixture.depth;
  const dx = bx + nx * fixture.depth;
  const dz = bz + nz * fixture.depth;
  return {
    x0: Math.min(ax, bx, cx, dx),
    z0: Math.min(az, bz, cz, dz),
    x1: Math.max(ax, bx, cx, dx),
    z1: Math.max(az, bz, cz, dz),
  };
}

/** Euclidean distance from a point to a rectangle (0 inside). */
function distPointRect(px: number, pz: number, r: FitRect): number {
  const dx = Math.max(r.x0 - px, 0, px - r.x1);
  const dz = Math.max(r.z0 - pz, 0, pz - r.z1);
  return Math.hypot(dx, dz);
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

/** Distance between a rectangle and a wall segment (vertex-to-edge both ways). */
function distRectSegment(r: FitRect, ax: number, az: number, bx: number, bz: number): number {
  let best = Math.min(
    distPointSegment(ax, az, r.x0, r.z0, r.x1, r.z0),
    distPointSegment(ax, az, r.x1, r.z0, r.x1, r.z1),
    distPointSegment(ax, az, r.x1, r.z1, r.x0, r.z1),
    distPointSegment(ax, az, r.x0, r.z1, r.x0, r.z0),
    distPointSegment(bx, bz, r.x0, r.z0, r.x1, r.z0),
    distPointSegment(bx, bz, r.x1, r.z0, r.x1, r.z1),
    distPointSegment(bx, bz, r.x1, r.z1, r.x0, r.z1),
    distPointSegment(bx, bz, r.x0, r.z1, r.x0, r.z0),
  );
  const corners: Array<[number, number]> = [
    [r.x0, r.z0],
    [r.x1, r.z0],
    [r.x1, r.z1],
    [r.x0, r.z1],
  ];
  for (const [cx, cz] of corners) {
    const d = distPointSegment(cx, cz, ax, az, bx, bz);
    if (d < best) best = d;
  }
  // Segment crossing straight through the rectangle: interiors intersect.
  if (rectContains(r, (ax + bx) / 2, (az + bz) / 2) || segmentHitsRect(ax, az, bx, bz, r)) {
    best = 0;
  }
  return best;
}

function rectContains(r: FitRect, x: number, z: number): boolean {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
}

function segmentsCross(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): boolean {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function segmentHitsRect(ax: number, az: number, bx: number, bz: number, r: FitRect): boolean {
  if (rectContains(r, ax, az) || rectContains(r, bx, bz)) return true;
  const edges: Array<[number, number, number, number]> = [
    [r.x0, r.z0, r.x1, r.z0],
    [r.x1, r.z0, r.x1, r.z1],
    [r.x1, r.z1, r.x0, r.z1],
    [r.x0, r.z1, r.x0, r.z0],
  ];
  return edges.some(([cx, cz, dx, dz]) => segmentsCross(ax, az, bx, bz, cx, cz, dx, dz));
}

/** In-swing door sectors (centre = hinge, radius = door width). */
export function doorSectors(room: RoomLayout, centroid: PlanPoint): DoorSector[] {
  const out: DoorSector[] = [];
  for (const opening of room.openings) {
    if (opening.type !== "door") continue;
    const door = opening as DoorOpening;
    if (door.swing !== "in") continue;
    const wall = room.walls.find((w) => w.id === door.wallId);
    if (wall === undefined) continue;
    const { ux, uz } = wallUnit(wall);
    const { nx, nz } = inwardNormal(wall, centroid);
    const hingeAt = door.hinge === "left" ? door.offset : door.offset + door.width;
    const hx = wall.start.x + ux * hingeAt;
    const hz = wall.start.z + uz * hingeAt;
    const s = door.hinge === "left" ? 1 : -1;
    const cx = wall.start.x + ux * (door.offset + door.width / 2) + nx * START_IN_CM;
    const cz = wall.start.z + uz * (door.offset + door.width / 2) + nz * START_IN_CM;
    out.push({
      doorId: door.id,
      hx,
      hz,
      radius: door.width,
      ax: s * ux,
      az: s * uz,
      nx,
      nz,
      startX: cx,
      startZ: cz,
    });
  }
  return out;
}

function pointInSector(px: number, pz: number, s: DoorSector): boolean {
  const dx = px - s.hx;
  const dz = pz - s.hz;
  if (Math.hypot(dx, dz) > s.radius + SLACK) return false;
  // On the swing side: along the leaf and inside the room.
  if (dx * s.ax + dz * s.az < -SLACK) return false;
  if (dx * s.nx + dz * s.nz < -SLACK) return false;
  return true;
}

/** True when an axis rectangle meets a door's quarter disc. */
function rectHitsSector(r: FitRect, s: DoorSector): boolean {
  // Disc centre inside the rectangle.
  if (rectContains(r, s.hx, s.hz)) return true;
  // A rectangle corner inside the sector.
  const corners: Array<[number, number]> = [
    [r.x0, r.z0],
    [r.x1, r.z0],
    [r.x1, r.z1],
    [r.x0, r.z1],
  ];
  for (const [cx, cz] of corners) {
    if (pointInSector(cx, cz, s)) return true;
  }
  // A leaf edge (hinge -> arc ends) crossing the rectangle.
  if (
    segmentHitsRect(s.hx, s.hz, s.hx + s.ax * s.radius, s.hz + s.az * s.radius, r) ||
    segmentHitsRect(s.hx, s.hz, s.hx + s.nx * s.radius, s.hz + s.nz * s.radius, r)
  ) {
    return true;
  }
  // The arc passing through the rectangle (dense sample; rects are >> step).
  const steps = Math.max(32, Math.ceil(s.radius * 2));
  for (let i = 0; i <= steps; i += 1) {
    const phi = (i / steps) * (Math.PI / 2);
    const px = s.hx + (s.ax * Math.cos(phi) + s.nx * Math.sin(phi)) * s.radius;
    const pz = s.hz + (s.az * Math.cos(phi) + s.nz * Math.sin(phi)) * s.radius;
    if (rectContains(r, px, pz)) return true;
  }
  return false;
}

interface SeatStrip {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** The three 45 cm access strips of a seat footprint (front + both sides). */
function seatStrips(rect: FitRect, rotationY: number): SeatStrip[] {
  const q = normQuarter(rotationY);
  if (q === 0) {
    // Front faces +Z.
    return [
      { x0: rect.x0, z0: rect.z1, x1: rect.x1, z1: rect.z1 + STRIP_CM },
      { x0: rect.x0 - STRIP_CM, z0: rect.z0, x1: rect.x0, z1: rect.z1 },
      { x0: rect.x1, z0: rect.z0, x1: rect.x1 + STRIP_CM, z1: rect.z1 },
    ];
  }
  if (q === 2) {
    // Front faces -Z.
    return [
      { x0: rect.x0, z0: rect.z0 - STRIP_CM, x1: rect.x1, z1: rect.z0 },
      { x0: rect.x0 - STRIP_CM, z0: rect.z0, x1: rect.x0, z1: rect.z1 },
      { x0: rect.x1, z0: rect.z0, x1: rect.x1 + STRIP_CM, z1: rect.z1 },
    ];
  }
  if (q === 1) {
    // Front faces +X.
    return [
      { x0: rect.x1, z0: rect.z0, x1: rect.x1 + STRIP_CM, z1: rect.z1 },
      { x0: rect.x0, z0: rect.z0 - STRIP_CM, x1: rect.x1, z1: rect.z0 },
      { x0: rect.x0, z0: rect.z1, x1: rect.x1, z1: rect.z1 + STRIP_CM },
    ];
  }
  // Front faces -X.
  return [
    { x0: rect.x0 - STRIP_CM, z0: rect.z0, x1: rect.x0, z1: rect.z1 },
    { x0: rect.x0, z0: rect.z0 - STRIP_CM, x1: rect.x1, z1: rect.z0 },
    { x0: rect.x0, z0: rect.z1, x1: rect.x1, z1: rect.z1 + STRIP_CM },
  ];
}

export interface FitAnalysis {
  issues: FitIssue[];
  /** Combined (static + scene) circulation-blocked cells, row-major nz rows. */
  blockedCirculation: Uint8Array;
  /** Grid width (cells) along X. */
  nx: number;
  /** Grid depth (cells) along Z. */
  nz: number;
  /** Plan cm of cell (0, 0)'s corner. */
  originX: number;
  originZ: number;
  doors: DoorSector[];
}

/**
 * Fit checker with precomputed wall + fixture blocking.
 *
 * Construct once per room (static grids are reused); call `analyze` per
 * scene. Passing `movedIds` (instance ids whose footprint changed since the
 * last call with the same item set) restricts the dynamic re-stamp to the
 * neighbourhood of those items — the drag path.
 */
export class FitEngine {
  private readonly room: RoomLayout;
  private readonly products: FitProducts;
  private readonly centroid: PlanPoint;
  private readonly fixtures: FitRect[];
  private readonly doors: DoorSector[];
  readonly nx: number;
  readonly nz: number;
  readonly originX: number;
  readonly originZ: number;
  /** Static circulation-blocked cells (walls + fixtures + outside). */
  private readonly staticCirc: Uint8Array;
  /** Static approach-blocked cells (walls + fixtures + outside). */
  private readonly staticAppr: Uint8Array;
  /** Dynamic (footprint) blocked cells, cached between calls. */
  private dynCirc: Uint8Array;
  private dynAppr: Uint8Array;
  private lastRects = new Map<string, FitRect>();

  constructor(room: RoomLayout, products: FitProducts) {
    this.room = room;
    this.products = products;
    this.centroid = roomCentroid(room);
    const bounds = roomBounds(room);
    this.originX = bounds.x0;
    this.originZ = bounds.z0;
    this.nx = Math.max(1, Math.round(bounds.x1 - bounds.x0));
    this.nz = Math.max(1, Math.round(bounds.z1 - bounds.z0));
    this.fixtures = [];
    for (const fx of room.fixtures) {
      const r = fixtureRect(fx, room, this.centroid);
      if (r !== null) this.fixtures.push(r);
    }
    this.doors = doorSectors(room, this.centroid);
    this.staticCirc = new Uint8Array(this.nx * this.nz);
    this.staticAppr = new Uint8Array(this.nx * this.nz);
    this.dynCirc = new Uint8Array(this.nx * this.nz);
    this.dynAppr = new Uint8Array(this.nx * this.nz);
    this.precomputeStatic();
  }

  doorsOf(): DoorSector[] {
    return this.doors;
  }

  private cellCentre(ix: number, iz: number): { x: number; z: number } {
    return { x: this.originX + ix + 0.5, z: this.originZ + iz + 0.5 };
  }

  private insideRoom(x: number, z: number): boolean {
    // Ray cast towards +x over the wall polygon.
    let crossings = 0;
    for (const wall of this.room.walls) {
      const ax = wall.start.x;
      const az = wall.start.z;
      const bx = wall.end.x;
      const bz = wall.end.z;
      if (az > z !== bz > z) {
        const t = (z - az) / (bz - az);
        if (ax + t * (bx - ax) > x) crossings += 1;
      }
    }
    return crossings % 2 === 1;
  }

  private wallDistance(x: number, z: number): number {
    let best = Infinity;
    for (const wall of this.room.walls) {
      const d = distPointSegment(x, z, wall.start.x, wall.start.z, wall.end.x, wall.end.z);
      if (d < best) best = d;
    }
    return best;
  }

  /** One-time per room: wall, fixture and outside blocking for both tiers. */
  private precomputeStatic(): void {
    for (let iz = 0; iz < this.nz; iz += 1) {
      for (let ix = 0; ix < this.nx; ix += 1) {
        const idx = iz * this.nx + ix;
        const { x, z } = this.cellCentre(ix, iz);
        if (!this.insideRoom(x, z)) {
          this.staticCirc[idx] = 1;
          this.staticAppr[idx] = 1;
          continue;
        }
        const wallD = this.wallDistance(x, z);
        let circ = wallD < CIRC_GROWTH_CM - SLACK ? 1 : 0;
        let appr = wallD < APPROACH_GROWTH_CM - SLACK ? 1 : 0;
        for (const fx of this.fixtures) {
          const d = distPointRect(x, z, fx);
          if (d < CIRC_GROWTH_CM - SLACK) circ = 1;
          if (d < APPROACH_GROWTH_CM - SLACK) appr = 1;
          if (circ === 1 && appr === 1) break;
        }
        this.staticCirc[idx] = circ;
        this.staticAppr[idx] = appr;
      }
    }
  }

  /**
   * Stamp the grown-rectangle disc into the target layer. Hot path: squared
   * distances, row pre-reject, no allocation per cell.
   */
  private stampRect(
    target: Uint8Array,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    growth: number,
    ix0: number,
    ix1: number,
    iz0: number,
    iz1: number,
  ): void {
    const loX = Math.max(0, ix0);
    const hiX = Math.min(this.nx - 1, ix1);
    const loZ = Math.max(0, iz0);
    const hiZ = Math.min(this.nz - 1, iz1);
    if (hiX < loX || hiZ < loZ) return;
    const rr = (growth - SLACK) * (growth - SLACK);
    const ox = this.originX;
    const oz = this.originZ;
    const nx = this.nx;
    for (let iz = loZ; iz <= hiZ; iz += 1) {
      const cz = oz + iz + 0.5;
      const dz = cz < z0 ? z0 - cz : cz > z1 ? cz - z1 : 0;
      const dz2 = dz * dz;
      if (dz2 >= rr) continue;
      const row = iz * nx;
      for (let ix = loX; ix <= hiX; ix += 1) {
        const cx = ox + ix + 0.5;
        const dx = cx < x0 ? x0 - cx : cx > x1 ? cx - x1 : 0;
        if (dx * dx + dz2 < rr) target[row + ix] = 1;
      }
    }
  }

  private fullBox(rect: FitRect, growth: number): [number, number, number, number] {
    return [
      Math.floor(rect.x0 - growth - this.originX),
      Math.floor(rect.x1 + growth - this.originX),
      Math.floor(rect.z0 - growth - this.originZ),
      Math.floor(rect.z1 + growth - this.originZ),
    ];
  }

  private stampFull(rects: FitRect[]): void {
    this.dynCirc.fill(0);
    this.dynAppr.fill(0);
    for (const rect of rects) {
      const [ax0, ax1, az0, az1] = this.fullBox(rect, CIRC_GROWTH_CM);
      this.stampRect(
        this.dynCirc,
        rect.x0,
        rect.z0,
        rect.x1,
        rect.z1,
        CIRC_GROWTH_CM,
        ax0,
        ax1,
        az0,
        az1,
      );
      const [bx0, bx1, bz0, bz1] = this.fullBox(rect, APPROACH_GROWTH_CM);
      this.stampRect(
        this.dynAppr,
        rect.x0,
        rect.z0,
        rect.x1,
        rect.z1,
        APPROACH_GROWTH_CM,
        bx0,
        bx1,
        bz0,
        bz1,
      );
    }
  }

  /**
   * Re-stamp the dynamic layer only inside the grown bounding boxes of the
   * given old/new rect pairs (the drag neighbourhood), from all rects.
   */
  private restampRegion(rects: FitRect[], regions: FitRect[]): void {
    const clear = (target: Uint8Array, growth: number): void => {
      for (const region of regions) {
        const [ax0, ax1, az0, az1] = this.fullBox(region, growth);
        const loX = Math.max(0, ax0);
        const hiX = Math.min(this.nx - 1, ax1);
        const loZ = Math.max(0, az0);
        const hiZ = Math.min(this.nz - 1, az1);
        for (let iz = loZ; iz <= hiZ; iz += 1) {
          for (let ix = loX; ix <= hiX; ix += 1) {
            target[iz * this.nx + ix] = 0;
          }
        }
      }
    };
    clear(this.dynCirc, CIRC_GROWTH_CM);
    clear(this.dynAppr, APPROACH_GROWTH_CM);
    for (const rect of rects) {
      for (const region of regions) {
        // Skip rects that cannot reach the region (expanded bbox test).
        if (
          rect.x1 + CIRC_GROWTH_CM < region.x0 - CIRC_GROWTH_CM ||
          rect.x0 - CIRC_GROWTH_CM > region.x1 + CIRC_GROWTH_CM ||
          rect.z1 + CIRC_GROWTH_CM < region.z0 - CIRC_GROWTH_CM ||
          rect.z0 - CIRC_GROWTH_CM > region.z1 + CIRC_GROWTH_CM
        ) {
          continue;
        }
        const [ax0, ax1, az0, az1] = this.fullBox(region, CIRC_GROWTH_CM);
        this.stampRect(
          this.dynCirc,
          rect.x0,
          rect.z0,
          rect.x1,
          rect.z1,
          CIRC_GROWTH_CM,
          ax0,
          ax1,
          az0,
          az1,
        );
        const [bx0, bx1, bz0, bz1] = this.fullBox(region, APPROACH_GROWTH_CM);
        this.stampRect(
          this.dynAppr,
          rect.x0,
          rect.z0,
          rect.x1,
          rect.z1,
          APPROACH_GROWTH_CM,
          bx0,
          bx1,
          bz0,
          bz1,
        );
      }
    }
  }

  analyze(scene: SceneState, movedIds?: readonly string[]): FitAnalysis {
    const issues: FitIssue[] = [];
    const items = scene.items;

    // ---- footprints ----
    const rects = new Map<string, FitRect>();
    const order: string[] = [];
    for (const item of items) {
      const product = this.products.get(item.productId);
      const size: SizeCm = product?.size ?? { w: 60, d: 60, h: 60 };
      rects.set(item.instanceId, footprintOf(size, item.position, item.rotationY));
      order.push(item.instanceId);
    }

    const rug = (instanceId: string): boolean => {
      const item = items.find((i) => i.instanceId === instanceId);
      if (item === undefined) return false;
      return isRug(item.productId, this.products.get(item.productId)?.category ?? "");
    };

    // ---- overlap (pairs, then fixtures) ----
    for (let i = 0; i < order.length; i += 1) {
      const aId = order[i] as string;
      const a = rects.get(aId);
      if (a === undefined || rug(aId)) continue;
      const aItem = items.find((it) => it.instanceId === aId);
      for (let j = i + 1; j < order.length; j += 1) {
        const bId = order[j] as string;
        const b = rects.get(bId);
        if (b === undefined || rug(bId)) continue;
        const bItem = items.find((it) => it.instanceId === bId);
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
        if (ox > OVERLAP_EPS_CM && oz > OVERLAP_EPS_CM) {
          const pair = [aId, bId].sort();
          const first = pair[0] as string;
          const second = pair[1] as string;
          issues.push({
            type: "overlap",
            severity: "error",
            itemIds: [first, second],
            message: "Pieces overlap",
            location: {
              x: ((aItem?.position.x ?? 0) + (bItem?.position.x ?? 0)) / 2,
              z: ((aItem?.position.z ?? 0) + (bItem?.position.z ?? 0)) / 2,
            },
          });
        }
      }
      if (aItem === undefined) continue;
      for (const fx of this.fixtures) {
        const ox = Math.min(a.x1, fx.x1) - Math.max(a.x0, fx.x0);
        const oz = Math.min(a.z1, fx.z1) - Math.max(a.z0, fx.z0);
        if (ox > OVERLAP_EPS_CM && oz > OVERLAP_EPS_CM) {
          issues.push({
            type: "overlap",
            severity: "error",
            itemIds: [aId],
            message: "Piece overlaps a fixed fixture",
            location: { ...aItem.position },
          });
          break;
        }
      }
    }

    // ---- outside ----
    const bounds = roomBounds(this.room);
    for (const item of items) {
      const r = rects.get(item.instanceId);
      if (r === undefined) continue;
      // Each side separately: beyond the inner face by more than 1 cm.
      const outside =
        bounds.x0 - r.x0 > OUTSIDE_TOL_CM + SLACK ||
        r.x1 - bounds.x1 > OUTSIDE_TOL_CM + SLACK ||
        bounds.z0 - r.z0 > OUTSIDE_TOL_CM + SLACK ||
        r.z1 - bounds.z1 > OUTSIDE_TOL_CM + SLACK;
      if (outside) {
        issues.push({
          type: "outside",
          severity: "error",
          itemIds: [item.instanceId],
          message: "Piece extends outside the room",
          location: { ...item.position },
        });
      }
    }

    // ---- door-swing ----
    for (const item of items) {
      const r = rects.get(item.instanceId);
      if (r === undefined) continue;
      for (const sector of this.doors) {
        if (rectHitsSector(r, sector)) {
          issues.push({
            type: "door-swing",
            severity: "error",
            itemIds: [item.instanceId],
            message: `Inside the swing of ${sector.doorId}`,
            location: { ...item.position },
          });
          break;
        }
      }
    }

    // ---- walkway ----
    const footprints = order
      .map((id) => rects.get(id))
      .filter((r): r is FitRect => r !== undefined);
    const movedSet = movedIds === undefined ? undefined : new Set(movedIds);
    const sameSet =
      movedSet !== undefined &&
      order.length === this.lastRects.size &&
      order.every((id) => this.lastRects.has(id));
    if (!sameSet) {
      this.stampFull(footprints);
      this.lastRects = new Map(rects);
    } else if (movedSet !== undefined) {
      const regions: FitRect[] = [];
      for (const id of movedSet) {
        const oldR = this.lastRects.get(id);
        const newR = rects.get(id);
        if (oldR !== undefined) regions.push(oldR);
        if (newR !== undefined) regions.push(newR);
      }
      if (regions.length > 0) {
        this.restampRegion(footprints, regions);
      }
      this.lastRects = new Map(rects);
    }

    const circBlocked = (idx: number): boolean =>
      (this.staticCirc[idx] ?? 0) === 1 || (this.dynCirc[idx] ?? 0) === 1;
    const apprBlocked = (idx: number): boolean =>
      (this.staticAppr[idx] ?? 0) === 1 || (this.dynAppr[idx] ?? 0) === 1;

    const startDoor = this.doors[0];
    if (startDoor !== undefined) {
      const six = Math.round(startDoor.startX - this.originX - 0.5);
      const siz = Math.round(startDoor.startZ - this.originZ - 0.5);
      const sixC = Math.min(this.nx - 1, Math.max(0, six));
      const sizC = Math.min(this.nz - 1, Math.max(0, siz));
      const startIdx = sizC * this.nx + sixC;
      const startCentre = this.cellCentre(sixC, sizC);
      if (circBlocked(startIdx)) {
        // Entrance blocked: one error naming the blocking items.
        const blockers = order.filter((id) => {
          const r = rects.get(id);
          return (
            r !== undefined &&
            distPointRect(startCentre.x, startCentre.z, r) < CIRC_GROWTH_CM - SLACK
          );
        });
        issues.push({
          type: "walkway-entrance",
          severity: "error",
          itemIds: [...blockers].sort(),
          message: "Entrance is blocked",
          location: { x: startDoor.startX, z: startDoor.startZ },
        });
      } else {
        // Circulation flood from the start.
        const circ = new Uint8Array(this.nx * this.nz);
        const queue = new Int32Array(this.nx * this.nz);
        let head = 0;
        let tail = 0;
        circ[startIdx] = 1;
        queue[tail] = startIdx;
        tail += 1;
        while (head < tail) {
          const cur = queue[head] as number;
          head += 1;
          const cx = cur % this.nx;
          const cz = (cur - cx) / this.nx;
          if (cx > 0 && circ[cur - 1] === 0 && !circBlocked(cur - 1)) {
            circ[cur - 1] = 1;
            queue[tail] = cur - 1;
            tail += 1;
          }
          if (cx < this.nx - 1 && circ[cur + 1] === 0 && !circBlocked(cur + 1)) {
            circ[cur + 1] = 1;
            queue[tail] = cur + 1;
            tail += 1;
          }
          if (cz > 0 && circ[cur - this.nx] === 0 && !circBlocked(cur - this.nx)) {
            circ[cur - this.nx] = 1;
            queue[tail] = cur - this.nx;
            tail += 1;
          }
          if (cz < this.nz - 1 && circ[cur + this.nx] === 0 && !circBlocked(cur + this.nx)) {
            circ[cur + this.nx] = 1;
            queue[tail] = cur + this.nx;
            tail += 1;
          }
        }
        // Approach: circulation plus approach-open cells within 60 steps.
        const approach = new Uint8Array(this.nx * this.nz);
        const depth = new Int32Array(this.nx * this.nz).fill(-1);
        const queue2 = new Int32Array(this.nx * this.nz);
        let head2 = 0;
        let tail2 = 0;
        for (let i = 0; i < circ.length; i += 1) {
          if (circ[i] === 1) {
            approach[i] = 1;
            depth[i] = 0;
            queue2[tail2] = i;
            tail2 += 1;
          }
        }
        const push = (nxt: number, d: number): void => {
          if (approach[nxt] === 1) return;
          if (circ[nxt] === 1 || !apprBlocked(nxt)) {
            if (d <= APPROACH_STEPS) {
              approach[nxt] = 1;
              depth[nxt] = d;
              queue2[tail2] = nxt;
              tail2 += 1;
            }
          }
        };
        while (head2 < tail2) {
          const cur = queue2[head2] as number;
          head2 += 1;
          const d = (depth[cur] as number) + 1;
          if (d > APPROACH_STEPS) continue;
          const cx = cur % this.nx;
          const cz = (cur - cx) / this.nx;
          if (cx > 0) push(cur - 1, d);
          if (cx < this.nx - 1) push(cur + 1, d);
          if (cz > 0) push(cur - this.nx, d);
          if (cz < this.nz - 1) push(cur + this.nx, d);
        }
        // Seats: one error per seat with no approach cell in any strip.
        for (const item of items) {
          const category = this.products.get(item.productId)?.category ?? "";
          if (!isSeatCategory(category)) continue;
          const r = rects.get(item.instanceId);
          if (r === undefined) continue;
          const strips = seatStrips(r, item.rotationY);
          let ok = false;
          for (const strip of strips) {
            const ix0 = Math.max(0, Math.floor(strip.x0 - this.originX));
            const ix1 = Math.min(this.nx - 1, Math.ceil(strip.x1 - this.originX));
            const iz0 = Math.max(0, Math.floor(strip.z0 - this.originZ));
            const iz1 = Math.min(this.nz - 1, Math.ceil(strip.z1 - this.originZ));
            for (let iz = iz0; iz <= iz1 && !ok; iz += 1) {
              for (let ix = ix0; ix <= ix1 && !ok; ix += 1) {
                if (approach[iz * this.nx + ix] !== 1) continue;
                const c = this.cellCentre(ix, iz);
                if (c.x > strip.x0 && c.x < strip.x1 && c.z > strip.z0 && c.z < strip.z1) {
                  ok = true;
                }
              }
            }
            if (ok) break;
          }
          if (!ok) {
            issues.push({
              type: "walkway",
              severity: "error",
              itemIds: [item.instanceId],
              message: "No walkway access to this seat",
              location: { ...item.position },
            });
          }
        }
      }
    }

    // ---- window (warning) ----
    const windows: Opening[] = this.room.openings.filter((o) => o.type === "window");
    for (const item of items) {
      const r = rects.get(item.instanceId);
      if (r === undefined) continue;
      const height = this.products.get(item.productId)?.size.h ?? 0;
      for (const opening of windows) {
        if (height <= opening.sillHeight) continue;
        const wall = this.room.walls.find((w) => w.id === opening.wallId);
        if (wall === undefined) continue;
        const { ux, uz } = wallUnit(wall);
        if (
          distRectSegment(r, wall.start.x, wall.start.z, wall.end.x, wall.end.z) >
          WINDOW_REACH_CM + SLACK
        ) {
          continue;
        }
        const corners: Array<[number, number]> = [
          [r.x0, r.z0],
          [r.x1, r.z0],
          [r.x1, r.z1],
          [r.x0, r.z1],
        ];
        let lo = Infinity;
        let hi = -Infinity;
        for (const [cx, cz] of corners) {
          const t = (cx - wall.start.x) * ux + (cz - wall.start.z) * uz;
          if (t < lo) lo = t;
          if (t > hi) hi = t;
        }
        const spanLo = opening.offset;
        const spanHi = opening.offset + opening.width;
        if (Math.min(hi, spanHi) - Math.max(lo, spanLo) <= SLACK) continue;
        issues.push({
          type: "window",
          severity: "warning",
          itemIds: [item.instanceId],
          message: `Too close to ${opening.id}`,
          location: { ...item.position },
        });
        break;
      }
    }

    const blocked = new Uint8Array(this.nx * this.nz);
    for (let i = 0; i < blocked.length; i += 1) {
      blocked[i] = circBlocked(i) ? 1 : 0;
    }
    return {
      issues,
      blockedCirculation: blocked,
      nx: this.nx,
      nz: this.nz,
      originX: this.originX,
      originZ: this.originZ,
      doors: this.doors,
    };
  }

  /** Convenience: just the issues. */
  check(scene: SceneState): FitIssue[] {
    return this.analyze(scene).issues;
  }
}

/** One-shot check without managing an engine instance. */
export function checkFit(room: RoomLayout, scene: SceneState, products: FitProducts): FitIssue[] {
  return new FitEngine(room, products).check(scene);
}
