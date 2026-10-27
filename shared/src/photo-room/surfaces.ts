/**
 * Photo-built room surfaces: wall tint + floor/wall finish picks.
 *
 * Pure TypeScript, no DOM. The browser computes per-photo medians from the
 * 1280 px photo pixels plus the SAM masks at hand (`client/src/photo-room/`);
 * this module holds the shared contracts both sides use:
 *
 * - per-channel median over a full-frame include mask minus an exclude mask
 *   (`medianMaskColor`), as `#RRGGBB`;
 * - full-frame union masks from SAM instances (`conceptMask`);
 * - floor finish by label family, wood/tile/carpet closest by median colour;
 * - wall finish by label family (`wallpaper` -> wallpaper, else paint);
 * - blending per-photo tints into one room tint.
 */

import type { SamInstance } from "../sam.js";
import type { RoomLabelFloorFamily, RoomLabelWallFamily } from "../room-label.js";

export const WALL_TEXTURE_PAINT = "PaintedPlaster017";
export const WALL_TEXTURE_WALLPAPER = "Wallpaper002A";

/** Every wall finish the pickers offer. */
export const WALL_FINISHES: readonly string[] = [WALL_TEXTURE_PAINT, WALL_TEXTURE_WALLPAPER];

export const WOOD_FLOORS: readonly string[] = [
  "WoodFloor070",
  "WoodFloor051",
  "WoodFloor064",
  "WoodFloor071",
];
export const TILE_FLOORS: readonly string[] = ["Tiles107", "Tiles139"];
export const CARPET_FLOORS: readonly string[] = ["Carpet012", "Carpet015", "Carpet016"];
export const CONCRETE_FLOORS: readonly string[] = ["Concrete034"];

/** Every floor finish the pickers offer. */
export const FLOOR_FINISHES: readonly string[] = [
  ...WOOD_FLOORS,
  ...TILE_FLOORS,
  ...CARPET_FLOORS,
  ...CONCRETE_FLOORS,
];

/** The sample room's floor: the `other`/no-label fallback. */
export const SAMPLE_FLOOR_SURFACE = "oak-light";
/** The sample room's wall finish. */
export const SAMPLE_WALL_SURFACE = "warm-white";

/**
 * Approximate mean colour per ambientCG finish (sRGB hex), for closest-by-
 * colour picks and picker swatches. Coarse on purpose: only the ordering
 * between finishes of one family matters.
 */
export const TEXTURE_MEAN_COLORS: Readonly<Record<string, string>> = {
  WoodFloor070: "#8A6642",
  WoodFloor051: "#6E4E30",
  WoodFloor064: "#A07A4F",
  WoodFloor071: "#7A5A38",
  Tiles107: "#CFCFCF",
  Tiles139: "#9AA0A3",
  Carpet012: "#B0A897",
  Carpet015: "#8B8D90",
  Carpet016: "#5E6063",
  Concrete034: "#9B9B9B",
  PaintedPlaster017: "#E8E2D9",
  Wallpaper002A: "#D8CFC2",
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** True for a `#RRGGBB` tint the schema accepts. */
export function isWallTintValid(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number): string =>
    Math.min(255, Math.max(0, Math.round(n)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${c(r)}${c(g)}${c(b)}`;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid] as number;
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA bytes, length width*height*4. */
  data: ArrayLike<number>;
}

/**
 * Per-channel median colour of the pixels where `include` is non-zero and
 * `exclude` (when given) is zero. Both masks are full-frame row-major
 * `width*height` arrays. Returns `#RRGGBB` or null when no pixel qualifies.
 */
export function medianMaskColor(
  image: RgbaImage,
  include: ArrayLike<number>,
  exclude?: ArrayLike<number> | null,
): string | null {
  const n = image.width * image.height;
  if (n <= 0) return null;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if ((include[i] ?? 0) === 0) continue;
    if (exclude !== undefined && exclude !== null && (exclude[i] ?? 0) !== 0) continue;
    const o = i * 4;
    rs.push(image.data[o] ?? 0);
    gs.push(image.data[o + 1] ?? 0);
    bs.push(image.data[o + 2] ?? 0);
  }
  if (rs.length === 0) return null;
  return rgbToHex(medianOf(rs), medianOf(gs), medianOf(bs));
}

function maskAt(inst: SamInstance, x: number, y: number): boolean {
  const [x1, y1, x2, y2] = inst.box;
  if (x < x1 || x > x2 || y < y1 || y > y2) return false;
  const w = inst.mask.width;
  const h = inst.mask.height;
  const bw = x2 - x1 + 1;
  const bh = y2 - y1 + 1;
  const ix = Math.min(w - 1, Math.max(0, Math.round(((x - x1) / Math.max(1, bw)) * w)));
  const iy = Math.min(h - 1, Math.max(0, Math.round(((y - y1) / Math.max(1, bh)) * h)));
  return (inst.mask.data[iy * w + ix] ?? 0) !== 0;
}

/**
 * Full-frame union mask (1 = covered) of every instance with one concept.
 * Row-major `width*height` bytes.
 */
export function conceptMask(
  instances: SamInstance[],
  concept: string,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const members = instances.filter((i) => i.concept === concept);
  if (members.length === 0) return out;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (const inst of members) {
        if (maskAt(inst, x, y)) {
          out[y * width + x] = 1;
          break;
        }
      }
    }
  }
  return out;
}

