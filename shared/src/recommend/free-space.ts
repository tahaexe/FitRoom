/**
 * Free-space analysis (geometry only): for each wall the free runs along it
 * (start/end in cm plus usable depth before the walkway or another item) and
 * the open floor rectangles in the middle. Door swings and 80 cm walkways
 * are kept out. No DOM, no three.js.
 *
 * Method: walk each wall in 5 cm samples; at every sample march inward until
 * a placed piece (5 cm gap), a fixture, a door swing or a walkway corridor
 * blocks the point. Contiguous samples with at least 35 cm of depth form a
 * run. Open areas come from a 10 cm grid over the room middle (80 cm off the
 * walls) minus pieces, fixtures, swings and walkways, grown by 40 cm.
 */

import {
  doorSectors,
  fixtureRect,
  orientedFootprint,
  type DoorSector,
  type FitRect,
  type OrientedRect,
} from "../fit.js";
import type { CatalogItem, RoomLayout, SceneState } from "../types.js";
import { wallLengthCm } from "../units.js";
import type { FreeRun, FreeSpace, OpenArea } from "./types.js";

const SAMPLE_CM = 5;
const DEPTH_STEP_CM = 1;
const GRID_CM = 10;
const MAX_DEPTH_CM = 150;
const MIN_RUN_DEPTH_CM = 35;
const MIN_RUN_LENGTH_CM = 40;
/** Runs are inset by one wall sample at each end (obstacle edges fall there). */
const RUN_INSET_CM = 5;
const AREA_GROWTH_CM = 40;
const WALL_STRIP_CM = 80;
const WALKWAY_WIDTH_CM = 80;
const WALKWAY_LENGTH_CM = 240;
const MIN_AREA_SIDE_CM = 60;

interface Frame {
  ux: number;
  uz: number;
  len: number;
  nx: number;
  nz: number;
}

function centroidOf(room: RoomLayout): { x: number; z: number } {
  let x = 0;
  let z = 0;
  const n = Math.max(1, room.walls.length * 2);
  for (const wall of room.walls) {
    x += wall.start.x + wall.end.x;
    z += wall.start.z + wall.end.z;
  }
  return { x: x / n, z: z / n };
}

function frameOf(
  wall: { start: { x: number; z: number }; end: { x: number; z: number } },
  centroid: { x: number; z: number },
): Frame {
  const len = wallLengthCm(wall.start, wall.end) || 1;
  const ux = (wall.end.x - wall.start.x) / len;
  const uz = (wall.end.z - wall.start.z) / len;
  const mx = (wall.start.x + wall.end.x) / 2;
  const mz = (wall.start.z + wall.end.z) / 2;
  const cx = centroid.x - mx;
  const cz = centroid.z - mz;
  const nx = cx * -uz + cz * ux >= 0 ? -uz : uz;
  const nz = cx * -uz + cz * ux >= 0 ? ux : -uz;
  return { ux, uz, len, nx, nz };
}

