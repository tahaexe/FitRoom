/**
 * `npm run demo:import` — copy `server/data/recorded/` into the committed
 * demo store `server/data/demo/` and list what was copied.
 *
 * A brief (furnish) turn is imported only when its end scene replays clean:
 * no fit errors, within its budget and seating as asked; otherwise nothing
 * is imported for it and its end state is reported. Only the recorded files
 * the replay reaches are copied, so a re-recorded turn leaves no stale
 * rounds behind.
 */

/* global console, process */
import {
  ASSISTANT_MAX_ROUNDS,
  assistantToolMessages,
  createAssistantContext,
  executeTurnRound,
  isAssistantRoundData,
  isDemoStoreFile,
  startBriefDraft,
  briefPricedTotal,
  briefSeatCount,
  briefNewItems,
  checkFit,
  type AssistantMessage,
  type AssistantRequest,
  type CatalogItem,
  type RoomLayout,
  type SceneState,
} from "@fitroom/shared";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAssistantDemoRequests,
  buildExampleAssistantDemoRequests,
} from "../src/assistant-demo.js";
import { loadGatewayConfig, META_MODELS } from "../src/config.js";
import { DEMO_REQUESTS } from "../src/demo-requests.js";
import { canonicalize, gatewayKey } from "../src/meta/keys.js";
import { assistantKeyInput } from "../src/routes/assistant.js";
import { recommendDef } from "../src/routes/recommend.js";
import { renderDef } from "../src/routes/render.js";
import { labelDef } from "../src/routes/room-label.js";

const ROUTES = ["recommend", "assistant", "render", "segment", "label"];

