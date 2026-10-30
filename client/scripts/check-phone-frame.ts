/**
 * `npm run check:phone-frame` — portrait-phone room framing (no browser,
 * no Meta calls). The room fills the free area (the scene container less
 * an open sheet), not a third of it:
 *
 * - `frameDollhouse` frames by the room's projected box (the eight corners
 *   at height 0 and the wall height), moving along the view direction until
 *   the box spans 92 % of the free width or 80 % of the free height;
 * - the picture's centre stays in the middle of the free area with
 *   `setViewOffset`, updated on sheet open/close and resize without moving
 *   the camera; cleared on desktop and in Plan.
 *
 * For a 390 x 740 area with and without a 338 px sheet, the fitted box is
 * centred in the free area within 2 px and fills it to the stated share
 * within 2 %.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  PHONE_FRAME_CLEAR_M,
  PHONE_FRAME_HEIGHT_SHARE,
  PHONE_FRAME_MAX_M,
  PHONE_FRAME_MIN_PX,
  PHONE_FRAME_WIDTH_SHARE,
  fitBoxToArea,
  phoneFrameMinDistance,
  phoneFrameReady,
  phoneFreeArea,
  phoneViewOffset,
  solvePhoneFrame,
} from "../src/guide.js";
import type { PhoneFrameProjection } from "../src/guide.js";

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

check(
  "phone-frame:width-share",
  PHONE_FRAME_WIDTH_SHARE === 0.92,
  `width share ${String(PHONE_FRAME_WIDTH_SHARE)}`,
);
check(
  "phone-frame:height-share",
  PHONE_FRAME_HEIGHT_SHARE === 0.8,
  `height share ${String(PHONE_FRAME_HEIGHT_SHARE)}`,
);

const freeClosed = phoneFreeArea({ w: 390, h: 740 }, 0);
check(
  "phone-frame:free-no-sheet",
  freeClosed.w === 390 && freeClosed.h === 740,
  `${String(freeClosed.w)}x${String(freeClosed.h)}`,
);

const freeOpen = phoneFreeArea({ w: 390, h: 740 }, 338);
check(
  "phone-frame:free-with-sheet",
  freeOpen.w === 390 && freeOpen.h === 402,
  `${String(freeOpen.w)}x${String(freeOpen.h)}`,
);

const offsetClosed = phoneViewOffset(390, 740, 0);
check(
  "phone-frame:offset-no-sheet",
  offsetClosed.fullW === 390 &&
    offsetClosed.fullH === 740 &&
    offsetClosed.x === 0 &&
    offsetClosed.y === 0 &&
    offsetClosed.w === 390 &&
    offsetClosed.h === 740,
  JSON.stringify(offsetClosed),
);

const offsetOpen = phoneViewOffset(390, 740, 338);
check(
  "phone-frame:offset-with-sheet",
  offsetOpen.fullW === 390 &&
    offsetOpen.fullH === 740 &&
    offsetOpen.x === 0 &&
    offsetOpen.y === 169 &&
    offsetOpen.w === 390 &&
    offsetOpen.h === 740,
  JSON.stringify(offsetOpen),
);

const boxes = [
  { x: 95, y: 295, w: 200, h: 150 },
  { x: 135, y: 220, w: 120, h: 300 },
  { x: 0, y: 0, w: 390, h: 740 },
];

for (const sheet of [0, 338]) {
  const area = { w: 390, h: 740 };
  const free = phoneFreeArea(area, sheet);
  for (const box of boxes) {
    const fit = fitBoxToArea(box, area, sheet);
    const cx = fit.screen.x + fit.screen.w / 2;
    const cy = fit.screen.y + fit.screen.h / 2;
    const dx = Math.abs(cx - free.w / 2);
    const dy = Math.abs(cy - free.h / 2);
    check(
      `phone-frame:centred-sheet-${sheet}-box-${box.w}x${box.h}`,
      dx <= 2 && dy <= 2,
      `centre off by ${dx.toFixed(2)},${dy.toFixed(2)} (screen ${fit.screen.x.toFixed(1)},${fit.screen.y.toFixed(1)} ${fit.screen.w.toFixed(1)}x${fit.screen.h.toFixed(1)} free ${String(free.w)}x${String(free.h)})`,
    );
    const widthShare = fit.screen.w / free.w;
    const heightShare = fit.screen.h / free.h;
    const widthHit = Math.abs(widthShare - PHONE_FRAME_WIDTH_SHARE) <= 0.02;
    const heightHit = Math.abs(heightShare - PHONE_FRAME_HEIGHT_SHARE) <= 0.02;
    const widthInside = widthShare <= PHONE_FRAME_WIDTH_SHARE + 0.02;
    const heightInside = heightShare <= PHONE_FRAME_HEIGHT_SHARE + 0.02;
    check(
      `phone-frame:fills-sheet-${sheet}-box-${box.w}x${box.h}`,
      (widthHit || heightHit) && widthInside && heightInside,
      `shares ${widthShare.toFixed(3)} x ${heightShare.toFixed(3)} (want 0.92 x 0.80)`,
    );
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(here, "..", "src", "main.ts"), "utf8");
const guideSource = readFileSync(join(here, "..", "src", "guide.ts"), "utf8");

check(
  "phone-frame:pure-fitting",
  guideSource.includes("phoneFreeArea") &&
    guideSource.includes("phoneViewOffset") &&
    guideSource.includes("fitBoxToArea"),
  "the fitting stays in pure functions in guide.ts",
);
check(
  "phone-frame:projects-corners",
  mainSource.includes("projectRoomBox") && mainSource.includes("wallHeightM"),
  "the framing camera projects the eight room corners",
);
check(
  "phone-frame:moves-along-view",
  guideSource.includes("solvePhoneFrame") &&
    guideSource.includes("dist / fit.scale") &&
    mainSource.includes("solvePhoneFrame"),
  "the solver moves the camera along the view direction to the 92/80 fit",
);
check(
  "phone-frame:uses-view-offset",
  mainSource.includes("phoneViewOffset") &&
    mainSource.includes("setViewOffset") &&
    mainSource.includes("clearViewOffset"),
  "the picture recentres with setViewOffset",
);
check(
  "phone-frame:updates-on-sheet-and-resize",
  mainSource.includes("openSheetHeight") &&
    mainSource.includes("applyPhoneViewOffset") &&
    mainSource.includes("private applyResize") &&
    mainSource.includes("syncPhoneBar"),
  "sheet open/close and resize re-seat without moving the camera",
);
check(
  "phone-frame:clears-desktop-and-plan",
  mainSource.includes("isPortraitPhone") &&
    mainSource.includes("clearViewOffset") &&
    mainSource.includes("private setMode") &&
    mainSource.includes("applyPhoneViewOffset"),
  "desktop and Plan clear the offset",
);

// ---- Safe framing: laid-out size, depth-aware steps, reload parity ----
check("phone-frame:min-size", PHONE_FRAME_MIN_PX === 100, `min ${String(PHONE_FRAME_MIN_PX)}`);
check(
  "phone-frame:clearance",
  PHONE_FRAME_CLEAR_M === 0.5,
  `clearance ${String(PHONE_FRAME_CLEAR_M)}`,
);
check("phone-frame:max-distance", PHONE_FRAME_MAX_M === 18, `max ${String(PHONE_FRAME_MAX_M)}`);
check(
  "phone-frame:zero-container-not-ready",
  phoneFrameReady(0, 0) === false && phoneFrameReady(1, 1) === false,
  "0x0 and 1x1 must not frame",
);
check(
  "phone-frame:small-container-not-ready",
  phoneFrameReady(99, 740) === false && phoneFrameReady(390, 99) === false,
  "a side below 100 px must not frame",
);
check(
  "phone-frame:laid-out-ready",
  phoneFrameReady(100, 100) === true && phoneFrameReady(390, 740) === true,
  "100x100 and 390x740 must frame",
);
check(
  "phone-frame:min-distance",
  Math.abs(phoneFrameMinDistance(3.062) - 3.562) < 1e-9,
  `min ${String(phoneFrameMinDistance(3.062))}`,
);

const frameAt = mainSource.indexOf("private framePhonePortrait(");
const frameEnd = mainSource.indexOf("\n  private ", frameAt + 1);
const frameBody =
  frameAt < 0 ? "" : mainSource.slice(frameAt, frameEnd < 0 ? frameAt + 6000 : frameEnd);
check(
  "phone-frame:keeps-camera-when-not-laid-out",
  frameBody.includes("phoneFrameReady") &&
    frameBody.includes("pendingPhoneFrame = true") &&
    frameBody.indexOf("phoneFrameReady") < frameBody.indexOf("orbitCam.position.set"),
  "the gate runs before any camera move and defers the frame",
);
check(
  "phone-frame:retries-on-resize-and-layout",
  mainSource.includes("pendingPhoneFrame") &&
    (mainSource.match(/pendingPhoneFrame/g) ?? []).length >= 5,
  "resize, layout and staged loads must consume the deferred frame",
);
check(
  "phone-frame:reload-frames-like-build",
  !mainSource.includes("if (firstVisit)") && mainSource.includes("this.frameDollhouse("),
  "the first view frames on a reload too, not only on a first visit",
);

interface ExampleWall {
  id: string;
  start: { x: number; z: number };
  end: { x: number; z: number };
  height: number;
}
interface ExampleRoom {
  walls: ExampleWall[];
  openings: Array<{ wallId: string; type: string }>;
}
const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."), "..");
const exampleRoom = JSON.parse(
  readFileSync(join(repoRoot, "shared", "samples", "example-room.json"), "utf8"),
) as ExampleRoom;

function exampleFacing(room: ExampleRoom): { x: number; z: number } {
  let cx = 0;
  let cz = 0;
  for (const wall of room.walls) {
    cx += (wall.start.x + wall.end.x) / 2;
    cz += (wall.start.z + wall.end.z) / 2;
  }
  cx /= Math.max(1, room.walls.length);
  cz /= Math.max(1, room.walls.length);
  const windowWalls = new Set(
    room.openings.filter((o) => o.type === "window").map((o) => o.wallId),
  );
  let ax = 0;
  let az = 0;
  let count = 0;
  for (const wall of room.walls) {
    if (!windowWalls.has(wall.id)) continue;
    const mx = (wall.start.x + wall.end.x) / 2;
    const mz = (wall.start.z + wall.end.z) / 2;
    const len = Math.hypot(mx - cx, mz - cz) || 1;
    ax += (mx - cx) / len;
    az += (mz - cz) / len;
    count += 1;
  }
  if (count === 0 || Math.hypot(ax, az) < 1e-6) {
    const dl = Math.hypot(0.85, 1) || 1;
    return { x: 0.85 / dl, z: 1 / dl };
  }
  const hl = Math.hypot(ax, az) || 1;
  return { x: -ax / hl, z: -az / hl };
}

function exampleRig(
  pxW: number,
  pxH: number,
): {
  radius: number;
  fitFov: number;
  wallH: number;
  wM: number;
  dM: number;
  cxM: number;
  czM: number;
  target: THREE.Vector3;
  dir: THREE.Vector3;
  camera: THREE.PerspectiveCamera;
  project: (distM: number) => PhoneFrameProjection;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let wallH = 0;
  for (const wall of exampleRoom.walls) {
    for (const p of [wall.start, wall.end]) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    wallH = Math.max(wallH, wall.height / 100);
  }
  const wM = (maxX - minX) / 100;
  const dM = (maxZ - minZ) / 100;
  const cxM = (minX + maxX) / 200;
  const czM = (minZ + maxZ) / 200;
  const facing = exampleFacing(exampleRoom);
  const camera = new THREE.PerspectiveCamera(50, pxW / pxH, 0.05, 200);
  const dir = new THREE.Vector3(facing.x, 0.85, facing.z).normalize();
  const target = new THREE.Vector3(cxM, 0.3, czM);
  const boxH = 2.6;
  const project = (distM: number): PhoneFrameProjection => {
    camera.position.set(
      target.x + dir.x * distM,
      target.y + dir.y * distM,
      target.z + dir.z * distM,
    );
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const corners: THREE.Vector3[] = [];
    for (const y of [0, boxH]) {
      for (const sx of [-0.5, 0.5]) {
        for (const sz of [-0.5, 0.5]) {
          corners.push(new THREE.Vector3(cxM + sx * wM, y, czM + sz * dM));
        }
      }
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const depths: number[] = [];
    for (const corner of corners) {
      depths.push(-corner.clone().applyMatrix4(camera.matrixWorldInverse).z);
      const ndc = corner.clone().project(camera);
      x0 = Math.min(x0, (ndc.x * 0.5 + 0.5) * pxW);
      y0 = Math.min(y0, (-ndc.y * 0.5 + 0.5) * pxH);
      x1 = Math.max(x1, (ndc.x * 0.5 + 0.5) * pxW);
      y1 = Math.max(y1, (-ndc.y * 0.5 + 0.5) * pxH);
    }
    return {
      box: { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) },
      depths,
    };
  };
  const vFov = (50 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (pxW / pxH));
  return {
    radius: Math.sqrt((wM / 2) ** 2 + (dM / 2) ** 2 + (boxH / 2) ** 2),
    fitFov: Math.min(vFov, hFov),
    wallH,
    wM,
    dM,
    cxM,
    czM,
    target,
    dir,
    camera,
    project,
  };
}

function poseCamera(
  rig: ReturnType<typeof exampleRig>,
  distM: number,
): { box: PhoneFrameProjection["box"]; depths: number[] } {
  const proj = rig.project(distM);
  return { box: proj.box, depths: proj.depths };
}

for (const sheet of [0, 338]) {
  const area = { w: 390, h: 740 };
  const rig = exampleRig(area.w, area.h);
  const dist = solvePhoneFrame(rig.radius, rig.fitFov, area, sheet, rig.project);
  const { box, depths } = poseCamera(rig, dist);
  const fit = fitBoxToArea(box, area, sheet);
  const free = phoneFreeArea(area, sheet);
  const cx = fit.screen.x + fit.screen.w / 2;
  const cy = fit.screen.y + fit.screen.h / 2;
  const cam = rig.camera.position;
  check(
    `phone-frame:example-stays-out-sheet-${sheet}`,
    dist >= rig.radius + PHONE_FRAME_CLEAR_M - 1e-6 && depths.every((d) => d > 0),
    `dist ${dist.toFixed(3)} min ${(rig.radius + PHONE_FRAME_CLEAR_M).toFixed(3)} depths ${depths.map((d) => d.toFixed(2)).join(",")}`,
  );
  check(
    `phone-frame:example-outside-footprint-sheet-${sheet}`,
    Math.abs(cam.x - rig.cxM) > rig.wM / 2 || Math.abs(cam.z - rig.czM) > rig.dM / 2,
    `cam ${cam.x.toFixed(2)},${cam.z.toFixed(2)} centre ${rig.cxM.toFixed(2)},${rig.czM.toFixed(2)}`,
  );
  check(
    `phone-frame:example-above-walls-sheet-${sheet}`,
    cam.y > rig.wallH,
    `cam y ${cam.y.toFixed(2)} walls ${rig.wallH.toFixed(2)}`,
  );
  const actual = poseCamera(rig, dist).box;
  const actualCx = actual.x + actual.w / 2;
  const actualCy = actual.y + actual.h / 2 - sheet / 2;
  check(
    `phone-frame:example-centred-sheet-${sheet}`,
    Math.abs(cx - actualCx) <= 2 && Math.abs(cy - actualCy) <= 2,
    `prediction off by ${Math.abs(cx - actualCx).toFixed(2)},${Math.abs(cy - actualCy).toFixed(2)}`,
  );
  const widthShare = fit.screen.w / free.w;
  const heightShare = fit.screen.h / free.h;
  check(
    `phone-frame:example-fills-sheet-${sheet}`,
    (Math.abs(widthShare - PHONE_FRAME_WIDTH_SHARE) <= 0.02 ||
      Math.abs(heightShare - PHONE_FRAME_HEIGHT_SHARE) <= 0.02) &&
      widthShare <= PHONE_FRAME_WIDTH_SHARE + 0.02 &&
      heightShare <= PHONE_FRAME_HEIGHT_SHARE + 0.02,
    `shares ${widthShare.toFixed(3)} x ${heightShare.toFixed(3)}`,
  );
}

{
  const area = { w: 390, h: 740 };
  const rig = exampleRig(area.w, area.h);
  let calls = 0;
  const flaky = (distM: number): PhoneFrameProjection => {
    calls += 1;
    if (calls === 1) {
      return {
        box: { x: -4000, y: -4000, w: 8000, h: 8000 },
        depths: [4, 4, 4, 4, 4, 4, 4, -1],
      };
    }
    return rig.project(distM);
  };
  const dist = solvePhoneFrame(rig.radius, rig.fitFov, area, 0, flaky);
  const { depths } = poseCamera(rig, dist);
  const cam = rig.camera.position;
  check(
    "phone-frame:behind-corner-widens",
    calls > 1 && depths.every((d) => d > 0),
    `${String(calls)} measurements, depths ${depths.map((d) => d.toFixed(2)).join(",")}`,
  );
  check(
    "phone-frame:behind-corner-stays-out",
    dist >= rig.radius + PHONE_FRAME_CLEAR_M - 1e-6 &&
      (Math.abs(cam.x - rig.cxM) > rig.wM / 2 || Math.abs(cam.z - rig.czM) > rig.dM / 2) &&
      cam.y > rig.wallH,
    `dist ${dist.toFixed(3)} cam ${cam.x.toFixed(2)},${cam.y.toFixed(2)},${cam.z.toFixed(2)}`,
  );
}

// ---- In-scene labels follow every phone camera the path sets ----
const offsetAt = mainSource.indexOf("private applyPhoneViewOffset(");
const offsetEnd = mainSource.indexOf("\n  private ", offsetAt + 1);
const offsetBody =
  offsetAt < 0 ? "" : mainSource.slice(offsetAt, offsetEnd < 0 ? offsetAt + 6000 : offsetEnd);
check(
  "phone-frame:labels-after-offset",
  offsetBody.includes("fitOverlay.update") &&
    offsetBody.includes("activeCamera()") &&
    offsetBody.includes("container.clientWidth") &&
    offsetBody.includes("container.clientHeight"),
  "applyPhoneViewOffset must place the labels with the current camera and laid-out size",
);
check(
  "phone-frame:labels-after-phone-portrait",
  frameBody.includes("fitOverlay.update") &&
    frameBody.includes("activeCamera()") &&
    frameBody.includes("container.clientWidth") &&
    frameBody.includes("container.clientHeight"),
  "framePhonePortrait must place the labels with the current camera and laid-out size",
);
const deferredNeedles = [
  "this.frameDollhouse(",
  "pendingPhoneFrame",
  "fitOverlay.update",
  "activeCamera()",
  "container.clientWidth",
  "container.clientHeight",
];
const deferredHits = deferredNeedles.every((needle) => mainSource.includes(needle));
const deferredBlocks = mainSource.split("pendingPhoneFrame");
const deferredLabelled =
  deferredBlocks.length >= 4 &&
  deferredBlocks.slice(1).some((block) => block.includes("fitOverlay.update"));
check(
  "phone-frame:labels-after-deferred-frame",
  deferredHits && deferredLabelled,
  "the deferred phone frame must place the labels with the current camera and laid-out size",
);

// ---- Labels can never run before the overlay exists ----
// The constructor's first frame once ran before `this.fitOverlay` was
// created, so every label update above read `update` of undefined and the
// boot stopped on portrait phones. Either the overlay is created before that
// first frame, or every update above skips a missing overlay (the first
// render places the labels anyway).
const ctorAt = mainSource.indexOf("constructor(container: HTMLElement)");
const firstFrameAt = mainSource.indexOf("this.frameDollhouse(", ctorAt);
const overlayAt = mainSource.indexOf("this.fitOverlay = new FitOverlay", ctorAt);
const overlayBeforeFirstFrame =
  ctorAt >= 0 && firstFrameAt >= 0 && overlayAt >= 0 && overlayAt < firstFrameAt;
const guardedUpdate = (body: string): boolean =>
  body.includes("this.fitOverlay?.update") || body.includes("if (this.fitOverlay");
const deferredLabelBlocks = deferredBlocks
  .slice(1)
  .filter((block) => block.includes("fitOverlay.update"));
check(
  "phone-frame:labels-safe-before-overlay",
  overlayBeforeFirstFrame ||
    (guardedUpdate(offsetBody) &&
      guardedUpdate(frameBody) &&
      deferredLabelBlocks.length > 0 &&
      deferredLabelBlocks.every(guardedUpdate)),
  "phone-path label updates must skip a missing overlay, or the overlay must be created before the constructor's first frame",
);

if (failures > 0) process.exit(1);
console.log("phone-frame: all checks passed");
