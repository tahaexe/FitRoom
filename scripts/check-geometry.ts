/**
 * `npm run check:geometry` — photo-room solver checks in three tiers.
 *
 * Tier 1 (synthetic): the generator in `shared/src/photo-room/synthetic.ts`
 * projects known rooms through a pinhole camera into SAM-shaped instances
 * (sample room + two asymmetric variants, one with a sofa hiding the floor
 * line), with yaw/pitch, roll, corner noise and ragged mask edges. Bars:
 * taped walls exact, ceiling height ±3 %, every opening on the right wall
 * in the right order with offset and width ±10 cm, and a flag on every
 * injected fault.
 *
 * Tier 2 (exact renders): `.inbox/truth/` (git-ignored) holds four renders
 * of the sample room `living-420x360` (one per wall, `.jpg`), their truth
 * files (`.json`: room layout, camera pose, intrinsics scaled to the
 * 1066 x 799 image) and SAM's output texts in `sam/<room>-<view>-<concept>.txt`
 * (no stream envelope; the decoder takes them as one output-text lane):
 * decode, solve, compare with the same bars; the inbox files are copied
 * into `shared/fixtures/photo-room/` so later runs check the same fixtures.
 * Without inbox or fixtures the tier reports SKIP and passes.
 *
 * Tier 3 (smoke): `.inbox/room-photos-sam/` holds SAM's output texts for 8
 * real CC0 photos at 1280 px (`<photo>-<concept>.txt`, no truth; the photo
 * size is in each box line): it runs, prints counts and flags, never throws.
 * What the check needs is copied to `shared/fixtures/photo-room-smoke/`.
 * Without the inbox it decodes the committed SAM streams instead.
 *
 * Prints PASS/FAIL per check plus one table per room, exits non-zero on
 * any FAIL. No Meta calls, no browser.
 */

/* global console, process */
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSamOutputText } from "../server/src/meta/client.js";
import { segmentInstances } from "../shared/src/sam.js";
import {
  LETTER_TO_WALL_ID,
  SAMPLE_SYNTH_ROOM,
  VARIANT_ROOM_1,
  VARIANT_ROOM_2,
  solveRoomFromPhotos,
  validateRoomDraft,
  type PhotoInput,
  type RoomDraft,
  type SynthPhotoOpts,
  type SynthRoom,
  type WallLetter,
  synthPhoto,
} from "../shared/src/photo-room/index.js";
import { validateRoomLayout } from "../shared/src/validate.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const inboxTruth = join(repoRoot, ".inbox", "truth");
const inboxSmoke = join(repoRoot, ".inbox", "room-photos-sam");
const fixtureDir = join(repoRoot, "shared", "fixtures", "photo-room");
const smokeFixtureDir = join(repoRoot, "shared", "fixtures", "photo-room-smoke");
const streamsDir = join(repoRoot, "server", "data", "sam-streams");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function photo(
  room: SynthRoom,
  wall: WallLetter,
  opts: SynthPhotoOpts,
): PhotoInput {
  return synthPhoto(room, wall, {
    imageW: 800,
    imageH: 600,
    distFraction: 0.93,
    focal35mm: 24,
    cornerNoisePx: 1,
    raggedPx: 1.2,
    ...opts,
  });
}

interface TruthOpening {
  wall: WallLetter;
  type: "door" | "window";
  offset: number;
  width: number;
  height: number;
  sill: number;
  hinge?: string;
}

function truthOpenings(room: SynthRoom): TruthOpening[] {
  return room.openings.map((o) => ({
    wall: o.wall,
    type: o.type,
    offset: o.offset,
    width: o.width,
    height: o.height,
    sill: o.sillHeight,
    hinge: o.hinge,
  }));
}

