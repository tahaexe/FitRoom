/**
 * `npm run check:guidance` — headless first-visit guidance check (no browser,
 * no Meta calls).
 *
 * - Category chips never show raw slugs: every `CATEGORIES` key has a
 *   readable `CATEGORY_LABELS` name;
 * - the top bar readout is labelled ("4 items · $3,280", never "$3,280 · 4");
 * - catalog search matches common synonyms (couch → sofa, chair → armchair,
 *   table → coffee or side table, plant → decor, cabinet/stand → TV unit,
 *   bookcase → shelf) and a query with no match ("bed") matches nothing
 *   (the panel then shows its no-match message with the categories).
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import type { CatalogItem } from "@fitroom/shared";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  formatTopBar,
  matchesCatalogQuery,
} from "../src/catalog-ui.js";

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function item(name: string, category: string): CatalogItem {
  return {
    name,
    category,
    styleTags: [],
    colors: [],
  } as unknown as CatalogItem;
}

const catalog: CatalogItem[] = [
  item("Black Sofa", "sofa"),
  item("Linen Armchair", "armchair"),
  item("Oak Coffee Table", "coffee-table"),
  item("Walnut Side Table", "side-table"),
  item("Low TV Unit", "tv-unit"),
  item("Pine Shelf", "shelf"),
  item("Ceramic Vase", "decor"),
];

function matchedCategories(query: string): string[] {
  return catalog.filter((entry) => matchesCatalogQuery(entry, query)).map((entry) => entry.name);
}

// Readable chip names, one per category, never the slug.
for (const key of CATEGORIES) {
  const label = CATEGORY_LABELS[key];
  check(
    `label:${key}`,
    typeof label === "string" && label.length > 0 && label !== key && !label.includes("-"),
    `got ${JSON.stringify(label)}`,
  );
}
check("label:coffee-table", CATEGORY_LABELS["coffee-table"] === "Coffee tables");
check("label:tv-unit", CATEGORY_LABELS["tv-unit"] === "TV units");

// Top bar readout: count first, labelled.
check("topbar:4-items", formatTopBar(4, 3280) === "4 items · $3,280", formatTopBar(4, 3280));
check("topbar:empty", formatTopBar(0, 0) === "0 items · $0", formatTopBar(0, 0));
check("topbar:singular", formatTopBar(1, 999) === "1 item · $999", formatTopBar(1, 999));

// Synonym search.
check(
  "synonym:couch",
  JSON.stringify(matchedCategories("couch")) === JSON.stringify(["Black Sofa"]),
  matchedCategories("couch").join(","),
);
check(
  "synonym:chair",
  JSON.stringify(matchedCategories("chair")) === JSON.stringify(["Linen Armchair"]),
  matchedCategories("chair").join(","),
);
check(
  "synonym:table",
  JSON.stringify(matchedCategories("table")) ===
    JSON.stringify(["Oak Coffee Table", "Walnut Side Table"]),
  matchedCategories("table").join(","),
);
check(
  "synonym:plant",
  JSON.stringify(matchedCategories("plant")) === JSON.stringify(["Ceramic Vase"]),
  matchedCategories("plant").join(","),
);
check(
  "synonym:cabinet",
  JSON.stringify(matchedCategories("cabinet")) === JSON.stringify(["Low TV Unit"]),
  matchedCategories("cabinet").join(","),
);
check(
  "synonym:stand",
  JSON.stringify(matchedCategories("stand")) === JSON.stringify(["Low TV Unit"]),
  matchedCategories("stand").join(","),
);
check(
  "synonym:bookcase",
  JSON.stringify(matchedCategories("bookcase")) === JSON.stringify(["Pine Shelf"]),
  matchedCategories("bookcase").join(","),
);

// No match stays empty (the panel names the categories instead).
check(
  "synonym:bed-empty",
  matchedCategories("bed").length === 0,
  matchedCategories("bed").join(","),
);

if (failures > 0) process.exit(1);
console.log("guidance: all checks passed");
