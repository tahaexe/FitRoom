/**
 * `npm run check:assistant` — headless assistant check for the demo room.
 *
 * For the demo room and the eight scripted assistant turns (six
 * arrangements plus two furnishing briefs) it replays each
 * turn from the demo store through the gateway pipeline in demo mode: every
 * round goes to `POST /api/assistant` (served from the store, zero upstream
 * calls), its tool calls run through the shared executor on a draft copy of
 * the demo scene, and the results go back as tool messages — until the model
 * answers in text (at most 8 rounds, like the client). Brief turns
 * replay from an empty draft with the brief in the key and must end with no
 * fit error, within budget and with their seats.
 *
 * It then checks that each final scene has no fit error and meets its
 * request (sofa centred on window A within 5 cm facing south; the Provence
 * swap at its wall spot in navy; a side table by the armchair; two armchairs
 * with the first moved east; request 5 by what the shopper asked — the TV
 * unit on the west wall clear of the door's swing, the sofa turned to face
 * it at a comfortable viewing distance with the coffee table between them;
 * the impossible turn unchanged with both lengths named), that every stored
 * assistant answer is reached by the six turns (it lists unreachable files),
 * and that demo mode makes zero upstream calls.
 *
 * Prints PASS or FAIL per request and exits non-zero on any FAIL. Demo mode
 * only: no live Meta calls.
 */

/* global console, process */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSISTANT_MAX_ROUNDS,
  assistantRequestError,
  assistantToolMessages,
  briefNewItems,
  briefPricedTotal,
  briefResultCard,
  briefSeatCount,
  briefStyleMatches,
  checkFit,
  cloneScene,
  createAssistantContext,
  executeAssistantTool,
  executeTurnRound,
  footprintOf,
  impossibleAnswer,
  isAssistantRequest,
  isAssistantRoundData,
  overBudgetError,
  startBriefDraft,
  summarizeAssistantTurn,
  wallDisplayName,
  type AssistantBrief,
  type AssistantMessage,
  type AssistantRequest,
  type AssistantToolRecord,
  type CatalogItem,
  type FitProducts,
  type RoomLayout,
  type SceneItem,
  type SceneState,
} from "@fitroom/shared";
import { META_MODELS } from "../src/config.js";
import {
  ASSISTANT_DEMO_BRIEFS,
  ASSISTANT_DEMO_REQUESTS,
  assistantDemoBriefRequests,
  buildAssistantDemoRequests,
} from "../src/assistant-demo.js";
import { DEMO_REQUESTS } from "../src/demo-requests.js";
import { gatewayKey } from "../src/meta/keys.js";
import { assistantKeyInput } from "../src/routes/assistant.js";

const PORT = 8790;
const BASE = `http://127.0.0.1:${String(PORT)}`;

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..");
const repoRoot = resolve(serverDir, "..");
const workDir = join(repoRoot, ".tmp", "check-assistant");
const dataDir = join(workDir, "data");
const logsDir = join(workDir, "logs");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForHealth(child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => resolve();
    child.once("exit", done);
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      setTimeout(done, 1000);
    }, 5000);
  });
}

interface Replay {
  ok: boolean;
  answer: string;
  rounds: number;
  draft: SceneState;
}

async function fetchRound(body: unknown): Promise<{ status: number; payload: unknown } | null> {
  // The turn loop runs seconds of executor work between rounds; a pooled
  // keep-alive connection can go stale in that gap and the next POST then
  // fails before a single byte reaches the server (ECONNRESET, server
  // healthy). Retry once on a fresh connection when nothing was received:
  // demo lookups are read-only, so resending is safe. Any HTTP answer —
  // including demo-miss — still goes through the strict checks below.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/api/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      return { status: res.status, payload: (await res.json()) as unknown };
    } catch {
      if (attempt === 1) return null;
    }
  }
  return null;
}

