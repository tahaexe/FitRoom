/**
 * Candidate filter + canonical request builder: products of the requested
 * category whose footprint fits, each with its proposed spot. Spots by
 * category:
 *
 * - coffee tables and ottomans go in front of the main seat (the sofa, else
 *   the largest seat), centred on its front and turned with it, with the
 *   smallest gap the fit engine accepts (45 cm, then 40 cm);
 * - side tables go beside a seat's arm (left, then right, 10 cm then 5 cm
 *   away);
 * - sofas, armchairs, shelves, TV units and decor stay on free wall runs
 *   with their back to the wall, longest fitting run first, then the open
 *   areas, as before.
 *
 * Seat accessories are verified against the scene ignoring placed items of
 * the requested category (see `./ignore.js`): the shopper is rethinking
 * that slot. A replacement query (`replace`) tries same-category products
 * (minus the selected one) where the selected item stands — same centre and
 * orientation, or slid along its wall run — with the selected instance left
 * out of the check.
 *
 * Every candidate still passes the caller-supplied fit-engine check before
 * it is listed. The canonical request sent to Muse Spark names walls the
 * way people do ("Back wall (window)"); `wall-N` ids stay internal.
 * Deterministic: catalog order, longest fitting run first.
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
import { wallDisplayName } from "./walls.js";

/**
 * The item back stands this far off the wall, plus 1 cm of safety against
 * the depth sampling: a run of depth D takes products with d ≤ D − 5.
 */
const STAND_OFF_CM = 4;
const DEPTH_SAFETY_CM = 1;

/** Front gaps tried for coffee tables and ottomans, smallest accept wins. */
const FRONT_GAPS_CM = [45, 40];
/** Arm sides (local −X is left, +X is right) and gaps tried for side tables. */
const SIDE_TRIES: Array<{ side: number; gap: number }> = [
  { side: -1, gap: 10 },
  { side: 1, gap: 10 },
  { side: -1, gap: 5 },
  { side: 1, gap: 5 },
];

export interface SpotVerifier {
  (productId: string, position: { x: number; z: number }, rotationY: number): boolean;
}

