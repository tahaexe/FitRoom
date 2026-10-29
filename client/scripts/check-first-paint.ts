/**
 * `npm run check:first-paint` — the setup screen's sample card paints first
 * (no browser, no Meta calls).
 *
 * - the built `client/dist/index.html` preloads the card-sized sample image
 *   with `fetchpriority="high"`, on the same URL the card's `img` uses, so
 *   it downloads once;
 * - the card file is WebP, at most 640 px wide (read from its own header,
 *   no new dependency) and at most 60 KB;
 * - the setup card's `img` names that file with `fetchpriority="high"` and
 *   its width and height;
 * - the stage's loads (`setupStage`, the floor and wall maps, the model
 *   loads via `syncInstances`) run only from the after-first-paint step:
 *   the constructor schedules them there on a first visit and starts them
 *   at once on a returning visit.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..");
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

const CARD_URL = "assets/sample-room-640.webp";

// ---- Built page preloads the card image, high priority, one URL ----
const distHtml = readFileSync(join(clientDir, "dist", "index.html"), "utf8");
const preloadMatch = distHtml.match(/<link\b[^>]*rel="preload"[^>]*>/g) ?? [];
const cardPreloads = preloadMatch.filter(
  (tag) =>
    tag.includes(CARD_URL) && tag.includes('as="image"') && tag.includes('fetchpriority="high"'),
);
check(
  "first-paint:dist-preloads-card",
  cardPreloads.length === 1,
  `expected one preload for ${CARD_URL}, found ${String(cardPreloads.length)}`,
);

// ---- Card file: WebP, width from its header, size on disk ----
const cardBytes = readFileSync(join(clientDir, "public", CARD_URL));
check(
  "first-paint:card-is-webp",
  cardBytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    cardBytes.subarray(8, 12).toString("latin1") === "WEBP",
  "missing RIFF/WEBP magic",
);

function webpWidth(bytes: Buffer): number | null {
  const fourcc = bytes.subarray(12, 16).toString("latin1");
  if (fourcc === "VP8 ") {
    // Lossy bitstream: frame tag (3) + start code (3), then u16 width/height.
    return bytes.readUInt16LE(26) & 0x3fff;
  }
  if (fourcc === "VP8L") {
    // Lossless bitstream: 0x2f then packed 14-bit (width - 1).
    const bits = bytes.readUInt32LE(21);
    return (bits & 0x3fff) + 1;
  }
  if (fourcc === "VP8X") {
    // Extended: 24-bit (width - 1) at offset 24.
    return bytes.readUIntLE(24, 3) + 1;
  }
  return null;
}

const cardWidth = webpWidth(cardBytes);
check(
  "first-paint:card-width",
  cardWidth !== null && cardWidth <= 640,
  cardWidth === null ? "unreadable WebP header" : `width ${String(cardWidth)}`,
);
const cardDiskBytes = statSync(join(clientDir, "public", CARD_URL)).size;
check("first-paint:card-bytes", cardDiskBytes <= 60 * 1024, `${String(cardDiskBytes)} bytes`);

// ---- Setup card's img names the file, high priority, sized ----
const firstOpenSource = src("first-open.ts");
check(
  "first-paint:card-img",
  firstOpenSource.includes(`img.src = "${CARD_URL}"`) &&
    firstOpenSource.includes('setAttribute("fetchpriority", "high")') &&
    firstOpenSource.includes('setAttribute("width", "640")') &&
    firstOpenSource.includes('setAttribute("height", "427")'),
  "card img must name the card file with fetchpriority high plus width/height",
);

// ---- Preload and card resolve to one URL ----
const distHref = cardPreloads.length === 1 ? cardPreloads[0].match(/href="([^"]+)"/)?.[1] : null;
check(
  "first-paint:one-url",
  distHref === CARD_URL,
  distHref === null ? "no card preload href" : `preload href ${distHref}`,
);

// ---- Stage loads run only from the after-first-paint step ----
const mainSource = src("main.ts");
const ctorStart = mainSource.indexOf("constructor(container: HTMLElement)");
const ctorEnd = mainSource.indexOf("\n  private afterFirstPaint(");
const ctor = mainSource.slice(ctorStart, ctorEnd);
check(
  "first-paint:deferred-in-constructor",
  ctor.includes("afterFirstPaint(() => this.startStageLoads())") &&
    ctor.includes("} else {") &&
    ctor.includes("this.startStageLoads();"),
  "constructor must schedule startStageLoads after first paint on setup, at once otherwise",
);
for (const call of ["setupStage(", "makeFloorMaterial(", "dressWalls("]) {
  check(
    `first-paint:ctor-avoids-${call.replace("(", "")}`,
    !ctor.includes(call),
    `constructor calls ${call} before the card paints`,
  );
}
check(
  "first-paint:ctor-avoids-initial-sync",
  !ctor.includes("\n    void this.syncInstances();"),
  "constructor starts model loads before the card paints",
);
const stageStart = mainSource.indexOf("private startStageLoads()");
const stageEnd = mainSource.indexOf("/** Queue a single frame unless one is already queued. */");
const stageStep = mainSource.slice(stageStart, stageEnd);
for (const call of ["setupStage(", "makeFloorMaterial(", "dressWalls(", "syncInstances("]) {
  check(
    `first-paint:stage-loads-${call.replace("(", "")}`,
    stageStep.includes(call),
    `after-first-paint step never calls ${call}`,
  );
}
const paintStart = mainSource.indexOf("private afterFirstPaint(");
const paintStep = mainSource.slice(paintStart, stageStart);
check(
  "first-paint:after-first-paint",
  paintStep.includes("requestAnimationFrame") &&
    paintStep.includes("decode(") &&
    paintStep.includes("setTimeout"),
  "after-first-paint must wait two frames or the card decode, with a short time-out",
);
const loadModelCalls = mainSource.split("loadModel(").length - 1;
check(
  "first-paint:models-via-sync",
  loadModelCalls === 1,
  `expected the single syncer loadModel call, found ${String(loadModelCalls)}`,
);

