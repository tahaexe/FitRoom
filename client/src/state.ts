import type { CatalogItem, PlanPoint, RoomLayout, SceneItem, SceneState } from "@fitroom/shared";
import { cmToMeters, wallLengthCm } from "@fitroom/shared";

export const AUTOSAVE_KEY = "fitroom.autosave.v1";
export const SNAP_CM = 5;
export const ROTATE_SNAP_DEG = 15;

export interface FitRecord {
  type: string;
  severity: "error" | "warning";
  itemIds: string[];
  message: string;
  location: PlanPoint;
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

function cornersOverlap(a: PlanPoint[], b: PlanPoint[]): boolean {
  // Separating-axis test on the two rectangles' edge normals.
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
    if (maxA <= minB || maxB <= minA) return false;
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

export function computeFitIssues(
  state: SceneState,
  catalog: Map<string, CatalogItem>,
  room: RoomLayout,
): FitRecord[] {
  const issues: FitRecord[] = [];
  const items = state.items;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined) continue;
    if (!isInsideRoom(item, catalog, room)) {
      issues.push({
        type: "outside",
        severity: "error",
        itemIds: [item.instanceId],
        message: "Piece extends outside the room",
        location: { ...item.position },
      });
    }
    for (let j = i + 1; j < items.length; j += 1) {
      const other = items[j];
      if (other === undefined) continue;
      const a = itemCorners(item, catalog);
      const b = itemCorners(other, catalog);
      if (cornersOverlap(a, b)) {
        issues.push({
          type: "overlap",
          severity: "error",
          itemIds: [item.instanceId, other.instanceId],
          message: "Pieces overlap",
          location: {
            x: (item.position.x + other.position.x) / 2,
            z: (item.position.z + other.position.z) / 2,
          },
        });
      }
    }
    for (const opening of room.openings) {
      if (opening.type !== "door" || opening.swing !== "in") continue;
      const wall = room.walls.find((w) => w.id === opening.wallId);
      if (wall === undefined) continue;
      const wallLen = wallLengthCm(wall.start, wall.end) || 1;
      const dirX = (wall.end.x - wall.start.x) / wallLen;
      const dirZ = (wall.end.z - wall.start.z) / wallLen;
      const hingeAt = opening.hinge === "left" ? opening.offset : opening.offset + opening.width;
      const hx = wall.start.x + dirX * hingeAt;
      const hz = wall.start.z + dirZ * hingeAt;
      const swingR = opening.width;
      const dist = Math.hypot(item.position.x - hx, item.position.z - hz);
      if (dist < swingR + 20) {
        issues.push({
          type: "door-swing",
          severity: "warning",
          itemIds: [item.instanceId],
          message: `Inside the swing of ${opening.id}`,
          location: { ...item.position },
        });
        break;
      }
    }
  }
  return issues;
}

/**
 * Nearest free placement: spiral search from the room centre for the first
 * spot where the footprint is inside the room and overlaps nothing.
 */
export function nearestFreeSpot(
  productId: string,
  catalog: Map<string, CatalogItem>,
  room: RoomLayout,
  state: SceneState,
): PlanPoint {
  const entry = catalog.get(productId);
  const w = entry?.size.w ?? 60;
  const d = entry?.size.d ?? 60;
  const bounds = roomBounds(room);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const probe: SceneItem = {
    instanceId: "probe",
    productId,
    position: { x: cx, z: cz },
    rotationY: 0,
    variant: "",
  };
  const fits = (x: number, z: number): boolean => {
    probe.position = { x, z };
    if (!isInsideRoom(probe, catalog, room)) return false;
    const pc = itemCorners(probe, catalog);
    for (const other of state.items) {
      if (cornersOverlap(pc, itemCorners(other, catalog))) return false;
    }
    return true;
  };
  if (fits(cx, cz)) return { x: cx, z: cz };
  const step = Math.max(w, d, 30);
  for (let ring = 1; ring <= 12; ring += 1) {
    const r = ring * step;
    const n = ring * 8;
    for (let k = 0; k < n; k += 1) {
      const a = (k / n) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (fits(x, z)) return { x, z };
    }
  }
  return { x: cx, z: cz };
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