export interface CandidateQuery {
  category: RecommendCategory;
  budget_usd?: number;
  spot?: { wall: string; start_cm: number; end_cm: number };
  replace?: {
    productId: string;
    position: { x: number; z: number };
    rotationY: number;
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function normDeg(deg: number): number {
  return round1(((deg % 360) + 360) % 360);
}

/** Snap cos/sin to exact 0/±1 near multiples of 90° (as the fit engine does). */
function snappedTrig(rad: number): { cos: number; sin: number } {
  let cos = Math.cos(rad);
  let sin = Math.sin(rad);
  if (Math.abs(cos) < 1e-9) cos = 0;
  if (Math.abs(sin) < 1e-9) sin = 0;
  if (Math.abs(Math.abs(cos) - 1) < 1e-9) cos = Math.sign(cos);
  if (Math.abs(Math.abs(sin) - 1) < 1e-9) sin = Math.sign(sin);
  return { cos, sin };
}

function wallById(room: RoomLayout, wallId: string): RoomLayout["walls"][number] | undefined {
  return room.walls.find((w) => w.id === wallId);
}

function centroidOf(room: RoomLayout): { x: number; z: number } {
  let x = 0;
  let z = 0;
  const n = Math.max(1, room.walls.length * 2);
  for (const w of room.walls) {
    x += w.start.x + w.end.x;
    z += w.start.z + w.end.z;
  }
  return { x: x / n, z: z / n };
}

/** Outward unit normal of a wall (centre-based, robust for any winding). */
function outwardOf(
  wall: RoomLayout["walls"][number],
  centroid: { x: number; z: number },
): { x: number; z: number } {
  const mx = (wall.start.x + wall.end.x) / 2;
  const mz = (wall.start.z + wall.end.z) / 2;
  const ox = mx - centroid.x;
  const oz = mz - centroid.z;
  const len = Math.hypot(ox, oz) || 1;
  return { x: ox / len, z: oz / len };
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

interface SeatAnchor {
  position: { x: number; z: number };
  rotationY: number;
  /** Front unit vector (world). */
  fx: number;
  fz: number;
  /** Local +X (right-hand) unit vector (world). */
  lx: number;
  lz: number;
  seatWidth: number;
  seatDepth: number;
  seatName: string;
}

/** The main seat: the (largest) sofa, else the largest seat. */
function mainSeat(scene: SceneState, catalog: ReadonlyMap<string, CatalogItem>): SeatAnchor | null {
  let sofa: { id: string; area: number } | null = null;
  let seat: { id: string; area: number } | null = null;
  for (const item of scene.items) {
    const entry = catalog.get(item.productId);
    if (entry === undefined) continue;
    const area = entry.size.w * entry.size.d;
    if (entry.category === "sofa" && (sofa === null || area > sofa.area)) {
      sofa = { id: item.instanceId, area };
    }
    if (
      (entry.category === "sofa" || entry.category === "armchair") &&
      (seat === null || area > seat.area)
    ) {
      seat = { id: item.instanceId, area };
    }
  }
  const chosen = sofa ?? seat;
  if (chosen === null) return null;
  const item = scene.items.find((i) => i.instanceId === chosen.id);
  const entry = item === undefined ? undefined : catalog.get(item.productId);
  if (item === undefined || entry === undefined) return null;
  const rad = (item.rotationY * Math.PI) / 180;
  const { cos, sin } = snappedTrig(rad);
  // Front is local +Z, right hand is local +X (see fit.ts orientation).
  return {
    position: { ...item.position },
    rotationY: normDeg(item.rotationY),
    fx: sin,
    fz: cos,
    lx: cos,
    lz: -sin,
    seatWidth: entry.size.w,
    seatDepth: entry.size.d,
    seatName: entry.name,
  };
}

/** Coffee table / ottoman spot: centred on the seat front, turned with it. */
function candidateOnSeatFront(
  seat: SeatAnchor,
  item: CatalogItem,
  gap: number,
): RecommendCandidate {
  const x = round1(seat.position.x + seat.fx * (seat.seatDepth / 2 + gap + item.size.d / 2));
  const z = round1(seat.position.z + seat.fz * (seat.seatDepth / 2 + gap + item.size.d / 2));
  return {
    productId: item.id,
    name: item.name,
    size_cm: [round1(item.size.w), round1(item.size.d), round1(item.size.h)],
    price_usd: item.price,
    styleTags: [...item.styleTags],
    colors: [...item.colors],
    spot: {
      kind: "area",
      areaId: "seat-front",
      area_cm: [round1(seat.seatWidth), round1(gap + item.size.d)],
      spare_cm: round1(gap),
      centre_cm: [x, z],
      rotationY: seat.rotationY,
      gap_cm: gap,
      seat: seat.seatName,
    },
  };
}

/** Side-table spot beside the seat's arm (side −1 = left, +1 = right). */
function candidateOnSeatSide(
  seat: SeatAnchor,
  item: CatalogItem,
  side: number,
  gap: number,
): RecommendCandidate {
  const off = seat.seatWidth / 2 + gap + item.size.w / 2;
  const x = round1(seat.position.x + seat.lx * side * off);
  const z = round1(seat.position.z + seat.lz * side * off);
  return {
    productId: item.id,
    name: item.name,
    size_cm: [round1(item.size.w), round1(item.size.d), round1(item.size.h)],
    price_usd: item.price,
    styleTags: [...item.styleTags],
    colors: [...item.colors],
    spot: {
      kind: "area",
      areaId: "seat-side",
      area_cm: [round1(item.size.w + gap), round1(item.size.d)],
      spare_cm: round1(gap),
      centre_cm: [x, z],
      rotationY: seat.rotationY,
      gap_cm: gap,
      seat: seat.seatName,
    },
  };
}

interface SlideTry {
  x: number;
  z: number;
  rotationY: number;
  along: number;
  halfAlong: number;
  wallId: string;
  slotStart_cm: number;
  slotEnd_cm: number;
  slotLength_cm: number;
}

/** Vacated slot of a replacement query: old wall, run and back edge. */
export interface VacatedSlot {
  wallId: string;
  start_cm: number;
  end_cm: number;
  length_cm: number;
  /** Old back edge inward distance from the wall start line, plan cm. */
  backEdge_cm: number;
  /** Old centre along-wall position, plan cm. */
  along_cm: number;
}

/**
 * The slot a replacement vacates: the wall behind the selected item (its
 * back direction) and the old piece's own along-wall footprint, anchored to
 * its back edge. Exported for the `check:recommend` bar.
 */
export function vacatedSlot(
  room: RoomLayout,
  oldItem: CatalogItem,
  selected: { position: { x: number; z: number }; rotationY: number },
): VacatedSlot | null {
  const rad = (selected.rotationY * Math.PI) / 180;
  const { cos, sin } = snappedTrig(rad);
  const back = { x: -sin, z: -cos };
  const centroid = centroidOf(room);
  let wall = room.walls[0];
  let best = Number.NEGATIVE_INFINITY;
  for (const w of room.walls) {
    const o = outwardOf(w, centroid);
    const score = o.x * back.x + o.z * back.z;
    if (wall === undefined || score > best) {
      wall = w;
      best = score;
    }
  }
  if (wall === undefined) return null;
  const len = wallLengthCm(wall.start, wall.end) || 1;
  const ux = (wall.end.x - wall.start.x) / len;
  const uz = (wall.end.z - wall.start.z) / len;
  const outward = outwardOf(wall, centroid);
  const nx = -outward.x;
  const nz = -outward.z;
  const rel = {
    x: selected.position.x - wall.start.x,
    z: selected.position.z - wall.start.z,
  };
  const a0 = rel.x * ux + rel.z * uz;
  const off0 = rel.x * nx + rel.z * nz;
  const oldHx = (oldItem.size.w / 2) * Math.abs(cos) + (oldItem.size.d / 2) * Math.abs(sin);
  const oldHz = (oldItem.size.w / 2) * Math.abs(sin) + (oldItem.size.d / 2) * Math.abs(cos);
  const oldHalfAlong = oldHx * Math.abs(ux) + oldHz * Math.abs(uz);
  const oldAcross = oldHx * Math.abs(nx) + oldHz * Math.abs(nz);
  return {
    wallId: wall.id,
    start_cm: round1(a0 - oldHalfAlong),
    end_cm: round1(a0 + oldHalfAlong),
    length_cm: round1(oldHalfAlong * 2),
    backEdge_cm: round1(off0 - oldAcross),
    along_cm: round1(a0),
  };
}

/**
 * Where the selected item stands, plus slides along its wall: the wall
 * behind the item (its back direction), anchored to the old piece's back
 * edge with the same orientation, offsets 0, +5, −5, … while the footprint
 * stays on the wall. The vacated slot is the old piece's own along-wall
 * footprint; every candidate reports that slot (not its own footprint) so
 * spare reads slot length minus the candidate's width.
 */
function replacementTries(
  room: RoomLayout,
  oldItem: CatalogItem,
  item: CatalogItem,
  selected: { position: { x: number; z: number }; rotationY: number },
): SlideTry[] {
  const rad = (selected.rotationY * Math.PI) / 180;
  const { cos, sin } = snappedTrig(rad);
  const back = { x: -sin, z: -cos };
  const centroid = centroidOf(room);
  let wall = room.walls[0];
  let best = Number.NEGATIVE_INFINITY;
  for (const w of room.walls) {
    const o = outwardOf(w, centroid);
    const score = o.x * back.x + o.z * back.z;
    if (wall === undefined || score > best) {
      wall = w;
      best = score;
    }
  }
  if (wall === undefined) return [];
  const len = wallLengthCm(wall.start, wall.end) || 1;
  const ux = (wall.end.x - wall.start.x) / len;
  const uz = (wall.end.z - wall.start.z) / len;
  const outward = outwardOf(wall, centroid);
  const nx = -outward.x;
  const nz = -outward.z;
  const rel = {
    x: selected.position.x - wall.start.x,
    z: selected.position.z - wall.start.z,
  };
  const a0 = rel.x * ux + rel.z * uz;
  const off0 = rel.x * nx + rel.z * nz;
  const oldHx = (oldItem.size.w / 2) * Math.abs(cos) + (oldItem.size.d / 2) * Math.abs(sin);
  const oldHz = (oldItem.size.w / 2) * Math.abs(sin) + (oldItem.size.d / 2) * Math.abs(cos);
  const oldHalfAlong = oldHx * Math.abs(ux) + oldHz * Math.abs(uz);
  const oldAcross = oldHx * Math.abs(nx) + oldHz * Math.abs(nz);
  const backEdge = off0 - oldAcross;
  const hx = (item.size.w / 2) * Math.abs(cos) + (item.size.d / 2) * Math.abs(sin);
  const hz = (item.size.w / 2) * Math.abs(sin) + (item.size.d / 2) * Math.abs(cos);
  const halfAlong = hx * Math.abs(ux) + hz * Math.abs(uz);
  const across = hx * Math.abs(nx) + hz * Math.abs(nz);
  const inward = backEdge + across;
  const rotationY = normDeg(selected.rotationY);
  const slotStart = round1(a0 - oldHalfAlong);
  const slotEnd = round1(a0 + oldHalfAlong);
  const slotLength = round1(oldHalfAlong * 2);
  const out: SlideTry[] = [];
  const offsets: number[] = [0];
  for (let step = 5; step <= len; step += 5) {
    offsets.push(step, -step);
  }
  for (const o of offsets) {
    const a = a0 + o;
    if (a < halfAlong + 2 - 1e-9 || a > len - halfAlong - 2 + 1e-9) continue;
    out.push({
      x: round1(wall.start.x + ux * a + nx * inward),
      z: round1(wall.start.z + uz * a + nz * inward),
      rotationY,
      along: round1(a),
      halfAlong: round1(halfAlong),
      wallId: wall.id,
      slotStart_cm: slotStart,
      slotEnd_cm: slotEnd,
      slotLength_cm: slotLength,
    });
  }
  return out;
}

function candidateOnReplacementSlide(
  room: RoomLayout,
  item: CatalogItem,
  slide: SlideTry,
): RecommendCandidate {
  void room;
  // Back-to-wall orientation puts the catalog width along the wall.
  const spare = round1(slide.slotLength_cm - item.size.w);
  return {
    productId: item.id,
    name: item.name,
    size_cm: [round1(item.size.w), round1(item.size.d), round1(item.size.h)],
    price_usd: item.price,
    styleTags: [...item.styleTags],
    colors: [...item.colors],
    spot: {
      kind: "run",
      wall: slide.wallId,
      run_cm: [slide.slotStart_cm, slide.slotEnd_cm],
      runLength_cm: slide.slotLength_cm,
      spare_cm: spare,
      centre_cm: [slide.x, slide.z],
      rotationY: slide.rotationY,
    },
  };
}

/**
 * Candidate products with proposed spots. A `spot` query uses every
 * category on that single run; a `replace` query uses same-category
 * products (minus the selected one) at the selected spot; otherwise only
 * `category` products are considered — seat accessories at their seat
 * spots, everything else longest fitting run first, then the open areas.
 */
export function buildCandidates(
  room: RoomLayout,
  scene: SceneState,
  catalog: CatalogItem[],
  freeSpace: FreeSpace,
  query: CandidateQuery,
  verify?: SpotVerifier,
): RecommendCandidate[] {
  const catalogById = new Map(catalog.map((c) => [c.id, c]));
  const pool =
    query.spot !== undefined || query.category === "any"
      ? catalog
      : catalog.filter(
          (item) =>
            item.category === query.category &&
            (query.replace === undefined || item.id !== query.replace.productId),
        );
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

  if (query.replace !== undefined) {
    const selected = query.replace;
    const oldEntry = catalogById.get(selected.productId);
    if (oldEntry === undefined) return [];
    const out: RecommendCandidate[] = [];
    for (const item of pool) {
      if (!inBudget(item)) continue;
      for (const slide of replacementTries(room, oldEntry, item, selected)) {
        const candidate = candidateOnReplacementSlide(room, item, slide);
        if (kept(candidate)) {
          out.push(candidate);
          break;
        }
      }
    }
    return out;
  }

  const seat =
    query.category === "coffee-table" ||
    query.category === "ottoman" ||
    query.category === "side-table"
      ? mainSeat(scene, catalogById)
      : null;
  const runs = [...freeSpace.runs].sort((a, b) => b.length_cm - a.length_cm);
  const out: RecommendCandidate[] = [];
  for (const item of pool) {
    if (!inBudget(item)) continue;
    let placed: RecommendCandidate | null = null;
    if (seat !== null && (query.category === "coffee-table" || query.category === "ottoman")) {
      for (const gap of FRONT_GAPS_CM) {
        const candidate = candidateOnSeatFront(seat, item, gap);
        if (kept(candidate)) {
          placed = candidate;
          break;
        }
      }
    }
    if (seat !== null && placed === null && query.category === "side-table") {
      for (const sideTry of SIDE_TRIES) {
        const candidate = candidateOnSeatSide(seat, item, sideTry.side, sideTry.gap);
        if (kept(candidate)) {
          placed = candidate;
          break;
        }
      }
    }
    if (placed === null && seat === null) {
      for (const run of runs) {
        const candidate = candidateOnRun(room, item, run);
        if (candidate !== null && kept(candidate)) {
          placed = candidate;
          break;
        }
      }
    }
    if (placed === null && seat === null) {
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
 * candidates. Wall runs and run spots name walls the way people do; this
 * same object is the gateway key input.
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
      ...(query.spot !== undefined
        ? {
            spot: {
              wall: wallDisplayName(room, query.spot.wall),
              start_cm: query.spot.start_cm,
              end_cm: query.spot.end_cm,
            },
          }
        : {}),
      ...(query.replace !== undefined
        ? {
            replace: {
              productId: query.replace.productId,
              centre_cm: [round1(query.replace.position.x), round1(query.replace.position.z)] as [
                number,
                number,
              ],
              rotationY: normDeg(query.replace.rotationY),
            },
          }
        : {}),
    },
    freeSpace: {
      runs: freeSpace.runs.map((run) => ({ ...run, wall: wallDisplayName(room, run.wall) })),
      openAreas: freeSpace.openAreas.map((area) => ({ ...area })),
    },
    candidates: candidates.map((candidate) =>
      candidate.spot.kind === "run"
        ? {
            ...candidate,
            spot: { ...candidate.spot, wall: wallDisplayName(room, candidate.spot.wall) },
          }
        : candidate,
    ),
  };
  return request;
}
