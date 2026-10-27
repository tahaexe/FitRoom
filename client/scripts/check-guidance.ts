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
 * - a typed wall length reads "Measured ± 0.5 cm", the amber band counts
 *   down the estimated walls and its pill reads "Tape wall <letter>".
 * - Esc mid-drag (corner, edge or box) cancels only that drag and stops
 *   there, so the editor stays open; a committed drag rebuilds the stage
 *   so every opening's visible box label shows the re-solved numbers.
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
import { measuredMarkText, photoBandText, tapeWallLabel } from "../src/editor/source-mark.js";
import {
  cornerHandleLabel,
  openingBoxLabel,
  openingBoxText,
  wallCardStatus,
} from "../src/editor/photo-confirm.js";
import {
  detectDefaultUnit,
  detectSlip,
  echoFor,
  parseLengthToCm,
  resolveFirstOpen,
  validateCeiling,
  validateSide,
} from "../src/room-units.js";

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

// Typed wall lengths turn measured with a ± 0.5 cm tape mark.
check("measured:plain", measuredMarkText() === "Measured", measuredMarkText());
check("measured:plus-minus", measuredMarkText(0.5) === "Measured ± 0.5 cm", measuredMarkText(0.5));
// The amber photo-draft band counts down the estimated walls.
check(
  "band:singular",
  photoBandText(1, 8) === "1 wall is estimated (± 8 cm). Tape it to make it exact.",
  photoBandText(1, 8),
);
check(
  "band:plural",
  photoBandText(3, 8) === "3 walls are estimated (± 8 cm). Tape one to make it exact.",
  photoBandText(3, 8),
);
// The band's tape pill names the next estimated wall letter.
check("tape:wall-a", tapeWallLabel("A") === "Tape wall A", tapeWallLabel("A"));
check("tape:wall-c", tapeWallLabel("C") === "Tape wall C", tapeWallLabel("C"));

// ---- "AI drafts, you confirm" texts ----
check(
  "confirm:corner-name",
  cornerHandleLabel("m1", "B") === "Corner top left of wall B",
  cornerHandleLabel("m1", "B"),
);
check(
  "confirm:corner-shift",
  cornerHandleLabel("m3", "D") === "Corner bottom left of wall D",
  cornerHandleLabel("m3", "D"),
);
check(
  "confirm:corner-m4",
  cornerHandleLabel("m4", "A") === "Corner bottom right of wall A",
  cornerHandleLabel("m4", "A"),
);
check(
  "confirm:opening-box",
  openingBoxLabel("window", "C", 120) === "Window on wall C, 120 cm",
  openingBoxLabel("window", "C", 120),
);
check(
  "confirm:opening-door",
  openingBoxLabel("door", "A", 90) === "Door on wall A, 90 cm",
  openingBoxLabel("door", "A", 90),
);
check(
  "confirm:opening-tag",
  openingBoxText("window", 120, 140) === "Window 120 × 140",
  openingBoxText("window", 120, 140),
);
check("confirm:active", wallCardStatus(true, true) === "Active", wallCardStatus(true, true));
check(
  "confirm:active-unseen",
  wallCardStatus(true, false) === "Active",
  wallCardStatus(true, false),
);
check("confirm:done", wallCardStatus(false, true) === "Done", wallCardStatus(false, true));
check("confirm:todo", wallCardStatus(false, false) === "To do", wallCardStatus(false, false));