/** Full-frame union of several concepts (e.g. window + door exclusions). */
export function unionConceptMask(
  instances: SamInstance[],
  concepts: readonly string[],
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const set = new Set(concepts);
  const members = instances.filter((i) => set.has(i.concept));
  if (members.length === 0) return out;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (const inst of members) {
        if (maskAt(inst, x, y)) {
          out[y * width + x] = 1;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Median wall colour of one photo: wall-concept pixels minus window/door
 * pixels. Returns `#RRGGBB` or null when the wall mask is empty.
 */
export function wallMedianColor(
  image: RgbaImage,
  instances: SamInstance[],
  width: number,
  height: number,
): string | null {
  const include = conceptMask(instances, "wall", width, height);
  const exclude = unionConceptMask(instances, ["window", "door"], width, height);
  return medianMaskColor(image, include, exclude);
}

/** Median floor colour of one photo, or null when the floor mask is empty. */
export function floorMedianColor(
  image: RgbaImage,
  instances: SamInstance[],
  width: number,
  height: number,
): string | null {
  const include = conceptMask(instances, "floor", width, height);
  return medianMaskColor(image, include);
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function closestByColor(options: readonly string[], medianHex: string | null): string {
  const first = options[0] as string;
  if (medianHex === null || !HEX_RE.test(medianHex)) return first;
  const target = hexToRgb(medianHex);
  let best = first;
  let bestD = Infinity;
  for (const id of options) {
    const ref = TEXTURE_MEAN_COLORS[id] ?? "#808080";
    const d = colorDistance(target, hexToRgb(ref));
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/**
 * Floor finish for a label family; wood/tile/carpet pick the closest finish
 * to the floor mask's median colour. `other` (or anything unknown, or no
 * label) falls back to the sample room's floor.
 */
export function pickFloorTexture(
  family: RoomLabelFloorFamily | string | null | undefined,
  floorMedianHex: string | null,
): string {
  switch (family) {
    case "wood":
      return closestByColor(WOOD_FLOORS, floorMedianHex);
    case "tile":
      return closestByColor(TILE_FLOORS, floorMedianHex);
    case "carpet":
      return closestByColor(CARPET_FLOORS, floorMedianHex);
    case "concrete":
      return CONCRETE_FLOORS[0] as string;
    default:
      return SAMPLE_FLOOR_SURFACE;
  }
}

/** Wall finish for a label family: wallpaper keeps its paper, else paint. */
export function pickWallTexture(family: RoomLabelWallFamily | string | null | undefined): string {
  return family === "wallpaper" ? WALL_TEXTURE_WALLPAPER : WALL_TEXTURE_PAINT;
}

/**
 * One room tint from per-photo tints: per-channel mean, rounded. Null when
 * no valid tint is given.
 */
export function blendWallTints(tints: Array<string | null | undefined>): string | null {
  const valid = tints.filter((t): t is string => typeof t === "string" && HEX_RE.test(t));
  if (valid.length === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const t of valid) {
    const [cr, cg, cb] = hexToRgb(t);
    r += cr;
    g += cg;
    b += cb;
  }
  return rgbToHex(r / valid.length, g / valid.length, b / valid.length);
}
