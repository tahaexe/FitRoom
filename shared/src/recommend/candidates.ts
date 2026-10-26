/**
 * Candidate filter + canonical request builder: products of the requested
 * category whose footprint fits at least one run or area by size, each with
 * its proposed spot (run or area, centre, rotationY with the back to the
 * wall). Deterministic: catalog order, longest fitting run first.
 */

import type { CatalogItem, RoomLayout, SceneState } from "../types.js";
import { wallLengthCm } from "../units.js";
import { analyzeFreeSpace, backToWallRotationY } from "./free-space.js";
import type {
  FreeRun,
  FreeSpace,
  OpenArea,
  RecommendCandidate,
  RecommendCategory,
  RecommendRequest,
} from "./types.js";

/**
 * The item back stands this far off the wall, plus 1 cm of safety against
 * the depth sampling: a run of depth D takes products with d ≤ D − 5.
 */
const STAND_OFF_CM = 4;
const DEPTH_SAFETY_CM = 1;

export interface SpotVerifier {
  (productId: string, position: { x: number; z: number }, rotationY: number): boolean;
}

export interface CandidateQuery {
  category: RecommendCategory;
  budget_usd?: number;
  spot?: { wall: string; start_cm: number; end_cm: number };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function wallById(room: RoomLayout, wallId: string): RoomLayout["walls"][number] | undefined {
  return room.walls.find((w) => w.id === wallId);
}

function rotationForWall(room: RoomLayout, wallId: string): number {
  const wall = wallById(room, wallId);
  if (wall === undefined) return 0;
  let cx = 0;
  let cz = 0;
  const n = Math.max(1, room.walls.length * 2);
  for (const w of room.walls) {
    cx += w.start.x + w.end.x;
    cz += w.start.z + w.end.z;
  }
  cx /= n;
  cz /= n;
  const len = wallLengthCm(wall.start, wall.end) || 1;
  const ux = (wall.end.x - wall.start.x) / len;
  const uz = (wall.end.z - wall.start.z) / len;
  const mx = (wall.start.x + wall.end.x) / 2;
  const mz = (wall.start.z + wall.end.z) / 2;
  const s = (cx - mx) * -uz + (cz - mz) * ux >= 0 ? 1 : -1;
  const nx = s * -uz;
  const nz = s * ux;
  return backToWallRotationY(-nx, -nz);
}

function centreOnRun(room: RoomLayout, run: FreeRun, depth: number): [number, number] | null {
  const wall = wallById(room, run.wall);
  if (wall === undefined) return null;
  let cx = 0;
  let cz = 0;
  const n = Math.max(1, room.walls.length * 2);
  for (const w of room.walls) {
    cx += w.start.x + w.end.x;
    cz += w.start.z + w.end.z;
  }
  cx /= n;
  cz /= n;
  const len = wallLengthCm(wall.start, wall.end) || 1;
  const ux = (wall.end.x - wall.start.x) / len;
  const uz = (wall.end.z - wall.start.z) / len;
  const mx = (wall.start.x + wall.end.x) / 2;
  const mz = (wall.start.z + wall.end.z) / 2;
  const s = (cx - mx) * -uz + (cz - mz) * ux >= 0 ? 1 : -1;
  const nx = s * -uz;
  const nz = s * ux;
  const mid = (run.start_cm + run.end_cm) / 2;
  return [
    round1(wall.start.x + ux * mid + nx * (depth / 2 + STAND_OFF_CM)),
    round1(wall.start.z + uz * mid + nz * (depth / 2 + STAND_OFF_CM)),
  ];
}

function candidateOnRun(
  room: RoomLayout,
  item: CatalogItem,
  run: FreeRun,
): RecommendCandidate | null {
  const w = item.size.w;
  const d = item.size.d;
  if (w > run.length_cm + 1e-9) return null;
  if (d > run.depth_cm - STAND_OFF_CM - DEPTH_SAFETY_CM + 1e-9) return null;
  const centre = centreOnRun(room, run, d);
  if (centre === null) return null;
  return {
    productId: item.id,
    name: item.name,
    size_cm: [round1(w), round1(d), round1(item.size.h)],
    price_usd: item.price,
    styleTags: [...item.styleTags],
    colors: [...item.colors],
    spot: {
      kind: "run",
      wall: run.wall,
      run_cm: [run.start_cm, run.end_cm],
      runLength_cm: run.length_cm,
      spare_cm: round1(run.length_cm - w),
      centre_cm: centre,
      rotationY: rotationForWall(room, run.wall),
    },
  };
}

function candidateOnArea(area: OpenArea, item: CatalogItem): RecommendCandidate | null {
  const w = item.size.w;
  const d = item.size.d;
  const cx = round1((area.x0 + area.x1) / 2);
  const cz = round1((area.z0 + area.z1) / 2);
  const base = {
    productId: item.id,
    name: item.name,
    size_cm: [round1(w), round1(d), round1(item.size.h)] as [number, number, number],
    price_usd: item.price,
    styleTags: [...item.styleTags],
    colors: [...item.colors],
  };
  if (w <= area.w_cm + 1e-9 && d <= area.d_cm + 1e-9) {
    return {
      ...base,
      spot: {
        kind: "area",
        areaId: area.id,
        area_cm: [area.w_cm, area.d_cm],
        spare_cm: round1(Math.min(area.w_cm - w, area.d_cm - d)),
        centre_cm: [cx, cz],
        rotationY: 0,
      },
    };
  }
  if (d <= area.w_cm + 1e-9 && w <= area.d_cm + 1e-9) {
    return {
      ...base,
      spot: {
        kind: "area",
        areaId: area.id,
        area_cm: [area.w_cm, area.d_cm],
        spare_cm: round1(Math.min(area.w_cm - d, area.d_cm - w)),
        centre_cm: [cx, cz],
        rotationY: 90,
      },
    };
  }
  return null;
}

/**
 * Candidate products with proposed spots. A `spot` query uses every
 * category on that single run; otherwise only `category` products are
 * considered, longest fitting run first, then the open areas.
 */
export function buildCandidates(
  room: RoomLayout,
  scene: SceneState,
  catalog: CatalogItem[],
  freeSpace: FreeSpace,
  query: CandidateQuery,
  verify?: SpotVerifier,
): RecommendCandidate[] {
  const pool =
    query.spot !== undefined || query.category === "any"
      ? catalog
      : catalog.filter((item) => item.category === query.category);
  const inBudget = (item: CatalogItem): boolean =>
    query.budget_usd === undefined || item.price <= query.budget_usd;
  const kept = (candidate: RecommendCandidate): boolean => {
    if (verify === undefined) return true;
    const [x, z] = candidate.spot.centre_cm;
    return verify(candidate.productId, { x, z }, candidate.spot.rotationY);
  };

  if (query.spot !== undefined) {
    const run = freeSpace.runs.find(
      (r) =>
        r.wall === query.spot?.wall &&
        Math.abs(r.start_cm - (query.spot?.start_cm ?? 0)) < 1e-9 &&
        Math.abs(r.end_cm - (query.spot?.end_cm ?? 0)) < 1e-9,
    );
    const target =
      run ??
      freeSpace.runs
        .filter((r) => r.wall === query.spot?.wall)
        .sort((a, b) => b.length_cm - a.length_cm)[0];
    if (target === undefined) return [];
    const out: RecommendCandidate[] = [];
    for (const item of pool) {
      if (!inBudget(item)) continue;
      const candidate = candidateOnRun(room, item, target);
      if (candidate !== null && kept(candidate)) out.push(candidate);
    }
    return out;
  }

  const runs = [...freeSpace.runs].sort((a, b) => b.length_cm - a.length_cm);
  const out: RecommendCandidate[] = [];
  for (const item of pool) {
    if (!inBudget(item)) continue;
    let placed: RecommendCandidate | null = null;
    for (const run of runs) {
      const candidate = candidateOnRun(room, item, run);
      if (candidate !== null && kept(candidate)) {
        placed = candidate;
        break;
      }
    }
    if (placed === null) {
      for (const area of freeSpace.openAreas) {
        const candidate = candidateOnArea(area, item);
        if (candidate !== null && kept(candidate)) {
          placed = candidate;
          break;
        }
      }
    }
    if (placed !== null) out.push(placed);
  }
  return out;
}

function roomSizeCm(room: RoomLayout): [number, number] {
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
  return [round1(maxX - minX), round1(maxZ - minZ)];
}

/**
 * Canonical request object: room, style, placed items, query, free space and
 * candidates. This same object is the gateway key input.
 */
export function buildRecommendRequest(
  room: RoomLayout,
  scene: SceneState,
  catalog: CatalogItem[],
  query: CandidateQuery,
  verify?: SpotVerifier,
): RecommendRequest {
  const catalogById = new Map(catalog.map((c) => [c.id, c]));
  const freeSpace = analyzeFreeSpace(room, scene, catalogById);
  const candidates = buildCandidates(room, scene, catalog, freeSpace, query, verify);
  const placed = [...scene.items]
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId))
    .map((item) => {
      const entry = catalogById.get(item.productId);
      return {
        productId: item.productId,
        name: entry?.name ?? item.productId,
        colors: entry !== undefined ? [...entry.colors] : [],
      };
    });
  const request: RecommendRequest = {
    room: {
      name: room.name,
      size_cm: roomSizeCm(room),
      style: { tags: [...room.style.tags], colors: [...room.style.dominantColors] },
    },
    placed,
    request: {
      category: query.category,
      ...(query.budget_usd !== undefined ? { budget_usd: query.budget_usd } : {}),
      ...(query.spot !== undefined ? { spot: { ...query.spot } } : {}),
    },
    freeSpace,
    candidates,
  };
  return request;
}
