/**
 * `npm run demo:record -- <route>` — send that route's demo-request list
 * through the live pipeline with recording on, in-process (no server left
 * running). Every upstream answer is written to
 * `server/data/recorded/<route>/<key>.json`; `npm run demo:import` then
 * copies them into the committed demo store.
 *
 * Each request is validated by its route's own body parser, called upstream
 * once (the recommend route retries once on invalid JSON itself), metered
 * as an `upstream` line in `server/logs/costs.csv`, and recorded.
 *
 * The assistant route instead records a whole multi-round turn per request:
 * each round goes upstream once and is recorded, its tool calls run through
 * the shared executor on a draft copy of the scene, and the results go back
 * as tool messages — up to 8 rounds, until the model answers in text.
 *
 * Refuses to run in mock mode and without `META_API_KEY`.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSISTANT_MAX_ROUNDS,
  assistantToolMessages,
  cloneScene,
  createAssistantContext,
  executeTurnRound,
  isAssistantRoundData,
  type AssistantMessage,
  type AssistantRequest,
  type CatalogItem,
  type RoomLayout,
  type SceneState,
} from "@fitroom/shared";
import { loadGatewayConfig } from "../src/config.js";
import { DEMO_REQUESTS } from "../src/demo-requests.js";
import { gatewayKey } from "../src/meta/keys.js";
import { writeRecorded } from "../src/meta/demo.js";
import { appendCostLine } from "../src/meta/metering.js";
import { costUsd } from "../src/meta/pricing.js";
import { assistantDef } from "../src/routes/assistant.js";
import { recommendDef } from "../src/routes/recommend.js";
import { renderDef } from "../src/routes/render.js";
import type { RouteDef } from "../src/meta/pipeline.js";

const DEFS: Record<string, RouteDef> = {
  recommend: recommendDef,
  assistant: assistantDef,
  render: renderDef,
};

function fail(message: string): never {
  console.error(`demo:record: ${message}`);
  process.exit(1);
}

function here(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function recordSingle(
  def: RouteDef,
  apiKey: string,
  dataDir: string,
  logsDir: string,
  item: unknown,
): Promise<number> {
  const parsed = def.parseBody(item);
  if ("error" in parsed) {
    fail(`invalid demo request for ${def.route}: ${parsed.error}`);
  }
  const keyInput = def.keyInput(parsed.input);
  const key = gatewayKey(def.route, def.model, keyInput);
  const result = await def.upstream(apiKey, parsed.input);
  writeRecorded(dataDir, def.route, def.model, key, keyInput, result.data);
  const usd = costUsd(def.model, result.usage);
  appendCostLine(logsDir, {
    time: new Date().toISOString(),
    session: "demo-record",
    route: def.route,
    model: def.model,
    source: "upstream",
    usage: result.usage,
    usd,
  });
  console.log(`demo:record: ${def.route} ${key.slice(0, 12)}… usd=${String(usd)}`);
  return usd;
}

/** Record one assistant turn: up to 8 upstream rounds with executor steps. */
async function recordAssistantTurn(
  apiKey: string,
  dataDir: string,
  logsDir: string,
  item: unknown,
): Promise<number> {
  const first = assistantDef.parseBody(item);
  if ("error" in first) {
    fail(`invalid demo request for assistant: ${first.error}`);
  }
  const start = first.input as AssistantRequest;
  const sharedDir = resolve(here(), "..", "shared");
  const catalog = JSON.parse(
    readFileSync(resolve(sharedDir, "catalog", "catalog.json"), "utf8"),
  ) as CatalogItem[];
  const ctx = createAssistantContext(start.room as RoomLayout, catalog);
  const draft = cloneScene(start.scene as SceneState);
  const messages: AssistantMessage[] = JSON.parse(
    JSON.stringify(start.messages),
  ) as AssistantMessage[];
  let totalUsd = 0;
  for (let round = 0; round < ASSISTANT_MAX_ROUNDS; round += 1) {
    const roundInput: AssistantRequest = {
      request: start.request,
      messages,
      room: start.room,
      scene: JSON.parse(JSON.stringify(draft)) as SceneState,
    };
    const parsed = assistantDef.parseBody(roundInput);
    if ("error" in parsed) {
      fail(`invalid assistant round input: ${parsed.error}`);
    }
    const keyInput = assistantDef.keyInput(parsed.input);
    const key = gatewayKey(assistantDef.route, assistantDef.model, keyInput);
    const result = await assistantDef.upstream(apiKey, parsed.input);
    writeRecorded(dataDir, assistantDef.route, assistantDef.model, key, keyInput, result.data);
    const usd = costUsd(assistantDef.model, result.usage);
    totalUsd = Math.round((totalUsd + usd) * 1_000_000) / 1_000_000;
    appendCostLine(logsDir, {
      time: new Date().toISOString(),
      session: "demo-record",
      route: assistantDef.route,
      model: assistantDef.model,
      source: "upstream",
      usage: result.usage,
      usd,
    });
    console.log(
      `demo:record: assistant round ${String(round + 1)} ${key.slice(0, 12)}… usd=${String(usd)}`,
    );
    if (!isAssistantRoundData(result.data) || result.data.toolCalls.length === 0) break;
    const records = executeTurnRound(ctx, draft, result.data.toolCalls);
    for (const record of records) {
      console.log(
        `demo:record:   ${record.name}(${JSON.stringify(record.args)}) → ${JSON.stringify(record.result).slice(0, 220)}`,
      );
    }
    messages.push({
      role: "assistant",
      content: result.data.text,
      toolCalls: result.data.toolCalls,
    });
    messages.push(...assistantToolMessages(result.data.toolCalls, records));
  }
  return totalUsd;
}

async function main(): Promise<void> {
  const route = process.argv[2];
  const def = route === undefined ? undefined : DEFS[route];
  if (route === undefined || def === undefined) {
    fail("usage: npm run demo:record -- <recommend|assistant|render>");
  }
  const config = loadGatewayConfig();
  if (config.mock) {
    fail("refuses to record mock answers (unset META_MOCK).");
  }
  if (config.apiKey === "") {
    fail("needs META_API_KEY in the environment.");
  }
  const requests = DEMO_REQUESTS[route as keyof typeof DEMO_REQUESTS];
  if (requests.length === 0) {
    console.log(`demo:record: no demo requests listed for ${route}; nothing to do.`);
    return;
  }
  let recorded = 0;
  let totalUsd = 0;
  for (const item of requests) {
    if (route === "assistant") {
      totalUsd =
        Math.round(
          (totalUsd +
            (await recordAssistantTurn(config.apiKey, config.dataDir, config.logsDir, item))) *
            1_000_000,
        ) / 1_000_000;
    } else {
      totalUsd =
        Math.round(
          (totalUsd +
            (await recordSingle(def, config.apiKey, config.dataDir, config.logsDir, item))) *
            1_000_000,
        ) / 1_000_000;
    }
    recorded += 1;
    console.log(`demo:record: ${route} turn ${String(recorded)} done`);
  }
  console.log(
    `demo:record: recorded ${String(recorded)} answer(s) for ${route}; total usd=${String(totalUsd)}.`,
  );
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