async function replayTurn(
  first: AssistantRequest,
  start: SceneState,
  reached: Set<string>,
): Promise<Replay> {
  // A brief with keepExisting false starts from an empty draft, like the
  // client, the recorder and the executor key all agree.
  const draft = startBriefDraft(start, first.brief);
  const messages: AssistantMessage[] = JSON.parse(
    JSON.stringify(first.messages),
  ) as AssistantMessage[];
  const room = first.room as RoomLayout;
  const replayProducts: FitProducts = new Map(
    replayCatalog.map((c) => [c.id, { size: c.size, category: c.category, name: c.name }]),
  );
  // Like the client's turn loop: a refused "does not fit" placement enforces
  // the refusal, so the turn applies no change at all, whatever the model
  // did after it. At the round cap a fit-clean draft is applied with an
  // answer composed from the tool records.
  const records: AssistantToolRecord[] = [];
  let clean: SceneState | null = null;
  // One context for the whole turn, like the client and the recorder: the
  // brief's new-piece set accumulates across rounds (budget refusals and the
  // check_fit status line replay exactly as recorded).
  const ctx = createAssistantContext(room, replayCatalog, first.brief);
  for (let round = 0; round < ASSISTANT_MAX_ROUNDS; round += 1) {
    const body = {
      request: first.request,
      messages,
      room: first.room,
      scene: draft,
      ...(first.brief === undefined ? {} : { brief: { ...first.brief } }),
    };
    // The key the pipeline reads for this round (same key input it uses).
    reached.add(gatewayKey("assistant", META_MODELS.spark, assistantKeyInput(body)));
    const fetched = await fetchRound(body);
    if (fetched === null) {
      return { ok: false, answer: "", rounds: round, draft };
    }
    const { status, payload } = fetched;
    if (
      status !== 200 ||
      !isRecord(payload) ||
      payload["status"] !== "ok" ||
      payload["source"] !== "demo" ||
      !isAssistantRoundData(payload["data"])
    ) {
      return { ok: false, answer: "", rounds: round, draft };
    }
    const data = payload["data"];
    if (data.toolCalls.length === 0) {
      const enforced = impossibleAnswer(records, data.text);
      if (enforced !== null) {
        return { ok: true, answer: enforced, rounds: round + 1, draft: cloneScene(start) };
      }
      return { ok: true, answer: data.text, rounds: round + 1, draft };
    }
    messages.push({ role: "assistant", content: data.text, toolCalls: data.toolCalls });
    const step = executeTurnRound(ctx, draft, data.toolCalls);
    records.push(...step);
    messages.push(...assistantToolMessages(data.toolCalls, step));
    if (errorsOf(room, draft, replayProducts).length === 0) {
      clean = cloneScene(draft);
    }
  }
  const refused = impossibleAnswer(records, "");
  if (refused !== null) {
    return { ok: true, answer: refused, rounds: ASSISTANT_MAX_ROUNDS, draft: cloneScene(start) };
  }
  if (clean !== null) {
    return {
      ok: true,
      answer: summarizeAssistantTurn(start, clean, room, replayCatalog),
      rounds: ASSISTANT_MAX_ROUNDS,
      draft: clean,
    };
  }
  return { ok: false, answer: "", rounds: ASSISTANT_MAX_ROUNDS, draft };
}

let replayCatalog: CatalogItem[] = [];

function errorsOf(room: RoomLayout, scene: SceneState, products: FitProducts): string[] {
  return checkFit(room, scene, products)
    .filter((i) => i.severity === "error")
    .map((i) => i.type);
}

/**
 * Independent landmark audit for a turn summary: a clause may claim "under
 * the window", "in front of the window" or "against the <wall>" only when
 * the placed piece's back faces that wall (front points into the room,
 * within 60 degrees) with at most 30 cm of gap; window phrases additionally
 * need the piece's centre over that window's span. Recomputed here from raw
 * geometry, not via the summary builder, so a stale landmark rule fails.
 */