function printRoomTable(title: string, room: SynthRoom, draft: RoomDraft): void {
  console.log(`--- ${title} (${room.width}x${room.depth}cm, ceiling truth ${String(room.height)}cm)`);
  for (const letter of ["A", "B", "C", "D"] as const) {
    const got = draft.wallLengths[letter];
    const want = letter === "A" || letter === "C" ? room.tapeA : room.tapeB;
    const err = Math.round((got.value - want) * 10) / 10;
    console.log(
      `wall ${letter} (${LETTER_TO_WALL_ID[letter]}): ${String(got.value)}cm [${got.source} ±${String(got.plusMinus)}] err ${err >= 0 ? "+" : ""}${String(err)}cm`,
    );
  }
  const cErr = Math.round((draft.ceilingHeight.value - room.height) * 10) / 10;
  const cPct = Math.round(((draft.ceilingHeight.value - room.height) / room.height) * 1000) / 10;
  console.log(
    `ceiling: ${String(draft.ceilingHeight.value)}cm [${draft.ceilingHeight.source} ±${String(draft.ceilingHeight.plusMinus)}] err ${cErr >= 0 ? "+" : ""}${String(cErr)}cm (${cPct >= 0 ? "+" : ""}${String(cPct)}%)`,
  );
  const truth = [...truthOpenings(room)].sort((a, b) =>
    a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : a.offset - b.offset,
  );
  const got = [...draft.openings].sort((a, b) =>
    a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : a.offset.value - b.offset.value,
  );
  console.log(`openings: got ${String(got.length)}, truth ${String(truth.length)}`);
  for (const o of got) {
    const same = truth.filter((t) => t.wall === o.wall && t.type === o.type);
    const near = same.length > 0
      ? same.reduce((a, b) =>
        Math.abs(b.offset - o.offset.value) < Math.abs(a.offset - o.offset.value) ? b : a,
      )
      : undefined;
    const dOff = near === undefined ? "n/a" : `${(o.offset.value - near.offset >= 0 ? "+" : "") + String(Math.round((o.offset.value - near.offset) * 10) / 10)}cm`;
    const dW = near === undefined ? "n/a" : `${(o.width.value - near.width >= 0 ? "+" : "") + String(Math.round((o.width.value - near.width) * 10) / 10)}cm`;
    console.log(
      `  ${o.wall} ${o.type} off ${String(o.offset.value)}±${String(o.offset.plusMinus)} w ${String(o.width.value)}±${String(o.width.plusMinus)} h ${String(o.height.value)} sill ${String(o.sillHeight.value)}${o.hinge === undefined ? "" : ` hinge ${o.hinge}`} | err off ${dOff} w ${dW}`,
    );
  }
  console.log(
    `flags (${String(draft.flags.length)}): ${draft.flags.map((f) => `${f.code}${f.wall === undefined ? "" : `@${f.wall}`}`).join(", ") || "none"}`,
  );
  const layoutRes = validateRoomLayout(draft.layout);
  console.log(`layout validates: ${layoutRes.ok ? "yes" : "NO — " + layoutRes.errors.map((e) => e.message).join("; ")}`);
}

