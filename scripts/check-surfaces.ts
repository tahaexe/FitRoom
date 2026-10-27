/**
 * `npm run check:surfaces` — photo-built room finishes, headless.
 *
 * - the median colour of a synthetic mask over a two-colour image is right
 *   and ignores the masked-out window;
 * - each floor family maps to a texture that exists on disk
 *   (`client/public/assets/textures/ambientcg/<id>/`);
 * - `other` (and no label) falls back to the sample room's floor.
 *
 * Prints PASS/FAIL per check, exits non-zero on any FAIL. No Meta calls.
 */

/* global console, process */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blendWallTints,
  CARPET_FLOORS,
  CONCRETE_FLOORS,
  medianMaskColor,
  pickFloorTexture,
  pickWallTexture,
  SAMPLE_FLOOR_SURFACE,
  TILE_FLOORS,
  WOOD_FLOORS,
} from "../shared/src/photo-room/surfaces.js";

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
  (CARPET_FLOORS as readonly string[]).includes(pickFloorTexture("carpet", "#8B8D90")),
);
check(
  "concrete maps to Concrete034",
  pickFloorTexture("concrete", "#9B9B9B") === (CONCRETE_FLOORS[0] as string),
);

// Wood closest-by-colour: a pale grey median picks the palest wood.
check("wood closest by colour", pickFloorTexture("wood", "#CFCFCF") === "WoodFloor064");

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

if (failures > 0) {
  console.log(`FAIL surfaces: ${String(failures)} check(s) failed`);
  process.exit(1);
} else {
  console.log("PASS surfaces");
}
