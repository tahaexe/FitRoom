/**
 * `npm run check:guide` — headless four-moment guide check (no browser, no
 * Meta calls). Pins the tour the first visitor sees:
 *
 * - a first open shows moment 1 only;
 * - skipping stores `skipped` and a reload shows nothing;
 * - finishing stores `done`;
 * - the retired `fitroom.coach-seen = 1` counts as seen;
 * - a room change to an empty room never shows moments 3-4;
 * - Help after `skipped`/`done` shows the moment that fits the screen;
 * - the placement function keeps the bubble inside the window (8 px margin,
 *   flipping side when needed) for targets at each edge of 390x844,
 *   1366x768 and 1904x951;
 * - `prefers-reduced-motion: reduce` yields no transition;
 * - the bubble fade stays inside its 200-250 ms window;
 * - the old coach marks are gone (module, bar, styles, key writes).
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fittingMoment,
  GUIDE_KEY,
  GUIDE_LEGACY_KEY,
  GUIDE_MARGIN_PX,
  GUIDE_TRANSITION_MS,
  Guide,
  guideAction,
  guideBubble,
  guideProgress,
  guideTargetCandidates,
  guideText,
  momentFits,
  placeBubble,
  type GuideScreen,
  type GuideStorage,
} from "../src/guide.js";

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function memoryStorage(seed: Record<string, string> = {}): GuideStorage {
  const map = new Map(Object.entries(seed));
  return {
    get: (key: string) => map.get(key) ?? null,
    set: (key: string, value: string) => {
      map.set(key, value);
    },
    remove: (key: string) => {
      map.delete(key);
    },
  };
}

const dialogScreen: GuideScreen = {
  firstOpenVisible: true,
  exampleActionVisible: true,
  roomVisible: false,
  itemCount: 0,
  aiVisible: false,
  isPhone: false,
};
const emptyScreen: GuideScreen = {
  firstOpenVisible: false,
  exampleActionVisible: false,
  roomVisible: true,
  itemCount: 0,
  aiVisible: true,
  isPhone: false,
};
const piecesScreen: GuideScreen = {
  firstOpenVisible: false,
  exampleActionVisible: false,
  roomVisible: true,
  itemCount: 2,
  aiVisible: true,
  isPhone: false,
};

// ---- The four texts, word for word ----
check(
  "guide:text-1",
  guideText(1, false) === "Start here: try the example room, or enter your own room size.",
  guideText(1, false),
);
check("guide:text-2", guideText(2, false) === "Add a piece from the catalog.", guideText(2, false));
check(
  "guide:text-2-phone",
  guideText(2, true) === "Open the catalog and add a piece.",
  guideText(2, true),
);
check(
  "guide:text-3",
  guideText(3, false) === "Drag it around. Its outline shows whether it fits.",
  guideText(3, false),
);
check(
  "guide:text-4",
  guideText(4, false) === "Let AI furnish the room for you.",
  guideText(4, false),
);
check("guide:progress", guideProgress(2) === "2 of 4", guideProgress(2));
check(
  "guide:actions",
  guideAction(1) === "Next" && guideAction(3) === "Next" && guideAction(4) === "Got it",
  `${guideAction(1)} / ${guideAction(4)}`,
);
check(
  "guide:bubble",
  JSON.stringify(guideBubble(2, false)) ===
    JSON.stringify({ text: "Add a piece from the catalog.", progress: "2 of 4", action: "Next" }),
  JSON.stringify(guideBubble(2, false)),
);

// ---- A first open shows moment 1 only ----
{
  const guide = new Guide(memoryStorage());
  const shown = guide.start(dialogScreen);
  check("guide:first-open-moment-1", shown === 1, `got ${String(shown)}`);
  check(
    "guide:first-open-only-1",
    !momentFits(2, dialogScreen) && !momentFits(3, dialogScreen) && !momentFits(4, dialogScreen),
    "moments 2-4 must not fit the first-run dialog",
  );
  check(
    "guide:first-open-single-bubble",
    guide.showing && guide.moment === 1,
    "one bubble at a time, never an upfront slideshow",
  );
}

// ---- Skipping stores `skipped`; a reload shows nothing ----
{
  const storage = memoryStorage();
  const guide = new Guide(storage);
  guide.start(emptyScreen);
  guide.skip();
  check("guide:skip-stores", storage.get(GUIDE_KEY) === "skipped", storage.get(GUIDE_KEY));
  const reload = new Guide(storage);
  check("guide:skip-reload-dark", reload.start(emptyScreen) === null, "reload must show nothing");
  const reloadDialog = new Guide(storage);
  check(
    "guide:skip-reload-dialog-dark",
    reloadDialog.start(dialogScreen) === null,
    "reload on the dialog must show nothing either",
  );
}

// ---- Finishing stores `done` ----
{
  const storage = memoryStorage();
  const guide = new Guide(storage);
  guide.start(emptyScreen);
  guide.advanceOnItemsAdded(piecesScreen);
  guide.advanceOnPieceMoved(piecesScreen);
  guide.next(piecesScreen);
  guide.finish();
  check("guide:finish-stores", storage.get(GUIDE_KEY) === "done", storage.get(GUIDE_KEY));
  const reload = new Guide(storage);
  check(
    "guide:finish-reload-dark",
    reload.start(piecesScreen) === null,
    "reload must show nothing",
  );
}

// ---- The old key counts as seen ----
{
  const storage = memoryStorage({ [GUIDE_LEGACY_KEY]: "1" });
  const guide = new Guide(storage);
  check("guide:legacy-seen", guide.hasSeen() === true, "coach-seen = 1 counts as seen");
  check("guide:legacy-dark", guide.start(piecesScreen) === null, "no bubble for a seen visitor");
  check(
    "guide:legacy-key-name",
    GUIDE_LEGACY_KEY === "fitroom.coach-seen" && GUIDE_KEY === "fitroom.guide",
    `${GUIDE_KEY} / ${GUIDE_LEGACY_KEY}`,
  );
}

// ---- A room change to an empty room never shows moments 3-4 ----
{
  check("guide:empty-hides-3", momentFits(3, emptyScreen) === false, "moment 3 needs a piece");
  check("guide:empty-hides-4", momentFits(4, emptyScreen) === false, "moment 4 needs a piece");
  check(
    "guide:empty-falls-back-2",
    fittingMoment(emptyScreen, 3) === null,
    "no moment at or after 3 fits an empty room",
  );
  const guide = new Guide(memoryStorage());
  guide.start(piecesScreen);
  guide.advanceOnItemsAdded(piecesScreen);
  check("guide:at-3-with-pieces", guide.moment === 3, `got ${String(guide.moment)}`);
  const after = guide.reevaluate(emptyScreen);
  check("guide:room-change-to-empty", after === 2, `got ${String(after)}`);
}

// ---- The real actions move on ----
{
  const guide = new Guide(memoryStorage());
  guide.start(emptyScreen);
  check("guide:starts-at-2", guide.moment === 2, `got ${String(guide.moment)}`);
  guide.advanceOnItemsAdded(piecesScreen);
  check("guide:add-moves-on", guide.moment === 3, `got ${String(guide.moment)}`);
  guide.advanceOnPieceMoved(piecesScreen);
  check("guide:move-moves-on", guide.moment === 4, `got ${String(guide.moment)}`);
  // A size-form detour fits no moment; the tour resumes instead of dying.
  const sizeScreen: GuideScreen = { ...emptyScreen, roomVisible: false };
  const paused = guide.reevaluate(sizeScreen);
  const resumed = guide.reevaluate(piecesScreen);
  check(
    "guide:survives-detour",
    paused === null && resumed === 4,
    `${String(paused)} then ${String(resumed)}`,
  );
  // "Next" never jumps to a moment whose target is missing.
  const stuck = new Guide(memoryStorage());
  stuck.start(emptyScreen);
  const stayed = stuck.next(emptyScreen);
  check("guide:next-never-missing", stayed === 2, `got ${String(stayed)}`);
}

// ---- Targets exist per moment, desktop and phone ----
{
  check(
    "guide:targets-1",
    JSON.stringify(guideTargetCandidates(1, false)) ===
      JSON.stringify([".first-open .setup-try-example"]),
    guideTargetCandidates(1, false).join(","),
  );
  check(
    "guide:targets-2-desktop",
    JSON.stringify(guideTargetCandidates(2, false)) === JSON.stringify(["#catalog"]),
    guideTargetCandidates(2, false).join(","),
  );
  const phone2 = guideTargetCandidates(2, true);
  check(
    "guide:targets-2-phone",
    phone2.includes("#catalog") && phone2.includes("#phone-catalog"),
    phone2.join(","),
  );
  check(
    "guide:targets-3",
    JSON.stringify(guideTargetCandidates(3, false)) === JSON.stringify(["#fit-badge"]),
    guideTargetCandidates(3, false).join(","),
  );
  const desk4 = guideTargetCandidates(4, false);
  check(
    "guide:targets-4-desktop",
    desk4.includes("#tool-assistant") && desk4.includes("#tool-recommend"),
    desk4.join(","),
  );
  check(
    "guide:targets-4-phone",
    JSON.stringify(guideTargetCandidates(4, true)) === JSON.stringify(["#phone-ai"]),
    guideTargetCandidates(4, true).join(","),
  );
}

// ---- Placement: inside the window with an 8 px margin, at three sizes ----
{
  const viewports = [
    { w: 390, h: 844 },
    { w: 1366, h: 768 },
    { w: 1904, h: 951 },
  ];
  const bubble = { x: 0, y: 0, w: 300, h: 140 };
  let placements = 0;
  let inside = 0;
  let flipped = 0;
  for (const viewport of viewports) {
    const { w, h } = viewport;
    // Targets at each edge: four corners, four edge centres, the centre.
    const targets = [
      { x: 4, y: 4, w: 48, h: 24 },
      { x: w - 52, y: 4, w: 48, h: 24 },
      { x: 4, y: h - 28, w: 48, h: 24 },
      { x: w - 52, y: h - 28, w: 48, h: 24 },
      { x: w / 2 - 60, y: 4, w: 120, h: 24 },
      { x: w / 2 - 60, y: h - 28, w: 120, h: 24 },
      { x: 4, y: h / 2 - 20, w: 48, h: 40 },
      { x: w - 52, y: h / 2 - 20, w: 48, h: 40 },
      { x: w / 2 - 60, y: h / 2 - 20, w: 120, h: 40 },
    ];
    for (const target of targets) {
      const placed = placeBubble(target, bubble, { x: 0, y: 0, w, h });
      placements += 1;
      const bw = Math.min(bubble.w, w - GUIDE_MARGIN_PX * 2);
      const bh = Math.min(bubble.h, h - GUIDE_MARGIN_PX * 2);
      const ok =
        placed.left >= GUIDE_MARGIN_PX &&
        placed.top >= GUIDE_MARGIN_PX &&
        placed.left + bw <= w - GUIDE_MARGIN_PX &&
        placed.top + bh <= h - GUIDE_MARGIN_PX;
      if (ok) inside += 1;
      else {
        check(
          `guide:placement-${w}x${h}`,
          false,
          `target (${String(target.x)},${String(target.y)}) escapes to (${String(placed.left)},${String(placed.top)})`,
        );
      }
      if (target.y < 200 && placed.side === "below") flipped += 1;
      if (target.y > h - 200 && placed.side === "above") flipped += 1;
    }
  }
  check(
    "guide:placement-inside",
    inside === placements,
    `${String(inside)}/${String(placements)} inside`,
  );
  check(
    "guide:placement-flips",
    flipped > 0,
    "near the top it drops below, near the bottom it rises above",
  );
}

// ---- Style + wiring in the repo ----
const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(here, "..", "src", "main.ts"), "utf8");
const styleSource = readFileSync(join(here, "..", "src", "style.css"), "utf8");
const hintsSource = readFileSync(join(here, "..", "src", "hints.ts"), "utf8");

check(
  "guide:motion-window",
  GUIDE_TRANSITION_MS >= 200 && GUIDE_TRANSITION_MS <= 250,
  `${String(GUIDE_TRANSITION_MS)} ms (200-250 ms fade and slight slide)`,
);
check(
  "guide:motion-css",
  styleSource.includes(".guide-bubble") &&
    styleSource.includes("220ms") &&
    /\.guide-bubble[^{]*\{[^}]*transition:[^}]*opacity[^}]*transform/.test(styleSource),
  "the bubble fades and slides in",
);
check(
  "guide:reduced-motion",
  styleSource.includes("@media (prefers-reduced-motion: reduce)") &&
    styleSource.includes(".guide-ring") &&
    /prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.guide-bubble[^}]*transition:\s*none/s.test(
      styleSource,
    ),
  "reduced motion yields no transition at all",
);
check(
  "guide:ring-tokens",
  styleSource.includes(".guide-ring") &&
    styleSource.toLowerCase().includes("#f54e49") &&
    styleSource.includes("14px") &&
    styleSource.includes("0 4px 16px rgba(30, 30, 40, 0.08)"),
  "white bubble, card radius/shadow, coral ring",
);
check(
  "guide:progress-coral",
  /\.guide-progress\s*\{[^}]*#[Ff]54[Ee]49/.test(styleSource),
  "the progress mark reads coral",
);
check(
  "guide:page-stays-usable",
  /\.guide-ring\s*\{[^}]*pointer-events:\s*none/.test(styleSource),
  "the ring never intercepts the page",
);
check(
  "guide:main-wires-guide",
  mainSource.includes('from "./guide"') &&
    mainSource.includes("updateGuide") &&
    mainSource.includes("renderGuide"),
  "main.ts runs the guide, not the coach marks",
);
check(
  "guide:old-tour-gone",
  !mainSource.includes("maybeShowCoachMarks") &&
    !mainSource.includes("coach-marks") &&
    !mainSource.includes("1 of 3"),
  "no coach-mark bar, method or copy left in main.ts",
);
check(
  "guide:old-css-gone",
  !styleSource.includes("coach-marks") && !styleSource.includes("coach-text"),
  "no coach-mark styles left",
);
check(
  "guide:old-key-retired",
  !mainSource.includes("fitroom.coach-seen") || mainSource.includes('from "./guide"'),
  "only the guide module reads the retired key (as seen)",
);
check(
  "guide:hints-rule-retired",
  !hintsSource.includes("coachMarksReady"),
  "the tour-start rule in hints.ts is gone with the tour",
);
check(
  "guide:storage-key-written",
  GUIDE_KEY === "fitroom.guide" &&
    readFileSync(join(here, "..", "src", "guide.ts"), "utf8").includes(
      'set(GUIDE_KEY, "skipped")',
    ) &&
    readFileSync(join(here, "..", "src", "guide.ts"), "utf8").includes('set(GUIDE_KEY, "done")'),
  "the outcome is stored as fitroom.guide = done or skipped",
);
check(
  "guide:escape-skips",
  mainSource.includes("this.skipGuide()") && /if \(this\.guide\.showing\)/.test(mainSource),
  "Escape skips the guide",
);
if (failures > 0) process.exit(1);
console.log("guide: all checks passed");
