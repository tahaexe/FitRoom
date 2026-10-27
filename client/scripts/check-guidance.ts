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
 *   (the panel then shows its no-match message with the categories);
 * - an overlap verdict names both pieces in shopper words;
 * - the selected-piece status pill reads in plain words (never symbols).
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FitEngine } from "@fitroom/shared";
import {
  briefPromptAddition,
  briefResultCard,
  briefShortLabel,
  briefStartLine,
  buildBriefRequest,
  overBudgetError,
  type AssistantBrief,
  type CatalogItem,
  type RoomLayout,
  type SceneState,
} from "@fitroom/shared";
import { furnishProgressLine, parseBriefChip } from "../src/assistant/panel.js";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  formatMeasure,
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

// An overlap verdict names both pieces in shopper words.
const guideRoom = {
  walls: [
    { id: "n", start: { x: 0, z: 0 }, end: { x: 1000, z: 0 } },
    { id: "e", start: { x: 1000, z: 0 }, end: { x: 1000, z: 1000 } },
    { id: "s", start: { x: 1000, z: 1000 }, end: { x: 0, z: 1000 } },
    { id: "w", start: { x: 0, z: 1000 }, end: { x: 0, z: 0 } },
  ],
  openings: [],
  fixtures: [],
} as unknown as RoomLayout;
const guideProducts = new Map([
  ["black-sofa", { size: { w: 180, d: 80, h: 90 }, category: "sofa", name: "Black Sofa" }],
  [
    "oak-table",
    { size: { w: 120, d: 60, h: 45 }, category: "coffee-table", name: "Oak Coffee Table" },
  ],
]);
const guideScene = {
  items: [
    {
      instanceId: "a",
      productId: "black-sofa",
      position: { x: 500, z: 500 },
      rotationY: 0,
      variant: "",
    },
    {
      instanceId: "b",
      productId: "oak-table",
      position: { x: 530, z: 500 },
      rotationY: 0,
      variant: "",
    },
  ],
} as unknown as SceneState;
const guideOverlap = new FitEngine(guideRoom, guideProducts)
  .analyze(guideScene)
  .issues.find((issue) => issue.type === "overlap");
check(
  "overlap:names-both",
  guideOverlap !== undefined &&
    guideOverlap.message.includes("Black Sofa") &&
    guideOverlap.message.includes("Oak Coffee Table"),
  guideOverlap?.message,
);

// The selected-piece status pill reads in plain words (never symbols).
const guidePill = formatMeasure("Black Sofa", 180, 80, 12, 90);
check(
  "pill:plain-words",
  guidePill.includes("Black Sofa") &&
    guidePill.includes("from the wall") &&
    !guidePill.includes("Δ") &&
    !guidePill.includes("∠") &&
    !guidePill.includes("✕") &&
    !guidePill.includes("✓"),
  guidePill,
);

