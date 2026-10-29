/**
 * `npm run check:share` — the "Share this layout" link (no browser, no Meta calls).
 *
 * - Encodes and decodes three layouts: the sample room's scene
 *   (`living-420x360.json` + `fit-tests/valid.json`); the example room's
 *   built layout (`example-room.json`, as `check:example-geometry` solves it)
 *   with a furnished scene (`example-furnished.json`); and a typed-in room.
 *   Each round trip is equal on every allowed field: the walls as points with
 *   height and thickness; the openings; the fixtures; own pieces' footprints
 *   and heights (never their labels); the surface ids and tints; each piece's
 *   product id, variant, position and rotation. Re-encoding is stable.
 * - The decoder rejects unknown fields and out-of-range numbers: walls
 *   outside `SIDE_MIN_CM`-`SIDE_MAX_CM` and heights outside
 *   `CEIL_MIN_CM`-`CEIL_MAX_CM` (both from `room-units.ts`); pieces outside
 *   the room; product ids or variants not in the catalog; surface ids not in
 *   `FLOOR_FINISHES`/`WALL_FINISHES` or the sample's `oak-light`/`warm-white`;
 *   tints that are not `#RRGGBB`.
 * - Every decoded room and scene passes `validateRoomLayout`/`validateSceneState`.
 * - The sample scene's link stays under 2,000 characters.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global Buffer, console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateRoomLayout,
  validateSceneState,
  type RoomLayout,
  type SceneState,
} from "@fitroom/shared";
import { decodeLayout, encodeLayout, LAYOUT_PREFIX } from "../src/layout-share.js";
import { CEIL_MAX_CM, CEIL_MIN_CM, SIDE_MAX_CM, SIDE_MIN_CM } from "../src/room-units.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharedRoot = join(root, "..", "shared");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const catalog = JSON.parse(
  readFileSync(join(sharedRoot, "catalog", "catalog.json"), "utf8"),
) as Array<{ id: string }>;
const catalogMap = new Map(
  (catalog as Array<{ id: string; variants: Array<{ name: string }> }>).map((entry) => [
    entry.id,
    entry,
  ]),
);

function loadSample(name: string): unknown {
  return JSON.parse(readFileSync(join(sharedRoot, "samples", name), "utf8"));
}

function toB64Url(json: string): string {
  return Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64Url(payload: string): unknown {
  let b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/** The raw payload object behind a fragment, for tampering. */
function payloadOf(fragment: string): Record<string, unknown> {
  return fromB64Url(fragment.slice(`#${LAYOUT_PREFIX}`.length)) as Record<string, unknown>;
}

function fragmentOf(payload: unknown): string {
  return `#${LAYOUT_PREFIX}${toB64Url(JSON.stringify(payload))}`;
}

