/**
 * Pure rectangle room model for the 2D plan editor.
 *
 * A rectangle room is four axis-aligned walls forming a closed
 * counter-clockwise polygon seen from above, with the origin at the inner
 * south-west corner:
 *
 * - wall-1 (south): (0, 0) -> (width, 0)
 * - wall-2 (east): (width, 0) -> (width, depth)
 * - wall-3 (north): (width, depth) -> (0, depth)
 * - wall-4 (west): (0, depth) -> (0, 0)
 *
 * Every function is pure: inputs are never mutated, outputs are fresh
 * objects. `setRectangleWallLength` keeps the rectangle closed by rebuilding
 * all four walls from the new size, so the opposite wall moves along; every
 * opening and fixture stays on its wall, clamped inside it, never dropped.
 * Every room produced here passes `validateRoomLayout`.
 */

import type { Fixture, Opening, RoomLayout, Wall } from "./types.js";

export const DEFAULT_RECTANGLE_WALL_HEIGHT_CM = 250;
export const DEFAULT_RECTANGLE_THICKNESS_CM = 12;
export const MIN_RECTANGLE_SIDE_CM = 50;
export const MAX_RECTANGLE_SIDE_CM = 2000;

export const RECTANGLE_WALL_IDS = ["wall-1", "wall-2", "wall-3", "wall-4"] as const;
export type RectangleWallId = (typeof RECTANGLE_WALL_IDS)[number];

export interface RectangleSize {
  widthCm: number;
  depthCm: number;
  heightCm: number;
}

function clampSide(value: number): number {
  if (!Number.isFinite(value)) return MIN_RECTANGLE_SIDE_CM;
  return Math.min(MAX_RECTANGLE_SIDE_CM, Math.max(MIN_RECTANGLE_SIDE_CM, Math.round(value)));
}

function wallLengthOf(wall: Wall): number {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z);
}

function isAxisRectangle(room: RoomLayout): boolean {
  if (room.walls.length !== 4) return false;
  const ids = room.walls.map((w) => w.id);
  if (ids[0] !== "wall-1" || ids[1] !== "wall-2" || ids[2] !== "wall-3" || ids[3] !== "wall-4") {
    return false;
  }
  const [w1, w2, w3, w4] = room.walls as [Wall, Wall, Wall, Wall];
  if (w1 === undefined || w2 === undefined || w3 === undefined || w4 === undefined) {
    return false;
  }
  const width = w1.end.x - w1.start.x;
  const depth = w2.end.z - w2.start.z;
  if (!(width >= MIN_RECTANGLE_SIDE_CM && depth >= MIN_RECTANGLE_SIDE_CM)) return false;
  return (
    w1.start.x === 0 &&
    w1.start.z === 0 &&
    w1.end.x === width &&
    w1.end.z === 0 &&
    w2.start.x === width &&
    w2.start.z === 0 &&
    w2.end.x === width &&
    w2.end.z === depth &&
    w3.start.x === width &&
    w3.start.z === depth &&
    w3.end.x === 0 &&
    w3.end.z === depth &&
    w4.start.x === 0 &&
    w4.start.z === depth &&
    w4.end.x === 0 &&
    w4.end.z === 0
  );
}

/** True when the room is a rectangle room as described above. */
export function isRectangleRoom(room: RoomLayout): boolean {
  return isAxisRectangle(room);
}

/** Width, depth and wall height of a rectangle room (rounded cm). */
export function rectangleSize(room: RoomLayout): RectangleSize {
  const w1 = room.walls[0];
  const w2 = room.walls[1];
  const widthCm = w1 === undefined ? 0 : Math.round(wallLengthOf(w1));
  const depthCm = w2 === undefined ? 0 : Math.round(wallLengthOf(w2));
  const heightCm = w1 === undefined ? DEFAULT_RECTANGLE_WALL_HEIGHT_CM : Math.round(w1.height);
  return { widthCm, depthCm, heightCm };
}

/** Length of one rectangle wall (rounded cm). */
export function rectangleWallLength(room: RoomLayout, wallId: string): number {
  const wall = room.walls.find((w) => w.id === wallId);
  if (wall === undefined) return 0;
  return Math.round(wallLengthOf(wall));
}

function buildWalls(
  width: number,
  depth: number,
  heights: number[],
  thicknesses: number[],
): Wall[] {
  const h = (i: number): number => heights[i] ?? DEFAULT_RECTANGLE_WALL_HEIGHT_CM;
  const t = (i: number): number => thicknesses[i] ?? DEFAULT_RECTANGLE_THICKNESS_CM;
  return [
    {
      id: "wall-1",
      start: { x: 0, z: 0 },
      end: { x: width, z: 0 },
      height: h(0),
      thickness: t(0),
    },
    {
      id: "wall-2",
      start: { x: width, z: 0 },
      end: { x: width, z: depth },
      height: h(1),
      thickness: t(1),
    },
    {
      id: "wall-3",
      start: { x: width, z: depth },
      end: { x: 0, z: depth },
      height: h(2),
      thickness: t(2),
    },
    {
      id: "wall-4",
      start: { x: 0, z: depth },
      end: { x: 0, z: 0 },
      height: h(3),
      thickness: t(3),
    },
  ];
}

/** Clamp a wall-mounted span inside its wall: never dropped, never overhanging. */
function clampSpan(
  offset: number,
  width: number,
  wallLength: number,
): { offset: number; width: number } {
  const len = Math.max(0, wallLength);
  const w = Math.min(Math.max(1, Math.round(width)), Math.max(1, Math.round(len)));
  const maxOffset = Math.max(0, Math.round(len) - w);
  const o = Math.min(Math.max(0, Math.round(offset)), maxOffset);
  return { offset: o, width: w };
}

