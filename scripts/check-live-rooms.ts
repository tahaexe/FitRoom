/**
 * `npm run check:live-rooms` — live room-photo fixture checks (headless, no
 * Meta calls, no browser).
 *
 * Fixtures in `shared/fixtures/photo-room-live/` are the SAM output texts the
 * live photo flow recorded (`.tmp/live-record/`, one file per photo and
 * concept; an empty file means SAM found no instance of the concept). Bars:
 *
 * - market-house's floor comes from `carpet` (the floor answer is empty, the
 *   carpet answer decodes as floor instances);
 * - market-house's wall A has no window under 40 cm;
 * - zaher-rio's wall A has no window wider than 80 % of the wall;
 * - hostel's `floor` and `carpet` are both empty and the card is the retake
 *   copy (`NO_FLOOR_MESSAGE`, retake-only), while the own-size SAM inbox
 *   recording has a floor;
 * - carlos-orig's `floor` and `carpet` are both empty, so the flow owes one
 *   more `floor` call at up to 1920 px (`needsFloorSecondTry` true with a
 *   larger photo, false otherwise; the cache key hashes the image so the
 *   size is in the key), shown with a larger decoded frame; carlos at 1280
 *   already finds a floor;
 * - ceborski flags `two-walls-in-view` (and not `edge-at-door`);
 * - carlos flags `edge-at-door` (and not `two-walls-in-view`);
 * - carlos's wall tint keeps its hue (Lab a* and b* within 4 of the lit-wall
 *   median; needs the inbox JPEG, otherwise SKIP);
 * - the fixture SOURCES.md names each photo's author, licence and source.
 *
 * Prints PASS/FAIL/SKIP per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { segmentInstances } from "../shared/src/sam.js";
import { solveRoomFromPhotos } from "../shared/src/photo-room/index.js";
import {
  conceptMask,
  litMedianMaskColor,
  wallAlbedoColor,
  type RgbaImage,
} from "../shared/src/photo-room/surfaces.js";
import {
  FALLBACK_DECODE_CONCEPT,
  FLOOR_FALLBACK_CONCEPT,
  FLOOR_SECOND_TRY_CONCEPT,
  NO_FLOOR_MESSAGE,
  errorRecovery,
  isEmptyAnswerText,
  needsFloorSecondTry,
} from "../client/src/photo-room/cards.js";
import { computePhotoPlan } from "../client/src/photo-room/intake.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const fixtureDir = join(repoRoot, "shared", "fixtures", "photo-room-live");
const inboxDir = join(repoRoot, ".inbox", "room-photos-live");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function skip(name: string, detail?: string): void {
  console.log(`SKIP ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

function textOf(photoId: string, concept: string): string {
  try {
    return readFileSync(join(fixtureDir, `${photoId}-${concept}.txt`), "utf8");
  } catch {
    return "";
  }
}

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

async function solveLive(photoId: string): Promise<ReturnType<typeof solveRoomFromPhotos>> {
  const concepts = ["wall", "floor", "ceiling", "door", "window"];
  const instances: Awaited<ReturnType<typeof segmentInstances>> = [];
  for (const concept of concepts) {
    const text = textOf(photoId, concept);
    if (text.trim().length === 0) continue;
    instances.push(...(await segmentInstances(concept, text)));
  }
  // The one-shot floor fallback: carpet decodes as floor.
  const carpet = textOf(photoId, FLOOR_FALLBACK_CONCEPT);
  if (carpet.trim().length > 0) {
    instances.push(...(await segmentInstances(FALLBACK_DECODE_CONCEPT, carpet)));
  }
  const first = instances[0];
  return solveRoomFromPhotos({
    photos: [
      {
        wall: "A",
        width: first?.imageWidth ?? 1280,
        height: first?.imageHeight ?? 960,
        instances,
      },
    ],
    tapeA: 420,
    tapeB: 360,
  });
}

async function main(): Promise<void> {
  console.log("== live rooms ==");
  // The floor fallback contract lives in the card module.
  check("the fallback asks the carpet concept", FLOOR_FALLBACK_CONCEPT === "carpet");
  check("the fallback decodes as floor", FALLBACK_DECODE_CONCEPT === "floor");

  // Market-house: the floor answer is empty, the carpet answer is the floor.
  const marketFloor = textOf("market-house-reading-room", "floor");
  const marketCarpet = textOf("market-house-reading-room", FLOOR_FALLBACK_CONCEPT);
  check("market-house floor answer is empty", isEmptyAnswerText(marketFloor));
  check("market-house carpet answer is not empty", !isEmptyAnswerText(marketCarpet));
  const marketFloorInstances = isEmptyAnswerText(marketCarpet)
    ? []
    : await segmentInstances(FALLBACK_DECODE_CONCEPT, marketCarpet);
  check(
    "market-house floor comes from carpet",
    marketFloorInstances.length > 0,
    `${String(marketFloorInstances.length)} floor instances`,
  );

  // Hostel: floor and carpet are both empty, so the card is the retake copy.
  const hostelFloor = textOf("hostel-twin-room-wardrobe", "floor");
  const hostelCarpet = textOf("hostel-twin-room-wardrobe", FLOOR_FALLBACK_CONCEPT);
  check("hostel floor answer is empty", isEmptyAnswerText(hostelFloor));
  check("hostel carpet answer is empty", isEmptyAnswerText(hostelCarpet));
  check(
    "hostel card is the retake copy",
    NO_FLOOR_MESSAGE ===
      "We couldn't find the floor. Get the floor in front of the wall in view and well lit, then retake.",
    NO_FLOOR_MESSAGE,
  );
  check("hostel card offers no retry", errorRecovery(NO_FLOOR_MESSAGE) === "retake");
  try {
    const samFloor = readFileSync(
      join(repoRoot, ".inbox", "room-photos-sam", "hostel-twin-room-wardrobe-floor.txt"),
      "utf8",
    );
    const ownSize = samFloor.trim().length === 0 ? [] : await segmentInstances("floor", samFloor);
    check(
      "hostel gets a floor from its own-size recording",
      ownSize.length > 0,
      `${String(ownSize.length)} floor instances at ${String(ownSize[0]?.imageWidth ?? 0)}x${String(ownSize[0]?.imageHeight ?? 0)}`,
    );
  } catch {
    check("hostel gets a floor from its own-size recording", false, "no sam inbox floor");
  }

  // Market-house wall A: no window under 40 cm.
  const marketDraft = await solveLive("market-house-reading-room");
  const marketWindows = marketDraft.openings.filter((o) => o.type === "window" && o.wall === "A");
  check(
    "market-house wall A has no window under 40 cm",
    marketWindows.every((o) => o.width.value >= 40),
    `${String(marketWindows.length)} windows [${marketWindows.map((o) => `${String(Math.round(o.width.value))}@${String(Math.round(o.offset.value))}`).join(", ")}]`,
  );

  // Zaher-rio wall A: no window wider than 80 % of the wall.
  const zaherDraft = await solveLive("living-room-zaher-rio");
  const zaherWallLen = zaherDraft.wallLengths.A.value;
  const zaherWindows = zaherDraft.openings.filter((o) => o.type === "window" && o.wall === "A");
  check(
    "zaher-rio wall A has no window wider than 80 % of the wall",
    zaherWindows.every((o) => o.width.value <= 0.8 * zaherWallLen),
    `${String(zaherWindows.length)} windows wall ${String(Math.round(zaherWallLen))} [${zaherWindows.map((o) => `${String(Math.round(o.width.value))}@${String(Math.round(o.offset.value))}`).join(", ")}]`,
  );

  // Carlos-orig: both 1280-orig answers empty, so one more floor call at 1920 px.
  const origFloor = textOf("living-room-carlos-zgz-orig", "floor");
  const origCarpet = textOf("living-room-carlos-zgz-orig", FLOOR_FALLBACK_CONCEPT);
  check("carlos-orig floor answer is empty", isEmptyAnswerText(origFloor));
  check("carlos-orig carpet answer is empty", isEmptyAnswerText(origCarpet));
  check("the second try re-asks the floor concept", FLOOR_SECOND_TRY_CONCEPT === "floor");
  check(
    "carlos-orig owes a 1920 px floor second try",
    needsFloorSecondTry(true, true, true) &&
      !needsFloorSecondTry(false, true, true) &&
      !needsFloorSecondTry(true, false, true) &&
      !needsFloorSecondTry(true, true, false),
    `predicate ${String(needsFloorSecondTry(isEmptyAnswerText(origFloor), isEmptyAnswerText(origCarpet), true))}`,
  );
  const largePlan = computePhotoPlan(1920, 1280, 1);
  check(
    "the second try decodes a larger frame",
    largePlan.hasLarge && largePlan.largeWidth === 1920 && largePlan.largeHeight === 1280,
    `${String(largePlan.largeWidth)}x${String(largePlan.largeHeight)}`,
  );
  const carlosFloor = textOf("living-room-carlos-zgz", "floor");
  check(
    "carlos finds a floor at 1280 or on the second try",
    !isEmptyAnswerText(carlosFloor) ||
      needsFloorSecondTry(isEmptyAnswerText(origFloor), isEmptyAnswerText(origCarpet), true),
    `1280 floor empty=${String(isEmptyAnswerText(carlosFloor))}`,
  );

  // Ceborski sees two walls in one frame; carlos ends at a door's jamb.
  const ceborski = await solveLive("living-room-unsplash-ceborski");
  check(
    "ceborski flags two-walls-in-view",
    ceborski.flags.some((f) => f.code === "two-walls-in-view"),
    ceborski.flags.map((f) => f.code).join(",") || "no flags",
  );
  check(
    "ceborski does not flag edge-at-door",
    !ceborski.flags.some((f) => f.code === "edge-at-door"),
    ceborski.flags.map((f) => f.code).join(",") || "no flags",
  );
  const carlos = await solveLive("living-room-carlos-zgz");
  check(
    "carlos flags edge-at-door",
    carlos.flags.some((f) => f.code === "edge-at-door"),
    carlos.flags.map((f) => f.code).join(",") || "no flags",
  );
  check(
    "carlos does not flag two-walls-in-view",
    !carlos.flags.some((f) => f.code === "two-walls-in-view"),
    carlos.flags.map((f) => f.code).join(",") || "no flags",
  );

  // Carlos's tint keeps its hue: a* and b* within 4 of the lit-wall median.
  const carlosJpg = join(inboxDir, "living-room-carlos-zgz-1280.jpg");
  if (!existsSync(carlosJpg)) {
    skip("carlos tint keeps its hue", "no inbox JPEG");
  } else {
    try {
      const { default: sharp } = await import("sharp");
      const wallText = textOf("living-room-carlos-zgz", "wall");
      const wallInstances = await segmentInstances("wall", wallText);
      const meta = await sharp(carlosJpg).metadata();
      const width = meta.width ?? 1280;
      const height = meta.height ?? 857;
      const raw = await sharp(carlosJpg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const { data, info } = raw;
      const rgba = new Uint8ClampedArray(info.width * info.height * 4);
      for (let i = 0; i < info.width * info.height; i += 1) {
        rgba[i * 4] = data[i * 3] ?? 0;
        rgba[i * 4 + 1] = data[i * 3 + 1] ?? 0;
        rgba[i * 4 + 2] = data[i * 3 + 2] ?? 0;
        rgba[i * 4 + 3] = 255;
      }
      const image: RgbaImage = { width: info.width, height: info.height, data: rgba };
      void width;
      void height;
      const tint = wallAlbedoColor(image, wallInstances, info.width, info.height);
      const lit = litMedianMaskColor(
        image,
        conceptMask(wallInstances, "wall", info.width, info.height),
      );
      if (tint === null || lit === null) {
        check("carlos tint keeps its hue", false, `tint ${tint ?? "null"} lit ${lit ?? "null"}`);
      } else {
        const [, ta, tb] = hexToLab(tint);
        const [, la, lb] = hexToLab(lit);
        check(
          "carlos tint keeps a*",
          Math.abs(ta - la) <= 4,
          `${tint} a*=${ta.toFixed(2)} vs ${lit} a*=${la.toFixed(2)}`,
        );
        check(
          "carlos tint keeps b*",
          Math.abs(tb - lb) <= 4,
          `${tint} b*=${tb.toFixed(2)} vs ${lit} b*=${lb.toFixed(2)}`,
        );
      }
    } catch (error) {
      check(
        "carlos tint keeps its hue",
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // SOURCES.md names each photo's author, licence and source.
  let sources = "";
  try {
    sources = readFileSync(join(fixtureDir, "SOURCES.md"), "utf8");
  } catch {
    // Missing SOURCES.md fails the checks below.
  }
  for (const [prefix, author] of [
    ["hostel-twin-room-wardrobe", "Profpcde"],
    ["market-house-reading-room", "Andy Li"],
    ["living-room-unsplash-ceborski", "Ceborski"],
    ["living-room-carlos-zgz", "Carlos ZGZ"],
    ["living-room-zaher-rio", "Wilfredor"],
    ["living-room-carlos-zgz-orig", "Carlos ZGZ"],
  ] as const) {
    check(
      `sources name ${prefix}`,
      sources.includes(prefix) && sources.includes(author) && sources.includes("CC0-1.0"),
      prefix,
    );
  }

  console.log(
    failures === 0
      ? "check:live-rooms: all checks passed"
      : `check:live-rooms: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`check:live-rooms: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
