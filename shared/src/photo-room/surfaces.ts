/**
 * Photo-built room surfaces: wall albedo + floor/wall finish picks.
 *
 * Pure TypeScript, no DOM. The browser computes per-photo colours from the
 * 1280 px photo pixels plus the SAM masks at hand
 * (`client/src/photo-room/`); this module holds the shared contracts both
 * sides use:
 *
 * - per-channel median over a full-frame include mask minus an exclude mask
 *   (`medianMaskColor`), as `#RRGGBB`;
 * - full-frame union masks from SAM instances (`conceptMask`);
 * - wall/floor albedo from the ceiling white reference (albedo 0.9):
 *   `albedo = surface median / ceiling median x 0.9` per channel,
 *   clamped to 0-1; without a ceiling mask the lit-area median (median
 *   over the mask pixels at or above the mask's median luminance, so
 *   bright clutter cannot latch the estimate) is scaled by one number —
 *   `0.9 x 255 / reference luminance`, where the reference is the 90th
 *   luminance percentile pixel of the surface's own mask — so the wall
 *   keeps its hue (a per-channel division by that pixel would cancel it);
 * - floor finish by label family, wood/tile/carpet closest by measured mean
 *   albedo (means computed from the texture files by
 *   `scripts/measure-texture-means.mjs` into `texture-means.json`);
 * - wall finish by label family (`wallpaper` -> wallpaper, else paint);
 * - blending per-photo albedos into one room tint;
 * - wall display colour for a texture normalised to a mean of 1, so the
 *   texture weave shows without darkening the albedo again:
 *   `wallDisplayLinear` divides in linear light with no clamp (three.js
 *   colours may exceed 1), so a wall lighter than the texture keeps its
 *   hue and renders light. `wallDisplayHex` is the legacy clamped sRGB
 *   form (kept for its long-standing bar, not for the material).
 */

import type { SamInstance } from "../sam.js";
import type { RoomLabelFloorFamily, RoomLabelWallFamily } from "../room-label.js";
import textureMeans from "./texture-means.json" with { type: "json" };

export const WALL_TEXTURE_PAINT = "PaintedPlaster017";
export const WALL_TEXTURE_WALLPAPER = "Wallpaper002A";

/**
 * Short readable name per finish id, for tooltips and accessible names
 * ("Floor: Light oak"). Every id in `FLOOR_FINISHES` and `WALL_FINISHES`
 * has exactly one entry; no name carries an asset id.
 */
export const FINISH_NAMES: Readonly<Record<string, string>> = {
  WoodFloor070: "Light oak",
  WoodFloor051: "Honey oak",
  WoodFloor064: "Smoked oak",
  WoodFloor071: "Pale ash",
  Tiles107: "Grey stone tiles",
  Tiles139: "Sand stone tiles",
  Carpet012: "Oatmeal carpet",
  Carpet015: "Pebble carpet",
  Carpet016: "Slate carpet",
  Concrete034: "Polished concrete",
  PaintedPlaster017: "Warm white plaster",
  Wallpaper002A: "Botanical wallpaper",
};

/** Readable name for a finish id (falls back to the id, never empty). */
export function finishName(id: string): string {
  return FINISH_NAMES[id] ?? id;
}

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
 * Mean sRGB colour per ambientCG finish, measured from each finish's own
 * `*_Color.jpg` by `scripts/measure-texture-means.mjs` (never hand-typed).
 */
export const TEXTURE_MEAN_COLORS: Readonly<Record<string, string>> = textureMeans as Record<
  string,
  string
>;

/** White reference albedo for the ceiling (a matte white ceiling). */
export const CEILING_REFERENCE_ALBEDO = 0.9;

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

function percentileOfSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  const idx = Math.min(sorted.length - 1, Math.floor(clamped * sorted.length));
  return sorted[idx] as number;
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
  const rgb = medianMaskRgb(image, include, exclude);
  if (rgb === null) return null;
  return rgbToHex(rgb[0], rgb[1], rgb[2]);
}

function medianMaskRgb(
  image: RgbaImage,
  include: ArrayLike<number>,
  exclude?: ArrayLike<number> | null,
): [number, number, number] | null {
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
  return [medianOf(rs), medianOf(gs), medianOf(bs)];
}

function maskLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

interface RankedPixel {
  lum: number;
  r: number;
  g: number;
  b: number;
}

