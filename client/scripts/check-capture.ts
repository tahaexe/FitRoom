/**
 * `npm run check:capture` — headless capture-framing check on the REAL room
 * shell (no browser, no live Meta calls).
 *
 * It builds the demo room exactly like the app (`client/src/room.ts`),
 * hides the dollhouse cutaway pair exactly like the app (`updateDollhouse`
 * in `client/src/main.ts`), puts the camera where the app's first view
 * puts it (`frameDollhouse`), then frames with the REAL capture helpers
 * (`collectShellPoints`, `fitRoomPerspective`, `captureSizeForRoom` from
 * `client/src/render/capture.ts`) and asserts the projected room fills
 * the frame: at least 85% on each side for the first view, with a small
 * margin, captured at 1024 x 768 because the room's projection is taller
 * than the stage. Prints PASS or FAIL per check and exits non-zero on any
 * FAIL. Run after `npm run build` (needs `@fitroom/shared` dist).
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import type { RoomLayout } from "@fitroom/shared";
import { buildRoom } from "../src/room.js";
import {
  captureSizeForRoom,
  collectShellPoints,
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
const FIRST_DIR = new THREE.Vector3(0.85, 0.85, 1).normalize();

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function main(): void {
  const mainSrc = readFileSync(join(clientDir, "src", "main.ts"), "utf8");
  check("app first view keeps a 50-degree orbit camera", mainSrc.includes("PerspectiveCamera(50"));
  check("app first view keeps the (0.85, 0.85, 1) corner", mainSrc.includes("0.85, 0.85, 1"));
  check("app still hides two walls by outward-dot", mainSrc.includes("outward.dot(toCam)"));

  const room = JSON.parse(
    readFileSync(join(repoRoot, "shared", "samples", "living-420x360.json"), "utf8"),
  ) as RoomLayout;
  const built = buildRoom(room, new THREE.MeshStandardMaterial({ color: 0xffffff }));
  const scene = new THREE.Scene();
  scene.add(built.group);

  // Room metres straight from the wall endpoints (plan cm).
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

  // First-view camera: the app's frameDollhouse from the same corner.
  const stageAspect = STAGE_W / STAGE_H;
  const camera = new THREE.PerspectiveCamera(FIRST_FOV, stageAspect, 0.05, 200);
  const vFov = (FIRST_FOV * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * stageAspect);
  const radius = Math.sqrt((wM / 2) ** 2 + (dM / 2) ** 2 + (2.6 / 2) ** 2);
  const dist0 = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.12;
  camera.position.set(
    cxM + FIRST_DIR.x * dist0,
    0.3 + FIRST_DIR.y * dist0,
    czM + FIRST_DIR.z * dist0,
  );
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
  check("first view cuts away two walls", hiddenIds.size === 2, [...hiddenIds].join(","));

  // The measured shell: visible floor and walls in world space — never the
  // hidden pair and never the studio backdrop disc.
  const points = collectShellPoints(scene);
  check("shell points are non-empty", points.length > 0, String(points.length));
  const inside = points.every(
    (p) => p.x > -0.5 && p.x < 4.7 && p.z > -0.5 && p.z < 4.1 && p.y > -0.1 && p.y < 2.7,
  );
  check("shell points exclude the backdrop disc", inside);

  // Provisional fit at the stage aspect, exactly like the capture: learn
  // the room's projected shape, then pick the frame.
  fitRoomPerspective(camera, points, stageAspect);
  const probe = projectBounds(camera, points);
  const spanY = Math.max(1e-6, probe.maxY - probe.minY);
  const roomAspect = ((probe.maxX - probe.minX) * stageAspect) / spanY;
  check(
    "first-view room projection is taller than the stage",
    roomAspect < stageAspect,
    roomAspect.toFixed(2),
  );
  const size = captureSizeForRoom(STAGE_W, STAGE_H, roomAspect);
  check(
    "tall room captures at about 4:3 (1024 x 768)",
    size.width === 1024 && size.height === 768,
    `${String(size.width)}x${String(size.height)}`,
  );

  // Final fit at the capture aspect, exactly like the capture.
  fitRoomPerspective(camera, points, size.width / size.height);
  const bounds = projectBounds(camera, points);
  const spanX = bounds.maxX - bounds.minX;
  const spanY2 = bounds.maxY - bounds.minY;
  check("room spans at least 85% of the frame width", spanX / 2 >= 0.85, spanX.toFixed(2));
  check("room spans at least 85% of the frame height", spanY2 / 2 >= 0.85, spanY2.toFixed(2));
  const edge = Math.max(
    Math.abs(bounds.minX),
    Math.abs(bounds.maxX),
    Math.abs(bounds.minY),
    Math.abs(bounds.maxY),
  );
  check("room keeps a small margin inside the frame", edge <= 0.96, edge.toFixed(3));

  // Size rule without a scene: wide rooms keep the stage aspect, and the
  // zero-size stage falls back to 16:9.
  const wide = captureSizeForRoom(STAGE_W, STAGE_H, 2.5);
  check(
    "wide room keeps the stage aspect",
    wide.width === 1024 && wide.height === Math.round(1024 / stageAspect),
    `${String(wide.width)}x${String(wide.height)}`,
  );
  const fallback = captureSizeForRoom(0, 0, 2.5);
  check(
    "zero-size stage falls back to 16:9",
    fallback.width === 1024 && fallback.height === 576,
    `${String(fallback.width)}x${String(fallback.height)}`,
  );

  console.log(
    failures === 0
      ? "check:capture: all checks passed"
      : `check:capture: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