/** Yaw (degrees) whose local −Z (the back) points along an outward vector. */
export function backToWallRotationY(outX: number, outZ: number): number {
  const deg = (Math.atan2(-outX, -outZ) * 180) / Math.PI;
  return Math.round((((deg % 360) + 360) % 360) * 10) / 10;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pointInOriented(r: OrientedRect, x: number, z: number, margin: number): boolean {
  const dx = x - r.cx;
  const dz = z - r.cz;
  const lx = dx * r.cos - dz * r.sin;
  const lz = dx * r.sin + dz * r.cos;
  return Math.abs(lx) <= r.hx + margin && Math.abs(lz) <= r.hz + margin;
}

function pointInRect(r: FitRect, x: number, z: number, margin: number): boolean {
  return x >= r.x0 - margin && x <= r.x1 + margin && z >= r.z0 - margin && z <= r.z1 + margin;
}

function pointInSector(s: DoorSector, x: number, z: number, margin: number): boolean {
  const rx = x - s.hx;
  const rz = z - s.hz;
  if (rx * s.ax + rz * s.az < 0) return false;
  if (rx * s.nx + rz * s.nz < 0) return false;
  return Math.hypot(rx, rz) < s.radius + margin;
}

function insideRoom(room: RoomLayout, x: number, z: number): boolean {
  let crossings = 0;
  for (const wall of room.walls) {
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

export interface RunPlacement {
  /** Run centre pushed inward by half the usable depth, plan cm. */
  x: number;
  z: number;
  rotationY: number;
}

/**
 * Floor placement describing a free run: centre, length, depth and the
 * back-to-wall yaw. Used by the client to highlight the hovered run.
 */
export function describeRun(
  room: RoomLayout,
  run: FreeRun,
): (RunPlacement & { length_cm: number; depth_cm: number }) | null {
  const wall = room.walls.find((w) => w.id === run.wall);
  if (wall === undefined) return null;
  const centroid = centroidOf(room);
  const frame = frameOf(wall, centroid);
  const mid = (run.start_cm + run.end_cm) / 2;
  const inward = run.depth_cm / 2;
  return {
    x: Math.round((wall.start.x + frame.ux * mid + frame.nx * inward) * 10) / 10,
    z: Math.round((wall.start.z + frame.uz * mid + frame.nz * inward) * 10) / 10,
    rotationY: backToWallRotationY(-frame.nx, -frame.nz),
    length_cm: run.length_cm,
    depth_cm: run.depth_cm,
  };
}

interface Obstacles {
  pieces: OrientedRect[];
  fixtures: FitRect[];
  sectors: DoorSector[];
  walkways: FitRect[];
}

function collectObstacles(
  room: RoomLayout,
  scene: SceneState,
  catalog: ReadonlyMap<string, CatalogItem>,
): Obstacles {
  const centroid = centroidOf(room);
  const pieces: OrientedRect[] = [];
  for (const item of scene.items) {
    const entry = catalog.get(item.productId);
    const size = entry?.size ?? { w: 60, d: 60, h: 60 };
    pieces.push(orientedFootprint(size, item.position, item.rotationY));
  }
  const fixtures: FitRect[] = [];
  for (const fx of room.fixtures) {
    const r = fixtureRect(fx, room, centroid);
    if (r !== null) fixtures.push(r);
  }
  const sectors = doorSectors(room, centroid);
  const walkways: FitRect[] = [];
  for (const s of sectors) {
    const cx = s.hx + s.nx * (WALKWAY_LENGTH_CM / 2);
    const cz = s.hz + s.nz * (WALKWAY_LENGTH_CM / 2);
    const alongX = Math.abs(s.nx) * (WALKWAY_LENGTH_CM / 2);
    const alongZ = Math.abs(s.nz) * (WALKWAY_LENGTH_CM / 2);
    const acrossX = Math.abs(s.nz) * (WALKWAY_WIDTH_CM / 2);
    const acrossZ = Math.abs(s.nx) * (WALKWAY_WIDTH_CM / 2);
    walkways.push({
      x0: cx - alongX - acrossX,
      z0: cz - alongZ - acrossZ,
      x1: cx + alongX + acrossX,
      z1: cz + alongZ + acrossZ,
    });
  }
  return { pieces, fixtures, sectors, walkways };
}

function blockedAt(o: Obstacles, x: number, z: number, margin: number): boolean {
  for (const r of o.pieces) {
    if (pointInOriented(r, x, z, margin)) return true;
  }
  for (const r of o.fixtures) {
    if (pointInRect(r, x, z, margin)) return true;
  }
  for (const s of o.sectors) {
    if (pointInSector(s, x, z, margin)) return true;
  }
  for (const r of o.walkways) {
    if (pointInRect(r, x, z, 0)) return true;
  }
  return false;
}

/**
 * Usable depth (cm) at wall offset s: march inward in 1 cm steps to the
 * first blockage, measured with zero margin (the candidate filter adds the
 * stand-off plus 1 cm of safety). The wall point itself (d = 0) is on the
 * boundary, so the inside-room test only applies from d = 1.
 */
function depthAt(
  room: RoomLayout,
  o: Obstacles,
  wall: { start: { x: number; z: number } },
  frame: Frame,
  s: number,
): number {
  const px = wall.start.x + frame.ux * s;
  const pz = wall.start.z + frame.uz * s;
  for (let d = 0; d <= MAX_DEPTH_CM; d += DEPTH_STEP_CM) {
    const qx = px + frame.nx * d;
    const qz = pz + frame.nz * d;
    if (d >= 1 && !insideRoom(room, qx, qz)) return d;
    if (blockedAt(o, qx, qz, 0)) return d;
  }
  return MAX_DEPTH_CM;
}

/**
 * Free runs + open areas for a room scene. Deterministic: walls in room
 * order, areas by descending size.
 */
export function analyzeFreeSpace(
  room: RoomLayout,
  scene: SceneState,
  catalog: ReadonlyMap<string, CatalogItem>,
): FreeSpace {
  const centroid = centroidOf(room);
  const obstacles = collectObstacles(room, scene, catalog);
  const runs: FreeRun[] = [];

  for (const wall of room.walls) {
    const frame = frameOf(wall, centroid);
    let runStart: number | null = null;
    let runDepth = Number.POSITIVE_INFINITY;
    const flush = (end: number): void => {
      if (runStart === null) return;
      const start = runStart + RUN_INSET_CM;
      const stop = end - RUN_INSET_CM;
      const length = round1(stop - start);
      if (length >= MIN_RUN_LENGTH_CM) {
        runs.push({
          wall: wall.id,
          start_cm: round1(start),
          end_cm: round1(stop),
          length_cm: length,
          depth_cm: round1(runDepth),
        });
      }
      runStart = null;
      runDepth = Number.POSITIVE_INFINITY;
    };
    for (let s = 0; s <= frame.len + 1e-9; s += SAMPLE_CM) {
      const clamped = Math.min(s, frame.len);
      const depth = depthAt(room, obstacles, wall, frame, clamped);
      if (depth >= MIN_RUN_DEPTH_CM) {
        if (runStart === null) runStart = clamped;
        if (depth < runDepth) runDepth = depth;
      } else {
        flush(clamped);
      }
    }
    flush(frame.len);
  }

  const openAreas = findOpenAreas(room, obstacles);
  return { runs, openAreas };
}

function findOpenAreas(room: RoomLayout, o: Obstacles): OpenArea[] {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const wall of room.walls) {
    for (const p of [wall.start, wall.end]) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  const x0 = minX + WALL_STRIP_CM;
  const x1 = maxX - WALL_STRIP_CM;
  const z0 = minZ + WALL_STRIP_CM;
  const z1 = maxZ - WALL_STRIP_CM;
  if (x1 <= x0 || z1 <= z0) return [];

  const nx = Math.max(1, Math.floor((x1 - x0) / GRID_CM));
  const nz = Math.max(1, Math.floor((z1 - z0) / GRID_CM));
  const blocked = new Uint8Array(nx * nz);
  for (let iz = 0; iz < nz; iz += 1) {
    for (let ix = 0; ix < nx; ix += 1) {
      const cx = x0 + ix * GRID_CM + GRID_CM / 2;
      const cz = z0 + iz * GRID_CM + GRID_CM / 2;
      let hit = !insideRoom(room, cx, cz);
      if (!hit) {
        for (const r of o.pieces) {
          if (pointInOriented(r, cx, cz, AREA_GROWTH_CM)) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) {
        for (const r of o.fixtures) {
          if (pointInRect(r, cx, cz, AREA_GROWTH_CM)) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) {
        for (const s of o.sectors) {
          if (pointInSector(s, cx, cz, AREA_GROWTH_CM)) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) {
        for (const r of o.walkways) {
          if (pointInRect(r, cx, cz, 0)) {
            hit = true;
            break;
          }
        }
      }
      blocked[iz * nx + ix] = hit ? 1 : 0;
    }
  }

  const seen = new Uint8Array(nx * nz);
  const areas: OpenArea[] = [];
  let counter = 0;
  for (let iz = 0; iz < nz; iz += 1) {
    for (let ix = 0; ix < nx; ix += 1) {
      const start = iz * nx + ix;
      if ((blocked[start] ?? 1) === 1 || (seen[start] ?? 1) === 1) continue;
      let bx0 = ix;
      let bx1 = ix;
      let bz0 = iz;
      let bz1 = iz;
      const queue = [start];
      seen[start] = 1;
      while (queue.length > 0) {
        const cur = queue.pop() as number;
        const cx = cur % nx;
        const cz = (cur - cx) / nx;
        if (cx < bx0) bx0 = cx;
        if (cx > bx1) bx1 = cx;
        if (cz < bz0) bz0 = cz;
        if (cz > bz1) bz1 = cz;
        const neighbours = [
          cx > 0 ? cur - 1 : -1,
          cx < nx - 1 ? cur + 1 : -1,
          cz > 0 ? cur - nx : -1,
          cz < nz - 1 ? cur + nx : -1,
        ];
        for (const nxt of neighbours) {
          if (nxt < 0) continue;
          if ((blocked[nxt] ?? 1) === 1 || (seen[nxt] ?? 1) === 1) continue;
          seen[nxt] = 1;
          queue.push(nxt);
        }
      }
      const ax0 = round1(x0 + bx0 * GRID_CM);
      const az0 = round1(z0 + bz0 * GRID_CM);
      const ax1 = round1(x0 + (bx1 + 1) * GRID_CM);
      const az1 = round1(z0 + (bz1 + 1) * GRID_CM);
      const w = round1(ax1 - ax0);
      const d = round1(az1 - az0);
      if (w >= MIN_AREA_SIDE_CM && d >= MIN_AREA_SIDE_CM) {
        counter += 1;
        areas.push({
          id: `area-${String(counter)}`,
          x0: ax0,
          z0: az0,
          x1: ax1,
          z1: az1,
          w_cm: w,
          d_cm: d,
        });
      }
    }
  }
  areas.sort((a, b) => b.w_cm * b.d_cm - a.w_cm * a.d_cm);
  return areas.map((area, index) => ({ ...area, id: `area-${String(index + 1)}` }));
}
