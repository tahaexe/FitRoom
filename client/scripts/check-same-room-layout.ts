/**
 * `npm run check:same-room-layout` — headless `sameRoomLayout` check (no
 * browser, no Meta calls).
 *
 * Drives the real `sameRoomLayout` from `client/src/state.ts` through an
 * equal copy, one wall changed (wall 1 to 380 cm) and one opening moved,
 * the three cases `resetDemoRoom` and `isSampleScene` rely on.
 */

/* global console, process */
import { sameRoomLayout } from "../src/state.js";
import type { RoomLayout } from "@fitroom/shared";

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function sampleShell(): RoomLayout {
  return {
    id: "sample-room",
    name: "Sample living room",
    units: "cm",
    walls: [
      { id: "wall-1", start: { x: 0, z: 0 }, end: { x: 420, z: 0 }, height: 250, thickness: 10 },
      {
        id: "wall-2",
        start: { x: 420, z: 0 },
        end: { x: 420, z: 360 },
        height: 250,
        thickness: 10,
      },
      {
        id: "wall-3",
        start: { x: 420, z: 360 },
        end: { x: 0, z: 360 },
        height: 250,
        thickness: 10,
      },
      { id: "wall-4", start: { x: 0, z: 360 }, end: { x: 0, z: 0 }, height: 250, thickness: 10 },
    ],
    openings: [
      {
        id: "door-1",
        wallId: "wall-1",
        type: "door",
        offset: 100,
        width: 80,
        height: 210,
        sillHeight: 0,
        hinge: "left",
        swing: "in",
      },
    ],
    fixtures: [],
    existing: [],
    surfaces: { floor: "WoodFloor039", wall: "PaintedPlaster017" },
    style: { tags: [], dominantColors: [] },
    source: "sample",
    confidence: 1,
  };
}

function main(): void {
  const room = sampleShell();
  const equal = JSON.parse(JSON.stringify(room)) as RoomLayout;
  check("same-room-layout:equal-copy", sameRoomLayout(room, equal) === true);

  const wallChanged = JSON.parse(JSON.stringify(room)) as RoomLayout;
  wallChanged.walls[0] = { ...wallChanged.walls[0]!, end: { x: 380, z: 0 } };
  check("same-room-layout:one-wall-changed", sameRoomLayout(room, wallChanged) === false);

  const openingMoved = JSON.parse(JSON.stringify(room)) as RoomLayout;
  const opening = openingMoved.openings[0];
  if (opening === undefined) {
    check("same-room-layout:one-opening-moved", false, "fixture has no opening");
  } else {
    openingMoved.openings[0] = { ...opening, offset: 120 };
    check("same-room-layout:one-opening-moved", sameRoomLayout(room, openingMoved) === false);
  }

  if (failures > 0) process.exit(1);
  console.log("same-room-layout: all checks passed");
}

main();