// ---- Walls start empty: no definite assignment, frames before loads are safe ----
check(
  "first-paint:no-bang-walls",
  !mainSource.includes("private roomWalls!") && !mainSource.includes("private wallEntries!"),
  "roomWalls and wallEntries must start empty without a ! assertion",
);
const dollStart = mainSource.indexOf("private updateDollhouse(");
const dollEnd = mainSource.indexOf("\n  private updateTag(");
const doll = dollStart >= 0 && dollEnd > dollStart ? mainSource.slice(dollStart, dollEnd) : "";
const frameStart = mainSource.indexOf("private frame(");
const frameStep = frameStart >= 0 ? mainSource.slice(frameStart, frameStart + 3000) : "";
check(
  "first-paint:empty-walls",
  doll.includes("this.wallEntries.length === 0") ||
    frameStep.includes("this.wallEntries.length === 0"),
  "updateDollhouse (or frame) must handle empty walls",
);

// ---- Loads start two frames after the decode settles or the time-out ----
const decodeAt = paintStep.indexOf("decode()");
const thenAt = paintStep.indexOf(".then(");
const catchAt = paintStep.indexOf(".catch(");
const thenSlice = thenAt >= 0 ? paintStep.slice(thenAt, thenAt + 500) : "";
const catchSlice = catchAt >= 0 ? paintStep.slice(catchAt, catchAt + 500) : "";
check(
  "first-paint:decode-then-frames",
  decodeAt >= 0 &&
    thenAt > decodeAt &&
    catchAt > thenAt &&
    thenSlice.includes("requestAnimationFrame") &&
    catchSlice.includes("requestAnimationFrame") &&
    paintStep.includes("1500") &&
    paintStep.split("requestAnimationFrame").length - 1 >= 2,
  "stage loads must start two frames after decode settles or the 1500ms time-out",
);

if (failures > 0) process.exit(1);
console.log("first-paint ok: the card paints first, the stage loads after");
