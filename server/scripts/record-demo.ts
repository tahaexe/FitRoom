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
  createAssistantContext,
  executeTurnRound,
  isAssistantRoundData,
  startBriefDraft,
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
import { labelDef } from "../src/routes/room-label.js";
import type { RouteDef } from "../src/meta/pipeline.js";

const DEFS: Record<string, RouteDef> = {
  recommend: recommendDef,
  assistant: assistantDef,
  render: renderDef,
  label: labelDef,
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
  const keyInput = await def.keyInput(parsed.input);
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
  const brief = (start as { brief?: AssistantRequest["brief"] }).brief;
  const ctx = createAssistantContext(start.room as RoomLayout, catalog, brief);
  // A brief with keepExisting false starts from an empty draft, inside the
  // same turn (the same undo step on the client).
  const draft = startBriefDraft(start.scene as SceneState, brief);
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
      ...(brief === undefined ? {} : { brief }),
    };
    const parsed = assistantDef.parseBody(roundInput);
    if ("error" in parsed) {
      fail(`invalid assistant round input: ${parsed.error}`);
    }
    const keyInput = await assistantDef.keyInput(parsed.input);
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
    fail(
      "usage: npm run demo:record -- <recommend|assistant|render|label> [1-based request numbers] [--only furnish|example] [--dry-run]",
    );
  }
  // `--only furnish` records only brief (furnish) turns: never re-records
  // the six existing arrangement turns. npm parses `--only furnish` as its
  // own config (it never reaches argv — npm warns `invalid config
  // only="furnish"`), so the env fallback `npm_config_only=furnish` that npm
  // sets for scripts counts too; so does `--only=furnish`/`--only-furnish`.
  const args = process.argv.slice(3);
  // `--dry-run` prints the requests it would record and makes no call.
  const dryRun = args.includes("--dry-run");
  const onlyFurnish =
    (args.includes("--only") && args.includes("furnish")) ||
    args.includes("--only=furnish") ||
    args.includes("--only-furnish") ||
    args.includes("--only furnish") ||
    process.env["npm_config_only"] === "furnish";
  const onlyExample =
    (args.includes("--only") && args.includes("example")) ||
    args.includes("--only=example") ||
    args.includes("--only-example") ||
    args.includes("--only example") ||
    process.env["npm_config_only"] === "example";
  if (args.includes("--only") && !onlyFurnish && !onlyExample) {
    fail(
      `invalid filter "${args.join(" ")}" (only "--only furnish" or "--only example" is supported).`,
    );
  }
  const only = new Set<number>();
  for (const arg of args) {
    if (
      arg === "--" ||
      arg === "--only" ||
      arg === "furnish" ||
      arg === "example" ||
      arg === "--dry-run" ||
      arg.startsWith("--only")
    )
      continue;
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) {
      fail(`invalid request number "${arg}".`);
    }
    only.add(n);
  }
  const requests = DEMO_REQUESTS[route as keyof typeof DEMO_REQUESTS];
  if (requests.length === 0) {
    console.log(`demo:record: no demo requests listed for ${route}; nothing to do.`);
    return;
  }
  const isBriefTurn = (item: unknown): boolean =>
    typeof item === "object" &&
    item !== null &&
    (item as Record<string, unknown>)["brief"] !== undefined;
  const isExampleRequest = (item: unknown): boolean => JSON.stringify(item).includes("photos-room");
  const picked = requests.filter(
    (_, index) =>
      (only.size === 0 || only.has(index + 1)) &&
      (!onlyFurnish || isBriefTurn(requests[index])) &&
      (!onlyExample || isExampleRequest(requests[index])),
  );
  if (onlyExample && picked.length !== 1) {
    fail(`--only example selected ${String(picked.length)} request(s), not one; stopping.`);
  }
  if (dryRun) {
    // No live call, no config needed: list the requests that would record.
    for (const item of picked) {
      const request =
        typeof item === "object" && item !== null && "request" in item
          ? (item as Record<string, unknown>)["request"]
          : null;
      console.log(typeof request === "string" ? request : JSON.stringify(item));
    }
    return;
  }
  console.log(
    `demo:record: selected ${String(picked.length)} of ${String(requests.length)} ` +
      `${route} request(s)${onlyFurnish ? " (--only furnish)" : ""}${onlyExample ? " (--only example)" : ""}.`,
  );
  if (picked.length === 0) {
    fail("no requests selected.");
  }
  const config = loadGatewayConfig();
  if (config.mock) {
    fail("refuses to record mock answers (unset META_MOCK).");
  }
  if (config.apiKey === "") {
    fail("needs META_API_KEY in the environment.");
  }
  let recorded = 0;
  let totalUsd = 0;
  for (const item of picked) {
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
