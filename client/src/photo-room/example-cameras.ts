/** Example room wall-photo records: the cameras the view draws from. No DOM. */

import type { RoomLayout, WallLetter } from "@fitroom/shared";
import type { PhotoSession } from "../editor/editor-store.js";

export interface ExamplePhotoCorners {
  m1: [number, number];
  m2: [number, number];
  m3: [number, number];
  m4: [number, number];
}

export interface ExampleWallCamera {
  wall: WallLetter;
  wallId: string;
  corners: ExamplePhotoCorners;
  focalPx: number;
  width: number;
  height: number;
}

export interface ExampleWallsSnapshot {
  id: string;
  start: { x: number; z: number };
  end: { x: number; z: number };
  height: number;
}

export interface ExamplePhotoStore {
  version: 1;
  roomName: string;
  walls: ExampleWallsSnapshot[];
  records: ExampleWallCamera[];
}

export const EXAMPLE_PHOTO_CAMERAS_KEY = "fitroom.example-photo-cameras.v1";

const LETTERS: WallLetter[] = ["A", "B", "C", "D"];

function isCorners(value: unknown): value is ExamplePhotoCorners {
  if (typeof value !== "object" || value === null) return false;
  const corners = value as Record<string, unknown>;
  for (const key of ["m1", "m2", "m3", "m4"]) {
    const point = corners[key];
    if (!Array.isArray(point) || point.length !== 2) return false;
    const [x, y] = point as unknown[];
    if (typeof x !== "number" || typeof y !== "number") return false;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  }
  return true;
}

function isRecord(value: unknown): value is ExampleWallCamera {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    record["wall"] !== "A" &&
    record["wall"] !== "B" &&
    record["wall"] !== "C" &&
    record["wall"] !== "D"
  ) {
    return false;
  }
  if (typeof record["wallId"] !== "string" || record["wallId"] === "") return false;
  if (!isCorners(record["corners"])) return false;
  if (typeof record["focalPx"] !== "number" || !((record["focalPx"] as number) > 0)) return false;
  if (typeof record["width"] !== "number" || typeof record["height"] !== "number") return false;
  if (!((record["width"] as number) > 0) || !((record["height"] as number) > 0)) return false;
  return true;
}

/** Snapshot of the walls a photo record was measured from. */
export function exampleWallsSignature(room: RoomLayout): ExampleWallsSnapshot[] {
  return room.walls.map((wall) => ({
    id: wall.id,
    start: { x: wall.start.x, z: wall.start.z },
    end: { x: wall.end.x, z: wall.end.z },
    height: wall.height,
  }));
}

/** True when the walls still match the photo (same ids, ends and heights). */
export function sameExampleWalls(
  left: ExampleWallsSnapshot[],
  right: ExampleWallsSnapshot[],
): boolean {
  if (left.length !== right.length) return false;
  for (const entry of left) {
    const other = right.find((wall) => wall.id === entry.id);
    if (other === undefined) return false;
    if (
      other.start.x !== entry.start.x ||
      other.start.z !== entry.start.z ||
      other.end.x !== entry.end.x ||
      other.end.z !== entry.end.z ||
      other.height !== entry.height
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Build one record per wall from the confirm session's current corners.
 * Sizes come from the session's own frames (1280 × 951 for the example),
 * never the open-draft fallback frame. Returns null when a wall's
 * corners, focal or size are missing.
 */
export function buildExamplePhotoRecords(session: PhotoSession | null): ExampleWallCamera[] | null {
  if (session === null) return null;
  const records: ExampleWallCamera[] = [];
  for (const letter of LETTERS) {
    const solution = session.draft.photos.find((photo) => photo.wall === letter);
    const size = session.sizes[letter];
    if (solution === undefined || size === undefined) return null;
    if (!(solution.focalPx > 0)) return null;
    if (!(size.width > 0) || !(size.height > 0)) return null;
    const corners = solution.corners as unknown;
    if (!isCorners(corners)) return null;
    records.push({
      wall: letter,
      wallId: solution.wallId,
      corners: {
        m1: [...corners.m1] as [number, number],
        m2: [...corners.m2] as [number, number],
        m3: [...corners.m3] as [number, number],
        m4: [...corners.m4] as [number, number],
      },
      focalPx: solution.focalPx,
      width: size.width,
      height: size.height,
    });
  }
  return records;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Save the example room's wall records with its walls signature. */
export function saveExamplePhotoCameras(records: ExampleWallCamera[], room: RoomLayout): void {
  const store = storage();
  if (store === null) return;
  const payload: ExamplePhotoStore = {
    version: 1,
    roomName: room.name,
    walls: exampleWallsSignature(room),
    records,
  };
  try {
    store.setItem(EXAMPLE_PHOTO_CAMERAS_KEY, JSON.stringify(payload));
  } catch {
    // Storage may be unavailable; the app keeps working in memory.
  }
}

/**
 * Load the stored records for the live room. Returns null when nothing is
 * stored, when the room is not the stored example room, or when a
 * plan-editor edit changed the walls (the photo no longer matches).
 */
export function loadExamplePhotoCameras(room: RoomLayout): ExampleWallCamera[] | null {
  const store = storage();
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(EXAMPLE_PHOTO_CAMERAS_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ExamplePhotoStore>;
    if (parsed.version !== 1 || parsed.roomName !== room.name) return null;
    if (!Array.isArray(parsed.records) || !parsed.records.every(isRecord)) return null;
    if (!Array.isArray(parsed.walls)) return null;
    if (!sameExampleWalls(parsed.walls as ExampleWallsSnapshot[], exampleWallsSignature(room))) {
      return null;
    }
    return parsed.records as ExampleWallCamera[];
  } catch {
    return null;
  }
}

/** Read the stored payload without matching it to a room (checks only). */
export function readExamplePhotoStore(): ExamplePhotoStore | null {
  const store = storage();
  if (store === null) return null;
  try {
    const raw = store.getItem(EXAMPLE_PHOTO_CAMERAS_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as ExamplePhotoStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Drop the stored example records (another room, or a wall edit). */
export function clearExamplePhotoCameras(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(EXAMPLE_PHOTO_CAMERAS_KEY);
  } catch {
    // Storage may be unavailable; nothing stored, nothing to clear.
  }
}
