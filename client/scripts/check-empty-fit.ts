/**
 * `npm run check:empty-fit` — no "Everything fits" without a piece in the
 * room: the fit status shows once a piece is in. Headless (no browser, no
 * Meta calls).
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATES } from "../src/copy.js";

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

const main = src("main.ts");
check(
  "fit badge hides with no piece in the room",
  main.includes("this.store.state.items.length === 0") &&
    main.includes('badge.setAttribute("hidden", "")'),
  "main.ts",
);
check(
  "fit badge returns with the first piece",
  main.includes('badge.removeAttribute("hidden")'),
  "main.ts",
);
check(
  "empty states stay listed",
  STATES.some((row) => row.id === "empty-room") && STATES.some((row) => row.id === "cart-empty"),
);

const catalog = src("catalog-ui.ts");
check(
  "catalog empty renders from the module",
  catalog.includes("catalogEmptyText"),
  "catalog-ui.ts",
);

if (failures > 0) process.exit(1);
console.log("empty fit ok");
