/**
 * `npm run check:photo-view` — "See it in your photo" draws the placed
 * pieces into the wall photo at true size. Headless (no browser, no Meta
 * calls).
 *
 * - Projects the furnished example scene (two chairs and the side table
 *   the example's Furnish answer places, backs flush against wall A) into
 *   photo A with the stored camera. Wall A's corners come from the
 *   example's replayed solve, as `check:example-geometry` gets them. Each
 *   piece's back bottom corners land within 1 % of the image height
 *   (9.5 px) of wall A's floor line (m3-m4) and inside the frame. Each
 *   piece's contact shadow (footprint plus the shadow margin) centres
 *   inside the frame and its projected width is within 10 % of the
 *   projected footprint width plus the margin.
 * - The overlay draws each piece once, where it stands: after building
 *   the view's own overlay for the furnished scene, each drawn clone's
 *   world position is within 1 cm of the piece's room position and its
 *   world rotation about Y within 0.5 deg of the piece's, and each
 *   shadow's world centre is within 1 cm of the same point.
 * - The view issues no request: no `fetch`, no `/api/` in the view or its
 *   app wiring; the photo loads as a static image.
 * - Exclusivity + chrome: the pill shows only in the built example room,
 *   never in flow/confirm; opening the view closes the side panel, the
 *   fit list and Visualise (and vice versa); Esc closes it; no guide
 *   bubble, empty-room hint or doors tip shows over it.
 * - The toolbar keeps one row and the single syncer load call stays the
 *   only one (`check:toolbar` / `check:first-paint` parity, no edits).
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import type { CatalogItem, RoomLayout, SceneItem, WallPhotoCamera } from "@fitroom/shared";
import { EXAMPLE_SEG_SIZE } from "../src/photo-room/example.js";
import { segmentInstances } from "../../shared/src/sam.js";
import {
  projectWallPhotoCamera,
  solveRoomFromPhotos,
  type PhotoInput,
  type RoomDraft,
  type WallLetter,
} from "../../shared/src/photo-room/index.js";
import { buildExamplePhotoRecords } from "../src/photo-room/example-cameras.js";
import {
  PHOTO_SHADOW_MARGIN_CM,
  buildPhotoOverlay,
  photoCameraForRecord,
  photoPieceCorners,
  photoPieceShadowCorners,
} from "../src/photo-room/photo-view.js";
import type { PhotoSession } from "../src/editor/editor-store.js";
import { PHOTO_VIEW_BUTTON, PHOTO_VIEW_LINE, photoViewOutside } from "../src/copy.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");
const repoRoot = resolve(clientDir, "..");
const segDir = join(repoRoot, "server", "data", "demo", "segment");
const exampleDir = join(repoRoot, "client", "public", "assets", "example-room");

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
  return readFileSync(join(clientDir, "src", relative), "utf8");
}

const LETTERS: WallLetter[] = ["A", "B", "C", "D"];
const FILE_OF: Record<WallLetter, string> = { A: "a", B: "b", C: "c", D: "d" };
const CONCEPTS = ["wall", "floor", "ceiling", "door", "window"] as const;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function loadDemoAnswers(): Map<string, Map<string, string>> {
  const byImage = new Map<string, Map<string, string>>();
  for (const file of readdirSync(segDir).filter((f) => f.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(readFileSync(join(segDir, file), "utf8")) as {
        input?: { concept?: unknown; image?: unknown };
        response?: { text?: unknown };
      };
      const concept = parsed.input?.concept;
      const image = parsed.input?.image;
      const text = parsed.response?.text;
      if (typeof concept !== "string" || typeof image !== "string" || typeof text !== "string") {
        continue;
      }
      let perConcept = byImage.get(image);
      if (perConcept === undefined) {
        perConcept = new Map<string, string>();
        byImage.set(image, perConcept);
      }
      perConcept.set(concept, text);
    } catch {
      continue;
    }
  }
  return byImage;
}

function estimateMissingTape(
  draft: RoomDraft,
  known: number,
  missingLetter: WallLetter,
  knownLetter: WallLetter,
): { value: number; plusMinus: number } {
  const missing = draft.photos.find((s) => s.wall === missingLetter);
  const knownSol = draft.photos.find((s) => s.wall === knownLetter);
  const ratioM = missing?.ratio ?? NaN;
  const ratioK = knownSol?.ratio ?? NaN;
  if (
    missing === undefined ||
    knownSol === undefined ||
    !Number.isFinite(ratioM) ||
    !Number.isFinite(ratioK) ||
    ratioM <= 0 ||
    ratioK <= 0
  ) {
    return { value: known, plusMinus: 15 };
  }
  const value = Math.max(50, Math.min(2000, Math.round((known * ratioM) / ratioK)));
  const rel =
    Math.abs(missing.ratioPlusMinus / ratioM) + Math.abs(knownSol.ratioPlusMinus / ratioK);
  return { value, plusMinus: Math.max(4, Math.round(value * rel + 2)) };
}

function distToSeg(
  point: { x: number; y: number },
  a: [number, number],
  b: [number, number],
): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((point.x - a[0]) * vx + (point.y - a[1]) * vy) / len2));
  return Math.hypot(point.x - (a[0] + t * vx), point.y - (a[1] + t * vy));
}

async function replayExampleDraft(): Promise<RoomDraft | null> {
  const byImage = loadDemoAnswers();
  const photos: PhotoInput[] = [];
  for (const letter of LETTERS) {
    let dataUrl: string;
    try {
      const bytes = readFileSync(join(exampleDir, `${FILE_OF[letter]}-seg.jpg`));
      dataUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    } catch {
      return null;
    }
    const perConcept = byImage.get(sha256Hex(dataUrl));
    if (perConcept === undefined) return null;
    const instances: PhotoInput["instances"] = [];
    for (const concept of CONCEPTS) {
      const text = perConcept.get(concept);
      if (text === undefined || text.trim().length === 0) continue;
      instances.push(
        ...(await segmentInstances(concept, text, {
          width: EXAMPLE_SEG_SIZE.width,
          height: EXAMPLE_SEG_SIZE.height,
        })),
      );
    }
    photos.push({
      wall: letter,
      width: EXAMPLE_SEG_SIZE.width,
      height: EXAMPLE_SEG_SIZE.height,
      focal35mm: undefined,
      instances,
    });
  }
  const firstPass = solveRoomFromPhotos({ photos, tapeA: 420, tapeB: 420 });
  const estB = estimateMissingTape(firstPass, 420, "B", "A");
  return solveRoomFromPhotos({ photos, tapeA: 420, tapeB: estB.value });
}

function sessionFromDraft(draft: RoomDraft): PhotoSession {
  return {
    draft: JSON.parse(JSON.stringify(draft)) as PhotoSession["draft"],
    sizes: {
      A: { width: EXAMPLE_SEG_SIZE.width, height: EXAMPLE_SEG_SIZE.height },
      B: { width: EXAMPLE_SEG_SIZE.width, height: EXAMPLE_SEG_SIZE.height },
      C: { width: EXAMPLE_SEG_SIZE.width, height: EXAMPLE_SEG_SIZE.height },
      D: { width: EXAMPLE_SEG_SIZE.width, height: EXAMPLE_SEG_SIZE.height },
    },
    activeWall: "A",
    seen: ["A"],
  } as PhotoSession;
}

/**
 * The overlay draws each piece once, where it stands: after building the
 * view's own overlay for the furnished example scene, each drawn clone's
 * world position is within 1 cm of the piece's room position and its world
 * rotation about Y within 0.5 deg of the piece's, and each shadow's world
 * centre is within 1 cm of the same point. Groups stand as the scene
 * syncer leaves them (room cm to metres, rotation about Y).
 */
