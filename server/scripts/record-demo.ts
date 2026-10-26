/**
 * `npm run demo:record -- <route>` — send that route's demo-request list
 * through the live pipeline with recording on, in-process (no server left
 * running). Every upstream answer is written to
 * `server/data/recorded/<route>/<key>.json`; `npm run demo:import` then
 * copies them into the committed demo store.
 *
 * The request lists live in `src/demo-requests.ts` (empty until the next
 * tasks fill them). Refuses to run in mock mode and without `META_API_KEY`.
 */

/* global console, process */
import { loadGatewayConfig } from "../src/config.js";
import { DEMO_REQUESTS } from "../src/demo-requests.js";
import { gatewayKey } from "../src/meta/keys.js";
import { writeRecorded } from "../src/meta/demo.js";
import { costUsd } from "../src/meta/pricing.js";
import { assistantDef } from "../src/routes/assistant.js";
import { recommendDef } from "../src/routes/recommend.js";
import { renderDef } from "../src/routes/render.js";
import type { RouteDef } from "../src/meta/pipeline.js";

const DEFS = { recommend: recommendDef, assistant: assistantDef, render: renderDef };

function fail(message: string): never {
  console.error(`demo:record: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const route = process.argv[2];
  if (route !== "recommend" && route !== "assistant" && route !== "render") {
    fail("usage: npm run demo:record -- <recommend|assistant|render>");
  }
  const config = loadGatewayConfig();
  if (config.mock) {
    fail("refuses to record mock answers (unset META_MOCK).");
  }
  if (config.apiKey === "") {
    fail("needs META_API_KEY in the environment.");
  }
  const def: RouteDef = DEFS[route];
  const requests = DEMO_REQUESTS[route];
  if (requests.length === 0) {
    console.log(`demo:record: no demo requests listed for ${route}; nothing to do.`);
    return;
  }
  let recorded = 0;
  for (const item of requests) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      fail(`skipping non-object demo request for ${route}.`);
    }
    const prompt = (item as Record<string, unknown>)["prompt"];
    if (typeof prompt !== "string" || prompt.length === 0) {
      fail(`skipping demo request without a prompt string for ${route}.`);
    }
    const keyInput = def.keyInput(prompt);
    const key = gatewayKey(def.route, def.model, keyInput);
    const result = await def.upstream(config.apiKey, prompt);
    writeRecorded(config.dataDir, def.route, def.model, key, keyInput, result.data);
    recorded += 1;
    console.log(
      `demo:record: ${route} ${key.slice(0, 12)}… usd=${String(costUsd(def.model, result.usage))}`,
    );
  }
  console.log(`demo:record: recorded ${String(recorded)} answer(s) for ${route}.`);
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