function summaryLandmarksBacked(
  room: RoomLayout,
  end: SceneState,
  catalog: CatalogItem[],
  summary: string,
): { ok: boolean; detail?: string } {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  let cx = 0;
  let cz = 0;
  for (const wall of room.walls) {
    cx += (wall.start.x + wall.end.x) / 2;
    cz += (wall.start.z + wall.end.z) / 2;
  }
  cx /= Math.max(1, room.walls.length);
  cz /= Math.max(1, room.walls.length);
  const gapToWall = (item: SceneItem, wallId: string): number => {
    const wall = room.walls.find((w) => w.id === wallId);
    const entry = byId.get(item.productId);
    const size = entry === undefined ? { w: 60, d: 60, h: 60 } : entry.size;
    if (wall === undefined) return Infinity;
    const box = footprintOf(size, item.position, item.rotationY);
    const corners = [
      { x: box.x0, z: box.z0 },
      { x: box.x1, z: box.z0 },
      { x: box.x1, z: box.z1 },
      { x: box.x0, z: box.z1 },
    ];
    let best = Infinity;
    for (const corner of corners) {
      const dx = wall.end.x - wall.start.x;
      const dz = wall.end.z - wall.start.z;
      const lenSq = dx * dx + dz * dz || 1;
      const t = Math.min(
        1,
        Math.max(0, ((corner.x - wall.start.x) * dx + (corner.z - wall.start.z) * dz) / lenSq),
      );
      best = Math.min(
        best,
        Math.hypot(corner.x - (wall.start.x + dx * t), corner.z - (wall.start.z + dz * t)),
      );
    }
    return best;
  };
  const backFacesWall = (item: SceneItem, wallId: string): boolean => {
    const wall = room.walls.find((w) => w.id === wallId);
    if (wall === undefined) return false;
    const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z) || 1;
    const ux = (wall.end.x - wall.start.x) / len;
    const uz = (wall.end.z - wall.start.z) / len;
    const mx = (wall.start.x + wall.end.x) / 2;
    const mz = (wall.start.z + wall.end.z) / 2;
    const s = (cx - mx) * -uz + (cz - mz) * ux >= 0 ? 1 : -1;
    const rad = (item.rotationY * Math.PI) / 180;
    return Math.sin(rad) * -uz * s + Math.cos(rad) * ux * s >= 0.5;
  };
  const overWindowSpan = (item: SceneItem, wallId: string): boolean => {
    const wall = room.walls.find((w) => w.id === wallId);
    if (wall === undefined) return false;
    const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z) || 1;
    const offset =
      ((item.position.x - wall.start.x) * (wall.end.x - wall.start.x) +
        (item.position.z - wall.start.z) * (wall.end.z - wall.start.z)) /
      len;
    return room.openings.some(
      (o) =>
        o.wallId === wallId &&
        o.type === "window" &&
        offset >= o.offset &&
        offset <= o.offset + o.width,
    );
  };
  for (const clause of summary.split("; ")) {
    const lower = clause.toLowerCase();
    const claimsWindow =
      lower.includes("under the window") || lower.includes("in front of the window");
    const claimsWall = lower.includes("against the");
    if (!claimsWindow && !claimsWall) continue;
    // The clause names its product; validate the end-scene pieces of it.
    const candidates = end.items.filter((item) => {
      const name = byId.get(item.productId)?.name ?? item.productId;
      return lower.includes(name.toLowerCase());
    });
    const pool = candidates.length > 0 ? candidates : end.items;
    let backed = false;
    for (const item of pool) {
      for (const wall of room.walls) {
        if (claimsWall) {
          // When the clause names the wall, only that wall backs the claim.
          const named = wallDisplayName(room, wall.id).toLowerCase();
          if (!lower.includes(named)) continue;
        }
        if (gapToWall(item, wall.id) > 30.5 || !backFacesWall(item, wall.id)) continue;
        if (claimsWindow && !overWindowSpan(item, wall.id)) continue;
        backed = true;
        break;
      }
      if (backed) break;
    }
    if (!backed) {
      return { ok: false, detail: clause.slice(0, 160) };
    }
  }
  return { ok: true };
}