// ---- Esc cancels only the drag; box labels follow each re-solve ----
const confirmSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "editor", "photo-confirm.ts"),
  "utf8",
);
// The drag's Esc handler stops the keypress, so the editor's own Esc
// handler never runs and the editor stays open with the photos intact.
check(
  "confirm:esc-stops-there",
  confirmSource.includes("event.stopPropagation()") &&
    confirmSource.includes("event.stopImmediatePropagation()"),
  "onEscape must stop the keypress reaching the editor",
);
check(
  "confirm:esc-capture",
  confirmSource.includes('document.addEventListener("keydown", onEscape, true)') &&
    confirmSource.includes('document.removeEventListener("keydown", onEscape, true)'),
  "drag Esc listener must run in the capture phase",
);
check(
  "confirm:esc-drag-flag",
  confirmSource.includes("isDragging(): boolean"),
  "the view must expose whether a drag is in progress",
);
// A commit dispatches while the drag flags are still set (the store
// subscription then skips the stage to protect pointer capture), so finish
// must rebuild afterwards: the visible tag then follows the re-solve.
check(
  "confirm:commit-rerenders",
  confirmSource.includes("visible box") && confirmSource.includes("follows the re-solve"),
  "finish must re-render the stage after a commit",
);
// The box tag and its accessible name read the re-solved room numbers.
check(
  "confirm:box-label-follows-resolve",
  confirmSource.includes("roomOpening?.width") &&
    confirmSource.includes("roomOpening?.height") &&
    confirmSource.includes("openingBoxText(kind, widthCm, heightCm)") &&
    confirmSource.includes("openingBoxLabel(kind, session.activeWall, widthCm)"),
  "box tag and accessible name must read the re-solved room numbers",
);
// The tag and the accessible name round the same width.
check(
  "confirm:label-tag-agree",
  openingBoxLabel("door", "A", 94) === "Door on wall A, 94 cm" &&
    openingBoxText("door", 94, 210) === "Door 94 × 210",
  `${openingBoxLabel("door", "A", 94)} / ${openingBoxText("door", 94, 210)}`,
);

// ---- Credits text (dialog plus CREDITS.md) ----
const creditsDialog = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"),
  "utf8",
).replace(/\s+/g, " ");
check(
  "credits:models-line",
  creditsDialog.includes(
    "Muse Spark runs Recommend, Arrange and Furnish and labels your photos; " +
      "SAM 3.1 finds the walls, doors and windows in your photos; " +
      "Muse Image draws the photoreal view.",
  ),
);
check(
  "credits:font-line",
  creditsDialog.includes("Nunito") &&
    creditsDialog.includes("@fontsource/nunito") &&
    creditsDialog.includes("SIL Open Font License 1.1"),
);
check(
  "credits:photos-line",
  creditsDialog.includes("eight") &&
    creditsDialog.includes("CC0-1.0") &&
    creditsDialog.includes("Wikimedia Commons"),
);
const creditsMd = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "CREDITS.md"),
  "utf8",
);
check("credits:cc0-section", creditsMd.includes("## CC0 assets"));
check("credits:code-section", creditsMd.includes("## Code dependencies"));
check("credits:hdri-author", creditsMd.includes("lebombo") && creditsMd.includes("Greg Zaal"));
const creditDeps: Array<[string, string]> = [
  ["@meta-sam/parser", "SAM License"],
  ["three", "MIT"],
  ["exifr", "MIT"],
  ["@fontsource/nunito", "SIL Open Font License 1.1"],
  ["hono", "MIT"],
  ["@hono/node-server", "MIT"],
  ["dotenv", "BSD-2-Clause"],
  ["ajv", "MIT"],
];
for (const [pkg, licence] of creditDeps) {
  check(
    `credits:dep-${pkg}`,
    creditsMd.includes(`Package: \`${pkg}\``) && creditsMd.includes(licence),
    `${pkg} with ${licence}`,
  );
}
const creditPhotos: Array<[string, string]> = [
  ["living-room-unsplash-ceborski", "Jarosław Ceborski"],
  ["living-room-carlos-zgz", "Carlos ZGZ"],
  ["apartment-granada-artchapiz", "Artchapiz"],
  ["hostel-twin-room-wardrobe", "Profpcde"],
  ["apartment-hotel-nice", "Paikan06"],
  ["living-room-houseplants", "Lo"],
  ["living-room-zaher-rio", "Wilfredor"],
  ["market-house-reading-room", "Andy Li"],
];
for (const [slug, author] of creditPhotos) {
  check(
    `credits:photo-${slug}`,
    creditsMd.includes(slug) &&
      creditsMd.includes(author) &&
      creditsMd.includes("commons.wikimedia.org"),
    `${slug} by ${author}`,
  );
}