/** Mask pixels (exclusions apply) ranked dimmest first. Empty when none qualify. */
function rankedMaskPixels(
  image: RgbaImage,
  include: ArrayLike<number>,
  exclude?: ArrayLike<number> | null,
): RankedPixel[] {
  const n = image.width * image.height;
  const order: RankedPixel[] = [];
  if (n <= 0) return order;
  for (let i = 0; i < n; i += 1) {
    if ((include[i] ?? 0) === 0) continue;
    if (exclude !== undefined && exclude !== null && (exclude[i] ?? 0) !== 0) continue;
    const o = i * 4;
    const r = image.data[o] ?? 0;
    const g = image.data[o + 1] ?? 0;
    const b = image.data[o + 2] ?? 0;
    order.push({ lum: maskLuminance(r, g, b), r, g, b });
  }
  order.sort((a, b) => a.lum - b.lum);
  return order;
}

function percentilePick<T>(ranked: T[], percentile: number): T | null {
  if (ranked.length === 0) return null;
  const idx = percentileOfSorted(
    ranked.map((_, i) => i),
    percentile,
  );
  return ranked[idx] ?? null;
}

/**
 * Colour of the pixel at the `percentile` luminance rank inside the mask
 * (window/door exclusions apply when given). The bright end of a shaded
 * surface is the white reference when no ceiling is in view.
 */
export function percentileMaskColor(
  image: RgbaImage,
  include: ArrayLike<number>,
  exclude?: ArrayLike<number> | null,
  percentile = 0.9,
): string | null {
  const pick = percentilePick(rankedMaskPixels(image, include, exclude), percentile);
  if (pick === null) return null;
  return rgbToHex(pick.r, pick.g, pick.b);
}

/** Luminance of the pixel at the `percentile` luminance rank inside the mask. */
export function percentileMaskLuminance(
  image: RgbaImage,
  include: ArrayLike<number>,
  exclude?: ArrayLike<number> | null,
  percentile = 0.9,
): number | null {
  const pick = percentilePick(rankedMaskPixels(image, include, exclude), percentile);
  return pick === null ? null : pick.lum;
}

/**
 * Per-channel median colour of the lit area: the mask pixels at or above
 * the mask's median luminance. Shade and dark furniture pull the plain
 * median down; the lit half holds the surface's own hue.
 */
export function litMedianMaskColor(
  image: RgbaImage,
  include: ArrayLike<number>,
  exclude?: ArrayLike<number> | null,
): string | null {
  const ranked = rankedMaskPixels(image, include, exclude);
  if (ranked.length === 0) return null;
  const gate = ranked[Math.floor(ranked.length / 2)]?.lum ?? 0;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const p of ranked) {
    if (p.lum < gate) continue;
    rs.push(p.r);
    gs.push(p.g);
    bs.push(p.b);
  }
  if (rs.length === 0) return null;
  return rgbToHex(medianOf(rs), medianOf(gs), medianOf(bs));
}

/**
 * Albedo from a surface median and a reference luminance: the median
 * scaled by the single number `0.9 x 255 / reference`, never channel by
 * channel, so the surface keeps its hue. A uniform fit keeps a bright
 * median inside `#RRGGBB` without clipping one channel first.
 */
export function albedoFromLuminance(
  surfaceHex: string | null,
  referenceLuminance: number | null,
): string | null {
  if (surfaceHex === null || referenceLuminance === null) return null;
  if (!HEX_RE.test(surfaceHex)) return null;
  if (!(referenceLuminance > 0)) return null;
  const [sr, sg, sb] = hexToRgb(surfaceHex);
  const k = (CEILING_REFERENCE_ALBEDO * 255) / referenceLuminance;
  const fit = Math.max(sr * k, sg * k, sb * k);
  const s = fit > 255 ? 255 / fit : 1;
  return rgbToHex(sr * k * s, sg * k * s, sb * k * s);
}