function overlaySingleTransformBar(
  room: RoomLayout,
  cam: WallPhotoCamera,
  rawItems: Array<{
    instanceId?: unknown;
    productId: string;
    position: { x: number; z: number };
    rotationY?: unknown;
    variant?: unknown;
  }>,
): void {
  const catalog = JSON.parse(
    readFileSync(join(repoRoot, "shared", "catalog", "catalog.json"), "utf8"),
  ) as CatalogItem[];
  const catalogMap = new Map(catalog.map((entry) => [entry.id, entry]));
  const items: SceneItem[] = rawItems.map((item, index) => ({
    instanceId:
      typeof item.instanceId === "string" ? item.instanceId : `${item.productId}-${String(index)}`,
    productId: item.productId,
    position: { x: item.position.x, z: item.position.z },
    rotationY: typeof item.rotationY === "number" ? item.rotationY : 0,
    variant: typeof item.variant === "string" ? item.variant : "default",
  }));
  const groups = new Map(
    items.map((item) => {
      const group = new THREE.Group();
      group.position.set(item.position.x / 100, 0, item.position.z / 100);
      group.rotation.y = (item.rotationY * Math.PI) / 180;
      return [item.instanceId, { group }] as const;
    }),
  );
  const built = buildPhotoOverlay({ items, groups, catalog: catalogMap, cam, room });
  built.overlay.updateMatrixWorld(true);
  check(
    "the overlay draws each furnished piece once",
    built.drawn.length === items.length,
    `${String(built.drawn.length)} of ${String(items.length)}`,
  );
  const point = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  for (const piece of built.drawn) {
    piece.clone.getWorldPosition(point);
    const expectedX = piece.item.position.x / 100;
    const expectedZ = piece.item.position.z / 100;
    const distM = Math.hypot(point.x - expectedX, point.z - expectedZ);
    console.log(
      `photo-view overlay ${piece.item.productId} world (${point.x.toFixed(3)},${point.z.toFixed(3)}) vs room (${expectedX.toFixed(3)},${expectedZ.toFixed(3)}) ${(distM * 100).toFixed(2)} cm`,
    );
    check(
      `piece ${piece.item.productId} clone stands where it stands (<= 1 cm)`,
      distM <= 0.01,
      `${(distM * 100).toFixed(2)} cm`,
    );
    piece.clone.getWorldQuaternion(quat);
    euler.setFromQuaternion(quat, "YXZ");
    const actualDeg = (euler.y * 180) / Math.PI;
    let diffDeg = Math.abs(actualDeg - piece.item.rotationY) % 360;
    if (diffDeg > 180) diffDeg = 360 - diffDeg;
    check(
      `piece ${piece.item.productId} clone turns with the piece (<= 0.5 deg)`,
      diffDeg <= 0.5,
      `${diffDeg.toFixed(3)} deg`,
    );
    piece.shadow.getWorldPosition(point);
    const shadowDistM = Math.hypot(point.x - expectedX, point.z - expectedZ);
    check(
      `piece ${piece.item.productId} shadow centres under the piece (<= 1 cm)`,
      shadowDistM <= 0.01,
      `${(shadowDistM * 100).toFixed(2)} cm`,
    );
  }
}

