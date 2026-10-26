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
 * Refuses to run in mock mode and without `META_API_KEY`.
 */

/* global console, process */
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
  for (const item of requests) {
    const parsed = def.parseBody(item);
    if ("error" in parsed) {
      fail(`invalid demo request for ${route}: ${parsed.error}`);
    }
    const keyInput = def.keyInput(parsed.input);
    const key = gatewayKey(def.route, def.model, keyInput);
    const result = await def.upstream(config.apiKey, parsed.input);
    writeRecorded(config.dataDir, def.route, def.model, key, keyInput, result.data);
    const usd = costUsd(def.model, result.usage);
    appendCostLine(config.logsDir, {
      time: new Date().toISOString(),
      session: "demo-record",
      route: def.route,
      model: def.model,
      source: "upstream",
      usage: result.usage,
      usd,
    });
    recorded += 1;
    console.log(`demo:record: ${route} ${key.slice(0, 12)}… usd=${String(usd)}`);
  }
  console.log(`demo:record: recorded ${String(recorded)} answer(s) for ${route}.`);
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
