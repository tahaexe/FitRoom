/**
 * `npm run check:store` — the demo product page (no browser, no Meta calls).
 *
 * - The build holds `/store.html` as a real file (never the SPA fallback):
 *   it differs from `dist/index.html` and loads the store entry;
 * - the sticky demo bar, the product containers and the missing-piece
 *   containers exist in the built page;
 * - for every catalog id the page model gives the catalog's own name,
 *   the formatters' size and price, the catalog's credit and thumbnail,
 *   and the `/?add=<id>` link; unknown ids (and a missing id) miss;
 * - every new word renders from `client/src/copy.ts`: the page sets the
 *   demo line from `DEMO_STORE_LINE` itself and carries no second copy.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogItem } from "@fitroom/shared";
import { formatCatalogPrice, formatCatalogSize } from "../src/catalog-ui.js";
import { storeAddHref, storeModelFor } from "../src/store-model.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const catalog = JSON.parse(
  readFileSync(join(clientDir, "..", "shared", "catalog", "catalog.json"), "utf8"),
) as unknown as CatalogItem[];

// ---- The built page is a real file, not the app fallback ----
const distStore = readFileSync(join(clientDir, "dist", "store.html"), "utf8");
const distIndex = readFileSync(join(clientDir, "dist", "index.html"), "utf8");
check("store:dist-holds-the-page", distStore.includes('id="store-product"'), "dist/store.html");
check("store:page-is-not-the-app", distStore !== distIndex, "dist/store.html");
check(
  "store:page-loads-the-store-entry",
  /assets\/store-[A-Za-z0-9_-]+\.js/.test(distStore),
  "dist/store.html",
);

// ---- Sticky demo bar + product and missing containers ----
const sourceHtml = readFileSync(join(clientDir, "store.html"), "utf8");
check(
  "store:demo-bar-stays-on-top",
  sourceHtml.includes('id="store-demo-line"') &&
    /\.store-bar\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/.test(sourceHtml),
  "store.html .store-bar",
);
for (const id of [
  "store-product",
  "store-thumb",
  "store-credit",
  "store-name",
  "store-size",
  "store-price",
  "store-see-it",
  "store-missing",
  "store-missing-text",
  "store-open-app",
]) {
  check(`store:container-${id}`, sourceHtml.includes(`id="${id}"`), "store.html");
}
check(
  "store:credit-sits-under-the-picture",
  sourceHtml.indexOf('id="store-thumb"') < sourceHtml.indexOf('id="store-credit"'),
  "store.html",
);

// ---- Every catalog id: name, formatter size/price, credit, link ----
let okCount = 0;
for (const entry of catalog) {
  const model = storeModelFor(catalog, entry.id);
  const good =
    model.status === "ok" &&
    model.name === entry.name &&
    model.sizeText === formatCatalogSize(entry.size.w, entry.size.d, entry.size.h) &&
    model.priceText === formatCatalogPrice(entry.price) &&
    model.credit === entry.credit &&
    model.thumbnail === entry.thumbnail &&
    model.addHref === `/?add=${encodeURIComponent(entry.id)}` &&
    model.addHref === storeAddHref(entry.id);
  if (!good) {
    check(`store:piece-${entry.id}`, false, JSON.stringify(model));
  } else {
    okCount += 1;
  }
}
check(
  "store:every-catalog-id-resolves",
  okCount === catalog.length,
  `${String(okCount)} of ${String(catalog.length)}`,
);
check("store:catalog-is-not-empty", catalog.length > 0, "catalog.json");

// ---- Unknown and missing ids miss, with a way back to the app ----
check(
  "store:unknown-id-misses",
  storeModelFor(catalog, "no-such-piece").status === "unknown",
  "no-such-piece",
);
check("store:missing-id-misses", storeModelFor(catalog, null).status === "unknown", "null id");

// ---- Words come from copy.ts, never a second copy ----
const storeTs = readFileSync(join(clientDir, "src", "store.ts"), "utf8");
const storeModelTs = readFileSync(join(clientDir, "src", "store-model.ts"), "utf8");
for (const token of [
  "DEMO_STORE_LINE",
  "STORE_SEE_IT",
  "STORE_UNKNOWN",
  "STORE_OPEN_APP",
  "storeModelFor",
]) {
  check(`store:page-renders-${token}-from-the-module`, storeTs.includes(token), "store.ts");
}
check(
  "store:model-sizes-through-the-formatter",
  storeModelTs.includes("formatCatalogSize(entry.size.w, entry.size.d, entry.size.h)"),
  "store-model.ts",
);
check(
  "store:model-prices-through-the-formatter",
  storeModelTs.includes("formatCatalogPrice(entry.price)"),
  "store-model.ts",
);
for (const [file, body] of [
  ["store.ts", storeTs],
  ["store-model.ts", storeModelTs],
  ["store.html", sourceHtml],
] as const) {
  check(
    `${file} carries no second copy of the demo line`,
    !body.includes("Demo store · invented products and prices"),
    file,
  );
  check(`${file} carries no own see-it copy`, !body.includes("See it in your room"), file);
  check(
    `${file} carries no own missing-piece copy`,
    !body.includes("That piece isn't in the demo store."),
    file,
  );
}

if (failures > 0) {
  console.log(`check:store: ${String(failures)} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("check:store: all checks passed");
}
