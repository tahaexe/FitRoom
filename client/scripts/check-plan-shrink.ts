/**
 * `npm run check:plan-shrink` — a plan change keeps every piece inside.
 *
 * A 400 x 350 room with no openings, a Rhythm TV Unit against the east
 * wall and a small piece in the middle; the width wall shortens to 380
 * the way the plan editor does it (`setRectangleWallLength`). Afterwards
 * every piece passes `isInsideRoom` and no fit issue is "outside", and
 * the middle piece keeps its place. Headless (no browser, no Meta calls).
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FitEngine, createRectangleRoom, setRectangleWallLength } from "@fitroom/shared";
import type { CatalogItem, RoomLayout, SceneItem, SceneState } from "@fitroom/shared";
import { isInsideRoom, movePiecesInside } from "../src/state.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..");
const sharedRoot = join(clientDir, "..", "shared");

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
) as CatalogItem[];
const catalogMap = new Map(catalog.map((entry) => [entry.id, entry]));
const products = new Map(
  catalog.map((entry) => [
    entry.id,
    { size: entry.size, category: entry.category, name: entry.name },
  ]),
);

check(
  "plan-shrink:catalog-holds-the-tv-unit",
  catalogMap.has("modern_wooden_cabinet"),
  "modern_wooden_cabinet",
);
check("plan-shrink:catalog-holds-a-side-table", catalogMap.has("side_table_01"), "side_table_01");

const room = createRectangleRoom({
  widthCm: 400,
  depthCm: 350,
  heightCm: 250,
  id: "manual-room",
  name: "My room",
});
check("plan-shrink:room-has-no-openings", room.openings.length === 0, "openings");

const wallPiece: SceneItem = {
  instanceId: "tv-1",
  productId: "modern_wooden_cabinet",
  position: { x: 372, z: 175 },
  rotationY: 90,
  variant: "default",
};
const middlePiece: SceneItem = {
  instanceId: "middle-1",
  productId: "side_table_01",
  position: { x: 200, z: 175 },
  rotationY: 0,
  variant: "default",
};
const scene: SceneState = {
  roomId: room.id,
  items: [wallPiece, middlePiece],
  camera: {
    mode: "orbit",
    position: { x: 3.4, y: 3.1, z: 4.2 },
    target: { x: 2.1, y: 0, z: 1.8 },
  },
};

const fitCheckFor = (active: RoomLayout) => {
  const engine = new FitEngine(active, products);
  return (items: SceneItem[]) => engine.check({ ...scene, roomId: active.id, items });
};

check("plan-shrink:wall-piece-starts-inside", isInsideRoom(wallPiece, catalogMap, room), "tv-1");
check(
  "plan-shrink:middle-piece-starts-inside",
  isInsideRoom(middlePiece, catalogMap, room),
  "middle-1",
);
check(
  "plan-shrink:no-outside-issue-before-the-edit",
  !fitCheckFor(room)(scene.items).some((issue) => issue.type === "outside"),
  "outside",
);

// The plan editor shortens the width wall from 400 to 380.
const shrunk = setRectangleWallLength(room, "wall-1", 380);
const shrunkFit = fitCheckFor(shrunk);
const shrunkOutsideIssue = shrunkFit(scene.items).some(
  (issue) => issue.type === "outside" && issue.itemIds.includes("tv-1"),
);
check(
  "plan-shrink:shortened-wall-leaves-the-tv-outside",
  !isInsideRoom(wallPiece, catalogMap, shrunk) || shrunkOutsideIssue,
  "tv-1 still inside after the shrink",
);

const moves = movePiecesInside(shrunk, catalogMap, scene, shrunkFit);
check("plan-shrink:one-piece-moves", moves.length === 1, String(moves.length));
check(
  "plan-shrink:the-wall-piece-moves",
  moves.some((move) => move.instanceId === "tv-1"),
  JSON.stringify(moves.map((move) => move.instanceId)),
);
check(
  "plan-shrink:the-middle-piece-keeps-its-place",
  !moves.some((move) => move.instanceId === "middle-1"),
  JSON.stringify(moves.map((move) => move.instanceId)),
);

const byId = new Map(moves.map((move) => [move.instanceId, move]));
const fixed: SceneItem[] = scene.items.map((item) => {
  const move = byId.get(item.instanceId);
  if (move === undefined) return item;
  return { ...item, position: { ...move.position }, rotationY: move.rotationY };
});
check(
  "plan-shrink:every-piece-is-inside-afterwards",
  fixed.every((item) => isInsideRoom(item, catalogMap, shrunk)),
  JSON.stringify(fixed.map((item) => isInsideRoom(item, catalogMap, shrunk))),
);
check(
  "plan-shrink:no-outside-issue-afterwards",
  !shrunkFit(fixed).some((issue) => issue.type === "outside"),
  JSON.stringify(shrunkFit(fixed).map((issue) => issue.type)),
);
const fixedMiddle = fixed.find((item) => item.instanceId === "middle-1");
check(
  "plan-shrink:middle-piece-position-unchanged",
  fixedMiddle?.position.x === 200 &&
    fixedMiddle?.position.z === 175 &&
    fixedMiddle?.rotationY === 0,
  JSON.stringify(fixedMiddle?.position),
);
check(
  "plan-shrink:nothing-moves-when-everything-is-inside",
  movePiecesInside(room, catalogMap, scene, fitCheckFor(room)).length === 0,
  "moves in the unshrunk room",
);

// The committed plan edit applies the moves as one scene-store commit.
const mainSrc = readFileSync(join(clientDir, "src", "main.ts"), "utf8");
const committedAt = mainSrc.indexOf("this.editorStore.onCommitted((room) => {");
const committedBlock = committedAt >= 0 ? mainSrc.slice(committedAt, committedAt + 1800) : "";
check(
  "plan-shrink:committed-edit-moves-pieces-inside",
  committedBlock.includes("movePiecesInside(ROOM, CATALOG_MAP, this.store.state"),
  "main.ts onCommitted",
);
check(
  "plan-shrink:committed-edit-commits-once",
  committedBlock.includes("planMoves.length > 0") &&
    committedBlock.includes("this.store.commit((draft) => {"),
  "main.ts onCommitted",
);

if (failures > 0) {
  console.log(`check:plan-shrink: ${String(failures)} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("check:plan-shrink: all checks passed");
}