/** Round-trip equality on every allowed field (ids regenerate; labels never travel). */
function checkRoundTrip(label: string, room: RoomLayout, scene: SceneState): string | null {
  const fragment = encodeLayout(room, scene);
  const decoded = decodeLayout(fragment, catalogMap);
  if (decoded === null) {
    check(`${label} round trip decodes`, false, fragment.slice(0, 40));
    return null;
  }
  const again = encodeLayout(decoded.room, decoded.scene);
  check(`${label} re-encodes stably`, again === fragment, label);
  const roomOk = validateRoomLayout(decoded.room).ok;
  const sceneOk = validateSceneState(decoded.scene).ok;
  check(`${label} decoded room validates`, roomOk, label);
  check(`${label} decoded scene validates`, sceneOk, label);

  const wallsOk =
    decoded.room.walls.length === room.walls.length &&
    decoded.room.walls.every(
      (wall, i) =>
        wall.start.x === Math.round(room.walls[i]!.start.x) &&
        wall.start.z === Math.round(room.walls[i]!.start.z) &&
        wall.end.x === Math.round(room.walls[i]!.end.x) &&
        wall.end.z === Math.round(room.walls[i]!.end.z) &&
        wall.height === Math.round(room.walls[i]!.height) &&
        wall.thickness === Math.round(room.walls[i]!.thickness),
    );
  check(`${label} walls round trip as points`, wallsOk, label);

  const openingsOk =
    decoded.room.openings.length === room.openings.length &&
    decoded.room.openings.every((opening, i) => {
      const wallIdx = room.walls.findIndex((wall) => wall.id === room.openings[i]!.wallId);
      const decodedWallIdx = decoded.room.walls.findIndex((wall) => wall.id === opening.wallId);
      const want = room.openings[i]!;
      return (
        decodedWallIdx === wallIdx &&
        opening.type === want.type &&
        opening.offset === Math.round(want.offset) &&
        opening.width === Math.round(want.width) &&
        opening.height === Math.round(want.height) &&
        opening.sillHeight === Math.round(want.sillHeight)
      );
    });
  check(`${label} openings round trip`, openingsOk, label);

  const fixturesOk =
    decoded.room.fixtures.length === room.fixtures.length &&
    decoded.room.fixtures.every((fixture, i) => {
      const wallIdx = room.walls.findIndex((wall) => wall.id === room.fixtures[i]!.wallId);
      const decodedWallIdx = decoded.room.walls.findIndex((wall) => wall.id === fixture.wallId);
      const want = room.fixtures[i]!;
      return (
        decodedWallIdx === wallIdx &&
        fixture.type === want.type &&
        fixture.offset === Math.round(want.offset) &&
        fixture.width === Math.round(want.width) &&
        fixture.height === Math.round(want.height) &&
        fixture.depth === Math.round(want.depth)
      );
    });
  check(`${label} fixtures round trip`, fixturesOk, label);

  const existingOk =
    decoded.room.existing.length === room.existing.length &&
    decoded.room.existing.every((own, i) => {
      const want = room.existing[i]!;
      return (
        own.footprint.x === Math.round(want.footprint.x) &&
        own.footprint.z === Math.round(want.footprint.z) &&
        own.footprint.w === Math.round(want.footprint.w) &&
        own.footprint.d === Math.round(want.footprint.d) &&
        own.footprint.rotationY === Math.round(want.footprint.rotationY) &&
        own.height === Math.round(want.height) &&
        own.label !== "" &&
        own.label !== want.label
      );
    });
  check(`${label} own pieces round trip without labels`, existingOk, label);

  const surfacesOk =
    decoded.room.surfaces.floor === room.surfaces.floor &&
    decoded.room.surfaces.wall === room.surfaces.wall &&
    (decoded.room.surfaces.wallTint ?? null) === (room.surfaces.wallTint ?? null);
  check(`${label} surfaces round trip`, surfacesOk, label);

  const itemsOk =
    decoded.scene.items.length === scene.items.length &&
    decoded.scene.items.every((got, i) => {
      const want = scene.items[i]!;
      return (
        got.productId === want.productId &&
        got.variant === want.variant &&
        got.position.x === Math.round(want.position.x) &&
        got.position.z === Math.round(want.position.z) &&
        got.rotationY === Math.round(want.rotationY)
      );
    });
  check(`${label} pieces round trip`, itemsOk, label);
  return fragment;
}

// ---- layout 1: the sample room's scene ----
const sampleRoom = loadSample("living-420x360.json") as RoomLayout;
const sampleScene = loadSample("fit-tests/valid.json") as SceneState;
const sampleFragment = checkRoundTrip("sample", sampleRoom, sampleScene);
if (sampleFragment !== null) {
  check(
    `sample link stays under 2,000 characters (${String(sampleFragment.length)})`,
    sampleFragment.length < 2000,
    String(sampleFragment.length),
  );
  console.log(`sample link length: ${String(sampleFragment.length)}`);
}

// ---- layout 2: the example room's built layout with a furnished scene ----
const exampleRoom = loadSample("example-room.json") as RoomLayout;
const exampleScene = loadSample("example-furnished.json") as SceneState;
checkRoundTrip("example", exampleRoom, exampleScene);

