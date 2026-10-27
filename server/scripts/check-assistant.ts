/**
 * `npm run check:assistant` — headless assistant check for the demo room.
 *
 * For the demo room and the six scripted assistant turns it replays each
 * turn from the demo store through the gateway pipeline in demo mode: every
 * round goes to `POST /api/assistant` (served from the store, zero upstream
 * calls), its tool calls run through the shared executor on a draft copy of
 * the demo scene, and the results go back as tool messages — until the model
 * answers in text (at most 8 rounds, like the client).
 *
 * It then checks that each final scene has no fit error and meets its
 * request (sofa centred on window A within 5 cm facing south; the Provence
 * swap at its wall spot in navy; a side table by the armchair; two armchairs
 * with the first moved east; request 5 by what the shopper asked — the TV
 * unit on the west wall clear of the door's swing, the sofa turned to face
 * it at a comfortable viewing distance with the coffee table between them;
 * the impossible turn unchanged with both lengths named), and that demo
 * mode makes zero upstream calls.
 *
 * Prints PASS or FAIL per request and exits non-zero on any FAIL. Demo mode
 * only: no live Meta calls.
 */

/* global console, process */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSISTANT_MAX_ROUNDS,
  assistantToolMessages,
  checkFit,
  cloneScene,
  createAssistantContext,
  executeTurnRound,
  impossibleAnswer,
  isAssistantRequest,
  isAssistantRoundData,
  summarizeAssistantTurn,
  type AssistantMessage,
  type AssistantRequest,
  type AssistantToolRecord,
  type CatalogItem,
  type FitProducts,
  type RoomLayout,
  type SceneState,
} from "@fitroom/shared";
import { META_MODELS } from "../src/config.js";
import { ASSISTANT_DEMO_REQUESTS, buildAssistantDemoRequests } from "../src/assistant-demo.js";
import { DEMO_REQUESTS } from "../src/demo-requests.js";
import { gatewayKey } from "../src/meta/keys.js";

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
  try {
    const res = await fetch(`${BASE}/api/assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, payload: (await res.json()) as unknown };
  } catch {
    return null;
  }
}

async function replayTurn(first: AssistantRequest, start: SceneState): Promise<Replay> {
  const draft = cloneScene(start);
  const messages: AssistantMessage[] = JSON.parse(
    JSON.stringify(first.messages),
  ) as AssistantMessage[];
  const room = first.room as RoomLayout;
  const replayProducts: FitProducts = new Map(
    replayCatalog.map((c) => [c.id, { size: c.size, category: c.category }]),
  );
  // Like the client's turn loop: a refused "does not fit" placement enforces
  // the refusal, so the turn applies no change at all, whatever the model
  // did after it. At the round cap a fit-clean draft is applied with an
  // answer composed from the tool records.
  const records: AssistantToolRecord[] = [];
  let clean: SceneState | null = null;
  for (let round = 0; round < ASSISTANT_MAX_ROUNDS; round += 1) {
    const body = {
      request: first.request,
      messages,
      room: first.room,
      scene: draft,
    };
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
    const ctx = createAssistantContext(room, replayCatalog);
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
    catalog.map((c) => [c.id, { size: c.size, category: c.category }]),
  );

  const rebuilt = buildAssistantDemoRequests();
  const listed = DEMO_REQUESTS["assistant"];
  check("demo list holds the six assistant requests", listed.length === 6);
  check(
    "demo list holds the scripted request texts",
    ASSISTANT_DEMO_REQUESTS.length === 6 &&
      ASSISTANT_DEMO_REQUESTS.every(
        (text, index) =>
          isRecord(listed[index]) && (listed[index] as Record<string, unknown>)["request"] === text,
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
    for (let i = 0; i < firsts.length; i += 1) {
      const first = firsts[i] as AssistantRequest;
      const tag = `request ${String(i + 1)}`;
      const replay = await replayTurn(first, scene);
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
      } else {
        check(
          `${tag}: scene unchanged`,
          JSON.stringify(replay.draft.items) === JSON.stringify(scene.items),
        );
        check(
          `${tag}: answer names both lengths`,
          replay.answer.includes("273") && replay.answer.includes("30"),
          replay.answer.slice(0, 200),
        );
      }
    }

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