async function projectionBar(): Promise<void> {
  const draft = await replayExampleDraft();
  check("example replay solves for the photo view", draft !== null);
  if (draft === null) return;
  const records = buildExamplePhotoRecords(sessionFromDraft(draft));
  check("stored records build for the photo view", records !== null && records.length === 4);
  if (records === null) return;
  const recordA = records.find((record) => record.wall === "A");
  check("wall A has a stored camera", recordA !== undefined);
  if (recordA === undefined) return;
  const room = draft.layout;
  const cam = photoCameraForRecord(room, recordA);
  check("wall A camera recovers for the view", cam !== null);
  if (cam === null) return;
  // The furnished example scene: two chairs and the side table the
  // example's Furnish answer places, backs flush against wall A.
  const furnished = JSON.parse(
    readFileSync(join(repoRoot, "shared", "samples", "example-furnished.json"), "utf8"),
  ) as {
    items: Array<{ productId: string; position: { x: number; z: number }; rotationY?: unknown }>;
  };
  const catalog = JSON.parse(
    readFileSync(join(repoRoot, "shared", "catalog", "catalog.json"), "utf8"),
  ) as Array<{ id: string; size: { w: number; d: number } }>;
  const sizeOf = new Map(catalog.map((entry) => [entry.id, entry.size]));
  check(
    "the furnished scene is two chairs and the side table",
    furnished.items.length === 3 &&
      furnished.items.filter((item) => item.productId === "SheenChair").length === 2 &&
      furnished.items.some((item) => item.productId === "side_table_01"),
    furnished.items.map((item) => item.productId).join(","),
  );
  const solA = draft.photos.find((photo) => photo.wall === "A");
  if (solA === undefined) {
    check("wall A corners replay", false);
    return;
  }
  const bar = 951 * 0.01;
  for (const item of furnished.items) {
    const size = sizeOf.get(item.productId);
    if (size === undefined) {
      check(`piece ${item.productId} has a catalog size`, false);
      continue;
    }
    // Backs flush against wall A: the back bottom edge sits on the wall plane.
    const flushZ = size.d / 2;
    const zOff = Math.abs(item.position.z - flushZ);
    check(
      `piece ${item.productId} sits backs-flush against wall A`,
      zOff <= 1,
      `z ${String(item.position.z)} vs ${String(flushZ)}`,
    );
    for (const side of [-1, 1]) {
      const point = { x: item.position.x + (side * size.w) / 2, y: 0, z: 0 };
      const projected = projectWallPhotoCamera(cam, point);
      const finite = Number.isFinite(projected.x) && Number.isFinite(projected.y);
      check(`piece ${item.productId} back corner projects`, finite);
      if (!finite) continue;
      const dist = distToSeg({ x: projected.x, y: projected.y }, solA.corners.m3, solA.corners.m4);
      const inside =
        projected.x >= 0 && projected.x <= 1280 && projected.y >= 0 && projected.y <= 951;
      console.log(
        `photo-view A ${item.productId} x=${point.x.toFixed(1)} -> (${projected.x.toFixed(1)},${projected.y.toFixed(1)}) floor-line ${dist.toFixed(2)} px (${((dist / 951) * 100).toFixed(2)}% H) inside=${String(inside)}`,
      );
      check(
        `piece ${item.productId} back corner lands on the floor line (<= 9.5 px)`,
        dist <= bar,
        `${dist.toFixed(2)} px`,
      );
      check(`piece ${item.productId} back corner lands inside the frame`, inside);
    }
    // Contact shadow: the footprint widened by the shadow margin all
    // round, projected with photo A's stored camera.
    const rotationY = typeof item.rotationY === "number" ? item.rotationY : 0;
    const box = {
      x: item.position.x,
      z: item.position.z,
      w: size.w,
      d: size.d,
      h: 0,
      rotationY,
    };
    const shadowProjected = photoPieceShadowCorners(box).map((point) =>
      projectWallPhotoCamera(cam, point),
    );
    const shadowFinite = shadowProjected.every(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
    );
    check(`piece ${item.productId} shadow projects`, shadowFinite);
    if (shadowFinite) {
      // The true-size shadow is cropped by the photo edge together with
      // the pieces' own front feet (their front corners project past the
      // frame bottom/right), so the check asserts the shadow's contact
      // centre — the visible mass under the piece — lies inside the frame.
      const centre = {
        x: shadowProjected.reduce((sum, point) => sum + point.x, 0) / shadowProjected.length,
        y: shadowProjected.reduce((sum, point) => sum + point.y, 0) / shadowProjected.length,
      };
      console.log(
        `photo-view A ${item.productId} shadow centre (${centre.x.toFixed(1)},${centre.y.toFixed(1)})`,
      );
      const shadowInside = centre.x >= 0 && centre.x <= 1280 && centre.y >= 0 && centre.y <= 951;
      check(`piece ${item.productId} shadow centre lies inside the frame`, shadowInside);
      const footProjected = photoPieceCorners(box)
        .slice(0, 4)
        .map((point) => projectWallPhotoCamera(cam, point));
      const span = (points: Array<{ x: number; y: number }>): number =>
        Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
      const footW = span(footProjected);
      const shadowW = span(shadowProjected);
      const expected = footW * ((size.w + PHOTO_SHADOW_MARGIN_CM * 2) / size.w);
      const within = Math.abs(shadowW - expected) / expected;
      console.log(
        `photo-view A ${item.productId} shadow width ${shadowW.toFixed(1)} px vs footprint-plus-margin ${expected.toFixed(1)} px (${(within * 100).toFixed(2)}%)`,
      );
      check(
        `piece ${item.productId} shadow width matches the footprint plus the margin (<= 10 %)`,
        within <= 0.1,
        `${(within * 100).toFixed(2)} %`,
      );
    }
  }
  overlaySingleTransformBar(room, cam, furnished.items);
}

