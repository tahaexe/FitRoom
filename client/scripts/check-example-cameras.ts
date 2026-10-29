/**
 * `npm run check:example-cameras` — the example room keeps its wall-photo
 * records, and drops them when the photo no longer matches. Headless
 * (no browser, no Meta calls).
 *
 * - `finishBuild` saves one record per wall (wall id and letter, the
 *   current corners from the editor session, focalPx, the session's own
 *   image size) before the session drops, only for the example room; a
 *   live photo room clears instead (it keeps nothing).
 * - Leaving photos-room drops the records: `openPhotoDraft`,
 *   `buildRoomAtSize`, `pickRoom` / `resetDemoRoom` leaving photos-room,
 *   and a shared layout opened over the photo room.
 * - A plan-editor edit that changes the example room's walls drops them
 *   (`onCommitted` compares the stored walls signature).
 * - The record's size is the session's own 1280 × 951 (never the 960
 *   open-draft fallback): pure builder test plus source bars.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLE_SEG_SIZE } from "../src/photo-room/example.js";
import {
  buildExamplePhotoRecords,
  exampleWallsSignature,
  sameExampleWalls,
} from "../src/photo-room/example-cameras.js";
import type { PhotoSession } from "../src/editor/editor-store.js";

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

const main = src("main.ts");
const cameras = src("photo-room/example-cameras.ts");

// ---- The example frame is 1280 × 951 ----
check(
  "example seg size is 1280 x 951",
  EXAMPLE_SEG_SIZE.width === 1280 && EXAMPLE_SEG_SIZE.height === 951,
  `${String(EXAMPLE_SEG_SIZE.width)} x ${String(EXAMPLE_SEG_SIZE.height)}`,
);
check(
  "the builder never falls back to the 960 draft frame",
  !cameras.includes("960"),
  "example-cameras.ts must not mention 960",
);

// ---- finishBuild saves before the session drops; live keeps nothing ----
check(
  "finishBuild saves the example records before the session drops",
  main.includes("buildExamplePhotoRecords(this.editorStore?.photo") &&
    main.includes("saveExamplePhotoCameras(records, ROOM)") &&
    main.indexOf("saveExamplePhotoCameras(records, ROOM)") <
      main.indexOf("this.editorStore?.setPhoto(null);", main.indexOf("private finishBuild")),
  "main.ts finishBuild",
);
check(
  "finishBuild saves only for the example room",
  main.includes("if (isExampleRoom(ROOM.name)) {") &&
    main.includes("buildExamplePhotoRecords(this.editorStore?.photo"),
  "main.ts finishBuild isExampleRoom",
);
check(
  "a live photo room keeps nothing on build",
  main.includes("A live photo room keeps nothing") && main.includes("clearExamplePhotoCameras();"),
  "main.ts finishBuild live branch",
);

// ---- Leaving photos-room drops the records ----
check(
  "openPhotoDraft drops the records",
  main.includes("private openPhotoDraft(result: PhotoFlowDone)") &&
    main.includes("clearExamplePhotoCameras();"),
  "main.ts openPhotoDraft",
);
check(
  "buildRoomAtSize drops the records when leaving photos-room",
  main.includes("Another room built: leaving photos-room drops its photo records.") &&
    main.includes('if (ROOM.id === "photos-room") clearExamplePhotoCameras();'),
  "main.ts buildRoomAtSize",
);
{
  const leavingDrops = (main.match(/Leaving photos-room/g) ?? []).length;
  check(
    "pickRoom and resetDemoRoom drop the records when leaving photos-room",
    leavingDrops >= 3,
    `${String(leavingDrops)} leaving-photos-room drop(s)`,
  );
}
check(
  "a shared layout opened over the photo room drops the records",
  main.includes("private applySharedLayout(decoded: DecodedLayout)") &&
    main.includes("A shared layout opened over the photo room leaves it") &&
    main.includes('if (ROOM.id === "photos-room") clearExamplePhotoCameras();'),
  "main.ts applySharedLayout",
);

// ---- A wall edit drops the records ----
check(
  "a plan-editor wall edit drops the records",
  main.includes("A plan-editor edit that changes the example room's walls drops its") &&
    main.includes("readExamplePhotoStore()") &&
    main.includes("sameExampleWalls(stored.walls, exampleWallsSignature(ROOM))"),
  "main.ts onCommitted",
);
check(
  "loading validates the walls signature",
  cameras.includes("sameExampleWalls(parsed.walls") &&
    cameras.includes("exampleWallsSignature(room)"),
  "example-cameras.ts loadExamplePhotoCameras",
);

// ---- Pure builder: current corners, focalPx, the session's own size ----
function fakeSession(): PhotoSession {
  const photos = (["A", "B", "C", "D"] as const).map((wall, index) => ({
    wall,
    wallId: ["wall-1", "wall-4", "wall-3", "wall-2"][index] as string,
    focalPx: 900 + index,
    focalSource: "default",
    focal35mm: 26,
    lines: null,
    corners: {
      m1: [10 + index, 20] as [number, number],
      m2: [1000 + index, 30] as [number, number],
      m3: [20 + index, 900] as [number, number],
      m4: [990 + index, 890] as [number, number],
    },
    ratio: 1,
    ratioPlusMinus: 0,
    heightEstimate: 260,
    heightPlusMinus: 0,
  }));
  return {
    draft: { photos } as unknown as PhotoSession["draft"],
    sizes: {
      A: { width: 1280, height: 951 },
      B: { width: 1280, height: 951 },
      C: { width: 1280, height: 951 },
      D: { width: 1280, height: 951 },
    },
    activeWall: "A",
    seen: ["A"],
  } as PhotoSession;
}

{
  const records = buildExamplePhotoRecords(fakeSession());
  check("the builder keeps one record per wall", records !== null && records.length === 4);
  if (records !== null) {
    const walls = records.map((record) => `${record.wall}/${record.wallId}`).join(",");
    check(
      "records carry the wall id and letter",
      walls === "A/wall-1,B/wall-4,C/wall-3,D/wall-2",
      walls,
    );
    check(
      "records carry the current corners",
      (records[0]?.corners.m1[0] ?? 0) === 10 && (records[0]?.corners.m3[1] ?? 0) === 900,
      JSON.stringify(records[0]?.corners),
    );
    check(
      "records carry focalPx",
      (records[0]?.focalPx ?? 0) === 900 && (records[3]?.focalPx ?? 0) === 903,
      String(records[0]?.focalPx),
    );
    const sizes = records.map((record) => `${String(record.width)}x${String(record.height)}`);
    check(
      "every record size is 1280 x 951",
      sizes.every((size) => size === "1280x951"),
      sizes.join(","),
    );
  }
  check("a missing wall builds nothing", buildExamplePhotoRecords(null) === null);
  const noFocal = fakeSession();
  const first = noFocal.draft.photos[0];
  if (first !== undefined) first.focalPx = 0;
  check("a missing focal builds nothing", buildExamplePhotoRecords(noFocal) === null);
}

// ---- Walls comparison ----
{
  const room = {
    walls: [
      { id: "wall-1", start: { x: 0, z: 0 }, end: { x: 420, z: 0 }, height: 260 },
      { id: "wall-2", start: { x: 420, z: 0 }, end: { x: 420, z: 360 }, height: 260 },
    ],
  } as unknown as Parameters<typeof exampleWallsSignature>[0];
  const signature = exampleWallsSignature(room);
  check("the same walls match", sameExampleWalls(signature, exampleWallsSignature(room)));
  const moved = JSON.parse(JSON.stringify(signature)) as typeof signature;
  const wall = moved.find((entry) => entry.id === "wall-1");
  if (wall !== undefined) wall.end.x = 430;
  check("a moved wall no longer matches", !sameExampleWalls(signature, moved));
  const dropped = signature.filter((entry) => entry.id !== "wall-2");
  check("a removed wall no longer matches", !sameExampleWalls(signature, dropped));
}

if (failures > 0) process.exit(1);
console.log("example-cameras ok");
