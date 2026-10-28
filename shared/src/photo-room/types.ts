/**
 * Photo-room conventions (single table; mirrored in the README section).
 *
 * | # | rule |
 * |---|------|
 * | 1 | Walls are a closed counter-clockwise polygon from the inner south-west corner (origin). |
 * | 2 | Letters run counter-clockwise seen from inside: A = wall-1 (the entrance door), B = wall-4 (on the left as you face A), C = wall-3 (opposite A), D = wall-2 (on the right as you face A). |
 * | 3 | Seen from inside, a wall runs from image left (its start) to image right (its end); an opening offset is measured from the wall start. |
 * | 4 | Plan (x, z) maps to three.js (x, z) with y up: facing +z, +x is on the left. |
 * | 5 | A door hinge side is stored in room terms (viewed from inside facing the wall; left = wall-end side, the image-right side), never image terms. |
 * | 6 | Every fixture has asymmetric openings and a hinged door so a consistent image/room flip fails the checks. |
 *
 * Letter to wall id: A -> wall-1, B -> wall-4, C -> wall-3, D -> wall-2.
 * Tape: A and C use tape A (width); B and D use tape B (depth).
 */

import type { SamInstance } from "../sam.js";

export type WallLetter = "A" | "B" | "C" | "D";
export type ValueSource = "taped" | "photo" | "default";
export type FocalSource = "exif" | "default";

export const LETTER_TO_WALL_ID: Record<WallLetter, string> = {
  A: "wall-1",
  B: "wall-4",
  C: "wall-3",
  D: "wall-2",
};

export const WALL_ID_TO_LETTER: Record<string, WallLetter> = {
  "wall-1": "A",
  "wall-4": "B",
  "wall-3": "C",
  "wall-2": "D",
};

export interface PhotoInput {
  wall: WallLetter;
  width: number;
  height: number;
  focal35mm?: number;
  instances: SamInstance[];
}

export interface SolverInput {
  photos: PhotoInput[];
  /** Wall A length in cm (taped). */
  tapeA: number;
  /** Wall B length in cm (taped). */
  tapeB: number;
  /**
   * Shopper-tapped door point for one wall, in that photo's pixel frame.
   * Used only when the solver would otherwise flag `tap-the-door` there:
   * the tap anchors a default-width door opening instead of the flag.
   */
  doorTap?: DoorTap;
}

export interface DoorTap {
  wall: WallLetter;
  x: number;
  y: number;
}

export interface Uncertain {
  value: number;
  plusMinus: number;
  source: ValueSource;
}

export interface DraftOpening {
  id: string;
  wall: WallLetter;
  wallId: string;
  type: "door" | "window";
  offset: Uncertain;
  width: Uncertain;
  height: Uncertain;
  sillHeight: Uncertain;
  hinge?: "left" | "right";
  swing?: "in" | "out";
}

/** Fitted line in pixels: ax + by + c = 0 with residual RMSE. */
export interface FittedLine {
  a: number;
  b: number;
  c: number;
  rmse: number;
  points: number;
  hiddenFraction: number;
}

export interface PhotoSolution {
  wall: WallLetter;
  wallId: string;
  focalPx: number;
  focalSource: FocalSource;
  focal35mm: number;
  /** Median wall colour of this photo (`#RRGGBB`), computed in the browser. */
  wallTint?: string;
  /** Median floor colour of this photo (`#RRGGBB`), computed in the browser. */
  floorColor?: string;
  lines: { floor: FittedLine; ceiling: FittedLine; left: FittedLine; right: FittedLine };
  corners: {
    m1: [number, number];
    m2: [number, number];
    m3: [number, number];
    m4: [number, number];
  };
  ratio: number;
  ratioPlusMinus: number;
  heightEstimate: number;
  heightPlusMinus: number;
}

export type DraftFlagCode =
  | "door-width"
  | "sill-range"
  | "ceiling-spread"
  | "corner-out-of-frame"
  | "corner-occluded"
  | "floor-hidden"
  | "height-from-ceiling"
  | "focal-wide"
  | "two-walls-in-view"
  | "edge-at-door"
  | "tap-the-door";

export interface DraftFlag {
  code: DraftFlagCode;
  message: string;
  wall?: WallLetter;
}

export interface RoomDraft {
  layout: import("../types.js").RoomLayout;
  wallLengths: Record<WallLetter, Uncertain>;
  ceilingHeight: Uncertain;
  openings: DraftOpening[];
  photos: PhotoSolution[];
  letterToWallId: Record<WallLetter, string>;
  flags: DraftFlag[];
}
