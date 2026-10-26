/**
 * Pure fit engine: RoomLayout + SceneState + product sizes in, FitIssue[] out.
 *
 * The rules below mirror the customer-facing fit contract exactly:
 * - Products are normalised: front faces +Z at rotationY 0; 90 → +X,
 *   180 → −Z, 270 → −X. Footprint = the W × D rectangle (W along local X,
 *   D along local Z) turned by rotationY about its centre, at any angle:
 *   local (lx, lz) → world (lx·cos θ + lz·sin θ, −lx·sin θ + lz·cos θ).
 *   cos/sin are exact 0 and ±1 at multiples of 90°, so axis-aligned scenes
 *   behave exactly like plain boxes (no 421.0000001 corners).
 * - overlap: two footprints, or a footprint and a fixture, overlap by more
 *   than 0.01 cm along every separating axis (the four edge normals of the
 *   two rectangles); for axis-aligned boxes this is "more than 0.01 cm on
 *   both axes". Rugs never fail overlap.
 * - outside: a footprint corner passes a wall's inner face by more than 1 cm.
 * - door-swing: a footprint intersects the door's quarter disc (centre =
 *   hinge point, radius = door width, on the swing side): the rectangle is
 *   clipped to the swing quadrant, and an issue is raised when the clipped
 *   part comes closer to the hinge than the door width.
 * - walkway, two tiers on a 1 cm grid (cell centres at x + 0.5, z + 0.5,
 *   4-neighbours): circulation cells blocked closer than 39.5 cm to a
 *   footprint, fixture or wall; approach cells open at 22 cm or more; the
 *   approach area is the circulation area plus approach-open cells reachable
 *   from it in at most 60 steps. Every seat (sofa, armchair) needs an
 *   approach-area cell strictly inside one of its three 45 cm access strips
 *   (front, left, right — they turn with the seat). A blocked entrance start
 *   yields a single walkway-entrance issue instead of one error per seat.
 * - window (warning): an item taller than the sill whose footprint (its
 *   corners) reaches within 30 cm of that window's wall and overlaps its
 *   span.
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

/**
 * Oriented W × D footprint in plan centimetres: centre, half extents and the
 * rotation that takes local (lx, lz) to world
 * (lx·cos + lz·sin, −lx·sin + lz·cos). Corners are stored explicitly; the
 * axis-aligned box bounds stamping and incremental updates.
 */
export interface OrientedRect {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  cos: number;
  sin: number;
  corners: PlanPoint[];
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

/** Overlap tolerance: intersection must exceed 0.01 cm on every axis. */
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

/**
 * cos/sin of a rotationY angle, exact 0 and ±1 at multiples of 90° so that
 * axis-aligned scenes compute exactly like plain boxes.
 */
function angleTrig(degrees: number): { cos: number; sin: number } {
  const q = ((degrees % 360) + 360) % 360;
  if (q === 0) return { cos: 1, sin: 0 };
  if (q === 90) return { cos: 0, sin: 1 };
  if (q === 180) return { cos: -1, sin: 0 };
  if (q === 270) return { cos: 0, sin: -1 };
  const rad = (degrees * Math.PI) / 180;
  return { cos: Math.cos(rad), sin: Math.sin(rad) };
}

export function isSeatCategory(category: string): boolean {
  return category === "sofa" || category === "armchair";
}

function isRug(productId: string, category: string): boolean {
  return category === "rug" || productId.toLowerCase().includes("rug");
}

/** Oriented rectangle from centre, half extents and rotation trig. */
function makeOriented(
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  cos: number,
  sin: number,
): OrientedRect {
  const corners: PlanPoint[] = [
    { x: cx + -hx * cos + -hz * sin, z: cz - -hx * sin + -hz * cos },
    { x: cx + hx * cos + -hz * sin, z: cz - hx * sin + -hz * cos },
    { x: cx + hx * cos + hz * sin, z: cz - hx * sin + hz * cos },
    { x: cx + -hx * cos + hz * sin, z: cz - -hx * sin + hz * cos },
  ];
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const c of corners) {
    if (c.x < x0) x0 = c.x;
    if (c.z < z0) z0 = c.z;
    if (c.x > x1) x1 = c.x;
    if (c.z > z1) z1 = c.z;
  }
  return { cx, cz, hx, hz, cos, sin, corners, x0, z0, x1, z1 };
}

