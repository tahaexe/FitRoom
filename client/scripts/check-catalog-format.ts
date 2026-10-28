/**
 * `npm run check:catalog-format` — catalog-first check (no browser,
 * no Meta calls).
 *
 * - The category chips sit in one horizontally scrolling row (never a
 *   wrapping block, never shrinking in the flex column — like the search
 *   field above them), so the first card row sits in the first screen at
 *   1366 × 768 and in the phone sheet's first view (computed from the CSS:
 *   panel/sheet heights minus search, chip row and gaps);
 * - every card shows "+ Add" on the price line (price left, "+ Add" right),
 *   with the size on one line and the name on at most two lines;
 * - every catalog size reads "181 × 82 × 71 cm" and every price "$1,490",
 *   through the one formatter in `client/src/catalog-ui.ts`
 *   (`formatCatalogSize` / `formatCatalogPrice`, also behind the cart
 *   summary, the measure pill and the size tag): no card or panel builds
 *   its own size or price string.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatCatalogPrice, formatCatalogSize, formatTopBar } from "../src/catalog-ui.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src", "style.css"), "utf8");
const catalogUi = readFileSync(join(root, "src", "catalog-ui.ts"), "utf8");
const inspector = readFileSync(join(root, "src", "inspector.ts"), "utf8");
const recommend = readFileSync(join(root, "src", "recommend", "panel.ts"), "utf8");
const assistant = readFileSync(join(root, "src", "assistant", "panel.ts"), "utf8");
const main = readFileSync(join(root, "src", "main.ts"), "utf8");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const px = (re: RegExp, fallback: number): number => {
  const match = re.exec(css);
  return match?.[1] === undefined ? fallback : Number(match[1]);
};

// The one formatter's values.
check(
  "size formats as 181 × 82 × 71 cm",
  formatCatalogSize(181, 82, 71) === "181 × 82 × 71 cm",
  formatCatalogSize(181, 82, 71),
);
check(
  "footprint formats as 181 × 82 cm",
  formatCatalogSize(181, 82) === "181 × 82 cm",
  formatCatalogSize(181, 82),
);
check("price formats as $1,490", formatCatalogPrice(1490) === "$1,490", formatCatalogPrice(1490));
check(
  "cart summary groups its price",
  formatTopBar(4, 3280) === "4 items · $3,280",
  formatTopBar(4, 3280),
);

// Every card and panel renders through it.
check(
  "catalog cards size through the formatter",
  catalogUi.includes("formatCatalogSize(item.size.w, item.size.d, item.size.h)"),
  "catalog-ui.ts",
);
check(
  "catalog cards price through the formatter",
  catalogUi.includes("formatCatalogPrice(item.price)"),
  "catalog-ui.ts",
);
check(
  "inspector sizes through the formatter",
  inspector.includes("formatCatalogSize(entry.size.w, entry.size.d, entry.size.h)"),
  "inspector.ts",
);
check(
  "inspector prices through the formatter",
  inspector.includes("formatCatalogPrice(entry.price)"),
  "inspector.ts",
);
check(
  "recommend cards size through the formatter",
  recommend.includes("formatCatalogSize(item.entry.size.w, item.entry.size.d, item.entry.size.h)"),
  "recommend/panel.ts",
);
check(
  "recommend cards price through the formatter",
  recommend.includes("formatCatalogPrice(item.entry.price)"),
  "recommend/panel.ts",
);
check(
  "assistant prices through the formatter",
  assistant.includes("formatCatalogPrice(row.price)"),
  "assistant/panel.ts",
);
check(
  "size tag uses the formatter",
  main.includes("formatCatalogSize(catalogEntry.size.w, catalogEntry.size.d)"),
  "main.ts",
);
check(
  "measure pill uses the formatter",
  catalogUi.includes("formatCatalogSize(widthCm, depthCm)"),
  "formatMeasure",
);
check(
  "cart summary uses the formatter",
  catalogUi.includes("formatCatalogPrice(total)"),
  "formatTopBar",
);

// No card or panel builds its own size or price string.
for (const [file, body] of [
  ["catalog-ui.ts", catalogUi],
  ["inspector.ts", inspector],
  ["recommend/panel.ts", recommend],
  ["assistant/panel.ts", assistant],
  ["main.ts", main],
] as const) {
  check(`${file} builds no ad-hoc size`, !body.includes("×${Math.round"), file);
  check(
    `${file} builds no ad-hoc price`,
    !/\$\$\{(?!.*toLocaleString)/.test(
      body.replace('return `$${Math.round(priceUsd).toLocaleString("en-US")}`;', ""),
    ),
    file,
  );
}
check(
  "grouping lives only in the formatter module",
  !inspector.includes("toLocaleString") &&
    !recommend.includes("toLocaleString") &&
    !assistant.includes("toLocaleString") &&
    !main.includes("toLocaleString"),
  "inspector/recommend/assistant/main",
);

// One horizontally scrolling chip row that never shrinks in the column.
check("chips never wrap", /\.chips\s*\{[^}]*flex-wrap:\s*nowrap/.test(css), ".chips");
check("chips scroll horizontally", /\.chips\s*\{[^}]*overflow-x:\s*auto/.test(css), ".chips");
check(
  "chips keep their height",
  /\.chips\s*\{[^}]*(?:flex-shrink:\s*0|flex:\s*none)/.test(css),
  ".chips",
);
check(
  "search field keeps its height",
  /#catalog input\[type="search"\]\s*\{[^}]*(?:flex-shrink:\s*0|flex:\s*none)/.test(css),
  "#catalog search",
);
check(
  "chip buttons keep one row",
  /\.chips button\s*\{[^}]*flex:\s*0 0 auto/.test(css),
  ".chips button",
);

// Every card shows "+ Add".
check(
  "cards render + Add",
  catalogUi.includes('textContent = "+ Add"') && catalogUi.includes("catalog-add"),
  "catalog-ui.ts",
);
check(
  "+ Add is a coral pill",
  /\.catalog-add\s*\{[^}]*background:\s*var\(--coral\)/.test(css),
  ".catalog-add",
);
check(
  "price and + Add share one row",
  catalogUi.includes("catalog-price-row") &&
    /priceRow\.append\(\s*price\s*,\s*add\s*\)/.test(catalogUi),
  "catalog-ui.ts",
);
check(
  "price row lays price left and + Add right",
  /\.catalog-price-row\s*\{[^}]*display:\s*flex/.test(css) &&
    /\.catalog-add\s*\{[^}]*margin-left:\s*auto/.test(css),
  ".catalog-price-row",
);
check(
  "sizes stay on one line",
  /\.catalog-dims\s*\{[^}]*white-space:\s*nowrap/.test(css),
  ".catalog-dims",
);
check(
  "names clamp to at most two lines",
  /\.catalog-name\s*\{[^}]*-webkit-line-clamp:\s*2/.test(css),
  ".catalog-name",
);

// First card row in the first screen: desktop and phone sheet, from the CSS.
const topBar = px(/--top-bar-height:\s*(\d+)px/, 64);
const gap = px(/--gap:\s*(\d+)px/, 16);
const catalogPad = 16;
const searchH = 40;
const chipRowH = 44;
const cardH = px(/\.catalog-card img\s*\{[^}]*height:\s*(\d+)px/, 64) + 16;
const beforeFirstCard = catalogPad + searchH + gap + chipRowH + gap;
const panelH = 768 - (topBar + gap) - gap;
check(
  `first card row fits 1366x768 (${String(beforeFirstCard + cardH)}px of ${String(panelH)}px)`,
  beforeFirstCard + cardH <= panelH,
  `panel top ${String(topBar + gap)}px`,
);
const sheetPeek = Math.round(844 * 0.4);
check(
  `first card fits the phone sheet peek (${String(24 + beforeFirstCard + cardH)}px of ${String(sheetPeek)}px)`,
  24 + beforeFirstCard + cardH <= sheetPeek,
  "40dvh at 390x844",
);

if (failures > 0) {
  console.log(`check:catalog-format: ${String(failures)} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("check:catalog-format: all checks passed");
}
