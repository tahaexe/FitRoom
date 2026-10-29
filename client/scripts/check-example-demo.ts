/**
 * `npm run check:example-demo` — headless example-demo key check (no browser,
 * no Meta calls).
 *
 * Builds the example room with the client's own code (`flow.ts` example
 * branch: fixture `shared/samples/example-room.json` plus the shared
 * `EXAMPLE_ROOM_STYLE` / `EXAMPLE_ROOM_SURFACES`), forms each example
 * request body exactly as the client sends it (Arrange chips, the brief,
 * "What fits here?" runs, Visualise after the brief), computes each key
 * with `server/src/meta/keys.ts` plus the route's own key-input function,
 * and asserts the file exists in `server/data/demo/<route>/`.
 *
 * Prints PASS or FAIL per case and exits non-zero on any FAIL.
 */

/* global console, process */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeFreeSpace,
  buildBriefRequest,
  buildRecommendRequest,
  buildRenderPrompt,
  dollhouseWallView,
  EXAMPLE_ROOM_STYLE,
  EXAMPLE_ROOM_SURFACES,
  firstViewVectors,
  recommendIgnoreIds,
  FitEngine,
  type CatalogItem,
  type RecommendRequest,
  type RoomLayout,
  type SceneState,
} from "@fitroom/shared";
import { EXAMPLE_ASSISTANT_DEMO_CHIPS } from "../src/assistant/panel.js";
import { gatewayKey } from "../../server/src/meta/keys.js";
import { assistantKeyInput } from "../../server/src/routes/assistant.js";
import { recommendKeyInput } from "../../server/src/routes/recommend.js";
import { renderDef } from "../../server/src/routes/render.js";
import { META_MODELS } from "../../server/src/meta/models.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");
const repoRoot = resolve(clientDir, "..");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** Example room exactly as the client's example branch builds it. */
function buildClientExampleRoom(): RoomLayout {
  const room = readJson(join(repoRoot, "shared", "samples", "example-room.json")) as RoomLayout;
  room.style = {
    tags: [...EXAMPLE_ROOM_STYLE.tags],
    dominantColors: [...EXAMPLE_ROOM_STYLE.dominantColors],
  };
  room.surfaces = { ...EXAMPLE_ROOM_SURFACES };
  return room;
}

function emptyScene(): SceneState {
  return {
    roomId: "photos-room",
    items: [],
    camera: {
      mode: "orbit",
      position: { x: 3.4, y: 3.1, z: 4.2 },
      target: { x: 2.1, y: 0, z: 1.8 },
    },
  } as unknown as SceneState;
}

function demoFile(route: string, key: string): string {
  return join(repoRoot, "server", "data", "demo", route, `${key}.json`);
}