/** Albedo from a surface median and a ceiling/reference median. */
export function albedoFromMedianPair(
  surfaceHex: string | null,
  referenceHex: string | null,
): string | null {
  if (surfaceHex === null || referenceHex === null) return null;
  if (!HEX_RE.test(surfaceHex) || !HEX_RE.test(referenceHex)) return null;
  const [sr, sg, sb] = hexToRgb(surfaceHex);
  const [rr, rg, rb] = hexToRgb(referenceHex);
  if (rr <= 0 || rg <= 0 || rb <= 0) return null;
  const ar = Math.min(1, Math.max(0, (sr / rr) * CEILING_REFERENCE_ALBEDO));
  const ag = Math.min(1, Math.max(0, (sg / rg) * CEILING_REFERENCE_ALBEDO));
  const ab = Math.min(1, Math.max(0, (sb / rb) * CEILING_REFERENCE_ALBEDO));
  return rgbToHex(ar * 255, ag * 255, ab * 255);
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

/** Median ceiling colour of one photo, or null when no ceiling is in view. */
export function ceilingMedianColor(
  image: RgbaImage,
  instances: SamInstance[],
  width: number,
  height: number,
): string | null {
  const include = conceptMask(instances, "ceiling", width, height);
  return medianMaskColor(image, include);
}

/**
 * Wall albedo of one photo: the wall median divided by the ceiling median
 * (albedo 0.9) per channel. Without a ceiling mask the lit-area median is
 * scaled by the single number `0.9 x 255 / reference luminance` (the 90th
 * luminance percentile pixel of the wall's own mask), so the tint keeps
 * the wall's hue and lightness.
 */
export function wallAlbedoColor(
  image: RgbaImage,
  instances: SamInstance[],
  width: number,
  height: number,
): string | null {
  const include = conceptMask(instances, "wall", width, height);
  const exclude = unionConceptMask(instances, ["window", "door"], width, height);
  const surface = medianMaskColor(image, include, exclude);
  if (surface === null) return null;
  const ceiling = ceilingMedianColor(image, instances, width, height);
  if (ceiling !== null) return albedoFromMedianPair(surface, ceiling);
  const lit = litMedianMaskColor(image, include, exclude);
  return albedoFromLuminance(lit, percentileMaskLuminance(image, include, exclude, 0.9));
}

/**
 * Floor albedo of one photo: same white-reference rule as the wall, over
 * the floor mask.
 */
export function floorAlbedoColor(
  image: RgbaImage,
  instances: SamInstance[],
  width: number,
  height: number,
): string | null {
  const include = conceptMask(instances, "floor", width, height);
  const surface = medianMaskColor(image, include);
  if (surface === null) return null;
  const ceiling = ceilingMedianColor(image, instances, width, height);
  if (ceiling !== null) return albedoFromMedianPair(surface, ceiling);
  const lit = litMedianMaskColor(image, include);
  return albedoFromLuminance(lit, percentileMaskLuminance(image, include, null, 0.9));
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
 * Floor finish for a label family; wood/tile/carpet pick the finish whose
 * measured mean albedo is closest to the floor's albedo. `other` (or
 * anything unknown, or no label) falls back to the sample room's floor.
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
 * Legacy clamped sRGB form of the wall display colour: `albedo /
 * textureMean` per channel, each channel clamped to 255. A wall lighter
 * than the texture clips to the texture's own grey, so the material uses
 * `wallDisplayLinear` instead. Kept for its long-standing bar. Falls back
 * to the albedo itself when the texture mean is unknown.
 */
function srgbChannelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/**
 * Display colour to put on the wall material for one albedo over a wall
 * texture: the albedo divided by the texture mean in linear light, with
 * no clamp. Channels may exceed 1 (three.js colours may): a wall lighter
 * than the texture keeps the albedo's hue and renders light instead of
 * clipping to the texture's own grey. Falls back to null when the albedo
 * or the texture mean is unknown, so the caller can use the albedo itself.
 */
export function wallDisplayLinear(
  albedoHex: string | null | undefined,
  textureId: string | null | undefined,
): [number, number, number] | null {
  if (typeof albedoHex !== "string" || !HEX_RE.test(albedoHex)) return null;
  const meanHex = (
    textureId !== null && textureId !== undefined ? TEXTURE_MEAN_COLORS[textureId] : undefined
  ) as string | undefined;
  if (meanHex === undefined || !HEX_RE.test(meanHex)) return null;
  const [ar, ag, ab] = hexToRgb(albedoHex);
  const [mr, mg, mb] = hexToRgb(meanHex);
  const lr = srgbChannelToLinear(mr);
  const lg = srgbChannelToLinear(mg);
  const lb = srgbChannelToLinear(mb);
  if (!(lr > 0) || !(lg > 0) || !(lb > 0)) return null;
  return [srgbChannelToLinear(ar) / lr, srgbChannelToLinear(ag) / lg, srgbChannelToLinear(ab) / lb];
}

export function wallDisplayHex(
  albedoHex: string | null | undefined,
  textureId: string | null | undefined,
): string | null {
  if (typeof albedoHex !== "string" || !HEX_RE.test(albedoHex)) return null;
  const meanHex = (
    textureId !== null && textureId !== undefined ? TEXTURE_MEAN_COLORS[textureId] : undefined
  ) as string | undefined;
  if (meanHex === undefined || !HEX_RE.test(meanHex)) return albedoHex;
  const [ar, ag, ab] = hexToRgb(albedoHex);
  const [mr, mg, mb] = hexToRgb(meanHex);
  if (mr <= 0 || mg <= 0 || mb <= 0) return albedoHex;
  const cr = Math.min(255, Math.max(0, Math.round((ar / mr) * 255)));
  const cg = Math.min(255, Math.max(0, Math.round((ag / mg) * 255)));
  const cb = Math.min(255, Math.max(0, Math.round((ab / mb) * 255)));
  return rgbToHex(cr, cg, cb);
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
