/**
 * `npm run check:light-maps` — light surface maps + environment (no browser,
 * no Meta calls).
 *
 * - the floor loader (`client/src/stage.ts`) and the wall loader
 *   (`dressWalls` in `client/src/main.ts`) build every map file name in one
 *   place (`client/src/surface-maps.ts`): no baked-in `_Color` /
 *   `_NormalGL` / `_Roughness` / `lebombo_1k.hdr` literals remain in either
 *   loader, and the stage uses the shared `HDRI_URL`;
 * - every finish the swatches offer (`FLOOR_FINISHES` / `WALL_FINISHES` in
 *   shared, plus the loader id lists in source) has its colour, normal and
 *   roughness files on disk;
 * - every map file the loaders can name exists and is at most 300 KB;
 * - normal maps are at most 512 px on each side (read from the JPEG SOF
 *   header, no new dependency);
 * - the environment map is at most 500 KB and 512x256 (read from the HDR
 *   resolution line);
 * - the first room's environment, floor and wall maps together (the sample
 *   room's `oak-light` floor renders as WoodFloor039, its `warm-white`
 *   wall as PaintedPlaster017; the wall loader requests colour + normal)
 *   are at most 1.5 MB.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FLOOR_FINISHES, WALL_FINISHES } from "../shared/src/photo-room/surfaces.js";
import { HDRI_URL, surfaceMapFiles } from "../client/src/surface-maps.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const clientDir = join(repoRoot, "client");
const srcDir = join(clientDir, "src");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function src(relative: string): string {
  return readFileSync(join(srcDir, relative), "utf8");
}

function diskFile(url: string): string {
  return join(clientDir, "public", url);
}

// ---- File names built in one place ----
const stageSource = src("stage.ts");
const mainSource = src("main.ts");
for (const literal of ["_Color.jpg", "_Color.webp", "_NormalGL", "_Roughness", "lebombo_1k.hdr"]) {
  check(
    `single-source:stage-avoids-${literal}`,
    !stageSource.includes(literal),
    `stage.ts still names ${literal} itself`,
  );
}
check(
  "single-source:stage-env",
  stageSource.includes("HDRI_URL"),
  "stage must use the shared HDRI_URL",
);
const dressStart = mainSource.indexOf("function dressWalls(");
const dressEnd = mainSource.indexOf("}", mainSource.indexOf("WALL_MATERIAL.needsUpdate = true;"));
const dress =
  dressStart >= 0 && dressEnd > dressStart ? mainSource.slice(dressStart, dressEnd) : "";
for (const literal of ["_Color.jpg", "_Color.webp", "_NormalGL", "_Roughness"]) {
  check(
    `single-source:walls-avoid-${literal}`,
    !dress.includes(literal),
    `dressWalls still names ${literal} itself`,
  );
}
check(
  "single-source:walls-helper",
  dress.includes("surfaceMapFiles("),
  "dressWalls must build names through surfaceMapFiles",
);

// ---- Every swatch finish has files on disk ----
function idsFromList(source: string, name: string): string[] {
  const at = source.indexOf(name);
  if (at < 0) return [];
  const open = source.indexOf("[", at);
  const close = source.indexOf("]", open);
  if (open < 0 || close < 0) return [];
  return [...source.slice(open, close).matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1] as string);
}

const loaderFloorIds = idsFromList(stageSource, "FLOOR_TEXTURE_IDS");
const loaderWallIds = idsFromList(mainSource, "WALL_TEXTURE_IDS");
check("loader-floor-ids", loaderFloorIds.length > 0, "no FLOOR_TEXTURE_IDS in stage.ts");
check("loader-wall-ids", loaderWallIds.length > 0, "no WALL_TEXTURE_IDS in main.ts");
const swatchIds = new Set<string>([...FLOOR_FINISHES, ...WALL_FINISHES]);
for (const id of [...loaderFloorIds, ...loaderWallIds]) {
  check(`swatch-offers-${id}`, swatchIds.has(id), `${id} is loadable but not offered`);
}

const finishIds = [
  ...new Set([...FLOOR_FINISHES, ...WALL_FINISHES, ...loaderFloorIds, ...loaderWallIds]),
];
const loaderFiles: string[] = [];
for (const id of finishIds) {
  const files = surfaceMapFiles(id);
  for (const url of [files.colorUrl, files.normalUrl, files.roughnessUrl]) {
    loaderFiles.push(url);
    let size: number | null;
    try {
      size = statSync(diskFile(url)).size;
    } catch {
      size = null;
    }
    check(`map-exists:${id}/${url.split("_").pop()}`, size !== null, `missing ${url}`);
    if (size !== null) {
      check(
        `map-bytes:${id}/${url.split("_").pop()}`,
        size <= 300 * 1024,
        `${url} is ${String(size)} bytes`,
      );
    }
  }
}

// ---- Normal maps at most 512 px (JPEG SOF header) ----
function jpegSize(bytes: Buffer): { w: number; h: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 < bytes.length) {
    if (bytes[pos] !== 0xff) return null;
    const marker = bytes[pos + 1] as number;
    const len = bytes.readUInt16BE(pos + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
      return { h: bytes.readUInt16BE(pos + 5), w: bytes.readUInt16BE(pos + 7) };
    }
    pos += 2 + len;
  }
  return null;
}

for (const id of finishIds) {
  const url = surfaceMapFiles(id).normalUrl;
  const size = jpegSize(readFileSync(diskFile(url)));
  check(
    `normal-512:${id}`,
    size !== null && size.w <= 512 && size.h <= 512,
    size === null ? `unreadable JPEG ${url}` : `${url} is ${String(size.w)}x${String(size.h)}`,
  );
}

// ---- Environment map at most 500 KB and 512x256 ----
const envFile = diskFile(HDRI_URL);
let envBytes: number | null;
try {
  envBytes = statSync(envFile).size;
} catch {
  envBytes = null;
}
check("env-exists", envBytes !== null, `missing ${HDRI_URL}`);
if (envBytes !== null) {
  check("env-bytes", envBytes <= 500 * 1024, `${HDRI_URL} is ${String(envBytes)} bytes`);
  const bytes = readFileSync(envFile);
  const headEnd = bytes.indexOf("\n\n");
  const resLine = headEnd >= 0 ? bytes.subarray(headEnd + 2, headEnd + 42).toString("latin1") : "";
  const res = resLine.match(/-Y (\d+) \+X (\d+)/);
  check(
    "env-size",
    res !== null && Number(res[1]) <= 256 && Number(res[2]) <= 512,
    res === null ? "unreadable HDR resolution" : resLine.split("\n")[0],
  );
}

// ---- First room: environment + floor + wall maps at most 1.5 MB ----
const firstRoomUrls = [
  HDRI_URL,
  surfaceMapFiles("WoodFloor039").colorUrl,
  surfaceMapFiles("WoodFloor039").normalUrl,
  surfaceMapFiles("WoodFloor039").roughnessUrl,
  surfaceMapFiles("PaintedPlaster017").colorUrl,
  surfaceMapFiles("PaintedPlaster017").normalUrl,
];
let firstRoomBytes = 0;
let firstRoomMissing = "";
for (const url of firstRoomUrls) {
  try {
    firstRoomBytes += statSync(diskFile(url)).size;
  } catch {
    firstRoomMissing = url;
  }
}
check(
  "first-room-maps-present",
  firstRoomMissing === "",
  firstRoomMissing === "" ? undefined : `missing ${firstRoomMissing}`,
);
check(
  "first-room-maps-bytes",
  firstRoomBytes <= 1.5 * 1024 * 1024,
  `${String(firstRoomBytes)} bytes for ${firstRoomUrls.join(", ")}`,
);
console.log(`first-room maps total: ${String(firstRoomBytes)} bytes`);

if (failures > 0) {
  console.log(`FAIL light-maps: ${String(failures)} check(s) failed`);
  process.exit(1);
} else {
  console.log("PASS light-maps");
}