function main(): void {
  const room = buildClientExampleRoom();
  const scene = emptyScene();
  check(
    "example room floor is the shared light-oak finish",
    (room.surfaces as Record<string, unknown>)["floor"] === "WoodFloor039",
    String((room.surfaces as Record<string, unknown>)["floor"]),
  );

  const brief = { seats: 2, style: "modern", budget: 1500, keepExisting: false } as const;
  const briefRequest = buildBriefRequest(brief);
  check(
    "example brief request text matches the panel",
    briefRequest === "Furnish this room for 2 people, Modern style, new pieces up to $1,500.",
    briefRequest,
  );

  // Assistant: two Arrange chips + the brief, first rounds as the client sends them.
  const assistantBodies: Array<{ name: string; body: unknown }> = [
    ...EXAMPLE_ASSISTANT_DEMO_CHIPS.map((request) => ({
      name: `arrange ${request.slice(0, 24)}`,
      body: {
        request,
        messages: [{ role: "user", content: request }],
        room: JSON.parse(JSON.stringify(room)) as RoomLayout,
        scene: JSON.parse(JSON.stringify(scene)) as SceneState,
      },
    })),
    {
      name: "brief 2 seats Modern $1,500",
      body: {
        request: briefRequest,
        messages: [{ role: "user", content: briefRequest }],
        room: JSON.parse(JSON.stringify(room)) as RoomLayout,
        scene: JSON.parse(JSON.stringify(scene)) as SceneState,
        brief: { ...brief },
      },
    },
  ];
  for (const entry of assistantBodies) {
    const key = gatewayKey("assistant", META_MODELS.spark, assistantKeyInput(entry.body));
    check(`assistant demo exists: ${entry.name}`, existsSync(demoFile("assistant", key)), key);
  }

  // Recommend: "What fits here?" on the free runs, built like the panel.
  const catalog = readJson(join(repoRoot, "shared", "catalog", "catalog.json")) as CatalogItem[];
  const catalogById = new Map(catalog.map((c) => [c.id, c]));
  const products = new Map(
    catalog.map((c) => [c.id, { size: { ...c.size }, category: c.category, name: c.name }]),
  );
  const engine = new FitEngine(room, products);
  const base = new Set<string>();
  for (const issue of engine.check(scene)) {
    if (issue.severity === "error") {
      base.add(`${issue.type}|${[...issue.itemIds].sort().join(",")}`);
    }
  }
  const free = analyzeFreeSpace(room, scene, catalogById);
  const runs = [...free.runs].sort((a, b) => b.length_cm - a.length_cm);
  const recommendBodies: RecommendRequest[] = [];
  for (const run of runs) {
    const query = {
      category: "any" as const,
      spot: { wall: run.wall, start_cm: run.start_cm, end_cm: run.end_cm },
    };
    const ignore = new Set(recommendIgnoreIds(scene, catalog, query));
    const items = scene.items.filter((i) => !ignore.has(i.instanceId));
    const verify = (productId: string, position: { x: number; z: number }, rot: number): boolean => {
      const probe = {
        ...scene,
        items: [
          ...items,
          {
            instanceId: "recommend-probe",
            productId,
            position: {
              x: Math.round(position.x * 10) / 10,
              z: Math.round(position.z * 10) / 10,
            },
            rotationY: rot,
            variant: "",
          },
        ],
      };
      for (const issue of engine.check(probe as SceneState)) {
        if (issue.severity !== "error") continue;
        if (!base.has(`${issue.type}|${[...issue.itemIds].sort().join(",")}`)) return false;
      }
      return true;
    };
    const built = buildRecommendRequest(room, scene, catalog, query, verify);
    if (built.candidates.length === 0) continue;
    recommendBodies.push(built);
  }
  check("example recommend covers at least one free run", recommendBodies.length >= 1, String(recommendBodies.length));
  for (const built of recommendBodies) {
    const key = gatewayKey("recommend", META_MODELS.spark, recommendKeyInput(built));
    const spot = (built.request as { spot?: { wall?: string } }).spot;
    check(`recommend demo exists: ${String(spot?.wall ?? "?")}`, existsSync(demoFile("recommend", key)), key);
  }

  // Render: Visualise after the brief, from the recorded furnished scene.
  const furnished = readJson(
    join(repoRoot, "shared", "samples", "example-furnished.json"),
  ) as SceneState;
  const first = firstViewVectors(room);
  const prompt = buildRenderPrompt(
    furnished,
    room,
    catalog,
    dollhouseWallView(room, first.toCam, first.right),
  );
  const renderBody = {
    prompt,
    scene: {
      roomId: furnished.roomId,
      items: JSON.parse(JSON.stringify(furnished.items)) as SceneState["items"],
    },
    camera: { preset: "dollhouse" },
  };
  const renderInput = (renderDef.keyInput as (v: unknown) => unknown)(renderBody);
  const renderKey = gatewayKey("render", META_MODELS.image, renderInput);
  check("render demo exists: example visualisation", existsSync(demoFile("render", renderKey)), renderKey);

  console.log(
    failures === 0
      ? "check:example-demo: all checks passed"
      : `check:example-demo: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
