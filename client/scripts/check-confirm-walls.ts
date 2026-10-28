/**
 * `npm run check:confirm-walls` — before "Build my room", walls not yet
 * viewed say what was found on them (one tap views the wall), and
 * "Build my room" stays one click. Headless (no browser, no Meta calls).
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wallChipFound, wallFoundSummary } from "../src/copy.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string): string => readFileSync(join(root, "src", rel), "utf8");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

check("one window reads 1 window found", wallChipFound(0, 1) === "1 window found");
check("one door reads 1 door found", wallChipFound(1, 0) === "1 door found");
check("no openings says so", wallChipFound(0, 0) === "no openings found");
check("two openings count both", wallChipFound(1, 1) === "2 openings found");
check(
  "long summary names doors and windows",
  wallFoundSummary(1, 1) === "2 openings found (1 door, 1 window)",
);

const confirm = src("editor/photo-confirm.ts");
check(
  "confirm chips render the found summary",
  confirm.includes("wallChipFound"),
  "photo-confirm.ts",
);
check("unviewed chip invites one tap", confirm.includes("Select to view it"), "photo-confirm.ts");
check("viewed walls keep Active/Done", confirm.includes("wallCardStatus"), "photo-confirm.ts");

const editor = src("editor/editor.ts");
check(
  "Build my room stays one click",
  editor.includes("() => this.callbacks.onBuild()") && !editor.includes("window.confirm("),
  "editor.ts",
);

if (failures > 0) process.exit(1);
console.log("confirm walls ok");
