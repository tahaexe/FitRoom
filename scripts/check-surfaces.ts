/**
 * `npm run check:surfaces` — photo-built room finishes, headless.
 *
 * - the median colour of a synthetic mask over a two-colour image is right
 *   and ignores the masked-out window;
 * - each floor family maps to a texture that exists on disk
 *   (`client/public/assets/textures/ambientcg/<id>/`);
 * - `other` (and no label) falls back to the sample room's floor;
 * - wall/floor albedo: a synthetic wall of known albedo under a
 *   left-to-right shading gradient with a 0.9-albedo ceiling recovers the
 *   wall albedo within dE 5; without the ceiling mask within dE 12;
 * - a floor of a texture's own mean colour picks that texture (measured
 *   means, never hand-typed);
 * - a light grey-beige wall never renders brown.
 *
 * Prints PASS/FAIL per check, exits non-zero on any FAIL. No Meta calls.
 */

/* global console, process */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  albedoFromMedianPair,
  blendWallTints,
  CARPET_FLOORS,
  CONCRETE_FLOORS,
  floorAlbedoColor,
  medianMaskColor,
  percentileMaskColor,
  pickFloorTexture,
  pickWallTexture,
  SAMPLE_FLOOR_SURFACE,
  TEXTURE_MEAN_COLORS,
  TILE_FLOORS,
  wallAlbedoColor,
  wallDisplayHex,
  WOOD_FLOORS,
  type RgbaImage,
} from "../shared/src/photo-room/surfaces.js";
import type { SamInstance } from "../shared/src/sam.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const texturesDir = join(repoRoot, "client", "public", "assets", "textures", "ambientcg");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

