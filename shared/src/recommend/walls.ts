/**
 * People-friendly wall names, as seen standing in the doorway looking in:
 * "Door wall", "Back wall", "Left wall", "Right wall", with " (window)"
 * added when a window sits on that wall (e.g. "Back wall (window)"). The
 * `wall-N` ids stay internal: every shopper-facing surface (the
 * "What fits here?" list, the plan view's wall labels, the request sent to
 * Muse Spark and its reasons) uses these names.
 */

import type { RoomLayout } from "../types.js";
import { wallLengthCm } from "../units.js";

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

function midpoint(wall: RoomLayout["walls"][number]): { x: number; z: number } {
  return {
    x: (wall.start.x + wall.end.x) / 2,
    z: (wall.start.z + wall.end.z) / 2,
  };
}

/** Outward unit normal of a wall (centre-based, robust for any winding). */
function outwardOf(
  wall: RoomLayout["walls"][number],
  centroid: { x: number; z: number },
): { x: number; z: number } {
  const mid = midpoint(wall);
  const ox = mid.x - centroid.x;
  const oz = mid.z - centroid.z;
  const len = Math.hypot(ox, oz) || 1;
  return { x: ox / len, z: oz / len };
}

/**
 * Display name per wall id, e.g. "Back wall (window)". The door wall is the
 * first wall with a door (else the first wall); looking means facing from
 * the door wall's midpoint towards the room centroid. Walls whose outward
 * normal points along the look direction are the back wall, against it the
 * door wall; the rest split into left/right by the look-left direction.
 */
export function wallDisplayNames(room: RoomLayout): Map<string, string> {
  const centroid = centroidOf(room);
  const doorOpening = room.openings.find((o) => o.type === "door");
  const doorWall = room.walls.find((w) => w.id === doorOpening?.wallId) ?? room.walls[0];
  let fx = 0;
  let fz = 1;
  if (doorWall !== undefined) {
    const mid = midpoint(doorWall);
    const dx = centroid.x - mid.x;
    const dz = centroid.z - mid.z;
    const len = Math.hypot(dx, dz) || 1;
    fx = dx / len;
    fz = dz / len;
  }
  // Facing (fx, fz), left is (-fz, fx): facing north (0, 1) gives west (-1, 0).
  const lx = -fz;
  const lz = fx;
  const windowWalls = new Set<string>();
  for (const o of room.openings) {
    if (o.type === "window") windowWalls.add(o.wallId);
  }
  const out = new Map<string, string>();
  for (const wall of room.walls) {
    const o = outwardOf(wall, centroid);
    const along = o.x * fx + o.z * fz;
    const side = o.x * lx + o.z * lz;
    let base: string;
    if (along <= -0.5) base = "Door wall";
    else if (along >= 0.5) base = "Back wall";
    else if (side >= 0) base = "Left wall";
    else base = "Right wall";
    if (windowWalls.has(wall.id)) base += " (window)";
    out.set(wall.id, base);
  }
  return out;
}

/** Display name of one wall ("Door wall", "Back wall (window)", ...). */
export function wallDisplayName(room: RoomLayout, wallId: string): string {
  return wallDisplayNames(room).get(wallId) ?? wallId;
}

/** Shopper-facing run label, e.g. "Back wall (window) · 175 cm". */
export function runDisplayLabel(room: RoomLayout, wallId: string, lengthCm: number): string {
  return `${wallDisplayName(room, wallId)} · ${String(Math.round(lengthCm))} cm`;
}

/** Shopper-facing plan-view wall label, e.g. "Back wall (window) · 420 cm". */
export function planWallLabel(room: RoomLayout, wallId: string): string {
  const wall = room.walls.find((w) => w.id === wallId);
  const len = wall === undefined ? 0 : wallLengthCm(wall.start, wall.end);
  return `${wallDisplayName(room, wallId)} · ${String(Math.round(len))} cm`;
}
