/**
 * `npm run check:phone-menu` — phone menu wiring check (no browser, no server).
 *
 * On phones every "More actions" and AI menu item must do what its label says:
 *
 * - every `data-phone-action="X"` value in `client/index.html` has a matching
 *   branch in `client/src/main.ts` (`action === "X"` in `phoneMenuAction` or in
 *   the AI menu loop);
 * - no `dataset["…"]` or `dataset['…']` key in any file under `client/src`
 *   contains a hyphen (a `data-phone-action` attribute reads as
 *   `dataset.phoneAction`, so a hyphenated key is always `undefined`);
 * - both menu loops (`#phone-menu` and `#phone-ai-menu`) read `phoneAction`.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, "..");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const html = readFileSync(join(clientRoot, "index.html"), "utf8");
const main = readFileSync(join(clientRoot, "src", "main.ts"), "utf8");

// Every menu action in the markup has a matching branch in main.ts.
const actions = [...html.matchAll(/data-phone-action="([^"]+)"/g)].map((match) => match[1] ?? "");
check(
  "phone-menu:actions-found",
  actions.length > 0,
  `${String(actions.length)} data-phone-action values in index.html`,
);
for (const action of new Set(actions)) {
  check(
    `phone-menu:action "${action}" is handled`,
    main.includes(`action === "${action}"`),
    `no action === "${action}" branch in main.ts`,
  );
}

// No hyphenated dataset key anywhere under client/src: dataset keys are
// camelCase (`data-phone-action` reads as `dataset.phoneAction`).
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const hyphenKeys: string[] = [];
for (const file of listTsFiles(join(clientRoot, "src"))) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/dataset\[\s*("([^"]*)"|'([^']*)')\s*\]/g)) {
    const key = match[2] ?? match[3] ?? "";
    if (key.includes("-")) {
      hyphenKeys.push(`${relative(clientRoot, file)}: dataset["${key}"]`);
    }
  }
}
check(
  "phone-menu:no-hyphen-dataset-keys",
  hyphenKeys.length === 0,
  hyphenKeys.slice(0, 5).join("; "),
);

// Both menu loops read the camelCase key.
for (const menuId of ["phone-menu", "phone-ai-menu"]) {
  const at = main.indexOf(`#${menuId} [data-phone-action]`);
  const body = at < 0 ? "" : main.slice(at, at + 600);
  check(
    `phone-menu:${menuId}-reads-phoneAction`,
    body.includes('dataset["phoneAction"]') || body.includes("dataset.phoneAction"),
    `${menuId} loop does not read phoneAction`,
  );
}

// An open phone menu hides the guide bubble on phones, so every AI menu
// item can be tapped while the guide shows.
const style = readFileSync(join(clientRoot, "src", "style.css"), "utf8");
const phoneMediaAt = style.indexOf("@media (max-width: 720px)");
const bubbleRuleAt = style.indexOf("body:has(.phone-menu:not([hidden])) .guide-bubble");
check(
  "phone-menu:guide-bubble-hidden-while-menu-open",
  phoneMediaAt >= 0 &&
    bubbleRuleAt > phoneMediaAt &&
    style.slice(bubbleRuleAt, bubbleRuleAt + 200).includes("visibility: hidden"),
  "the phone media query does not hide .guide-bubble while a .phone-menu is open",
);

// Escape closes the phone chrome through closePhoneMenus, so aria-expanded
// on #phone-ai and #tool-phone-menu resets to "false".
const chromeAt = main.indexOf("closePhoneChrome");
const chromeBody = chromeAt < 0 ? "" : main.slice(chromeAt, chromeAt + 800);
check(
  "phone-menu:close-chrome-closes-menus",
  chromeBody.includes("closePhoneMenus()"),
  "closePhoneChrome does not call closePhoneMenus()",
);

if (failures > 0) process.exit(1);
console.log("phone-menu ok");