/** Same bars for synthetic and exact-render tiers. Returns true when all hold. */
function checkBars(
  tag: string,
  room: SynthRoom,
  draft: RoomDraft,
  expectedFlags: string[],
): void {
  for (const letter of ["A", "B", "C", "D"] as const) {
    const want = letter === "A" || letter === "C" ? room.tapeA : room.tapeB;
    check(`${tag}: taped wall ${letter} exact`, draft.wallLengths[letter].value === want);
  }
  const cErrPct = Math.abs(draft.ceilingHeight.value - room.height) / room.height;
  check(
    `${tag}: ceiling within ±3 %`,
    cErrPct <= 0.03,
    `${String(draft.ceilingHeight.value)} vs ${String(room.height)}`,
  );
  const truth = [...truthOpenings(room)].sort((a, b) =>
    a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : a.offset - b.offset,
  );
  const got = [...draft.openings].sort((a, b) =>
    a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : a.offset.value - b.offset.value,
  );
  check(`${tag}: opening count matches`, got.length === truth.length, `got ${String(got.length)} want ${String(truth.length)}`);
  const n = Math.min(got.length, truth.length);
  for (let i = 0; i < n; i += 1) {
    const g = got[i];
    const t = truth[i];
    if (g === undefined || t === undefined) continue;
    check(`${tag}: opening ${String(i)} on the right wall`, g.wall === t.wall && g.type === t.type, `got ${g.wall}/${g.type} want ${t.wall}/${t.type}`);
    if (g.wall === t.wall && g.type === t.type) {
      check(`${tag}: opening ${String(i)} offset ±10 cm`, Math.abs(g.offset.value - t.offset) <= 10, `got ${String(g.offset.value)} want ${String(t.offset)}`);
      check(`${tag}: opening ${String(i)} width ±10 cm`, Math.abs(g.width.value - t.width) <= 10, `got ${String(g.width.value)} want ${String(t.width)}`);
    }
  }
  // Order along each wall matches truth order.
  for (const letter of ["A", "B", "C", "D"] as const) {
    const gWalls = got.filter((g) => g.wall === letter).map((g) => `${g.type}@${Math.round(g.offset.value)}`);
    const tWalls = truth.filter((t) => t.wall === letter).map((t) => `${t.type}@${t.offset}`);
    check(`${tag}: wall ${letter} order [${gWalls.join(", ")}]`, gWalls.length === tWalls.length && gWalls.every((_, i) => got.filter((g) => g.wall === letter)[i]?.type === truth.filter((t) => t.wall === letter)[i]?.type));
  }
  for (const code of expectedFlags) {
    check(`${tag}: flag on injected fault (${code})`, draft.flags.some((f) => f.code === code), draft.flags.map((f) => f.code).join(","));
  }
  const vd = validateRoomDraft(draft);
  check(`${tag}: RoomDraft validates`, vd.ok, vd.errors.join("; "));
}