/** Oriented footprint of a product at a plan position, at any angle. */
export function orientedFootprint(
  size: SizeCm,
  position: PlanPoint,
  rotationY: number,
): OrientedRect {
  const { cos, sin } = angleTrig(rotationY);
  return makeOriented(position.x, position.z, size.w / 2, size.d / 2, cos, sin);
}

/** Axis-aligned footprint box of a product at a plan position. */
export function footprintOf(size: SizeCm, position: PlanPoint, rotationY: number): FitRect {
  const o = orientedFootprint(size, position, rotationY);
  return { x0: o.x0, z0: o.z0, x1: o.x1, z1: o.z1 };
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

/** Oriented footprint of a fixture (axis-aligned for axis walls). */
function fixtureOriented(
  fixture: Fixture,
  room: RoomLayout,
  centroid: PlanPoint,
): OrientedRect | null {
  const r = fixtureRect(fixture, room, centroid);
  if (r === null) return null;
  return makeOriented(
    (r.x0 + r.x1) / 2,
    (r.z0 + r.z1) / 2,
    (r.x1 - r.x0) / 2,
    (r.z1 - r.z0) / 2,
    1,
    0,
  );
}

/** Euclidean distance from a point to an oriented rectangle (0 inside). */
function distPointOriented(px: number, pz: number, r: OrientedRect): number {
  const dx = px - r.cx;
  const dz = pz - r.cz;
  const lx = dx * r.cos - dz * r.sin;
  const lz = dx * r.sin + dz * r.cos;
  const ex = lx < -r.hx ? -r.hx - lx : lx > r.hx ? lx - r.hx : 0;
  const ez = lz < -r.hz ? -r.hz - lz : lz > r.hz ? lz - r.hz : 0;
  return Math.hypot(ex, ez);
}

/** Strict containment of a point in an oriented rectangle. */
function containsStrict(r: OrientedRect, px: number, pz: number): boolean {
  const dx = px - r.cx;
  const dz = pz - r.cz;
  const lx = dx * r.cos - dz * r.sin;
  const lz = dx * r.sin + dz * r.cos;
  return Math.abs(lx) < r.hx && Math.abs(lz) < r.hz;
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

/**
 * Separating-axis overlap: the projections overlap by more than 0.01 cm on
 * every one of the four edge normals of the two rectangles.
 */
function rectsOverlap(a: OrientedRect, b: OrientedRect): boolean {
  const axes: Array<[number, number]> = [
    [a.cos, -a.sin],
    [a.sin, a.cos],
    [b.cos, -b.sin],
    [b.sin, b.cos],
  ];
  for (const [ax, az] of axes) {
    const len = Math.hypot(ax, az) || 1;
    const nx = ax / len;
    const nz = az / len;
    const ca = a.cx * nx + a.cz * nz;
    const ra = a.hx * Math.abs(a.cos * nx - a.sin * nz) + a.hz * Math.abs(a.sin * nx + a.cos * nz);
    const cb = b.cx * nx + b.cz * nz;
    const rb = b.hx * Math.abs(b.cos * nx - b.sin * nz) + b.hz * Math.abs(b.sin * nx + b.cos * nz);
    const penetration = Math.min(ca + ra, cb + rb) - Math.max(ca - ra, cb - rb);
    if (!(penetration > OVERLAP_EPS_CM)) return false;
  }
  return true;
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

/** Clip a convex polygon to the half plane dot(p − h, a) >= 0. */
function clipHalfPlane(
  poly: PlanPoint[],
  hx: number,
  hz: number,
  ax: number,
  az: number,
): PlanPoint[] {
  const out: PlanPoint[] = [];
  if (poly.length === 0) return out;
  for (let i = 0; i < poly.length; i += 1) {
    const cur = poly[i] as PlanPoint;
    const nxt = poly[(i + 1) % poly.length] as PlanPoint;
    const dCur = (cur.x - hx) * ax + (cur.z - hz) * az;
    const dNxt = (nxt.x - hx) * ax + (nxt.z - hz) * az;
    const inCur = dCur >= -SLACK;
    const inNxt = dNxt >= -SLACK;
    if (inCur && inNxt) {
      out.push({ ...nxt });
    } else if (inCur && !inNxt) {
      const t = dCur / (dCur - dNxt);
      out.push({ x: cur.x + (nxt.x - cur.x) * t, z: cur.z + (nxt.z - cur.z) * t });
    } else if (!inCur && inNxt) {
      const t = dCur / (dCur - dNxt);
      out.push({ x: cur.x + (nxt.x - cur.x) * t, z: cur.z + (nxt.z - cur.z) * t });
      out.push({ ...nxt });
    }
  }
  return out;
}

/** True when a point lies inside a convex polygon (any winding). */
function pointInConvex(poly: PlanPoint[], px: number, pz: number): boolean {
  let positive = false;
  let negative = false;
  for (let i = 0; i < poly.length; i += 1) {
    const cur = poly[i] as PlanPoint;
    const nxt = poly[(i + 1) % poly.length] as PlanPoint;
    const cross = (nxt.x - cur.x) * (pz - cur.z) - (nxt.z - cur.z) * (px - cur.x);
    if (cross > 0) positive = true;
    else if (cross < 0) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

/** Distance from a point to a convex polygon (0 inside). */
function distPointConvex(poly: PlanPoint[], px: number, pz: number): number {
  if (poly.length === 0) return Infinity;
  if (pointInConvex(poly, px, pz)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const cur = poly[i] as PlanPoint;
    const nxt = poly[(i + 1) % poly.length] as PlanPoint;
    const d = distPointSegment(px, pz, cur.x, cur.z, nxt.x, nxt.z);
    if (d < best) best = d;
  }
  return best;
}

/**
 * True when an oriented footprint meets a door's quarter disc: the rectangle
 * is clipped to the swing quadrant, and an issue is raised when the clipped
 * part comes closer to the hinge than the door width.
 */
function orientedHitsSector(r: OrientedRect, s: DoorSector): boolean {
  let poly = clipHalfPlane(r.corners, s.hx, s.hz, s.ax, s.az);
  if (poly.length === 0) return false;
  poly = clipHalfPlane(poly, s.hx, s.hz, s.nx, s.nz);
  if (poly.length === 0) return false;
  return distPointConvex(poly, s.hx, s.hz) < s.radius;
}

/** The three 45 cm access strips of a seat footprint (front + both sides). */
function seatStrips(seat: OrientedRect): OrientedRect[] {
  const half = STRIP_CM / 2;
  // Strip centres in the seat's local frame, then to world with the seat's
  // own rotation so the strips turn with the seat.
  const toWorld = (lx: number, lz: number): PlanPoint => ({
    x: seat.cx + lx * seat.cos + lz * seat.sin,
    z: seat.cz - lx * seat.sin + lz * seat.cos,
  });
  const frontC = toWorld(0, seat.hz + half);
  const leftC = toWorld(-(seat.hx + half), 0);
  const rightC = toWorld(seat.hx + half, 0);
  return [
    makeOriented(frontC.x, frontC.z, seat.hx, half, seat.cos, seat.sin),
    makeOriented(leftC.x, leftC.z, half, seat.hz, seat.cos, seat.sin),
    makeOriented(rightC.x, rightC.z, half, seat.hz, seat.cos, seat.sin),
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
  private readonly fixtures: OrientedRect[];
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
  private lastRects = new Map<string, OrientedRect>();

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
      const r = fixtureOriented(fx, room, this.centroid);
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
          const d = distPointOriented(x, z, fx);
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
   * Stamp the grown-rectangle disc into the target layer. Hot path: local
   * frame plus squared distances, row pre-reject, no allocation per cell.
   */
  private stampRect(
    target: Uint8Array,
    r: OrientedRect,
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
    const { cx, cz, hx, hz, cos, sin } = r;
    for (let iz = loZ; iz <= hiZ; iz += 1) {
      const wz = oz + iz + 0.5 - cz;
      const row = iz * nx;
      for (let ix = loX; ix <= hiX; ix += 1) {
        const wx = ox + ix + 0.5 - cx;
        const lx = wx * cos - wz * sin;
        if (lx < -hx) {
          const ex = -hx - lx;
          if (ex * ex >= rr) continue;
        } else if (lx > hx) {
          const ex = lx - hx;
          if (ex * ex >= rr) continue;
        }
        const lz = wx * sin + wz * cos;
        const ez = lz < -hz ? -hz - lz : lz > hz ? lz - hz : 0;
        const ex2 = lx < -hx ? (-hx - lx) * (-hx - lx) : lx > hx ? (lx - hx) * (lx - hx) : 0;
        if (ex2 + ez * ez < rr) target[row + ix] = 1;
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

  private stampFull(rects: OrientedRect[]): void {
    this.dynCirc.fill(0);
    this.dynAppr.fill(0);
    for (const rect of rects) {
      const [ax0, ax1, az0, az1] = this.fullBox(rect, CIRC_GROWTH_CM);
      this.stampRect(this.dynCirc, rect, CIRC_GROWTH_CM, ax0, ax1, az0, az1);
      const [bx0, bx1, bz0, bz1] = this.fullBox(rect, APPROACH_GROWTH_CM);
      this.stampRect(this.dynAppr, rect, APPROACH_GROWTH_CM, bx0, bx1, bz0, bz1);
    }
  }

  /**
   * Re-stamp the dynamic layer only inside the grown bounding boxes of the
   * given old/new rect pairs (the drag neighbourhood), from all rects.
   */
  private restampRegion(rects: OrientedRect[], regions: FitRect[]): void {
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
        this.stampRect(this.dynCirc, rect, CIRC_GROWTH_CM, ax0, ax1, az0, az1);
        const [bx0, bx1, bz0, bz1] = this.fullBox(region, APPROACH_GROWTH_CM);
        this.stampRect(this.dynAppr, rect, APPROACH_GROWTH_CM, bx0, bx1, bz0, bz1);
      }
    }
  }

  analyze(scene: SceneState, movedIds?: readonly string[]): FitAnalysis {
    const issues: FitIssue[] = [];
    const items = scene.items;

    // ---- footprints ----
    const rects = new Map<string, OrientedRect>();
    const order: string[] = [];
    for (const item of items) {
      const product = this.products.get(item.productId);
      const size: SizeCm = product?.size ?? { w: 60, d: 60, h: 60 };
      rects.set(item.instanceId, orientedFootprint(size, item.position, item.rotationY));
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
        if (rectsOverlap(a, b)) {
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
        if (rectsOverlap(a, fx)) {
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

    // ---- outside: any corner past a wall's inner face by more than 1 cm ----
    for (const item of items) {
      const r = rects.get(item.instanceId);
      if (r === undefined) continue;
      let outside = false;
      for (const wall of this.room.walls) {
        const { nx, nz } = inwardNormal(wall, this.centroid);
        for (const c of r.corners) {
          const past = (wall.start.x - c.x) * nx + (wall.start.z - c.z) * nz;
          if (past > OUTSIDE_TOL_CM + SLACK) {
            outside = true;
            break;
          }
        }
        if (outside) break;
      }
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
        if (orientedHitsSector(r, sector)) {
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
      .filter((r): r is OrientedRect => r !== undefined);
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
            distPointOriented(startCentre.x, startCentre.z, r) < CIRC_GROWTH_CM - SLACK
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
          const strips = seatStrips(r);
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
                if (containsStrict(strip, c.x, c.z)) {
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

    // ---- window (warning): corners within reach + span overlap ----
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
        let reach = Infinity;
        for (const c of r.corners) {
          const d = distPointSegment(c.x, c.z, wall.start.x, wall.start.z, wall.end.x, wall.end.z);
          if (d < reach) reach = d;
        }
        if (reach > WINDOW_REACH_CM + SLACK) continue;
        let lo = Infinity;
        let hi = -Infinity;
        for (const c of r.corners) {
          const t = (c.x - wall.start.x) * ux + (c.z - wall.start.z) * uz;
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
