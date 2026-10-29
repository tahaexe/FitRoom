/**
 * Demo assistant requests: the six scripted turns for the demo room (the
 * sample room with `shared/samples/fit-tests/valid.json`) — five
 * arrangements plus the impossible one — and three furnishing briefs on the
 * same demo room (seats 4 classic $2,500; seats 2 modern $1,500; seats 4
 * scandinavian $2,000), all with `keepExisting` false.
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
import {
  buildBriefRequest,
  EXAMPLE_ROOM_STYLE,
  EXAMPLE_ROOM_SURFACES,
  type AssistantBrief,
  type AssistantRequest,
  type RoomLayout,
  type SceneState,
} from "@fitroom/shared";

export const ASSISTANT_DEMO_REQUESTS: string[] = [
  "Put the sofa under the window and keep 80 cm free in front of the door.",
  "Swap the black sofa for the Provence loveseat, in navy.",
  "Add a side table on the right of the armchair.",
  "I want a second armchair facing the sofa.",
  "Move the TV unit to the west wall and turn the sofa to face it.",
  "Put the Heritage Grand Sofa on the wall between the door and the corner.",
];

/** The three demo furnishing briefs (seats, style, budget, empty room). */
export const ASSISTANT_DEMO_BRIEFS: AssistantBrief[] = [
  { seats: 4, style: "classic", budget: 2500, keepExisting: false },
  { seats: 2, style: "modern", budget: 1500, keepExisting: false },
  { seats: 4, style: "scandinavian", budget: 2000, keepExisting: false },
];

/** Request texts of the three demo briefs, built like the panel builds them. */
export function assistantDemoBriefRequests(): string[] {
  return ASSISTANT_DEMO_BRIEFS.map((brief) => buildBriefRequest(brief));
}

function serverRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** The demo turns, rebuilt deterministically (six arrangements + three briefs). */
export function buildAssistantDemoRequests(): AssistantRequest[] {
  const sharedDir = resolve(serverRoot(), "..", "shared");
  const room = readJson(resolve(sharedDir, "samples", "living-420x360.json")) as RoomLayout;
  const scene = readJson(resolve(sharedDir, "samples", "fit-tests", "valid.json")) as SceneState;
  const arrange: AssistantRequest[] = ASSISTANT_DEMO_REQUESTS.map((request) => ({
    request,
    messages: [{ role: "user" as const, content: request }],
    room: JSON.parse(JSON.stringify(room)) as RoomLayout,
    scene: JSON.parse(JSON.stringify(scene)) as SceneState,
  }));
  const furnish: AssistantRequest[] = ASSISTANT_DEMO_BRIEFS.map((brief) => {
    const request = buildBriefRequest(brief);
    return {
      request,
      messages: [{ role: "user" as const, content: request }],
      room: JSON.parse(JSON.stringify(room)) as RoomLayout,
      scene: JSON.parse(JSON.stringify(scene)) as SceneState,
      brief: { ...brief },
    };
  });
  return [...arrange, ...furnish];
}

/**
 * The example room's built layout, exactly as the client builds it after
 * "Build my room" (`client/src/photo-room/flow.ts` build + applyLabel):
 * photo-solved with A taped 420 and B estimated, then the recorded label
 * answer's style tags and colours
 * (`server/data/demo/label/27e8386c9a009618b9d692c360fb969723c6c1ee4b74d7e5b7d34a6fc56c8886.json`:
 * minimalist/scandinavian/bright, #f2eee6/#d9c19a/#8a6742), the wood-family
 * shared example finishes (`EXAMPLE_ROOM_SURFACES` /
 * `EXAMPLE_ROOM_STYLE`): light-oak floor `WoodFloor039`, paint `PaintedPlaster017`
 * (`pickWallTexture`) and the blended wall tint `#DEDEDC`
 * (`blendWallTints` over the per-photo tints in `surfaceColors`).
 * The fixture `shared/samples/example-room.json` already holds this
 * post-build room; the overlay below keeps the builders exact even if the
 * fixture geometry is re-solved.
 */
export function readExampleRoom(): RoomLayout {
  const sharedDir = resolve(serverRoot(), "..", "shared");
  const room = readJson(resolve(sharedDir, "samples", "example-room.json")) as RoomLayout;
  room.style = {
    tags: [...EXAMPLE_ROOM_STYLE.tags],
    dominantColors: [...EXAMPLE_ROOM_STYLE.dominantColors],
  };
  room.surfaces = { ...EXAMPLE_ROOM_SURFACES };
  return room;
}

export function emptyExampleScene(): SceneState {
  return {
    roomId: "photos-room",
    items: [],
    camera: {
      mode: "orbit",
      position: { x: 3.4, y: 3.1, z: 4.2 },
      target: { x: 2.1, y: 0, z: 1.8 },
    },
  };
}

/**
 * The example room's scripted arrange chips recorded for the demo: the
 * first chip and the impossible one, on the built (empty) layout.
 */
export const EXAMPLE_ASSISTANT_DEMO_CHIPS: string[] = [
  ASSISTANT_DEMO_REQUESTS[0] as string,
  ASSISTANT_DEMO_REQUESTS[5] as string,
];

/** The example brief recorded for the demo: seats 2, modern, under $1,500. */
export const EXAMPLE_ASSISTANT_DEMO_BRIEF: AssistantBrief = {
  ...(ASSISTANT_DEMO_BRIEFS[1] as AssistantBrief),
};

/**
 * The example demo turns, rebuilt deterministically (one brief + two
 * arrangements, all on the built empty layout). `demo-requests.ts` embeds
 * their output; `check:assistant` replays them from the store.
 */
export function buildExampleAssistantDemoRequests(): AssistantRequest[] {
  const room = readExampleRoom();
  const scene = emptyExampleScene();
  const brief = EXAMPLE_ASSISTANT_DEMO_BRIEF;
  const briefRequest = buildBriefRequest(brief);
  const first: AssistantRequest = {
    request: briefRequest,
    messages: [{ role: "user" as const, content: briefRequest }],
    room: JSON.parse(JSON.stringify(room)) as RoomLayout,
    scene: JSON.parse(JSON.stringify(scene)) as SceneState,
    brief: { ...brief },
  };
  const arrange: AssistantRequest[] = EXAMPLE_ASSISTANT_DEMO_CHIPS.map((request) => ({
    request,
    messages: [{ role: "user" as const, content: request }],
    room: JSON.parse(JSON.stringify(room)) as RoomLayout,
    scene: JSON.parse(JSON.stringify(scene)) as SceneState,
  }));
  return [first, ...arrange];
}