function tierSynthetic(): void {
  console.log("== tier 1: synthetic ==");
  // Room 1: sample room, clean poses (yaw/pitch a few degrees, roll <= 1).
  const clean1 = [
    photo(SAMPLE_SYNTH_ROOM, "A", { yawDeg: 1.5, pitchDeg: -3, rollDeg: 1, seed: 11 }),
    photo(SAMPLE_SYNTH_ROOM, "B", { yawDeg: -1.5, pitchDeg: -4, rollDeg: -1, seed: 12 }),
    photo(SAMPLE_SYNTH_ROOM, "C", { yawDeg: 1, pitchDeg: -5, rollDeg: 0.5, seed: 13 }),
    photo(SAMPLE_SYNTH_ROOM, "D", { yawDeg: -1, pitchDeg: -3, rollDeg: -0.5, seed: 14 }),
  ];
  const d1 = solveRoomFromPhotos({ photos: clean1, tapeA: 420, tapeB: 360 });
  printRoomTable("synthetic living-420x360", SAMPLE_SYNTH_ROOM, d1);
  checkBars("synthetic living-420x360", SAMPLE_SYNTH_ROOM, d1, []);

  // Room 2: asymmetric variant; SAM splits the A wall at the doorway, a
  // sofa hides the B floor line, the door is narrow and a sill is high.
  const r2 = [
    photo(VARIANT_ROOM_1, "A", { yawDeg: 2.5, pitchDeg: -3, rollDeg: 2, seed: 21, splitWall: true }),
    photo(VARIANT_ROOM_1, "B", { yawDeg: -3, pitchDeg: -5, rollDeg: 1, seed: 22, hideFloorMiddle: 0.68 }),
    photo(VARIANT_ROOM_1, "C", { yawDeg: 3, pitchDeg: -4, rollDeg: -2, seed: 23 }),
    photo(VARIANT_ROOM_1, "D", { yawDeg: -2, pitchDeg: -3, rollDeg: 1, seed: 24 }),
  ];
  const d2 = solveRoomFromPhotos({ photos: r2, tapeA: 380, tapeB: 300 });
  printRoomTable("synthetic variant-380x300", VARIANT_ROOM_1, d2);
  checkBars("synthetic variant-380x300", VARIANT_ROOM_1, d2, ["door-width", "sill-range", "floor-hidden"]);

  // Room 3: asymmetric variant with a hinged door; faults are a cropped
  // corner, a 0.5x photo and a door leaf with no visible opening.
  const r3 = [
    photo(VARIANT_ROOM_2, "A", { yawDeg: 2, pitchDeg: -4, rollDeg: 1, seed: 31, doorLeafOnly: true }),
    photo(VARIANT_ROOM_2, "B", { yawDeg: 3, pitchDeg: -3, rollDeg: 0, seed: 32, cornerOutOfFrame: "right" }),
    photo(VARIANT_ROOM_2, "C", { yawDeg: -2, pitchDeg: -5, rollDeg: -1, seed: 33, focal35mm: 13 }),
    photo(VARIANT_ROOM_2, "D", { yawDeg: -4, pitchDeg: -2, rollDeg: 3, seed: 34 }),
  ];
  const d3 = solveRoomFromPhotos({ photos: r3, tapeA: 450, tapeB: 330 });
  printRoomTable("synthetic variant-450x330", VARIANT_ROOM_2, d3);
  // The A photo hides the doorway (leaf only): no door opening is emitted
  // for A, so count/order bars cannot hold — check the remaining bars here.
  check("synthetic variant-450x330: taped wall A exact", d3.wallLengths.A.value === 450);
  check("synthetic variant-450x330: taped wall B exact", d3.wallLengths.B.value === 330);
  check("synthetic variant-450x330: taped wall C exact", d3.wallLengths.C.value === 450);
  check("synthetic variant-450x330: taped wall D exact", d3.wallLengths.D.value === 330);
  const cErr3 = Math.abs(d3.ceilingHeight.value - VARIANT_ROOM_2.height) / VARIANT_ROOM_2.height;
  check("synthetic variant-450x330: ceiling within ±3 %", cErr3 <= 0.03, `${String(d3.ceilingHeight.value)} vs 265`);
  for (const code of ["corner-out-of-frame", "focal-wide", "tap-the-door"]) {
    check(
      `synthetic variant-450x330: flag on injected fault (${code})`,
      d3.flags.some((f) => f.code === code),
      d3.flags.map((f) => f.code).join(","),
    );
  }
  // Openings on the clean walls still meet the bars.
  for (const o of d3.openings) {
    const truth = VARIANT_ROOM_2.openings.filter((t) => t.wall === o.wall && t.type === o.type)
      .sort((a, b) => a.offset - b.offset);
    if (truth.length === 0) continue;
    const near = truth.reduce((a, b) =>
      Math.abs(b.offset - o.offset.value) < Math.abs(a.offset - o.offset.value) ? b : a,
    );
    check(`synthetic variant-450x330: ${o.wall}/${o.type} offset ±10 cm`, Math.abs(o.offset.value - near.offset) <= 10, `got ${String(o.offset.value)} want ${String(near.offset)}`);
    check(`synthetic variant-450x330: ${o.wall}/${o.type} width ±10 cm`, Math.abs(o.width.value - near.width) <= 10, `got ${String(o.width.value)} want ${String(near.width)}`);
  }
  const vd3 = validateRoomDraft(d3);
  check("synthetic variant-450x330: RoomDraft validates", vd3.ok, vd3.errors.join("; "));
}

/** Truth file schema in `.inbox/truth/` (and copied fixtures). */
interface ExactTruth {
  room: {
    walls: Array<[string, [number, number], [number, number], number]>;
    openings: Array<[string, string, string, number, number, number, number]>;
  };
  width: number;
  height: number;
  fx: number;
  fy: number;
  yawDeg: number;
}

/** View suffix -> wall letter (camyaw is clockwise from north). */
const VIEW_LETTER: Record<string, WallLetter> = { n: "C", s: "A", e: "D", w: "B" };