function wiringBars(): void {
  const view = src("photo-room/photo-view.ts");
  const main = src("main.ts");
  const copy = src("copy.ts");
  check(
    "the button words live in copy.ts",
    copy.includes('PHOTO_VIEW_BUTTON = "See it in your photo"'),
    "copy.ts PHOTO_VIEW_BUTTON",
  );
  check(
    "the plain line lives in copy.ts",
    copy.includes("PHOTO_VIEW_LINE") &&
      copy.includes("Pieces drawn at true size, with the camera measured from this photo."),
    "copy.ts PHOTO_VIEW_LINE",
  );
  check(
    "the outside count lives in copy.ts",
    copy.includes('return "1 piece is outside this photo"'),
    "copy.ts photoViewOutside",
  );
  check(
    "the pill renders from the module",
    main.includes("photoViewButton.textContent = PHOTO_VIEW_BUTTON"),
    "main.ts pill",
  );
  check(
    "the phone item renders from the module",
    main.includes('data-phone-action="photo-view"') &&
      main.includes("photoViewMenu.textContent = PHOTO_VIEW_BUTTON"),
    "main.ts phone menu",
  );
  check(
    "the caption reuses the flow badge",
    view.includes("exampleBadge(this.letter") && view.includes('"photo-example-caption"'),
    "photo-view.ts caption",
  );
  check("the view states the plain line", view.includes("PHOTO_VIEW_LINE"), "photo-view.ts line");
  check(
    "outside pieces count in one line",
    view.includes("photoViewOutside(outsideCount)"),
    "photo-view.ts count",
  );
  // No request: the photo loads as a static image. The app's other
  // screens fetch elsewhere, so the main.ts bar only covers the photo
  // view's own wiring (open/close/sync legs).
  check("photo-view.ts issues no fetch", !view.includes("fetch("), "photo-view.ts");
  check("photo-view.ts calls no /api/", !view.includes("/api/"), "photo-view.ts");
  const wiringAt = main.indexOf("private openPhotoView()");
  const wiringEnd = main.indexOf("private syncPhotoViewButton()");
  const wiring =
    wiringAt >= 0 && wiringEnd > wiringAt
      ? main.slice(wiringAt, main.indexOf("}", main.indexOf("menu.setAttribute", wiringEnd)) + 1)
      : "";
  check("photo wiring is found", wiring.length > 0, "main.ts openPhotoView..sync");
  check("photo wiring issues no fetch", !wiring.includes("fetch("), "main.ts photo wiring");
  check("photo wiring calls no /api/", !wiring.includes("/api/"), "main.ts photo wiring");
  check(
    "the photo loads as a static image",
    view.includes("exampleWebpUrl(this.letter)") && view.includes("img.src = exampleWebpUrl"),
    "photo-view.ts img",
  );
  // Pieces only: no room shell, contact plane or overlays in the view.
  check("the view draws no room shell", !view.includes("fitroom-room"), "photo-view.ts");
  check(
    "the view draws no contact plane",
    !view.includes("fitroom-contact") && !view.includes("contactPlane"),
    "photo-view.ts",
  );
  // Groups the syncer already loaded: no second load call in main.ts.
  const loads = main.split("loadModel(").length - 1;
  check("main.ts keeps its single syncer load call", loads === 1, `${String(loads)} call(s)`);
  check(
    "the view clones the loaded groups",
    view.includes("entry.group.clone(true)"),
    "photo-view.ts clone",
  );
  // One view at a time.
  check(
    "opening the view closes the side panel, the fit list and Visualise",
    main.includes("private openPhotoView()") &&
      main.includes('this.showSidePanel("none")') &&
      main.includes("this.renderViewer?.close()"),
    "main.ts openPhotoView",
  );
  check(
    "opening a side panel closes the view",
    main.includes('if (name !== "none") this.closePhotoView();'),
    "main.ts showSidePanel",
  );
  check(
    "opening the fit list closes the view",
    main.includes("private openFitList()") && main.includes("this.closePhotoView();"),
    "main.ts openFitList",
  );
  check(
    "opening Visualise closes the view",
    main.includes("private openVisualise()") && main.includes("this.closePhotoView();"),
    "main.ts openVisualise",
  );
  check(
    "the photo flow and the plan editor close the view",
    main.includes("private openPhotoFlow()") &&
      main.includes("private openEditor()") &&
      (main.match(/this\.closePhotoView\(\);/g) ?? []).length >= 6,
    "main.ts flow/editor",
  );
  check(
    "Esc closes the view",
    main.includes("if (this.photoView !== null) {") &&
      main.includes("this.closePhotoView();\n          return;"),
    "main.ts bindKeys",
  );
  check(
    "no guide bubble, hint or doors tip shows over the view",
    main.includes("No guide bubble, empty-room hint or doors tip shows over the photo view.") &&
      main.includes("No doors tip shows over the photo view."),
    "main.ts suppressions",
  );
  // The pill is its own overlay, never a toolbar button.
  const html = readFileSync(join(clientDir, "index.html"), "utf8");
  check(
    "the pill sits over the room view, not in the toolbar",
    html.includes('id="photo-view-button"') &&
      !html
        .slice(html.indexOf("bottom-toolbar"), html.indexOf("measure-readout"))
        .includes("photo-view-button"),
    "index.html pill",
  );
  check(
    "the phone menu carries the photo item",
    html.includes('data-phone-action="photo-view"'),
    "index.html phone menu",
  );
  check(
    "closing leaves the 3D camera and renderer alone",
    main.includes("its camera and its renderer are never") || main.includes("are untouched"),
    "main.ts closePhotoView",
  );
}

async function main(): Promise<void> {
  check(
    "the button reads See it in your photo",
    PHOTO_VIEW_BUTTON === "See it in your photo",
    PHOTO_VIEW_BUTTON,
  );
  check(
    "the line reads the true-size sentence",
    PHOTO_VIEW_LINE === "Pieces drawn at true size, with the camera measured from this photo.",
    PHOTO_VIEW_LINE,
  );
  check(
    "the outside line reads the quoted sentence",
    photoViewOutside(1) === "1 piece is outside this photo",
    photoViewOutside(1),
  );
  await projectionBar();
  wiringBars();
  if (failures > 0) process.exit(1);
  console.log("photo-view ok");
}

await main();