async function main(): Promise<void> {
  const builtServer = join(serverDir, "dist", "index.js");
  if (!existsSync(builtServer)) {
    check("built server exists (run npm run build first)", false, "server/dist/index.js missing");
    process.exit(1);
  }

  const room = JSON.parse(
    readFileSync(join(repoRoot, "shared", "samples", "living-420x360.json"), "utf8"),
  ) as RoomLayout;
  const scene = JSON.parse(
    readFileSync(join(repoRoot, "shared", "samples", "fit-tests", "valid.json"), "utf8"),
  ) as SceneState;
  const catalog = JSON.parse(
    readFileSync(join(repoRoot, "shared", "catalog", "catalog.json"), "utf8"),
  ) as CatalogItem[];
  replayCatalog = catalog;
  const products: FitProducts = new Map(
    catalog.map((c) => [c.id, { size: c.size, category: c.category, name: c.name }]),
  );

  const rebuilt = buildAssistantDemoRequests();
  const listed = DEMO_REQUESTS["assistant"];
  check("demo list holds the eight assistant requests", listed.length === 8);
  check(
    "demo list holds the scripted request texts",
    ASSISTANT_DEMO_REQUESTS.length === 6 &&
      ASSISTANT_DEMO_REQUESTS.every(
        (text, index) =>
          isRecord(listed[index]) && (listed[index] as Record<string, unknown>)["request"] === text,
      ),
  );
  const briefTexts = assistantDemoBriefRequests();
  check(
    "demo list holds the two brief requests",
    ASSISTANT_DEMO_BRIEFS.length === 2 &&
      briefTexts.length === 2 &&
      ASSISTANT_DEMO_BRIEFS.every(
        (brief, index) =>
          isRecord(listed[6 + index]) &&
          (listed[6 + index] as Record<string, unknown>)["request"] === briefTexts[index] &&
          JSON.stringify((listed[6 + index] as Record<string, unknown>)["brief"]) ===
            JSON.stringify(brief),
      ),
  );
  const keysMatch =
    listed.length === rebuilt.length &&
    listed.every((entry, index) => {
      const want = rebuilt[index] as AssistantRequest | undefined;
      if (want === undefined || !isRecord(entry) || !isAssistantRequest(entry)) return false;
      return (
        gatewayKey("assistant", META_MODELS.spark, entry) ===
        gatewayKey("assistant", META_MODELS.spark, want)
      );
    });
  check("demo list matches the rebuilt requests", keysMatch);
  if (!keysMatch) {
    process.exitCode = 1;
    return;
  }

  const baseErrors = checkFit(room, scene, products).filter((i) => i.severity === "error");
  check("demo room scene has no fit errors", baseErrors.length === 0);

  // ---- brief validation: friendly rejections like the rest of the body ----
  const validBody = {
    request: "Furnish it",
    messages: [{ role: "user" as const, content: "Furnish it" }],
    room,
    scene,
  };
  const briefBody = (brief: unknown): unknown => ({ ...validBody, brief });
  const classicBrief = { seats: 4, style: "classic", budget: 2500, keepExisting: false };
  check("brief: missing brief is fine", assistantRequestError(validBody) === null);
  check("brief: valid brief passes", assistantRequestError(briefBody(classicBrief)) === null);
  check(
    "brief: seats 0 rejected",
    assistantRequestError(briefBody({ ...classicBrief, seats: 0 })) ===
      "The brief needs seats from 1 to 8.",
  );
  check(
    "brief: seats 9 rejected",
    assistantRequestError(briefBody({ ...classicBrief, seats: 9 })) ===
      "The brief needs seats from 1 to 8.",
  );
  check(
    "brief: fractional seats rejected",
    assistantRequestError(briefBody({ ...classicBrief, seats: 2.5 })) ===
      "The brief needs seats from 1 to 8.",
  );
  check(
    "brief: bad style rejected",
    assistantRequestError(briefBody({ ...classicBrief, style: "victorian" })) ===
      "The brief style is any, modern, classic or scandinavian.",
  );
  check(
    "brief: budget 299 rejected",
    assistantRequestError(briefBody({ ...classicBrief, budget: 299 })) ===
      "The brief needs a budget from $300 to $20,000.",
  );
  check(
    "brief: budget 20001 rejected",
    assistantRequestError(briefBody({ ...classicBrief, budget: 20001 })) ===
      "The brief needs a budget from $300 to $20,000.",
  );
  check(
    "brief: bad keepExisting rejected",
    assistantRequestError(briefBody({ ...classicBrief, keepExisting: "yes" })) ===
      "The brief needs keepExisting true or false.",
  );

  // ---- style groups by catalog tag (case-insensitive) ----
  check("style: modern matches mid-century modern", briefStyleMatches("modern", ["mid-century modern"]));
  check("style: modern matches Mid-Century", briefStyleMatches("modern", ["Mid-Century"]));
  check(
    "style: classic matches French provincial",
    briefStyleMatches("classic", ["French provincial"]),
  );
  check("style: scandinavian matches Simple", briefStyleMatches("scandinavian", ["Simple"]));
  check("style: classic misses modern", !briefStyleMatches("classic", ["modern"]));
  check("style: any matches everything", briefStyleMatches("any", ["modern"]));
  check("style: any tag matches classic", briefStyleMatches("classic", ["any"]));

  // ---- budget engine: refuse over budget, free on remove ----
  const brief4 = { ...classicBrief } as AssistantBrief;
  const budgetCtx = createAssistantContext(room, catalog, brief4);
  const budgetDraft = startBriefDraft(scene, brief4);
  check("brief: keepExisting false starts empty", budgetDraft.items.length === 0);
  check(
    "brief: keepExisting true keeps pieces",
    startBriefDraft(scene, { ...brief4, keepExisting: true }).items.length === scene.items.length,
  );
  const placed1 = executeAssistantTool(budgetCtx, budgetDraft, "place_item", {
    productId: "sofa_02",
    x: 210,
    z: 180,
    rotationY: 180,
  });
  check("brief: first piece placed", placed1["ok"] === true);
  const placed2 = executeAssistantTool(budgetCtx, budgetDraft, "place_item", {
    productId: "modern_coffee_table_01",
    x: 210,
    z: 60,
    rotationY: 0,
  });
  check("brief: second piece placed", placed2["ok"] === true);
  const itemsBefore = budgetDraft.items.length;
  const refused = executeAssistantTool(budgetCtx, budgetDraft, "place_item", {
    productId: "modern_wooden_cabinet",
    x: 100,
    z: 100,
    rotationY: 0,
  });
  check(
    "brief: over budget refused with amounts",
    refused["ok"] === false &&
      refused["error"] === overBudgetError("Rhythm TV Unit", 860, 1830, 2500),
    String(refused["error"] ?? refused["ok"]),
  );
  check("brief: refused placement changes nothing", budgetDraft.items.length === itemsBefore);
  const wallCtx = createAssistantContext(room, catalog, brief4);
  const wallDraft = startBriefDraft(scene, brief4);
  executeAssistantTool(wallCtx, wallDraft, "place_item", {
    productId: "sofa_02",
    x: 210,
    z: 180,
    rotationY: 180,
  });
  executeAssistantTool(wallCtx, wallDraft, "place_item", {
    productId: "modern_coffee_table_01",
    x: 210,
    z: 60,
    rotationY: 0,
  });
  const wallId = room.walls[0]?.id ?? "wall-1";
  const refusedWall = executeAssistantTool(wallCtx, wallDraft, "place_against_wall", {
    productId: "modern_wooden_cabinet",
    wallId,
    offset_cm: 50,
  });
  check(
    "brief: wall placement over budget refused",
    refusedWall["ok"] === false &&
      typeof refusedWall["error"] === "string" &&
      refusedWall["error"].includes("Over budget"),
    String(refusedWall["error"] ?? refusedWall["ok"]),
  );
  const removed = executeAssistantTool(budgetCtx, budgetDraft, "remove_item", {
    instanceId: "sofa_02",
  });
  check("brief: removing a new piece frees its price", removed["ok"] === true);
  const placed3 = executeAssistantTool(budgetCtx, budgetDraft, "place_item", {
    productId: "modern_wooden_cabinet",
    x: 100,
    z: 100,
    rotationY: 0,
  });
  check("brief: placement fits after the remove", placed3["ok"] === true);
  check(
    "brief: seat count",
    briefSeatCount(catalog, [
      {
        instanceId: "a",
        productId: "sofa_02",
        position: { x: 1, z: 1 },
        rotationY: 0,
        variant: "default",
      },
      {
        instanceId: "b",
        productId: "GreenChair_01",
        position: { x: 2, z: 2 },
        rotationY: 0,
        variant: "default",
      },
    ]) === 3,
  );
  const briefStatus = executeAssistantTool(budgetCtx, budgetDraft, "check_fit", {});
  check(
    "brief: check_fit adds the status line",
    typeof briefStatus["brief"] === "string" &&
      (briefStatus["brief"] as string).includes("Seats 0 of 4") &&
      (briefStatus["brief"] as string).includes("$1,200 of $2,500") &&
      (briefStatus["brief"] as string).includes("Classic match: none"),
    String(briefStatus["brief"] ?? ""),
  );
  const plainStatus = executeAssistantTool(
    createAssistantContext(room, catalog),
    budgetDraft,
    "check_fit",
    {},
  );
  check("brief: no status line without a brief", !("brief" in plainStatus));

  // ---- result card numbers equal the end scene's ----
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const endSeats = budgetDraft.items.reduce(
    (sum, item) => sum + (byId.get(item.productId)?.seats ?? 0),
    0,
  );
  const endTotal = budgetDraft.items.reduce(
    (sum, item) => sum + (byId.get(item.productId)?.price ?? 0),
    0,
  );
  const card = briefResultCard(scene, budgetDraft, room, catalog, brief4);
  check("brief: card seats equal the end scene", card.seats === endSeats);
  check("brief: card total equals the end scene", card.total === endTotal);
  check(
    "brief: card counts every new piece",
    card.newCount === budgetDraft.items.length && card.rows.length === budgetDraft.items.length,
  );
  check(
    "brief: card headline names seats, pieces and budget",
    card.headline.includes(`Seats ${String(endSeats)} of 4`) &&
      card.headline.includes(`$${String(endTotal.toLocaleString("en-US"))} of $2,500`),
    card.headline,
  );
  check(
    "brief: every end piece is new from an empty draft",
    briefNewItems(scene, budgetDraft, brief4).length === budgetDraft.items.length,
  );

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  cpSync(join(serverDir, "data"), dataDir, { recursive: true });

  const child = spawn("node", [builtServer], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      META_MOCK: "",
      META_RECORD: "",
      META_API_KEY: "",
      // Demo-store hits are free and never count toward the per-IP rate
      // limit, so the check keeps the production limit.
      FITROOM_DATA_DIR: dataDir,
      FITROOM_LOGS_DIR: logsDir,
    },
    stdio: "ignore",
  });
  try {
    check("demo server starts", await waitForHealth(child), "no /api/health on 8790");
    if (child.exitCode !== null) {
      process.exitCode = 1;
      return;
    }

    const firsts = rebuilt;
    const reached = new Set<string>();
    for (let i = 0; i < firsts.length; i += 1) {
      const first = firsts[i] as AssistantRequest;
      const tag = `request ${String(i + 1)}`;
      const replay = await replayTurn(first, scene, reached);
      check(
        `${tag} replays from the store to a text answer`,
        replay.ok,
        replay.rounds === 0 ? "turn not recorded yet" : `rounds=${String(replay.rounds)}`,
      );
      if (!replay.ok) continue;
      check(
        `${tag} answer hides wall ids`,
        !replay.answer.includes("wall-"),
        replay.answer.slice(0, 120),
      );
      const errs = errorsOf(room, replay.draft, products);

      if (i === 0) {
        const sofa = replay.draft.items.find((it) => it.productId === "sofa_02");
        check(`${tag}: Chester sofa still placed`, sofa !== undefined);
        check(
          `${tag}: sofa centred on window A within 5 cm`,
          sofa !== undefined && Math.abs(sofa.position.x - 260) <= 5,
          sofa === undefined ? "missing" : `x=${String(sofa.position.x)}`,
        );
        check(
          `${tag}: sofa faces south`,
          sofa !== undefined && Math.abs(sofa.rotationY - 180) <= 10,
          sofa === undefined ? "missing" : `rot=${String(sofa.rotationY)}`,
        );
        check(`${tag}: no fit error`, errs.length === 0, errs.join(","));
      } else if (i === 1) {
        const chester = replay.draft.items.find((it) => it.productId === "sofa_02");
        const love = replay.draft.items.find((it) => it.productId === "Sofa_01");
        check(`${tag}: Chester removed`, chester === undefined);
        check(
          `${tag}: Provence loveseat where the Chester stood`,
          love !== undefined &&
            Math.abs(love.position.x - 32.9) <= 2 &&
            Math.abs(love.position.z - 200) <= 2 &&
            Math.abs(love.rotationY - 90) <= 5,
          love === undefined
            ? "missing"
            : `(${String(love.position.x)}, ${String(love.position.z)}) rot=${String(love.rotationY)}`,
        );
        check(`${tag}: variant Navy`, love?.variant === "Navy", love?.variant);
        check(`${tag}: no fit error`, errs.length === 0, errs.join(","));
      } else if (i === 2) {
        const table = replay.draft.items.find((it) => it.productId === "side_table_01");
        check(`${tag}: Pine Side Table added`, table !== undefined);
        check(
          `${tag}: table on the armchair's right side`,
          table !== undefined &&
            table.position.x > 180 &&
            table.position.x - 180 < 180 &&
            Math.abs(table.position.z - 60) < 120,
          table === undefined
            ? "missing"
            : `(${String(table.position.x)}, ${String(table.position.z)})`,
        );
        check(`${tag}: no fit error`, errs.length === 0, errs.join(","));
      } else if (i === 3) {
        const chairs = replay.draft.items.filter(
          (it) => catalog.find((c) => c.id === it.productId)?.category === "armchair",
        );
        check(
          `${tag}: two armchairs placed`,
          chairs.length === 2,
          `count=${String(chairs.length)}`,
        );
        const second = chairs.find(
          (it) =>
            Math.hypot(it.position.x - 280, it.position.z - 200) <= 80 &&
            Math.abs(it.rotationY - 270) <= 20,
        );
        check(
          `${tag}: second armchair faces the sofa across the table`,
          second !== undefined,
          chairs
            .map(
              (c) =>
                `(${String(c.position.x)}, ${String(c.position.z)}) rot=${String(c.rotationY)}`,
            )
            .join(" "),
        );
        const firstMoved = chairs.some(
          (it) => it.instanceId === "modern_arm_chair_01" && it.position.x > 240,
        );
        check(`${tag}: first armchair moved east`, firstMoved);
        check(`${tag}: no fit error`, errs.length === 0, errs.join(","));
      } else if (i === 4) {
        // Judged by what the shopper asked: the TV unit on the west wall
        // clear of the door's swing, the sofa turned to face it at a
        // comfortable viewing distance with the coffee table between them.
        // The sofa may stand against the east wall or float in the room.
        const tv = replay.draft.items.find((it) => it.productId === "modern_wooden_cabinet");
        const sofa = replay.draft.items.find((it) => it.productId === "sofa_02");
        const table = replay.draft.items.find((it) => it.productId === "modern_coffee_table_01");
        const angDiff = (a: number, b: number): number => {
          const d = Math.abs((((a - b) % 360) + 360) % 360);
          return Math.min(d, 360 - d);
        };
        check(
          `${tag}: TV unit on the west wall clear of the swing`,
          tv !== undefined && tv.position.x < 120 && tv.position.z >= 212,
          tv === undefined ? "missing" : `(${String(tv.position.x)}, ${String(tv.position.z)})`,
        );
        const bearing =
          tv !== undefined && sofa !== undefined
            ? ((Math.atan2(tv.position.x - sofa.position.x, tv.position.z - sofa.position.z) *
                180) /
                Math.PI +
                360) %
              360
            : null;
        const distance =
          tv !== undefined && sofa !== undefined
            ? Math.hypot(tv.position.x - sofa.position.x, tv.position.z - sofa.position.z)
            : null;
        check(
          `${tag}: sofa turned to face the TV`,
          sofa !== undefined && bearing !== null && angDiff(sofa.rotationY, bearing) <= 15,
          sofa === undefined
            ? "missing"
            : `(${String(sofa.position.x)}, ${String(sofa.position.z)}) rot=${String(sofa.rotationY)}`,
        );
        check(
          `${tag}: sofa at a comfortable viewing distance`,
          distance !== null && distance >= 150 && distance <= 400,
          distance === null ? "missing" : `dist=${String(Math.round(distance))}`,
        );
        check(
          `${tag}: coffee table between sofa and TV`,
          tv !== undefined &&
            sofa !== undefined &&
            table !== undefined &&
            table.position.x > tv.position.x &&
            table.position.x < sofa.position.x,
        );
        check(`${tag}: no fit error`, errs.length === 0, errs.join(","));
      } else if (i === 5) {
        check(
          `${tag}: scene unchanged`,
          JSON.stringify(replay.draft.items) === JSON.stringify(scene.items),
        );
        check(
          `${tag}: answer names both lengths`,
          replay.answer.includes("273") && replay.answer.includes("30"),
          replay.answer.slice(0, 200),
        );
      } else {
        // A recorded brief replays to an end scene with no fit errors,
        // within its budget and with its seats; the card's numbers equal the
        // end scene's (recomputed here, not via the card builder).
        const brief = ASSISTANT_DEMO_BRIEFS[i - 6] as AssistantBrief;
        const seats = replay.draft.items.reduce(
          (sum, item) => sum + (byId.get(item.productId)?.seats ?? 0),
          0,
        );
        const total = replay.draft.items.reduce(
          (sum, item) => sum + (byId.get(item.productId)?.price ?? 0),
          0,
        );
        check(`${tag}: no fit error`, errs.length === 0, errs.join(","));
        check(
          `${tag}: seats as asked`,
          seats >= brief.seats,
          `seats=${String(seats)} asked=${String(brief.seats)}`,
        );
        check(
          `${tag}: within budget`,
          total <= brief.budget,
          `total=$${String(total)} budget=$${String(brief.budget)}`,
        );
        const briefCard = briefResultCard(scene, replay.draft, room, replayCatalog, brief);
        check(`${tag}: card seats equal the end scene`, briefCard.seats === seats);
        check(`${tag}: card total equals the end scene`, briefCard.total === total);
        check(
          `${tag}: card counts every new piece`,
          briefCard.newCount === replay.draft.items.length &&
            briefCard.rows.length === replay.draft.items.length,
        );
        check(
          `${tag}: card rows price the catalog`,
          briefCard.rows.every((row) => row.price === (byId.get(row.productId)?.price ?? -1)),
        );
      }
      // Every turn summary tells the truth about landmarks and casing: a
      // piece is "under/in front of the window" or "against the wall" only
      // with its back to that wall within 30 cm, and every clause after a
      // semicolon starts in lower case.
      const summary = summarizeAssistantTurn(scene, replay.draft, room, replayCatalog);
      const landmarks = summaryLandmarksBacked(room, replay.draft, replayCatalog, summary);
      check(
        `${tag}: summary landmarks backed (back to wall within 30 cm)`,
        landmarks.ok,
        landmarks.detail ?? summary.slice(0, 200),
      );
      check(
        `${tag}: summary clauses after ";" start lower-case`,
        !/; [A-Z]/.test(summary),
        summary.slice(0, 200),
      );
      if (i === 4) {
        check(
          `${tag}: summary no longer says "under the window"`,
          !summary.toLowerCase().includes("under the window"),
          summary.slice(0, 200),
        );
      }
    }

    // Every stored assistant answer is reached by the eight demo turns;
    // anything else is a leftover of an earlier recording (like the old
    // turn-6 rounds) and must be removed from the committed store.
    const stored = readdirSync(join(dataDir, "demo", "assistant"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
    const unreachable = stored.filter((key) => !reached.has(key)).sort();
    check(
      "demo store holds no unreachable assistant files",
      unreachable.length === 0,
      unreachable.length === 0 ? undefined : `remove: ${unreachable.join(", ")}`,
    );

    const costsFile = join(logsDir, "costs.csv");
    const lines = existsSync(costsFile)
      ? readFileSync(costsFile, "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .slice(1)
      : [];
    const upstream = lines.filter((line) => line.split(",")[4] === "upstream").length;
    check("demo mode makes zero upstream calls", upstream === 0, `upstream=${String(upstream)}`);
  } finally {
    await stopServer(child);
  }

  console.log(
    failures === 0
      ? "check:assistant: all checks passed"
      : `check:assistant: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`check:assistant: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