function exactRoom(roomId: string, room: ExactTruth["room"]): SynthRoom {
  const len = (id: string): number => {
    const w = room.walls.find((e) => e[0] === id);
    if (w === undefined) return 0;
    return Math.hypot(w[2][0] - w[1][0], w[2][1] - w[1][1]);
  };
  return {
    id: roomId,
    width: len("wall-1"),
    depth: len("wall-2"),
    height: room.walls[0]?.[3] ?? 260,
    tapeA: len("wall-1"),
    tapeB: len("wall-2"),
    openings: room.openings.map((o) => ({
      type: o[1] as "door" | "window",
      wall: ({ "wall-1": "A", "wall-4": "B", "wall-3": "C", "wall-2": "D" } as const)[o[2] as string] as WallLetter,
      offset: o[3] as number,
      width: o[4] as number,
      height: o[5] as number,
      sillHeight: o[6] as number,
      hinge: "left" as const,
    })),
  };
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function copyIntoRepo(files: string[]): void {
  mkdirSync(fixtureDir, { recursive: true });
  for (const f of files) {
    try {
      copyFileSync(f, join(fixtureDir, basename(f)));
    } catch {
      // A copy failure must not fail the geometry bars themselves.
    }
  }
}

async function tierExact(): Promise<void> {
  console.log("== tier 2: exact renders ==");
  // Prefer the git-ignored inbox; fall back to fixtures copied from it.
  // Truth files are `<room>-<view>.json` (view n/s/e/w); SAM texts live in
  // `sam/<room>-<view>-<concept>.txt` with no stream envelope.
  const roomOf = (t: string): string => basename(t, ".json").replace(/-[nsew]$/, "");
  let base = inboxTruth;
  let files = listFiles(inboxTruth).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    files = listFiles(fixtureDir).filter((f) => f.endsWith(".json"));
    base = fixtureDir;
  }
  if (files.length === 0) {
    console.log("SKIP tier 2: no .inbox/truth and no shared/fixtures/photo-room");
    return;
  }
  const byRoom = new Map<string, string[]>();
  for (const t of files) {
    const list = byRoom.get(roomOf(t)) ?? [];
    list.push(t);
    byRoom.set(roomOf(t), list);
  }
  for (const [roomId, truths] of [...byRoom.entries()].sort()) {
    try {
      const photos: PhotoInput[] = [];
      const used: string[] = [];
      let roomJson: ExactTruth | null = null;
      for (const t of truths.sort()) {
        const raw = JSON.parse(readFileSync(join(base, t), "utf8")) as ExactTruth;
        roomJson = raw;
        used.push(join(base, t));
        const view = basename(t, ".json").slice(-1);
        const letter = VIEW_LETTER[view];
        if (letter === undefined) continue;
        const prefix = basename(t, ".json");
        const samFiles = listFiles(join(base, "sam")).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".txt"));
        const flatFiles = listFiles(base).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".txt"));
        const all = [...samFiles.map((f) => join(base, "sam", f)), ...flatFiles.map((f) => join(base, f))];
        const instances = [];
        for (const f of all.sort()) {
          const concept = basename(f, ".txt").slice(prefix.length + 1);
          const text = readFileSync(f, "utf8");
          used.push(f);
          // An empty text means SAM found no instance of the concept.
          if (text.trim().length === 0) continue;
          instances.push(...(await segmentInstances(concept, text)));
        }
        const focal35mm = ((raw.fx + raw.fy) / 2) * 43.27 / Math.hypot(raw.width, raw.height);
        photos.push({ wall: letter, width: raw.width, height: raw.height, focal35mm, instances });
      }
      if (roomJson === null || photos.length === 0) continue;
      const room = exactRoom(roomId, roomJson.room);
      const draft = solveRoomFromPhotos({ photos, tapeA: room.tapeA, tapeB: room.tapeB });
      printRoomTable(`exact ${roomId}`, room, draft);
      checkBars(`exact ${roomId}`, room, draft, []);
      if (base === inboxTruth) copyIntoRepo(used);
    } catch (error) {
      check(`exact ${roomId}: decodes and solves`, false, error instanceof Error ? error.message : String(error));
    }
  }
}

