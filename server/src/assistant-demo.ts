/**
 * Demo assistant requests: the six scripted turns for the demo room (the
 * sample room with `shared/samples/fit-tests/valid.json`) — five
 * arrangements plus the impossible one.
 *
 * Each entry is the turn's first round: the customer text, the conversation
 * so far (just that text), the room and the start scene. Later rounds append
 * the stored tool calls and their executor results, so every round has its
 * own demo-store entry. `demo-requests.ts` embeds their output;
 * `check:assistant` rebuilds and compares.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantRequest, RoomLayout, SceneState } from "@fitroom/shared";

export const ASSISTANT_DEMO_REQUESTS: string[] = [
  "Put the sofa under the window and keep 80 cm free in front of the door.",
  "Swap the black sofa for the Provence loveseat, in navy.",
  "Add a side table on the right of the armchair.",
  "I want a second armchair facing the sofa.",
  "Move the TV unit to the west wall and turn the sofa to face it.",
  "Put the Heritage Grand Sofa on the wall between the door and the corner.",
];

function serverRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** The six demo turns, rebuilt deterministically. */
export function buildAssistantDemoRequests(): AssistantRequest[] {
  const sharedDir = resolve(serverRoot(), "..", "shared");
  const room = readJson(resolve(sharedDir, "samples", "living-420x360.json")) as RoomLayout;
  const scene = readJson(resolve(sharedDir, "samples", "fit-tests", "valid.json")) as SceneState;
  return ASSISTANT_DEMO_REQUESTS.map((request) => ({
    request,
    messages: [{ role: "user" as const, content: request }],
    room: JSON.parse(JSON.stringify(room)) as RoomLayout,
    scene: JSON.parse(JSON.stringify(scene)) as SceneState,
  }));
}
