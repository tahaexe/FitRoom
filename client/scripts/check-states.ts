/**
 * `npm run check:states` — every judge-path state says what happened and
 * what to do next. Headless (no browser, no Meta calls).
 *
 * - Renders each listed state's text from the same code (`STATES` in
 *   `client/src/copy.ts`, the module the UI renders from).
 * - Asserts a next action: the action names a button on the screen (the
 *   action words appear in the text) or carries a verb.
 * - Asserts no internal word (an id, "undefined", a raw error string).
 * - Asserts the README's conventions table mirrors every row verbatim.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATES } from "../src/copy.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

/** Verbs a next action (button or sentence) must carry. */
const VERBS = [
  "wait",
  "try",
  "turn",
  "use",
  "add",
  "select",
  "enter",
  "retake",
  "asking",
  "visualising",
  "solving",
  "reading",
  "analysing",
  "furnish",
  "take",
  "photograph",
  "measure",
  "solve",
  "choose",
  "continue",
  "back",
  "send",
  "place",
  "leave",
  "build",
  "confirm",
  "next",
];

/** Fragments that must never reach a shopper's screen. */
const FORBIDDEN = [
  "undefined",
  "NaN",
  "[object",
  "TypeError",
  "ReferenceError",
  "instanceId",
  "wall-1",
  "wall-2",
  "roomId",
  "HTTP 5",
  "Error:",
  "stack",
];

function hasVerb(text: string): boolean {
  const lower = text.toLowerCase();
  return VERBS.some((verb) => lower.includes(verb));
}

const ids = STATES.map((row) => row.id);
check("states list is non-empty", STATES.length >= 20, `got ${String(STATES.length)}`);
check("state ids are unique", new Set(ids).size === ids.length);

for (const row of STATES) {
  const body = `${row.where} ${row.text} ${row.action}`;
  check(
    `state ${row.id} names a next action`,
    (row.text.includes(row.action) || hasVerb(`${row.text} ${row.action}`)) &&
      row.text.trim().length > 0 &&
      row.action.trim().length > 0,
    JSON.stringify(row),
  );
  const leaked = FORBIDDEN.filter((word) => body.includes(word));
  check(`state ${row.id} shows no internal word`, leaked.length === 0, leaked.join(","));
}

const readme = readFileSync(join(root, "README.md"), "utf8");
for (const row of STATES) {
  check(
    `README mirrors state ${row.id}`,
    readme.includes(row.text) && readme.includes(row.action),
    row.id,
  );
}

if (failures > 0) process.exit(1);
console.log(`states ok: ${String(STATES.length)} rows`);