// ---- Furnish brief texts ----
const furnishBrief: AssistantBrief = {
  seats: 4,
  style: "classic",
  budget: 2500,
  keepExisting: false,
};
check(
  "brief:request",
  buildBriefRequest(furnishBrief) ===
    "Furnish this room for 4 people, Classic style, new pieces up to $2,500.",
  buildBriefRequest(furnishBrief),
);
check(
  "brief:request-note",
  buildBriefRequest(furnishBrief, "leave the window wall free") ===
    "Furnish this room for 4 people, Classic style, new pieces up to $2,500. leave the window wall free",
);
check(
  "brief:request-singular",
  buildBriefRequest({ seats: 1, style: "modern", budget: 1500, keepExisting: false }) ===
    "Furnish this room for 1 person, Modern style, new pieces up to $1,500.",
);
check(
  "brief:request-scandinavian",
  buildBriefRequest({ seats: 2, style: "scandinavian", budget: 1500, keepExisting: false }) ===
    "Furnish this room for 2 people, Scandinavian style, new pieces up to $1,500.",
);
check(
  "brief:over-budget",
  overBudgetError("Rhythm TV Unit", 860, 1850, 2500) ===
    "Over budget: Rhythm TV Unit ($860) would make $2,710 of $2,500; $650 left.",
  overBudgetError("Rhythm TV Unit", 860, 1850, 2500),
);
const briefAddition = briefPromptAddition(furnishBrief);
check(
  "brief:prompt",
  briefAddition.includes(
    "Furnishing brief: seat 4 people, Classic style, new pieces at most $2,500 in total, starting from an empty room.",
  ) && briefAddition.includes("Answer in at most three sentences: what you chose and why."),
  briefAddition.slice(0, 160),
);
// Short chip labels (the request sentence stays the chat line and store key).
check(
  "brief:chip-label",
  briefShortLabel(furnishBrief) === "4 seats · Classic · up to $2,500",
  briefShortLabel(furnishBrief),
);
check(
  "brief:chip-label-singular",
  briefShortLabel({ seats: 1, style: "modern", budget: 1500, keepExisting: false }) ===
    "1 seat · Modern · up to $1,500",
);
check(
  "brief:chip-label-note",
  briefShortLabel(furnishBrief, "keep the window wall free") ===
    "4 seats · Classic · up to $2,500 · keep the window wall free",
);
// The computed line under a brief's card (real counts, never a move list).
check(
  "brief:start-line-empty",
  briefStartLine(furnishBrief, 4) ===
    "Started from an empty room; Undo brings back the 4 pieces that were here.",
  briefStartLine(furnishBrief, 4),
);
check(
  "brief:start-line-kept",
  briefStartLine({ ...furnishBrief, keepExisting: true }, 4) === "Kept the 4 pieces already here.",
);
check(
  "brief:start-line-singular",
  briefStartLine(furnishBrief, 1) ===
    "Started from an empty room; Undo brings back the 1 piece that was here.",
  briefStartLine(furnishBrief, 1),
);
check(
  "brief:start-line-kept-singular",
  briefStartLine({ ...furnishBrief, keepExisting: true }, 1) === "Kept the 1 piece already here.",
);
check(
  "brief:progress-choose",
  furnishProgressLine(["get_room", "list_items"]) === "Choosing pieces…",
);
check(
  "brief:progress-place",
  furnishProgressLine(["place_item", "place_item"]) === "Placing 2 pieces…",
);
check(
  "brief:progress-place-one",
  furnishProgressLine(["place_against_wall"]) === "Placing 1 piece…",
);
check("brief:progress-check", furnishProgressLine(["check_fit"]) === "Checking the fit…");
const parsedBrief = parseBriefChip(buildBriefRequest(furnishBrief));
check(
  "brief:chip-roundtrip",
  parsedBrief !== null &&
    JSON.stringify(parsedBrief.brief) === JSON.stringify(furnishBrief) &&
    parsedBrief.note === "",
);
check(
  "brief:chip-note",
  parseBriefChip(buildBriefRequest(furnishBrief, "leave the window wall free"))?.note ===
    "leave the window wall free",
);
check("brief:chip-reject", parseBriefChip("Put the sofa under the window") === null);
// Recorded sentences predate style capitalization and still parse.
check(
  "brief:chip-recorded-lowercase",
  JSON.stringify(
    parseBriefChip("Furnish this room for 4 people, classic style, new pieces up to $2,500.")
      ?.brief,
  ) === JSON.stringify(furnishBrief),
);

// The result card, computed from the end scene: headline, rows, shortfall.
const furnishCatalog = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "catalog", "catalog.json"),
    "utf8",
  ),
) as CatalogItem[];
const furnishStart = {
  roomId: "guide",
  items: [],
  camera: {
    mode: "orbit",
    position: { x: 0, y: 0, z: 0 },
    target: { x: 0, y: 0, z: 0 },
  },
} as SceneState;
const furnishEnd: SceneState = {
  ...furnishStart,
  items: [
    {
      instanceId: "sofa_02",
      productId: "sofa_02",
      position: { x: 500, z: 500 },
      rotationY: 0,
      variant: "default",
    },
    {
      instanceId: "GreenChair_01",
      productId: "GreenChair_01",
      position: { x: 750, z: 250 },
      rotationY: 0,
      variant: "default",
    },
  ],
};
const furnishCard = briefResultCard(
  furnishStart,
  furnishEnd,
  guideRoom,
  furnishCatalog,
  furnishBrief,
);
check(
  "brief:card-headline",
  furnishCard.headline === "Seats 3 of 4 · 2 new pieces · $1,870 of $2,500 · ✓ Fits",
  furnishCard.headline,
);
check("brief:card-short", furnishCard.seatsShort === true);
check(
  "brief:card-rows",
  furnishCard.rows.length === 2 &&
    furnishCard.rows.every((row) => row.styleMatch) &&
    furnishCard.rows[0]?.name === "Chester Leather Sofa" &&
    furnishCard.rows[0]?.price === 1490,
);

if (failures > 0) process.exit(1);
console.log("guidance: all checks passed");
