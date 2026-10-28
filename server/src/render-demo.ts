/**
 * Demo render requests: the sample room's recorded views (the valid demo
 * scene, the moved-sofa view and the navy-swap view, all from the first
 * dollhouse view) plus one photoreal visualisation of the example room
 * after the recorded Furnish, from the same first view.
 *
 * Built with the shared code: each prompt comes from `buildRenderPrompt`
 * over its scene, its room and the catalog, with the first-view wall
 * cutaway (`dollhouseWallView` from the client's own first-view framing
 * `firstViewVectors`, the same vectors the render check uses). The key
 * input carries the normalised scene (room id + items, no camera) beside
 * `camera: { preset }`, exactly like the committed renders, so each
 * recorded answer replays from the demo store with no upstream call.
 *
 * The sample scenes are the committed demo views (never by hand): the
 * valid demo scene (`shared/samples/fit-tests/valid.json`), the same room
 * with the Chester sofa moved under the window, and the same room with the
 * navy Provence loveseat swap. The example furnished scene is the replay of
 * the recorded example Furnish turn (`shared/samples/example-furnished.json`,
 * written from the committed assistant store, never by hand).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRenderPrompt,
  dollhouseWallView,
  firstViewVectors,
  type CatalogItem,
  type RoomLayout,
  type SceneState,
} from "@fitroom/shared";
import { readExampleRoom } from "./assistant-demo.js";

function serverRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** First-view camera vectors (the client's own first-view framing). */
function firstViewFor(room: RoomLayout): {
  toCam: { x: number; z: number };
  right: { x: number; z: number };
} {
  return firstViewVectors(room);
}

export interface RenderDemoRequest {
  prompt: string;
  scene: { roomId: string; items: SceneState["items"] };
  camera: { preset: string };
}

/** The sample room's recorded views, rebuilt deterministically (three). */
export function buildSampleRenderDemoRequests(): RenderDemoRequest[] {
  const sharedDir = resolve(serverRoot(), "..", "shared");
  const room = readJson(resolve(sharedDir, "samples", "living-420x360.json")) as RoomLayout;
  const valid = readJson(resolve(sharedDir, "samples", "fit-tests", "valid.json")) as SceneState;
  const catalog = readJson(resolve(sharedDir, "catalog", "catalog.json")) as CatalogItem[];
  const first = firstViewFor(room);
  const view = dollhouseWallView(room, first.toCam, first.right);
  const baseItems = JSON.parse(JSON.stringify(valid.items)) as SceneState["items"];
  const movedItems = JSON.parse(JSON.stringify(valid.items)) as SceneState["items"];
  for (const item of movedItems) {
    if (item.productId === "sofa_02") {
      item.position = { x: 260, z: 309 };
      item.rotationY = 180;
    }
  }
  const navyItems = (JSON.parse(JSON.stringify(valid.items)) as SceneState["items"])
    .filter((item) => item.productId !== "sofa_02")
    .concat([
      {
        instanceId: "Sofa_01",
        productId: "Sofa_01",
        position: { x: 33, z: 200 },
        rotationY: 90,
        variant: "Navy",
      },
    ]);
  const scenes = [baseItems, movedItems, navyItems];
  return scenes.map((items) => {
    const scene = {
      roomId: "living-420x360",
      items: JSON.parse(JSON.stringify(items)) as SceneState["items"],
      camera: {
        mode: "orbit",
        position: { x: 0, y: 0, z: 0 },
        target: { x: 0, y: 0, z: 0 },
      },
    } as unknown as SceneState;
    const prompt = buildRenderPrompt(scene, room, catalog, view);
    return {
      prompt,
      scene: {
        roomId: "living-420x360",
        items: JSON.parse(JSON.stringify(items)) as SceneState["items"],
      },
      camera: { preset: "dollhouse" },
    };
  });
}

/** All render requests, rebuilt deterministically (three sample + at most one example). */
export function buildRenderDemoRequests(): RenderDemoRequest[] {
  const sharedDir = resolve(serverRoot(), "..", "shared");
  const furnishedFile = resolve(sharedDir, "samples", "example-furnished.json");
  const out = buildSampleRenderDemoRequests();
  if (!existsSync(furnishedFile)) return out;
  const room = readExampleRoom() as RoomLayout;
  const furnished = readJson(furnishedFile) as SceneState;
  if (!Array.isArray(furnished.items)) return out;
  const catalog = readJson(resolve(sharedDir, "catalog", "catalog.json")) as CatalogItem[];
  const first = firstViewFor(room);
  const prompt = buildRenderPrompt(
    furnished,
    room,
    catalog,
    dollhouseWallView(room, first.toCam, first.right),
  );
  out.push({
    prompt,
    scene: {
      roomId: furnished.roomId,
      items: JSON.parse(JSON.stringify(furnished.items)) as SceneState["items"],
    },
    camera: { preset: "dollhouse" },
  });
  return out;
}