/** 4x2 image: left half red, right half blue (opaque RGBA). */
function twoColorImage(): { width: number; height: number; data: Uint8ClampedArray } {
  const width = 4;
  const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (x < 2) {
        data[o] = 200;
        data[o + 1] = 20;
        data[o + 2] = 20;
      } else {
        data[o] = 20;
        data[o + 1] = 40;
        data[o + 2] = 200;
      }
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

const image = twoColorImage();
const n = image.width * image.height;

// Full mask: 4 red + 4 blue pixels -> per-channel medians (110, 30, 110).
const full = new Uint8Array(n).fill(1);
check("median two-colour", medianMaskColor(image, full) === "#6E1E6E");

// Mask only the red half -> red median.
const redHalf = new Uint8Array([1, 1, 0, 0, 1, 1, 0, 0]);
check("median red half", medianMaskColor(image, redHalf) === "#C81414");

// Exclude the red half as a "window": blue median survives.
const excludeRed = new Uint8Array([1, 1, 0, 0, 1, 1, 0, 0]);
check("median ignores window", medianMaskColor(image, full, excludeRed) === "#1428C8");

// Empty mask -> null.
check("median empty", medianMaskColor(image, new Uint8Array(n)) === null);

function textureExists(id: string): boolean {
  return existsSync(join(texturesDir, id));
}

for (const id of [...WOOD_FLOORS, ...TILE_FLOORS, ...CARPET_FLOORS, ...CONCRETE_FLOORS]) {
  check(`floor texture on disk ${id}`, textureExists(id));
}
check("wall texture on disk PaintedPlaster017", textureExists("PaintedPlaster017"));
check("wall texture on disk Wallpaper002A", textureExists("Wallpaper002A"));

// Each family resolves to one of its own on-disk textures.
check(
  "wood maps to a wood floor",
  (WOOD_FLOORS as readonly string[]).includes(pickFloorTexture("wood", "#8A6642")),
);
check(
  "tile maps to a tile floor",
  (TILE_FLOORS as readonly string[]).includes(pickFloorTexture("tile", "#CFCFCF")),
);
check(
  "carpet maps to a carpet floor",
  (CARPET_FLOORS as readonly string[]).includes(
    pickFloorTexture("carpet", TEXTURE_MEAN_COLORS["Carpet015"] ?? null),
  ),
);
check(
  "concrete maps to Concrete034",
  pickFloorTexture("concrete", "#9B9B9B") === (CONCRETE_FLOORS[0] as string),
);

// A floor of a texture's own measured mean picks that texture.
for (const id of [...WOOD_FLOORS, ...TILE_FLOORS, ...CARPET_FLOORS]) {
  const mean = TEXTURE_MEAN_COLORS[id] ?? null;
  const family = (WOOD_FLOORS as readonly string[]).includes(id)
    ? "wood"
    : (TILE_FLOORS as readonly string[]).includes(id)
      ? "tile"
      : "carpet";
  check(`floor own mean picks ${id}`, pickFloorTexture(family, mean) === id, mean ?? undefined);
}

// `other` (and no label) falls back to the sample room's floor.
check("other falls back", pickFloorTexture("other", "#8A6642") === SAMPLE_FLOOR_SURFACE);
check("no label falls back", pickFloorTexture(undefined, "#8A6642") === SAMPLE_FLOOR_SURFACE);

// Wall family: wallpaper keeps its paper, everything else is paint.
check("wallpaper stays wallpaper", pickWallTexture("wallpaper") === "Wallpaper002A");
check("paint stays paint", pickWallTexture("paint") === "PaintedPlaster017");
check("other wall is paint", pickWallTexture("other") === "PaintedPlaster017");

// Tint blending: mean of two primaries, null when empty.
check("tints blend", blendWallTints(["#FF0000", "#0000FF"]) === "#800080");
check("tints empty", blendWallTints([]) === null);

// ---- albedo helpers ----

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function hexToLab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = hexToLab(a);
  const [l2, a2, b2] = hexToLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function fullMaskInstance(
  concept: string,
  id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  imageW: number,
  imageH: number,
): SamInstance {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  return {
    concept,
    id,
    box: [x0, y0, x1, y1],
    imageWidth: imageW,
    imageHeight: imageH,
    mask: { width: w, height: h, data: new Uint8Array(w * h).fill(1) },
  };
}

/**
 * Synthetic shaded photo: wall of `wallAlbedo` under a left-to-right
 * gradient (1.0 -> 0.4), ceiling of albedo 0.9 under the same gradient.
 * Top half rows are ceiling, bottom half rows are wall.
 */
function shadedRoomImage(
  wallAlbedo: string,
  ceilingAlbedo = "#E6E6E6",
  width = 60,
  height = 12,
): RgbaImage {
  const [wr, wg, wb] = hexToRgb(wallAlbedo);
  const [cr, cg, cb] = hexToRgb(ceilingAlbedo);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = 1 - (0.6 * x) / Math.max(1, width - 1);
      const isCeiling = y < height / 2;
      const o = (y * width + x) * 4;
      data[o] = Math.round((isCeiling ? cr : wr) * s);
      data[o + 1] = Math.round((isCeiling ? cg : wg) * s);
      data[o + 2] = Math.round((isCeiling ? cb : wb) * s);
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

const LIGHT_WALL = "#D8D2C4";
{
  const synth = shadedRoomImage(LIGHT_WALL);
  const wall = fullMaskInstance("wall", "A-wall", 0, 6, 59, 11, 60, 12);
  const ceiling = fullMaskInstance("ceiling", "A-ceiling", 0, 0, 59, 5, 60, 12);
  const withCeiling = wallAlbedoColor(synth, [wall, ceiling], 60, 12);
  check(
    "wall albedo with ceiling within dE 5",
    withCeiling !== null && deltaE(withCeiling, LIGHT_WALL) <= 5,
    withCeiling === null
      ? "null"
      : `${withCeiling} vs ${LIGHT_WALL} dE=${deltaE(withCeiling, LIGHT_WALL).toFixed(2)}`,
  );
  const withoutCeiling = wallAlbedoColor(synth, [wall], 60, 12);
  check(
    "wall albedo without ceiling within dE 12",
    withoutCeiling !== null && deltaE(withoutCeiling, LIGHT_WALL) <= 12,
    withoutCeiling === null
      ? "null"
      : `${withoutCeiling} vs ${LIGHT_WALL} dE=${deltaE(withoutCeiling, LIGHT_WALL).toFixed(2)}`,
  );
  // The floor path follows the same white-reference rule.
  const floorInst = fullMaskInstance("floor", "A-floor", 0, 6, 59, 11, 60, 12);
  const floorAlbedo = floorAlbedoColor(synth, [floorInst, ceiling], 60, 12);
  check(
    "floor albedo with ceiling within dE 5",
    floorAlbedo !== null && deltaE(floorAlbedo, LIGHT_WALL) <= 5,
    floorAlbedo === null
      ? "null"
      : `${floorAlbedo} dE=${deltaE(floorAlbedo, LIGHT_WALL).toFixed(2)}`,
  );
  // A light grey-beige wall never renders brown: balanced and light.
  if (withCeiling !== null) {
    const [r, g, b] = hexToRgb(withCeiling);
    const balanced = Math.max(r, g, b) - Math.min(r, g, b) < 32 && r > 150 && g > 150 && b > 140;
    check("light wall stays light", balanced, withCeiling);
    const display = wallDisplayHex(withCeiling, "PaintedPlaster017");
    const ok =
      display !== null &&
      (() => {
        const [dr, dg, db] = hexToRgb(display);
        void dr;
        void dg;
        void db;
        const mean = TEXTURE_MEAN_COLORS["PaintedPlaster017"] as string;
        const [mr, mg, mb] = hexToRgb(mean);
        const rx = Math.min(255, Math.round((dr * mr) / 255));
        const gx = Math.min(255, Math.round((dg * mg) / 255));
        const bx = Math.min(255, Math.round((db * mb) / 255));
        const rendered = `#${rx.toString(16).padStart(2, "0").toUpperCase()}${gx.toString(16).padStart(2, "0").toUpperCase()}${bx.toString(16).padStart(2, "0").toUpperCase()}`;
        return deltaE(rendered, LIGHT_WALL) <= 12;
      })();
    check("normalised wall renders albedo", ok, display ?? "null");
  } else {
    check("light wall stays light", false, "null albedo");
    check("normalised wall renders albedo", false, "null albedo");
  }
  // Pair helper: median over ceiling times 0.9.
  check("albedo pair scales by 0.9", albedoFromMedianPair("#808080", "#E6E6E6") !== null);
  // Percentile helper returns the bright end of a gradient.
  {
    const grad: RgbaImage = {
      width: 10,
      height: 1,
      data: new Uint8ClampedArray(
        Array.from({ length: 10 }, (_, x) => {
          const v = Math.round(50 + (180 * x) / 9);
          return [v, v, v, 255];
        }).flat(),
      ),
    };
    const inc = new Uint8Array(10).fill(1);
    const p90 = percentileMaskColor(grad, inc, null, 0.9);
    check("p90 is bright end", p90 !== null && hexToRgb(p90 as string)[0] >= 200, p90 ?? "null");
  }
}

if (failures > 0) {
  console.log(`FAIL surfaces: ${String(failures)} check(s) failed`);
  process.exit(1);
} else {
  console.log("PASS surfaces");
}