// ---- layout 3: a typed-in room ----
const typedRoom: RoomLayout = {
  id: "manual-room",
  name: "My room",
  units: "cm",
  walls: [
    { id: "wall-1", start: { x: 0, z: 0 }, end: { x: 420, z: 0 }, height: 250, thickness: 10 },
    { id: "wall-2", start: { x: 420, z: 0 }, end: { x: 420, z: 360 }, height: 250, thickness: 10 },
    { id: "wall-3", start: { x: 420, z: 360 }, end: { x: 0, z: 360 }, height: 250, thickness: 10 },
    { id: "wall-4", start: { x: 0, z: 360 }, end: { x: 0, z: 0 }, height: 250, thickness: 10 },
  ],
  openings: [
    {
      id: "door-1",
      wallId: "wall-1",
      type: "door",
      offset: 30,
      width: 90,
      height: 210,
      sillHeight: 0,
      hinge: "left",
      swing: "in",
    },
  ],
  fixtures: [
    {
      id: "fixture-1",
      wallId: "wall-3",
      type: "radiator",
      offset: 90,
      width: 140,
      height: 60,
      depth: 10,
    },
  ],
  existing: [
    {
      id: "own-1",
      label: "My piece",
      footprint: { x: 50, z: 50, w: 80, d: 60, rotationY: 0 },
      height: 70,
    },
  ],
  surfaces: { floor: "WoodFloor070", wall: "PaintedPlaster017", wallTint: "#A8A29E" },
  style: { tags: [], dominantColors: [] },
  source: "manual",
  confidence: 1,
};
const typedScene: SceneState = {
  roomId: "manual-room",
  items: [
    {
      instanceId: "typed-1",
      productId: "SheenChair",
      position: { x: 210, z: 180 },
      rotationY: 0,
      variant: "Mango Velvet",
    },
    {
      instanceId: "typed-2",
      productId: "sofa_02",
      position: { x: 100, z: 100 },
      rotationY: 90,
      variant: "default",
    },
  ],
  camera: {
    mode: "orbit",
    position: { x: 3.4, y: 3.1, z: 4.2 },
    target: { x: 2.1, y: 0, z: 1.8 },
  },
};
check(
  "typed room validates before sharing",
  validateRoomLayout(typedRoom).ok && validateSceneState(typedScene).ok,
);
checkRoundTrip("typed", typedRoom, typedScene);

// ---- rejections: unknown fields and out-of-range numbers ----
if (sampleFragment !== null) {
  const base = payloadOf(sampleFragment);
  const tamper = (
    name: string,
    mutate: (payload: Record<string, unknown>) => void,
    control = false,
  ): void => {
    const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    mutate(copy);
    const result = decodeLayout(fragmentOf(copy), catalogMap);
    check(
      control ? `${name} still decodes` : `${name} is rejected`,
      control ? result !== null : result === null,
      name,
    );
  };
  tamper("unknown top-level field", (payload) => {
    payload["z"] = 1;
  });
  tamper("wall shorter than SIDE_MIN_CM", (payload) => {
    (payload["w"] as number[][])[0] = [0, 0, SIDE_MIN_CM - 50, 0, 260, 12];
  });
  tamper("wall longer than SIDE_MAX_CM", (payload) => {
    (payload["w"] as number[][])[0] = [0, 0, SIDE_MAX_CM + 100, 0, 260, 12];
  });
  tamper("wall lower than CEIL_MIN_CM", (payload) => {
    (payload["w"] as number[][])[0]![4] = CEIL_MIN_CM - 50;
  });
  tamper("wall higher than CEIL_MAX_CM", (payload) => {
    (payload["w"] as number[][])[0]![4] = CEIL_MAX_CM + 100;
  });
  tamper("piece outside the room", (payload) => {
    (payload["p"] as unknown[][])[0]![2] = 9999;
  });
  tamper("unknown product id", (payload) => {
    (payload["p"] as unknown[][])[0]![0] = "no-such-piece";
  });
  tamper("unknown variant", (payload) => {
    (payload["p"] as unknown[][])[0] = ["SheenChair", "No Such Velvet", 210, 180, 0];
  });
  tamper("variant on a variant-free product", (payload) => {
    (payload["p"] as unknown[][])[0]![1] = "Nope";
  });
  tamper("unknown floor finish", (payload) => {
    (payload["s"] as unknown[])[0] = "shag-carpet";
  });
  tamper("unknown wall finish", (payload) => {
    (payload["s"] as unknown[])[1] = "wallpaper-x";
  });
  tamper("non-hex tint", (payload) => {
    (payload["s"] as unknown[])[2] = "red";
  });
  tamper("malformed tint", (payload) => {
    (payload["s"] as unknown[])[2] = "#GGGGGG";
  });
  tamper(
    "sample tint decodes",
    (payload) => {
      (payload["s"] as unknown[])[2] = "#A8A29E";
    },
    true,
  );
  check("empty hash is rejected", decodeLayout("", catalogMap) === null);
  check("wrong version is rejected", decodeLayout("#layout=2.abc", catalogMap) === null);
  check("broken payload is rejected", decodeLayout("#layout=1.!!!", catalogMap) === null);
  check(
    "no photo, room, piece or shopper name travels",
    !sampleFragment.includes("Living room") &&
      !sampleFragment.includes("living-420x360") &&
      !sampleFragment.includes("photo") &&
      !sampleFragment.includes("My piece"),
  );
}

if (failures > 0) {
  console.log(`check:share: ${String(failures)} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("check:share: all checks passed");
}