function here(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

interface BriefReplay {
  ok: boolean;
  files: string[];
  end: SceneState | null;
  detail: string;
}

/**
 * Replay one brief turn against the recorded (not yet committed) assistant
 * answers: each round's key names its recorded file, the stored tool calls
 * run through the shared executor on the draft, and the results go back as
 * tool messages — up to 8 rounds, until the model answers in text.
 */
function replayBriefTurn(
  recordedDir: string,
  catalog: CatalogItem[],
  first: AssistantRequest,
): BriefReplay {
  const brief = first.brief;
  if (brief === undefined) return { ok: false, files: [], end: null, detail: "no brief" };
  const room = first.room as RoomLayout;
  const ctx = createAssistantContext(room, catalog, brief);
  const draft = startBriefDraft(first.scene as SceneState, brief);
  const messages: AssistantMessage[] = JSON.parse(
    JSON.stringify(first.messages),
  ) as AssistantMessage[];
  const files: string[] = [];
  for (let round = 0; round < ASSISTANT_MAX_ROUNDS; round += 1) {
    const body = {
      request: first.request,
      messages,
      room: first.room,
      scene: JSON.parse(JSON.stringify(draft)) as SceneState,
      brief: { ...brief },
    };
    const key = gatewayKey("assistant", META_MODELS.spark, assistantKeyInput(body));
    const file = join(recordedDir, "assistant", `${key}.json`);
    if (!existsSync(file)) {
      return { ok: false, files, end: draft, detail: `round ${String(round + 1)} not recorded` };
    }
    const stored: unknown = readJson(file);
    if (!isDemoStoreFile(stored) || !isAssistantRoundData(stored.response)) {
      return { ok: false, files, end: draft, detail: `round ${String(round + 1)} unparsable` };
    }
    files.push(`${key}.json`);
    const data = stored.response;
    if (data.toolCalls.length === 0) break;
    const records = executeTurnRound(ctx, draft, data.toolCalls);
    messages.push({ role: "assistant", content: data.text, toolCalls: data.toolCalls });
    messages.push(...assistantToolMessages(data.toolCalls, records));
  }
  return { ok: true, files, end: draft, detail: "replayed" };
}

/**
 * Replay one arrangement turn against the recorded answers: each round's key
 * names its recorded file, the stored tool calls run through the shared
 * executor on a scene copy, and the results go back as tool messages — up to
 * 8 rounds, until the model answers in text. Collects every reached file so
 * the import below takes only reached rounds, never older leftovers.
 */
function replayArrangeTurn(recordedDir: string, catalog: CatalogItem[], first: AssistantRequest): string[] {
  const room = first.room as RoomLayout;
  const ctx = createAssistantContext(room, catalog, undefined);
  const draft = JSON.parse(JSON.stringify(first.scene)) as SceneState;
  const messages: AssistantMessage[] = JSON.parse(
    JSON.stringify(first.messages),
  ) as AssistantMessage[];
  const files: string[] = [];
  for (let round = 0; round < ASSISTANT_MAX_ROUNDS; round += 1) {
    const body = {
      request: first.request,
      messages,
      room: first.room,
      scene: JSON.parse(JSON.stringify(draft)) as SceneState,
    };
    const key = gatewayKey("assistant", META_MODELS.spark, assistantKeyInput(body));
    const file = join(recordedDir, "assistant", `${key}.json`);
    if (!existsSync(file)) return files;
    const stored: unknown = readJson(file);
    if (!isDemoStoreFile(stored) || !isAssistantRoundData(stored.response)) return files;
    files.push(`${key}.json`);
    const data = stored.response;
    if (data.toolCalls.length === 0) break;
    const records = executeTurnRound(ctx, draft, data.toolCalls);
    messages.push({ role: "assistant", content: data.text, toolCalls: data.toolCalls });
    messages.push(...assistantToolMessages(data.toolCalls, records));
  }
  return files;
}

/** Stable equality of two demo-store payloads, ignoring `time` and formatting. */
function sameDemoAnswer(a: unknown, b: unknown): boolean {
  if (!isDemoStoreFile(a) || !isDemoStoreFile(b)) return false;
  const left = { route: a.route, model: a.model, input: a.input, response: a.response };
  const right = { route: b.route, model: b.model, input: b.input, response: b.response };
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function describeEndState(
  room: RoomLayout,
  catalog: CatalogItem[],
  start: SceneState,
  end: SceneState,
  brief: NonNullable<AssistantRequest["brief"]>,
): string {
  const products = new Map(
    catalog.map((c) => [c.id, { size: { ...c.size }, category: c.category, name: c.name }]),
  );
  const fitErrors = checkFit(room, end, products).filter((i) => i.severity === "error");
  const fresh = briefNewItems(start, end, brief);
  const total = briefPricedTotal(catalog, fresh);
  const seats = briefSeatCount(catalog, end.items);
  const pieces = fresh.map((item) => catalog.find((c) => c.id === item.productId)?.name ?? "?");
  return (
    `${String(fitErrors.length)} fit error(s), ${String(seats)} of ${String(brief.seats)} seats, ` +
    `$${String(total)} of $${String(brief.budget)}: ${pieces.join("; ") || "no pieces"}`
  );
}

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const recordedDir = join(config.dataDir, "recorded");
  const demoDir = join(config.dataDir, "demo");
  if (!existsSync(recordedDir)) {
    console.log("demo:import: nothing to import (no server/data/recorded/).");
    return;
  }

  // Brief turns: replay against the recording, import only clean ones.
  const sharedDir = resolve(here(), "..", "shared");
  const catalog = JSON.parse(
    readFileSync(resolve(sharedDir, "catalog", "catalog.json"), "utf8"),
  ) as CatalogItem[];
  const assistantFirsts = [...buildAssistantDemoRequests(), ...buildExampleAssistantDemoRequests()];
  const briefFirsts = assistantFirsts.filter((first) => first.brief !== undefined);
  const arrangeFirsts = assistantFirsts.filter((first) => first.brief === undefined);
  const briefReached = new Set<string>();
  const briefImportable = new Set<string>();
  for (const first of briefFirsts) {
    const brief = first.brief;
    if (brief === undefined) continue;
    const replay = replayBriefTurn(recordedDir, catalog, first);
    for (const file of replay.files) briefReached.add(file);
    if (!replay.ok || replay.end === null) {
      console.log(`demo:import: brief "${first.request}" not recorded (${replay.detail}).`);
      continue;
    }
    const room = first.room as RoomLayout;
    const products = new Map(
      catalog.map((c) => [c.id, { size: { ...c.size }, category: c.category, name: c.name }]),
    );
    const fitErrors = checkFit(room, replay.end, products).filter((i) => i.severity === "error");
    const fresh = briefNewItems(first.scene as SceneState, replay.end, brief);
    const total = briefPricedTotal(catalog, fresh);
    const seats = briefSeatCount(catalog, replay.end.items);
    if (fitErrors.length > 0 || total > brief.budget || seats < brief.seats) {
      console.log(
        `demo:import: brief "${first.request}" not imported: ` +
          describeEndState(room, catalog, first.scene as SceneState, replay.end, brief),
      );
      continue;
    }
    for (const file of replay.files) briefImportable.add(file);
    console.log(
      `demo:import: brief "${first.request}" clean: ` +
        describeEndState(room, catalog, first.scene as SceneState, replay.end, brief),
    );
  }
  // Arrange turns: replay to learn every reached round; only reached rounds
  // import, so an older leftover with an unreachable key never touches the store.
  const arrangeReached = new Set<string>();
  for (const first of arrangeFirsts) {
    for (const file of replayArrangeTurn(recordedDir, catalog, first)) arrangeReached.add(file);
  }

  // Expected keys for the single-shot routes, rebuilt from today's demo
  // lists: a recorded file whose key is not listed is an older leftover.
  const expectedByRoute = new Map<string, Set<string>>();
  const expectEntries: Array<{ route: string; def: { parseBody: (b: unknown) => unknown; keyInput: (i: unknown) => unknown | Promise<unknown> }; model: string }> = [
    { route: "recommend", def: recommendDef, model: recommendDef.model },
    { route: "render", def: renderDef, model: renderDef.model },
    { route: "label", def: labelDef, model: labelDef.model },
  ];
  for (const entry of expectEntries) {
    const expected = new Set<string>();
    const requests = DEMO_REQUESTS[entry.route as keyof typeof DEMO_REQUESTS] as unknown[];
    for (const item of requests) {
      const parsed = entry.def.parseBody(item) as { input?: unknown; error?: string };
      if (parsed === null || typeof parsed !== "object" || !("input" in parsed)) continue;
      const keyInput = await entry.def.keyInput((parsed as { input: unknown }).input);
      expected.add(gatewayKey(entry.route, entry.model, keyInput));
    }
    expectedByRoute.set(entry.route, expected);
  }

  // Current recording session: the newest recorded answer's embedded time;
  // files older than the session window are earlier leftovers, never copied.
  const SESSION_WINDOW_MS = 12 * 60 * 60 * 1000;
  let newest = 0;
  const recordedTimes = new Map<string, number>();
  for (const route of ROUTES) {
    const from = join(recordedDir, route);
    if (!existsSync(from)) continue;
    for (const name of readdirSync(from).filter((n) => n.endsWith(".json"))) {
      try {
        const raw: unknown = JSON.parse(readFileSync(join(from, name), "utf8"));
        const time = isDemoStoreFile(raw) ? Date.parse(raw.time) : NaN;
        const stamp = Number.isFinite(time) ? time : statSync(join(from, name)).mtimeMs;
        recordedTimes.set(`${route}/${name}`, stamp);
        if (stamp > newest) newest = stamp;
      } catch {
        continue;
      }
    }
  }

  const copied: string[] = [];
  const copyWhenChanged = (source: string, dest: string, label: string): void => {
    mkdirSync(dirname(dest), { recursive: true });
    const nextRaw: unknown = JSON.parse(readFileSync(source, "utf8"));
    if (existsSync(dest)) {
      try {
        const currentRaw: unknown = JSON.parse(readFileSync(dest, "utf8"));
        // Same answer (ignoring `time` and formatting): an older leftover
        // re-recording the same answer never touches the committed store.
        if (sameDemoAnswer(nextRaw, currentRaw)) return;
      } catch {
        // Unparsable committed file: fall through to the copy below.
      }
    }
    // Keep the repository's line endings: normalize the copy to LF and let
    // Git's checkout handle the working-copy endings.
    const next = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
    writeFileSync(dest, next, "utf8");
    copied.push(label);
  };
  for (const route of ROUTES) {
    // Segment answers never enter the committed demo store (size): in demo
    // mode the route answers demo-miss like any unknown request.
    if (route === "segment") {
      const from = join(recordedDir, route);
      if (!existsSync(from)) continue;
      for (const name of readdirSync(from).filter((n) => n.endsWith(".json"))) {
        console.log(`demo:import: skipping ${route}/${name} (segment never imports).`);
      }
      continue;
    }
    const from = join(recordedDir, route);
    if (!existsSync(from)) continue;
    const names = readdirSync(from)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of names) {
      const raw: unknown = JSON.parse(readFileSync(join(from, name), "utf8"));
      if (!isDemoStoreFile(raw)) {
        console.log(`demo:import: skipping ${route}/${name} (not a demo store file).`);
        continue;
      }
      const stamp = recordedTimes.get(`${route}/${name}`) ?? 0;
      if (newest > 0 && newest - stamp > SESSION_WINDOW_MS) {
        console.log(`demo:import: skipping ${route}/${name} (older leftover).`);
        continue;
      }
      if (route === "assistant") {
        const keyInput = raw.input as { brief?: unknown } | null | undefined;
        if (keyInput !== null && typeof keyInput === "object" && "brief" in keyInput) {
          if (!briefImportable.has(name)) {
            if (!briefReached.has(name)) {
              console.log(`demo:import: skipping assistant/${name} (stale brief round).`);
            }
            continue;
          }
        } else if (!arrangeReached.has(name)) {
          console.log(`demo:import: skipping assistant/${name} (stale arrange round).`);
          continue;
        }
      } else {
        const expected = expectedByRoute.get(route);
        if (expected !== undefined && !expected.has(name.replace(/\.json$/, ""))) {
          console.log(`demo:import: skipping ${route}/${name} (older leftover).`);
          continue;
        }
      }
      copyWhenChanged(join(from, name), join(demoDir, route, name), `${route}/${name}`);
    }
  }
  if (copied.length === 0) {
    console.log("demo:import: nothing to import.");
    return;
  }
  console.log(`demo:import: copied ${String(copied.length)} file(s):`);
  for (const file of copied) console.log(`  ${file}`);
}

void main().catch((error: unknown) => {
  console.error(`demo:import: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
