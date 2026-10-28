/**
 * Demo render request: one photoreal visualisation of the example room after
 * the recorded Furnish, from the default (first) dollhouse view.
 *
 * Built with the shared code like the sample room's answers: the prompt
 * comes from `buildRenderPrompt` over the furnished scene, the example room
 * and the catalog, with the first-view wall cutaway (`dollhouseWallView`
 * from the default corner, the same vectors the render check uses). The key
 * input carries the normalised scene (room id + items, no camera) beside
 * `camera: { preset }`, exactly like the committed sample renders, so the
 * recorded answer replays from the demo store with no upstream call.
 *
 * The furnished scene is the replay of the recorded example Furnish turn
 * (`shared/samples/example-furnished.json`, written from the committed
 * assistant store, never by hand). Until that fixture exists the list is
 * empty and there is nothing to record.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRenderPrompt,
  dollhouseWallView,
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

/** First-view camera vectors (default dollhouse corner, like the render check). */
const FIRST_TO_CAM = { x: 0.85 / Math.hypot(0.85, 1), z: 1 / Math.hypot(0.85, 1) };
const FIRST_RIGHT = { x: 1 / Math.hypot(1, 0.85), z: -0.85 / Math.hypot(1, 0.85) };

export interface RenderDemoRequest {
  prompt: string;
  scene: { roomId: string; items: SceneState["items"] };
  camera: { preset: string };
}

/** The example render request, rebuilt deterministically (at most one). */
export function buildRenderDemoRequests(): RenderDemoRequest[] {
  const sharedDir = resolve(serverRoot(), "..", "shared");
  const furnishedFile = resolve(sharedDir, "samples", "example-furnished.json");
  if (!existsSync(furnishedFile)) return [];
  const room = readExampleRoom() as RoomLayout;
  const furnished = readJson(furnishedFile) as SceneState;
  if (!Array.isArray(furnished.items)) return [];
  const catalog = readJson(resolve(sharedDir, "catalog", "catalog.json")) as CatalogItem[];
  const prompt = buildRenderPrompt(
    furnished,
    room,
    catalog,
    dollhouseWallView(room, FIRST_TO_CAM, FIRST_RIGHT),
  );
  return [
    {
      prompt,
      scene: {
        roomId: furnished.roomId,
        items: JSON.parse(JSON.stringify(furnished.items)) as SceneState["items"],
      },
      camera: { preset: "dollhouse" },
    },
  ];
}
