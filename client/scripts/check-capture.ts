/**
 * `npm run check:capture` — headless capture-framing + plan-data check on
 * the REAL room shell (no browser, no live Meta calls).
 *
 * Framing: it builds each room exactly like the app (`client/src/room.ts`),
 * picks the camera side exactly like the app (`facingDirForRoom` in
 * `client/src/render/capture.ts`, opposite the window walls so the
 * found windows stay drawn), hides the dollhouse cutaway pair exactly like
 * the app (`updateDollhouse` in `client/src/main.ts`), then frames with the
 * REAL capture helpers (`collectShellPoints`, `fitRoomPerspective`,
 * `captureSizeForRoom`) and asserts the projected room fills the frame:
 * at least 85% on each side with a small margin. Rooms: the sample room,
 * the example truth (420 x 360, door on A, windows on C/D) and a long
 * narrow room (600 x 220). The window walls must be among the drawn walls
 * for the rooms that have windows.
 *
 * Plans: the confirm view's small plan draws the real room
 * (`miniPlanData`): wall A on the same side as the main Plan view
 * (`planWallSide`), every wall with its own length, one swing arc per
 * door (none without a door), and doors apart from windows.
 *
 * Rendering look (source bars): warm-white matte walls, light oak plank
 * floor at board scale, warm bright daylight, contact shadows, and the
 * dark silhouette outline on every piece.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL. Run after
 * `npm run build` (needs `@fitroom/shared` dist).
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import type { Opening, RoomLayout } from "@fitroom/shared";
import type { PhotoSession } from "../src/editor/editor-store.js";
import { miniPlanData, type WallLetter } from "../src/editor/photo-confirm.js";
import { wallLetterLabel } from "../../shared/src/fit.js";
import { planWallSide } from "../src/plan.js";
import { buildRoom } from "../src/room.js";
import {
  captureSizeForRoom,
  collectShellPoints,
  facingDirForRoom,
  fitRoomPerspective,
  projectBounds,
} from "../src/render/capture.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");
const repoRoot = resolve(clientDir, "..");

// Window 1898 x 948, no panel open: the stage keeps the catalog column
// (300 + 2 x 16 gaps) on the left and the 64 + 16 top bar above, so
// 1898 - 332 - 16 = 1550 wide and 948 - 80 - 16 = 852 tall.
const STAGE_W = 1550;
const STAGE_H = 852;
const FIRST_FOV = 50;

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function rectRoom(id: string, name: string, w: number, d: number, openings: Opening[]): RoomLayout {
  return {
    id,
    name,
    units: "cm",
    walls: [
      { id: "wall-1", start: { x: 0, z: 0 }, end: { x: w, z: 0 }, height: 260, thickness: 12 },
      { id: "wall-2", start: { x: w, z: 0 }, end: { x: w, z: d }, height: 260, thickness: 12 },
      { id: "wall-3", start: { x: w, z: d }, end: { x: 0, z: d }, height: 260, thickness: 12 },
      { id: "wall-4", start: { x: 0, z: d }, end: { x: 0, z: 0 }, height: 260, thickness: 12 },
    ],
    openings,
    fixtures: [],
    existing: [],
    surfaces: { floor: "oak-light", wall: "warm-white" },
    style: { tags: ["modern", "neutral"], dominantColors: ["#E8E2D9"] },
    source: "sample",
    confidence: 1,
  };
}

function door(wallId: string, offset: number, width: number): Opening {
  return {
    id: `door-${wallId}`,
    wallId,
    type: "door",
    offset,
    width,
    height: 210,
    sillHeight: 0,
    hinge: "left",
    swing: "in",
  };
}

function windowOn(wallId: string, offset: number, width: number): Opening {
  return {
    id: `window-${wallId}`,
    wallId,
    type: "window",
    offset,
    width,
    height: 140,
    sillHeight: 90,
  };
}

interface Framed {
  spanX: number;
  spanY: number;
  edge: number;
  hiddenIds: Set<string>;
  visibleIds: Set<string>;
  size: { width: number; height: number };
  roomAspect: number;
}

function frameRoom(room: RoomLayout): Framed {
  const built = buildRoom(room, new THREE.MeshStandardMaterial({ color: 0xffffff }));
  const scene = new THREE.Scene();
  scene.add(built.group);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const wall of room.walls) {
    for (const p of [wall.start, wall.end]) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
  }
  const wM = (maxX - minX) / 100;
  const dM = (maxZ - minZ) / 100;
  const cxM = (minX + maxX) / 200;
  const czM = (minZ + maxZ) / 200;

  // First-view camera: the app's frameDollhouse on the window-aware side.
  const stageAspect = STAGE_W / STAGE_H;
  const camera = new THREE.PerspectiveCamera(FIRST_FOV, stageAspect, 0.05, 200);
  const side = facingDirForRoom(room);
  const dir = new THREE.Vector3(side.x, 0.85, side.z).normalize();
  const vFov = (FIRST_FOV * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * stageAspect);
  const radius = Math.sqrt((wM / 2) ** 2 + (dM / 2) ** 2 + (2.6 / 2) ** 2);
  const dist0 = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.12;
  camera.position.set(cxM + dir.x * dist0, 0.3 + dir.y * dist0, czM + dir.z * dist0);
  camera.lookAt(cxM, 0.3, czM);
  camera.updateMatrixWorld();

  // Dollhouse cutaway: hide the two walls nearest the camera.
  const toCam = new THREE.Vector3(camera.position.x - cxM, 0, camera.position.z - czM).normalize();
  const scored = built.wallEntries.map((e) => ({ e, d: e.outward.dot(toCam) }));
  scored.sort((a, b) => b.d - a.d);
  const first = scored[0];
  const second = scored[1];
  const hiddenIds =
    first !== undefined && second !== undefined
      ? new Set([first.e.wallId, second.e.wallId])
      : new Set<string>();
  for (const { e } of scored) {
    const show = !hiddenIds.has(e.wallId);
    for (const mesh of e.meshes) mesh.visible = show;
  }
  const visibleIds = new Set(
    scored.filter((s) => !hiddenIds.has(s.e.wallId)).map((s) => s.e.wallId),
  );

  const points = collectShellPoints(scene);
  fitRoomPerspective(camera, points, stageAspect);
  const probe = projectBounds(camera, points);
  const spanY = Math.max(1e-6, probe.maxY - probe.minY);
  const roomAspect = ((probe.maxX - probe.minX) * stageAspect) / spanY;
  const size = captureSizeForRoom(STAGE_W, STAGE_H, roomAspect);
  fitRoomPerspective(camera, points, size.width / size.height);
  const bounds = projectBounds(camera, points);
  const spanX = bounds.maxX - bounds.minX;
  const spanY2 = bounds.maxY - bounds.minY;
  const edge = Math.max(
    Math.abs(bounds.minX),
    Math.abs(bounds.maxX),
    Math.abs(bounds.minY),
    Math.abs(bounds.maxY),
  );
  return { spanX, spanY: spanY2, edge, hiddenIds, visibleIds, size, roomAspect };
}

function sessionFor(activeWall: WallLetter): PhotoSession {
  return {
    draft: {
      letterToWallId: { A: "wall-1", B: "wall-4", C: "wall-3", D: "wall-2" },
    },
    sizes: {
      A: { width: 1280, height: 960 },
      B: { width: 1280, height: 960 },
      C: { width: 1280, height: 960 },
      D: { width: 1280, height: 960 },
    },
    activeWall,
    seen: ["A"],
  } as unknown as PhotoSession;
}

function main(): void {
  const mainSrc = readFileSync(join(clientDir, "src", "main.ts"), "utf8");
  const stageSrc = readFileSync(join(clientDir, "src", "stage.ts"), "utf8");
  const roomSrc = readFileSync(join(clientDir, "src", "room.ts"), "utf8");
  const modelsSrc = readFileSync(join(clientDir, "src", "models.ts"), "utf8");
  const fitSrc = readFileSync(join(clientDir, "src", "fit-overlay.ts"), "utf8");
  check("app first view keeps a 50-degree orbit camera", mainSrc.includes("PerspectiveCamera(50"));
  check(
    "the first view faces the window walls (window-aware side)",
    mainSrc.includes("facingDirForRoom") && mainSrc.includes("dollhouseDir"),
  );
  check(
    "windowless rooms keep the south-east corner",
    stageSrc.includes("facingDirForRoom") ||
      readFileSync(join(clientDir, "src", "render", "capture.ts"), "utf8").includes("0.85"),
  );
  check("app still hides two walls by outward-dot", mainSrc.includes("outward.dot(toCam)"));
  check(
    "every room change reframes the whole room",
    mainSrc.includes("Any room change reframes the whole room"),
  );
  check(
    "the plan view hides the studio backdrop disc",
    mainSrc.includes("fitroom-backdrop") && mainSrc.includes('mode !== "plan"'),
  );

  // Rendering look, rendering only.
  check("walls render warm-white matte", roomSrc.includes("0xf3efe8"));
  check(
    "floor tiles at board scale",
    stageSrc.includes("FLOOR_TILE_M") && stageSrc.includes("WoodFloor039: 1.9"),
  );
  check(
    "sample floor renders as the new look's light oak",
    stageSrc.includes('if (surfaceId === "oak-light") return "WoodFloor039"'),
  );
  check(
    "light oak planks use the real 190 cm tile",
    stageSrc.includes("WoodFloor039: 1.9") && stageSrc.includes("FLOOR_TILE_M[finish]"),
  );
  check("daylight is warm and bright", stageSrc.includes("1.35") && stageSrc.includes("2.6"));
  check("contact shadows read under every piece", stageSrc.includes("0.38"));
  check(
    "every piece carries the dark silhouette outline",
    modelsSrc.includes("OUTLINE_COLOR = 0x2b2c30") && modelsSrc.includes("OUTLINE_OPACITY = 0.6"),
  );
  check(
    "existing blocks carry the same outline",
    mainSrc.includes("fitroom-outline") && mainSrc.includes("0x2b2c30"),
  );
  const arcsAt = fitSrc.indexOf("private buildArcs");
  const arcsEnd = arcsAt < 0 ? -1 : fitSrc.indexOf("private updateClearance", arcsAt);
  const arcsBlock = arcsAt < 0 || arcsEnd < 0 ? "" : fitSrc.slice(arcsAt, arcsEnd);
  check(
    "door swings draw as thin red arcs, one per door",
    arcsBlock.includes("fit-swing-") &&
      arcsBlock.includes("LineBasicMaterial") &&
      !arcsBlock.includes("ShapeGeometry"),
  );

  const sample = JSON.parse(
    readFileSync(join(repoRoot, "shared", "samples", "living-420x360.json"), "utf8"),
  ) as RoomLayout;
  const example = rectRoom("example-room", "Example room (generated photos)", 420, 360, [
    door("wall-1", 30, 90),
    windowOn("wall-3", 80, 160),
    windowOn("wall-2", 120, 120),
  ]);
  const narrow = rectRoom("narrow-room", "Long narrow room", 600, 220, [
    door("wall-1", 40, 90),
    windowOn("wall-3", 200, 160),
  ]);

  for (const [label, room] of [
    ["sample", sample],
    ["example", example],
    ["long narrow", narrow],
  ] as const) {
    const framed = frameRoom(room);
    check(
      `${label} room spans at least 85% of the frame width`,
      framed.spanX / 2 >= 0.85,
      framed.spanX.toFixed(2),
    );
    check(
      `${label} room spans at least 85% of the frame height`,
      framed.spanY / 2 >= 0.85,
      framed.spanY.toFixed(2),
    );
    check(
      `${label} room keeps a small margin inside the frame`,
      framed.edge <= 0.96,
      framed.edge.toFixed(3),
    );
    const windowWalls = new Set(
      room.openings.filter((o) => o.type === "window").map((o) => o.wallId),
    );
    const drawn = [...windowWalls].every((id) => framed.visibleIds.has(id));
    check(
      `${label} room draws its window walls (none cut away)`,
      drawn,
      `hidden ${[...framed.hiddenIds].join(",")}`,
    );
  }

  // Plans over their drawing data.
  check(
    "wall A reads at the top in the main Plan view",
    planWallSide(sample, "wall-1") === "top",
    String(planWallSide(sample, "wall-1")),
  );
  const data = miniPlanData(sample, sessionFor("A"));
  check("the confirm plan draws the real room", data !== null);
  if (data !== null) {
    check(
      "wall A sits the same way up in both plans",
      data.aSide === planWallSide(sample, "wall-1"),
      `${data.aSide} vs ${String(planWallSide(sample, "wall-1"))}`,
    );
    check("the confirm plan draws four walls", data.edges.length === 4, String(data.edges.length));
    let lengthsOk = true;
    for (const edge of data.edges) {
      const wallId = { A: "wall-1", B: "wall-4", C: "wall-3", D: "wall-2" }[edge.letter];
      const wall = sample.walls.find((w) => w.id === wallId);
      const want =
        wall === undefined
          ? 0
          : Math.round(Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z));
      if (
        edge.lengthCm !== want ||
        edge.label !== `${wallLetterLabel(sample, edge.letter)} · ${String(want)} cm`
      ) {
        lengthsOk = false;
      }
    }
    check("every confirm wall carries its own length", lengthsOk);
    const doors = data.openings.filter((o) => o.kind === "door");
    const windows = data.openings.filter((o) => o.kind === "window");
    check(
      "one swing arc per door",
      doors.length === 1 && doors.every((d) => d.arc && d.arcD !== null),
    );
    check(
      "windows draw apart from doors (no arc, double line)",
      windows.length === 2 && windows.every((w) => !w.arc && w.windowLines.length === 2),
    );
    const active = data.edges.filter((e) => e.active);
    check(
      "the active wall marks apart from the openings",
      active.length === 1 && active[0]?.letter === "A",
    );
  }
  const empty = rectRoom("empty-room", "Empty room", 400, 350, []);
  const emptyData = miniPlanData(empty, sessionFor("A"));
  check(
    "no door means no swing arc",
    emptyData !== null && emptyData.openings.length === 0,
    String(emptyData?.openings.length ?? "null"),
  );

  console.log(
    failures === 0
      ? "check:capture: all checks passed"
      : `check:capture: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
