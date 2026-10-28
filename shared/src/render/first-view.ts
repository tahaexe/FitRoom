import type { RoomLayout } from "../types.js";

/**
 * Horizontal camera-side direction for the dollhouse first view: opposite
 * the average outward of the walls holding windows, so the window walls
 * are the drawn (far) pair instead of the cut-away pair. Rooms without
 * windows keep the south-east corner. Pure plan maths, headless-testable.
 */
export function facingDirForRoom(room: RoomLayout): { x: number; z: number } {
  let cx = 0;
  let cz = 0;
  for (const wall of room.walls) {
    cx += (wall.start.x + wall.end.x) / 2;
    cz += (wall.start.z + wall.end.z) / 2;
  }
  cx /= Math.max(1, room.walls.length);
  cz /= Math.max(1, room.walls.length);
  const windowWalls = new Set(
    room.openings.filter((o) => o.type === "window").map((o) => o.wallId),
  );
  let ax = 0;
  let az = 0;
  let count = 0;
  for (const wall of room.walls) {
    if (!windowWalls.has(wall.id)) continue;
    const mx = (wall.start.x + wall.end.x) / 2;
    const mz = (wall.start.z + wall.end.z) / 2;
    const len = Math.hypot(mx - cx, mz - cz) || 1;
    ax += (mx - cx) / len;
    az += (mz - cz) / len;
    count += 1;
  }
  if (count === 0 || Math.hypot(ax, az) < 1e-6) {
    const dl = Math.hypot(0.85, 1) || 1;
    return { x: 0.85 / dl, z: 1 / dl };
  }
  const hl = Math.hypot(ax, az) || 1;
  return { x: -ax / hl, z: -az / hl };
}

/**
 * First-view camera-side vectors for a room: the window-aware side from
 * {@link facingDirForRoom} plus the screen-right axis `(z, -x)` for that
 * side (the camera looks back at the room centre, so screen-right is the
 * facing direction rotated -90 degrees about Y). Pure plan maths.
 */
export function firstViewVectors(room: RoomLayout): {
  toCam: { x: number; z: number };
  right: { x: number; z: number };
} {
  const toCam = facingDirForRoom(room);
  return { toCam, right: { x: toCam.z, z: -toCam.x } };
}