async function tierSmoke(): Promise<void> {
  console.log("== tier 3: smoke ==");
  const files = listFiles(inboxSmoke).filter((f) => f.endsWith(".txt"));
  if (files.length > 0) {
    // Group by photo prefix (<photo>-<concept>.txt); the wall letter is
    // unknown without truth, so each photo solves alone as wall A.
    const byPhoto = new Map<string, Array<{ concept: string; file: string }>>();
    for (const f of files) {
      const m = f.match(/^(.*)-([^-\s]+)\.txt$/);
      if (m === null) continue;
      const photoId = m[1] as string;
      const concept = m[2] as string;
      const list = byPhoto.get(photoId) ?? [];
      list.push({ concept, file: f });
      byPhoto.set(photoId, list);
    }
    mkdirSync(smokeFixtureDir, { recursive: true });
    for (const [photoId, parts] of [...byPhoto.entries()].sort()) {
      try {
        const instances = [];
        for (const part of parts) {
          const text = readFileSync(join(inboxSmoke, part.file), "utf8");
          // An empty text means SAM found no instance of the concept.
          if (text.trim().length === 0) continue;
          instances.push(...(await segmentInstances(part.concept, text)));
          try {
            copyFileSync(join(inboxSmoke, part.file), join(smokeFixtureDir, part.file));
          } catch {
            // Copy failures never fail the smoke bars.
          }
        }
        const first = instances[0];
        const draft = solveRoomFromPhotos({
          photos: [{
            wall: "A",
            width: first?.imageWidth ?? 1280,
            height: first?.imageHeight ?? 960,
            instances,
          }],
          tapeA: 420,
          tapeB: 360,
        });
        console.log(
          `smoke ${photoId}: ${String(instances.length)} instances, ${String(draft.openings.length)} openings, flags [${draft.flags.map((f) => f.code).join(", ") || "none"}]`,
        );
        const vd = validateRoomDraft(draft);
        check(`smoke ${photoId}: runs and validates`, vd.ok, vd.errors.join("; "));
      } catch (error) {
        check(`smoke ${photoId}: never throws`, false, error instanceof Error ? error.message : String(error));
      }
    }
    return;
  }
  // No inbox: decode the committed SAM streams and run the solver over one
  // real segmented photo (counts + flags, never throws).
  const streams = listFiles(streamsDir).filter((f) => f.endsWith(".sse"));
  if (streams.length === 0) {
    console.log("SKIP tier 3: no .inbox/room-photos-sam and no committed streams");
    return;
  }
  for (const s of streams) {
    try {
      const raw = readFileSync(join(streamsDir, s), "utf8");
      const text = extractSamOutputText(raw);
      const concept = s.endsWith("-door.sse") ? "door" : s.endsWith("-window.sse") ? "window" : "wall";
      const instances = await segmentInstances(concept, text);
      console.log(`smoke stream ${s}: ${String(instances.length)} ${concept} instances`);
      check(`smoke stream ${s}: decodes`, instances.length > 0);
    } catch (error) {
      check(`smoke stream ${s}: never throws`, false, error instanceof Error ? error.message : String(error));
    }
  }
  try {
    const texts = new Map<string, string>();
    for (const s of streams) {
      const raw = readFileSync(join(streamsDir, s), "utf8");
      texts.set(s, extractSamOutputText(raw));
    }
    const doorText = texts.get("apartment-hotel-nice-1280-door.sse") ?? "";
    const windowText = texts.get("apartment-hotel-nice-1280-window.sse") ?? "";
    const instances = [
      ...(await segmentInstances("door", doorText)),
      ...(await segmentInstances("window", windowText)),
    ];
    const first = instances[0];
    if (first !== undefined) {
      const draft = solveRoomFromPhotos({
        photos: [{ wall: "A", width: first.imageWidth, height: first.imageHeight, instances }],
        tapeA: 400,
        tapeB: 350,
      });
      console.log(
        `smoke apartment-hotel-nice-1280: ${String(instances.length)} instances, ${String(draft.openings.length)} openings, flags [${draft.flags.map((f) => f.code).join(", ") || "none"}]`,
      );
    }
    check("smoke committed streams: solver never throws", true);
  } catch (error) {
    check("smoke committed streams: solver never throws", false, error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  tierSynthetic();
  await tierExact();
  await tierSmoke();
  console.log(
    failures === 0
      ? "check:geometry: all checks passed"
      : `check:geometry: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`check:geometry: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