function clampOpeningVertical<T extends Opening>(opening: T, wallHeight: number): T {
  const height = Math.min(Math.max(1, Math.round(opening.height)), Math.round(wallHeight));
  const maxSill = Math.max(0, Math.round(wallHeight) - height);
  const sillHeight = Math.min(Math.max(0, Math.round(opening.sillHeight)), maxSill);
  if (height === opening.height && sillHeight === opening.sillHeight) return opening;
  return { ...opening, height, sillHeight };
}

/** Return a copy of the opening clamped inside a wall of the given length. */
export function clampOpeningToWall<T extends Opening>(opening: T, wallLength: number): T {
  const span = clampSpan(opening.offset, opening.width, wallLength);
  if (span.offset === opening.offset && span.width === opening.width) return opening;
  return { ...opening, offset: span.offset, width: span.width };
}

function clampFixtureToWall(fixture: Fixture, wallLength: number): Fixture {
  const span = clampSpan(fixture.offset, fixture.width, wallLength);
  if (span.offset === fixture.offset && span.width === fixture.width) return fixture;
  return { ...fixture, offset: span.offset, width: span.width };
}

export interface CreateRectangleRoomOptions {
  widthCm: number;
  depthCm: number;
  heightCm?: number;
  id?: string;
  name?: string;
}

/**
 * Fresh rectangle room with no openings, fixtures or pieces. The four walls
 * run counter-clockwise seen from above and close exactly.
 */
export function createRectangleRoom(options: CreateRectangleRoomOptions): RoomLayout {
  const width = clampSide(options.widthCm);
  const depth = clampSide(options.depthCm);
  const height =
    options.heightCm === undefined ? DEFAULT_RECTANGLE_WALL_HEIGHT_CM : clampSide(options.heightCm);
  return {
    id: options.id ?? "manual-room",
    name: options.name ?? "My room",
    units: "cm",
    walls: buildWalls(width, depth, [height, height, height, height], []),
    openings: [],
    fixtures: [],
    existing: [],
    surfaces: { floor: "oak-light", wall: "warm-white" },
    style: { tags: ["modern", "neutral"], dominantColors: ["#E8E2D9", "#A8A29E"] },
    source: "manual",
    confidence: 1,
  };
}

/**
 * The starter manual room: 400 x 350 x 250 cm with one door on the south
 * wall and one window on the north wall, both well inside their walls.
 */
export function createManualRoom(): RoomLayout {
  const room = createRectangleRoom({
    widthCm: 400,
    depthCm: 350,
    heightCm: DEFAULT_RECTANGLE_WALL_HEIGHT_CM,
    id: "manual-room",
    name: "My room",
  });
  return {
    ...room,
    openings: [
      {
        id: "door-1",
        wallId: "wall-1",
        type: "door",
        offset: 40,
        width: 90,
        height: 210,
        sillHeight: 0,
        hinge: "left",
        swing: "in",
      },
      {
        id: "window-1",
        wallId: "wall-3",
        type: "window",
        offset: 120,
        width: 160,
        height: 140,
        sillHeight: 90,
      },
    ],
  };
}

/** Wall length used for clamping a wall-mounted item. */
function wallAxisLength(width: number, depth: number, wallId: string): number {
  return wallId === "wall-1" || wallId === "wall-3" ? width : depth;
}

function refitMounts(room: RoomLayout, width: number, depth: number): RoomLayout {
  const heights = new Map(room.walls.map((w) => [w.id, w.height]));
  const openings: Opening[] = room.openings.map((opening) => {
    const len = wallAxisLength(width, depth, opening.wallId);
    const wallHeight = heights.get(opening.wallId) ?? DEFAULT_RECTANGLE_WALL_HEIGHT_CM;
    return clampOpeningVertical(clampOpeningToWall(opening, len), wallHeight);
  });
  const fixtures = room.fixtures.map((fixture) =>
    clampFixtureToWall(fixture, wallAxisLength(width, depth, fixture.wallId)),
  );
  return { ...room, openings, fixtures };
}

/**
 * Set one rectangle wall's length (cm). Width walls (wall-1, wall-3) resize
 * the room width, depth walls (wall-2, wall-4) the depth; all four walls are
 * rebuilt so the polygon stays closed and the opposite wall moves along.
 * Openings and fixtures stay on their walls, clamped inside, never dropped.
 */
export function setRectangleWallLength(
  room: RoomLayout,
  wallId: string,
  lengthCm: number,
): RoomLayout {
  const next = clampSide(lengthCm);
  const size = rectangleSize(room);
  const width = wallId === "wall-1" || wallId === "wall-3" ? next : size.widthCm;
  const depth = wallId === "wall-2" || wallId === "wall-4" ? next : size.depthCm;
  const heights = room.walls.map((w) => w.height);
  const thicknesses = room.walls.map((w) => w.thickness);
  const walls = buildWalls(width, depth, heights, thicknesses);
  return refitMounts({ ...room, walls }, width, depth);
}

/**
 * Rebuild the four walls from an explicit width/depth, keeping ids, heights
 * and thicknesses, and clamping every wall-mounted item inside its wall.
 */
export function resizeRectangleRoom(
  room: RoomLayout,
  widthCm: number,
  depthCm: number,
): RoomLayout {
  const width = clampSide(widthCm);
  const depth = clampSide(depthCm);
  const heights = room.walls.map((w) => w.height);
  const thicknesses = room.walls.map((w) => w.thickness);
  const walls = buildWalls(width, depth, heights, thicknesses);
  return refitMounts({ ...room, walls }, width, depth);
}