// ---- Room size units: every accepted format, slips, limits, echo text ----
check("units:bare-cm", parseLengthToCm("420") === 420, String(parseLengthToCm("420")));
check("units:cm-suffix", parseLengthToCm("420 cm") === 420);
check("units:metres", parseLengthToCm("4.2 m") === 420);
check("units:metres-comma", parseLengthToCm("4,2 m") === 420);
check(
  "units:feet-inches-quote",
  parseLengthToCm(`13'9"`) === 419,
  String(parseLengthToCm(`13'9"`)),
);
check("units:feet-inches-space", parseLengthToCm(`13' 9"`) === 419);
check("units:feet-inches-bare", parseLengthToCm("13 9") === 419);
check("units:inches-only", parseLengthToCm(`165"`) === 419, String(parseLengthToCm(`165"`)));
check("units:feet-decimal", parseLengthToCm("13.75 ft") === 419);
check(
  "units:slip-message",
  detectSlip("4.2", 4, "side")?.message === "4.2 cm? Did you mean 4.2 m (420 cm)?",
  detectSlip("4.2", 4, "side")?.message,
);
check("units:slip-action", detectSlip("4.2", 4, "side")?.action === "Use 420 cm");
check("units:slip-suggests", detectSlip("4.2", 4, "side")?.suggestedCm === 420);
check("units:no-slip-normal", detectSlip("420", 420, "side") === null);
check(
  "units:side-limit-cm",
  validateSide("width", 50, "cm") === `Width must be 1-15 m (3'3"-49'2")`,
  validateSide("width", 50, "cm") ?? "",
);
check(
  "units:side-limit-ft",
  validateSide("width", 50, "ftin") === `Width must be 3'3"-49'2" (1-15 m)`,
  validateSide("width", 50, "ftin") ?? "",
);
check("units:side-ok", validateSide("width", 420, "cm") === null);
check(
  "units:ceiling-limit-cm",
  validateCeiling(150, "cm") === "Ceiling height must be 2-4 m (6'7\"-13'1\")",
);
check("units:ceiling-ok", validateCeiling(250, "cm") === null);
check("units:echo-cm", echoFor(419, "ftin") === "= 419 cm", echoFor(419, "ftin"));
check("units:echo-ft", echoFor(419, "cm") === `= 13'9"`, echoFor(419, "cm"));
check("units:default-en-us", detectDefaultUnit("en-US") === "ftin");
check("units:default-de", detectDefaultUnit("de-DE") === "cm");
check("units:default-en-gb", detectDefaultUnit("en-GB") === "cm");

// ---- First-open choice: saved room, ?room=sample, none ----
check(
  "firstopen:sample-param",
  resolveFirstOpen({ hasSavedRoom: false, roomParam: "sample" }) === "sample",
);
check(
  "firstopen:sample-wins",
  resolveFirstOpen({ hasSavedRoom: true, roomParam: "sample" }) === "sample",
);
check("firstopen:returning", resolveFirstOpen({ hasSavedRoom: true, roomParam: null }) === "room");
check("firstopen:fresh", resolveFirstOpen({ hasSavedRoom: false, roomParam: null }) === "setup");

// ---- First-open screen reads correctly in the built app ----
const firstOpenSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "first-open.ts"),
  "utf8",
);
check("firstopen:title", firstOpenSource.includes("Set up your room"));
check("firstopen:main-card", firstOpenSource.includes("Enter my room size"));
check("firstopen:photos-live", firstOpenSource.includes("Uses Live AI"));
check("firstopen:sample-size", firstOpenSource.includes("420 × 360 cm"));
check("firstopen:measure-hint", firstOpenSource.includes("Measure wall to wall at floor level."));
check(
  "firstopen:not-rectangle",
  firstOpenSource.includes("Not a rectangle? Shape it in the plan editor"),
);
check(
  "firstopen:door-tip",
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts"),
    "utf8",
  ).includes("Add your door and windows; clearance checks use them."),
);
check(
  "firstopen:more-ceiling",
  firstOpenSource.includes("More") && firstOpenSource.includes("Ceiling height"),
);
check(
  "firstopen:phone-css",
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "style.css"),
    "utf8",
  ).includes("@media (max-width: 720px)"),
);
check(
  "firstopen:inputmode",
  firstOpenSource.includes('inputmode", "decimal') || firstOpenSource.includes("inputmode"),
);

if (failures > 0) process.exit(1);
console.log("guidance: all checks passed");
