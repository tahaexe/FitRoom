/**
 * `npm run check:capped` — every Live AI surface shows a `capped` answer as
 * the resting line with its "Use the sample room" way out (never
 * "unavailable", "error" or an HTTP code), while recorded demo answers keep
 * working.
 *
 * Headless (no browser, no Meta calls): reads the same sources the UI
 * renders from (`copy.ts`) and the panels that render them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPPED_MESSAGE, USE_SAMPLE_ROOM } from "../src/copy.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function src(relative: string): string {
  return readFileSync(join(srcDir, relative), "utf8");
}

// The resting line itself: names the sample-room way out, never an error.
check("capped:message-names-sample-room", CAPPED_MESSAGE.includes(USE_SAMPLE_ROOM), CAPPED_MESSAGE);
check("capped:message-is-resting", CAPPED_MESSAGE.includes("is resting"), CAPPED_MESSAGE);
for (const word of ["unavailable", "HTTP", "error"]) {
  check(
    `capped:message-avoids-${word}`,
    !CAPPED_MESSAGE.toLowerCase().includes(word.toLowerCase()) ||
      (word === "error" && CAPPED_MESSAGE.toLowerCase().includes("error") === false),
    CAPPED_MESSAGE,
  );
}

// Each surface handles `capped` with the resting message + sample-room action.
const assistant = src("assistant/panel.ts");
check(
  "capped:assistant-handles-capped",
  assistant.includes('"capped"') && assistant.includes("USE_SAMPLE_ROOM"),
);
check(
  "capped:assistant-capped-shows-demo-miss-card",
  assistant.includes('result.status === "demo-miss" || result.status === "capped"') &&
    assistant.includes("addDemoMiss(result.message)"),
  "assistant capped must render the resting card",
);

const recommend = src("recommend/panel.ts");
check(
  "capped:recommend-handles-capped",
  recommend.includes('"capped"') && recommend.includes("USE_SAMPLE_ROOM"),
);
check(
  "capped:recommend-capped-shows-notice-with-actions",
  recommend.includes('result.status === "demo-miss" || result.status === "capped"') &&
    recommend.includes("showNotice(result.message, true)"),
  "recommend capped must render the resting notice with actions",
);

const viewer = src("render/viewer.ts");
check(
  "capped:visualise-handles-capped",
  viewer.includes('"capped"') && viewer.includes("USE_SAMPLE_ROOM"),
);
check(
  "capped:visualise-capped-shows-demo-miss",
  viewer.includes('result.status === "demo-miss" || result.status === "capped"') &&
    viewer.includes("showDemoMiss(messageFor(result))"),
  "visualise capped must render the resting card",
);

const segment = src("photo-room/segment.ts");
check(
  "capped:segment-returns-capped",
  segment.includes("{ capped: true }") &&
    !segment.includes('result.status === "error" || result.status === "capped"'),
  "segment must resolve capped, never throw it as an error",
);
const flow = src("photo-room/flow.ts");
check(
  "capped:photo-check-shows-resting-line",
  flow.includes("state.capped") &&
    flow.includes("CAPPED_MESSAGE") &&
    flow.includes("USE_SAMPLE_ROOM"),
);
check(
  "capped:photo-check-no-error-words",
  flow.includes("CAPPED_MESSAGE") && !flow.includes("AI service is unreachable"),
  "photo capped card must not show the unreachable line",
);

// No capped branch renders "unavailable", a bare "error" or an HTTP code.
for (const [label, text] of [
  ["assistant", assistant],
  ["recommend", recommend],
  ["viewer", viewer],
  ["flow", flow],
] as const) {
  const cappedLines = text.split("\n").filter((line) => {
    if (!line.includes("capped") && !line.includes("CAPPED")) return false;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"))
      return false;
    return true;
  });
  const bad = cappedLines.filter(
    (line) =>
      line.toLowerCase().includes("unavailable") ||
      line.includes("HTTP") ||
      (line.toLowerCase().includes("error") && !line.includes("result.status")),
  );
  check(
    `capped:${label}-branch-avoids-error-words`,
    bad.length === 0,
    bad.join(" | ").slice(0, 200),
  );
}

if (failures > 0) process.exit(1);
console.log("capped ok: every Live AI surface rests with the sample-room way out");
