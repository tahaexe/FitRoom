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
import {
  EXAMPLE_ASSISTANT_DEMO_CHIPS,
  EXAMPLE_FURNISH_DEMO_BRIEFS,
  parseBriefChip,
} from "../src/assistant/panel.js";
import { listDemoStore } from "../../server/src/meta/demo.js";
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
    ...EXAMPLE_FURNISH_DEMO_BRIEFS.map((request) => ({
      name: `brief ${request.slice(0, 24)}`,
      body: {
        request,
        messages: [{ role: "user", content: request }],
        room: JSON.parse(JSON.stringify(room)) as RoomLayout,
        scene: JSON.parse(JSON.stringify(scene)) as SceneState,
        brief: { ...brief },
      },
    })),
  ];
  for (const entry of assistantBodies) {
    const key = gatewayKey("assistant", META_MODELS.spark, assistantKeyInput(entry.body));
    check(`assistant demo exists: ${entry.name}`, existsSync(demoFile("assistant", key)), key);
  }

  // Furnish chips: every example brief must be matched by a served demo-chip
  // text the way fillFurnishChips matches (parse then rebuild, never raw).
  const servedRequests: string[] = [];
  const seenServed = new Set<string>();
  for (const file of listDemoStore(join(repoRoot, "server", "data"), "assistant")) {
    const input = file.input as { request?: unknown; messages?: unknown } | null | undefined;
    if (
      typeof input?.request === "string" &&
      Array.isArray(input.messages) &&
      input.messages.length === 1 &&
      !seenServed.has(input.request)
    ) {
      seenServed.add(input.request);
      servedRequests.push(input.request);
    }
  }
  for (const expected of EXAMPLE_FURNISH_DEMO_BRIEFS) {
    const matched = servedRequests.some((text) => {
      const parsed = parseBriefChip(text);
      return parsed !== null && buildBriefRequest(parsed.brief, parsed.note) === expected;
    });
    check(`served furnish chip replays: ${expected.slice(0, 24)}`, matched, expected);
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
    const verify = (
      productId: string,
      position: { x: number; z: number },
      rot: number,
    ): boolean => {
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
  check(
    "example recommend covers at least one free run",
    recommendBodies.length >= 1,
    String(recommendBodies.length),
  );
  for (const built of recommendBodies) {
    const key = gatewayKey("recommend", META_MODELS.spark, recommendKeyInput(built));
    const spot = (built.request as { spot?: { wall?: string } }).spot;
    check(
      `recommend demo exists: ${String(spot?.wall ?? "?")}`,
      existsSync(demoFile("recommend", key)),
      key,
    );
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
  check(
    "render demo exists: example visualisation",
    existsSync(demoFile("render", renderKey)),
    renderKey,
  );

  // ---- Furnish form in Demo: usable controls, recorded replays, no upstream ----
  const panelSource = readFileSync(join(clientDir, "src", "assistant", "panel.ts"), "utf8");
  const styleSource = readFileSync(join(clientDir, "src", "style.css"), "utf8");
  check(
    "furnish demo controls usable",
    panelSource.includes('field.classList.contains("furnish-step")') &&
      panelSource.includes('field.classList.contains("furnish-style")') &&
      panelSource.includes('field.id === "furnish-budget"') &&
      panelSource.includes('field.classList.contains("furnish-go")') &&
      panelSource.includes('field.removeAttribute("disabled")'),
    "seats, style chips, budget and Furnish stay enabled in Demo",
  );
  check(
    "furnish demo recorded replays",
    panelSource.includes("private async furnishDemoSubmit") &&
      panelSource.includes("buildBriefRequest(parsed.brief, parsed.note) === request") &&
      panelSource.includes("await this.sendFurnishDemo(text, parsed.brief, parsed.note)"),
    "a brief equal to a recorded one replays as its chip does",
  );
  check(
    "furnish demo unrecorded needs live",
    panelSource.includes(
      "This brief needs Live AI. Pick a ready brief above, or turn on Live AI.",
    ) && panelSource.includes("private addFurnishLiveNeeded"),
    "another brief shows the Live AI answer in place",
  );
  const liveNeededAt = panelSource.indexOf("private addFurnishLiveNeeded");
  const liveNeededBody =
    liveNeededAt < 0 ? "" : panelSource.slice(liveNeededAt, liveNeededAt + 1200);
  check(
    "furnish demo no upstream",
    liveNeededBody !== "" &&
      !liveNeededBody.includes("postAssistant") &&
      !liveNeededBody.includes("furnishTurn") &&
      !liveNeededBody.includes("fetch("),
    "the Live AI answer makes no model call",
  );
  check(
    "furnish demo note next to button",
    panelSource.includes("furnish-foot") &&
      panelSource.includes("foot.append(go, liveNote, demoNote, liveButton)"),
    "Other briefs use Live AI stays with the Furnish button",
  );
  check(
    "furnish style disabled looks disabled",
    styleSource.includes(".furnish-style[disabled]") && styleSource.includes("cursor: not-allowed"),
    ".furnish-style[disabled] is lighter with cursor: not-allowed",
  );
  const sendingAt = panelSource.indexOf("private setSending");
  const sendingBody = sendingAt < 0 ? "" : panelSource.slice(sendingAt, sendingAt + 1600);
  check(
    "demo chips stay disabled after a send",
    sendingBody.includes("applyDemoDisabled") &&
      sendingBody.includes('title.includes("needs Live AI")'),
    "setSending(false) re-disables chips with no recorded answer",
  );
  const recommendSource = readFileSync(join(clientDir, "src", "recommend", "panel.ts"), "utf8");
  const loadingAt = recommendSource.indexOf("private setLoading");
  const loadingBody = loadingAt < 0 ? "" : recommendSource.slice(loadingAt, loadingAt + 1600);
  check(
    "demo runs stay disabled after a send",
    loadingBody.includes("applyDemoDisabled") &&
      recommendSource.includes('title.includes("needs Live AI")'),
    "setLoading(false) re-disables runs with no recorded answer",
  );

  console.log(
    failures === 0
      ? "check:example-demo: all checks passed"
      : `check:example-demo: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
