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
  bubbleMeasuredSize,
  fittingMoment,
  GUIDE_BUBBLE_MAX_W_PX,
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
import { shouldResumePhotoConfirm } from "../src/state.js";

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
  guideText(1, false) ===
    "Start here: try it with our example photos, or enter your own room size.",
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

// ---- Help after `skipped` or `done` shows the moment that fits ----
{
  for (const outcome of ["skipped", "done"] as const) {
    const storage = memoryStorage({ [GUIDE_KEY]: outcome });
    const guide = new Guide(storage);
    check(
      `guide:help-after-${outcome}-empty`,
      guide.restart(emptyScreen) === 2,
      `Help on an empty room must show moment 2 after ${outcome}`,
    );
    const storagePieces = memoryStorage({ [GUIDE_KEY]: outcome });
    const guidePieces = new Guide(storagePieces);
    check(
      `guide:help-after-${outcome}-pieces`,
      guidePieces.restart(piecesScreen) === 3,
      `Help with pieces must show moment 3 after ${outcome}`,
    );
    const storageDialog = memoryStorage({ [GUIDE_KEY]: outcome });
    const guideDialog = new Guide(storageDialog);
    check(
      `guide:help-after-${outcome}-dialog`,
      guideDialog.restart(dialogScreen) === 1,
      `Help on the dialog must show moment 1 after ${outcome}`,
    );
  }
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

// ---- Breakpoint crossings keep the moment, switch text and target ----
{
  const phoneEmpty: GuideScreen = { ...emptyScreen, isPhone: true };
  const deskEmpty: GuideScreen = { ...emptyScreen, isPhone: false };
  const guide = new Guide(memoryStorage());
  const atPhone = guide.start(phoneEmpty);
  check("guide:breakpoint-phone-moment-2", atPhone === 2, `got ${String(atPhone)}`);
  check(
    "guide:breakpoint-phone-text",
    guideText(guide.moment ?? 2, true) === "Open the catalog and add a piece.",
    guideText(guide.moment ?? 2, true),
  );
  const phoneTargets = guideTargetCandidates(guide.moment ?? 2, true);
  // 390 px wide, developer panel or turned tablet: the phone target is the
  // open sheet or the Catalog tab, both zero-size on desktop.
  check(
    "guide:breakpoint-phone-target",
    phoneTargets.includes("#phone-catalog"),
    phoneTargets.join(","),
  );
  // 390 → 1366 in a frame: the moment stays, the desktop text and the
  // desktop target take over.
  const atDesk = guide.reevaluate(deskEmpty);
  check("guide:breakpoint-desk-keeps-moment", atDesk === 2, `got ${String(atDesk)}`);
  check(
    "guide:breakpoint-desk-text",
    guideText(guide.moment ?? 2, false) === "Add a piece from the catalog.",
    guideText(guide.moment ?? 2, false),
  );
  check(
    "guide:breakpoint-desk-target",
    JSON.stringify(guideTargetCandidates(guide.moment ?? 2, false)) ===
      JSON.stringify(["#catalog"]),
    guideTargetCandidates(guide.moment ?? 2, false).join(","),
  );
  // And back 1366 → 390: still moment 2, phone text and phone target again.
  const backPhone = guide.reevaluate(phoneEmpty);
  const backTargets = guideTargetCandidates(guide.moment ?? 2, true);
  check("guide:breakpoint-back-keeps-moment", backPhone === 2, `got ${String(backPhone)}`);
  check(
    "guide:breakpoint-back-text",
    guideText(guide.moment ?? 2, true) === "Open the catalog and add a piece.",
    guideText(guide.moment ?? 2, true),
  );
  check(
    "guide:breakpoint-back-target",
    backTargets.includes("#phone-catalog"),
    backTargets.join(","),
  );
  // A zero-size target never seats a bubble: the phone-only target at 1366
  // (or the desktop catalog at 390 while hidden) reports 0 × 0, so the view
  // hides instead of parking a 12 × 12 ring at the top-left corner.
  const zeroRect = { x: 0, y: 0, w: 0, h: 0 };
  check(
    "guide:breakpoint-zero-target-hides",
    zeroRect.w <= 0 || zeroRect.h <= 0,
    "a zero-size target must hide the bubble, never ring the corner",
  );
}

// ---- Placement keeps 8 px at 390x844, 1366x768 and 1904x951 ----
{
  const viewports = [
    { w: 390, h: 844 },
    { w: 1366, h: 768 },
    { w: 1904, h: 951 },
  ];
  // Observed widths: the moment-1 bubble paints 304 px wide at 390 px.
  const bubbles = [
    { w: 300, h: 140 },
    { w: 304, h: 148 },
  ];
  let placements = 0;
  let inside = 0;
  for (const viewport of viewports) {
    const { w, h } = viewport;
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
    for (const bubble of bubbles) {
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
            `guide:placement-edge-${w}x${h}-${bubble.w}`,
            false,
            `target (${String(target.x)},${String(target.y)}) escapes to (${String(placed.left)},${String(placed.top)})`,
          );
        }
      }
    }
  }
  check(
    "guide:placement-edge-inside",
    inside === placements,
    `${String(inside)}/${String(placements)} inside at 8 px`,
  );
  // A hidden bubble measures 0 × 0: the fallback still paints inside the
  // window (never a 1 px box centred on the target, overflowing once shown).
  for (const viewport of viewports) {
    const measured = bubbleMeasuredSize(0, 0, viewport.w);
    const expectedW = Math.min(GUIDE_BUBBLE_MAX_W_PX, viewport.w - GUIDE_MARGIN_PX * 2);
    check(
      `guide:placement-hidden-fallback-${viewport.w}`,
      measured.w === expectedW && measured.w <= viewport.w - GUIDE_MARGIN_PX * 2,
      `fallback ${String(measured.w)} at ${String(viewport.w)} px`,
    );
  }
}

// ---- Startup: a built photo room opens built; only never-built resumes ----
{
  check(
    "guide:startup-built-flagged",
    shouldResumePhotoConfirm("photos-room", { built: true, itemCount: 1 }) === false,
    "built + furnished (1 item) opens as the built room",
  );
  check(
    "guide:startup-built-empty",
    shouldResumePhotoConfirm("photos-room", { built: true, itemCount: 0 }) === false,
    "built with no pieces yet still opens as the built room",
  );
  check(
    "guide:startup-built-legacy-items",
    shouldResumePhotoConfirm("photos-room", { built: false, itemCount: 1 }) === false,
    "pieces in the autosave mean built, even without the flag",
  );
  check(
    "guide:startup-never-built-resumes",
    shouldResumePhotoConfirm("photos-room", { built: false, itemCount: 0 }) === true,
    "only a never-built photo room resumes the confirm view",
  );
  check(
    "guide:startup-other-room",
    shouldResumePhotoConfirm("manual-room", { built: false, itemCount: 0 }) === false,
    "any other room never resumes the photo confirm view",
  );
}

// ---- Style + wiring in the repo ----
const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(here, "..", "src", "main.ts"), "utf8");
const styleSource = readFileSync(join(here, "..", "src", "style.css"), "utf8");
const hintsSource = readFileSync(join(here, "..", "src", "hints.ts"), "utf8");
const indexSource = readFileSync(join(here, "..", "index.html"), "utf8");
const phoneSource = readFileSync(join(here, "..", "index.html"), "utf8");

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
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function coralContrastOnWhite(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  return 1.05 / (luminance + 0.05);
}

const coralToken = /:root\s*\{[^}]*--coral:\s*(#[0-9a-fA-F]{6})/.exec(styleSource)?.[1] ?? "";
const progressUsesCoralToken = /\.guide-progress\s*\{[^}]*color:\s*var\(--coral\)/.test(
  styleSource,
);
const coralContrast = coralToken ? coralContrastOnWhite(coralToken) : 0;
check(
  "guide:progress-coral",
  progressUsesCoralToken && coralContrast >= 4.5,
  `the progress mark reads coral (${coralToken || "no --coral"}, ${coralContrast.toFixed(2)}:1 on white)`,
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
check(
  "guide:help-desktop",
  indexSource.includes('id="tool-guide"') &&
    indexSource.includes('aria-label="Show the guide again"') &&
    indexSource.includes('title="Show the guide again"'),
  "a ? button in the header",
);
check(
  "guide:help-phone",
  phoneSource.includes('data-phone-action="guide"') &&
    phoneSource.replace(/\s+/g, " ").includes("> Show the guide again <"),
  "the phone ⋯ menu restarts the guide",
);
check(
  "guide:help-wires-restart",
  mainSource.includes("restartGuide") && mainSource.includes('"guide"'),
  "Help starts the guide again at the fitting moment",
);
check(
  "guide:breakpoint-resyncs",
  mainSource.includes("private syncBreakpoint") &&
    mainSource.includes("this.updateGuide()") &&
    /syncBreakpoint\(\)[\s\S]*updateGuide\(\)/.test(mainSource),
  "every breakpoint crossing (both ways) re-picks text and target",
);
check(
  "guide:resize-throttled",
  mainSource.includes("resizeQueued") &&
    mainSource.includes("requestAnimationFrame") &&
    /resizeQueued[\s\S]*requestAnimationFrame/.test(mainSource),
  "window resize re-seats the bubble at most once per animation frame",
);
check(
  "guide:resize-reseats",
  /addEventListener\("resize"[\s\S]*updateGuide\(\)/.test(mainSource) &&
    !mainSource.includes("guideView?.reposition()"),
  "a resize re-renders by the current target, never a stale corner ring",
);
check(
  "guide:zero-target-hides",
  readFileSync(join(here, "..", "src", "guide.ts"), "utf8").includes("rect.width <= 0") &&
    readFileSync(join(here, "..", "src", "guide.ts"), "utf8").includes("this.hide()"),
  "a missing or zero-size target hides the bubble",
);
check(
  "guide:unhide-before-measure",
  /removeAttribute\("hidden"\)[\s\S]*this\.place\(\)/.test(
    readFileSync(join(here, "..", "src", "guide.ts"), "utf8"),
  ),
  "the bubble unhides before its position is measured (8 px margin holds)",
);
check(
  "guide:startup-wires-decision",
  mainSource.includes("shouldResumePhotoConfirm") &&
    mainSource.includes("isPhotoBuiltRoom()") &&
    mainSource.includes("markPhotoBuiltRoom()") &&
    mainSource.includes("clearPhotoBuiltRoom()"),
  "a built photo room opens built; only a never-built one resumes confirm",
);

// ---- A phone sheet hides the bubble; a desktop panel keeps it clear ----
{
  const renderAt = mainSource.indexOf("private renderGuide()");
  const renderBody = renderAt < 0 ? "" : mainSource.slice(renderAt, renderAt + 1200);
  check(
    "guide:panel-hides-bubble",
    renderBody.includes('this.sidePanel !== "none"') &&
      renderBody.includes("isPhone") &&
      renderBody.includes("guideView.hide()"),
    "only a phone sheet hides the bubble in renderGuide",
  );
  check(
    "guide:panel-keeps-step",
    !/private renderGuide\(\)[\s\S]{0,1200}\.(skip|finish|restart)\(/.test(mainSource) &&
      !/private renderGuide\(\)[\s\S]{0,1200}GUIDE_KEY/.test(mainSource),
    "hiding never skips, finishes, restarts or writes the stored outcome",
  );
  const showAt = mainSource.indexOf("private showSidePanel(");
  const showBody = showAt < 0 ? "" : mainSource.slice(showAt, showAt + 4000);
  check(
    "guide:panel-toggle-rerenders",
    showBody.includes("this.renderGuide()"),
    "opening or closing a panel re-renders the guide at the same step",
  );
  check(
    "guide:panel-close-rerenders",
    mainSource.includes("private watchPanelClose()") &&
      /watchPanelClose\(\)[\s\S]{0,2000}this\.renderGuide\(\)/.test(mainSource),
    "a panel × close shows the guide again",
  );
  check(
    "guide:moment-3-over-inspector",
    renderBody.includes('this.sidePanel === "inspector"') &&
      renderBody.includes("this.guide.moment === 3"),
    "moment 3 stays up over the Inspector sheet",
  );
  check(
    "guide:sheet-size-hides-full",
    renderBody.includes("data-sheet-size") && renderBody.includes('=== "full"'),
    "a full sheet still hides the docked bubble",
  );
  const sizeObserverAt = mainSource.indexOf(
    'attributeFilter: ["data-sheet-open", "data-sheet-size"]',
  );
  const sizeObserverBody =
    sizeObserverAt < 0 ? "" : mainSource.slice(Math.max(0, sizeObserverAt - 400), sizeObserverAt);
  check(
    "guide:sheet-size-rerenders",
    sizeObserverBody.includes("this.renderGuide()"),
    "a sheet peek/full change re-renders the guide",
  );
  // Moment 3 over the peek Inspector sheet: the docked bubble's bottom
  // edge stays above the sheet's top (506 px at 390x844).
  const sheetPeek = Math.round(0.4 * 844);
  const overInspector = placeBubble(
    { x: 135, y: 300, w: 120, h: 40 },
    { x: 0, y: 0, w: 300, h: 140 },
    { x: 0, y: 0, w: 390, h: 844 },
    GUIDE_MARGIN_PX,
    10,
    { bottomChrome: 56 + sheetPeek },
  );
  const overInspectorBottom = overInspector.top + Math.min(140, 844 - GUIDE_MARGIN_PX * 2);
  check(
    "guide:placement-moment-3-above-inspector",
    overInspectorBottom <= 506,
    `bottom edge ${String(overInspectorBottom)} vs sheet top 506`,
  );
}

// ---- The bubble stays inside the free area left of the open panel ----
{
  // A target at the free area's top right (like the fit badge beside the
  // open Inspector) keeps the bubble's right edge inside the free area.
  const freeW = 1520;
  const viewport = { x: 0, y: 0, w: freeW, h: 951 };
  const target = { x: freeW - 52, y: 4, w: 48, h: 24 };
  const bubble = { x: 0, y: 0, w: 300, h: 140 };
  const placed = placeBubble(target, bubble, viewport);
  const bw = Math.min(bubble.w, freeW - GUIDE_MARGIN_PX * 2);
  check(
    "guide:placement-free-area-top-right",
    placed.left >= GUIDE_MARGIN_PX && placed.left + bw <= freeW - GUIDE_MARGIN_PX,
    `bubble right ${String(placed.left + bw)} vs free width ${String(freeW)}`,
  );
}

// ---- Phones, moments 2-4: the bubble docks at the bottom of the free room
// area, 8 px above the 56 px bottom bar (or the open sheet), full width
// less 8 px a side; moment 1 keeps its place by its button. ----
{
  const viewport = { x: 0, y: 0, w: 390, h: 844 };
  const target = { x: 135, y: 300, w: 120, h: 40 };
  const bubble = { x: 0, y: 0, w: 300, h: 140 };
  const placed = placeBubble(target, bubble, viewport, GUIDE_MARGIN_PX, 10, {
    bottomChrome: 56,
  });
  const bh = Math.min(bubble.h, viewport.h - GUIDE_MARGIN_PX * 2);
  const bottomEdge = placed.top + bh;
  check(
    "guide:placement-phone-dock-8px-above-bar",
    bottomEdge === 844 - 56 - 8 && placed.left === GUIDE_MARGIN_PX,
    `bottom edge ${String(bottomEdge)} vs ${String(844 - 56 - 8)}, left ${String(placed.left)}`,
  );
  const dockedW = viewport.w - GUIDE_MARGIN_PX * 2;
  check(
    "guide:placement-phone-dock-full-width",
    placed.left === GUIDE_MARGIN_PX && dockedW === 390 - 16,
    `docked width ${String(dockedW)} at 390 px`,
  );
  const sheetPeek = Math.round(0.4 * viewport.h);
  const overSheet = placeBubble(target, bubble, viewport, GUIDE_MARGIN_PX, 10, {
    bottomChrome: 56 + sheetPeek,
  });
  check(
    "guide:placement-phone-dock-8px-above-sheet",
    overSheet.top + bh === 844 - 56 - sheetPeek - 8,
    `bottom edge ${String(overSheet.top + bh)} vs ${String(844 - 56 - sheetPeek - 8)}`,
  );
  const guideSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "guide.ts"),
    "utf8",
  );
  const placeAt = guideSrc.indexOf("private place()");
  const placeBody = placeAt < 0 ? "" : guideSrc.slice(placeAt, placeAt + 6000);
  check(
    "guide:phone-dock-keeps-ring-on-target",
    placeBody.includes("this.ring.style.left") &&
      placeBody.includes("bottomChrome") &&
      placeBody.indexOf("this.ring.style.left") < placeBody.indexOf("bottomChrome") &&
      placeBody.includes("shownMoment !== 1"),
    "moment 1 inline",
  );
  // A problem pill in the bottom dock band pushes the bubble under the room
  // view's top row (10 px under the badge bottom edge at 108 px, top 118).
  const dockBubble = { x: 0, y: 0, w: 374, h: 126 };
  const dockedHigh = placeBubble(target, dockBubble, viewport, GUIDE_MARGIN_PX, 10, {
    bottomChrome: 56,
    topChrome: 108,
    avoid: [{ x: 120, y: 700, w: 150, h: 48 }],
  });
  check(
    "guide:placement-phone-dock-avoids-label",
    dockedHigh.top === 118 && dockedHigh.side === "above",
    `top ${String(dockedHigh.top)} side ${dockedHigh.side}`,
  );
  const dockedLow = placeBubble(target, dockBubble, viewport, GUIDE_MARGIN_PX, 10, {
    bottomChrome: 56,
    topChrome: 108,
    avoid: [{ x: 120, y: 400, w: 150, h: 48 }],
  });
  check(
    "guide:placement-phone-dock-stays-low-when-clear",
    dockedLow.top === 654 && dockedLow.side === "below",
    `top ${String(dockedLow.top)} vs 654, bottom edge 8 px above the bar`,
  );
  const dockedBoth = placeBubble(target, dockBubble, viewport, GUIDE_MARGIN_PX, 10, {
    bottomChrome: 56,
    topChrome: 108,
    avoid: [
      { x: 120, y: 700, w: 150, h: 48 },
      { x: 20, y: 130, w: 350, h: 100 },
    ],
  });
  check(
    "guide:placement-phone-dock-picks-less-covered",
    dockedBoth.top === 654,
    `top ${String(dockedBoth.top)} vs 654 (that place covers less)`,
  );
  const dockedNoTop = placeBubble(target, dockBubble, viewport, GUIDE_MARGIN_PX, 10, {
    bottomChrome: 56,
    avoid: [{ x: 120, y: 700, w: 150, h: 48 }],
  });
  check(
    "guide:placement-phone-dock-no-top-chrome",
    dockedNoTop.top === 654,
    `top ${String(dockedNoTop.top)} vs 654`,
  );
  check(
    "guide:moment-1-inline",
    placeBody.includes('closest(".setup-card")') &&
      placeBody.includes(".after(this.bubble)") &&
      placeBody.includes('dataset["inline"]'),
    "place() joins the dialog flow after the card",
  );
  check(
    "guide:phone-dock-passes-top-chrome-and-avoid",
    placeBody.includes("topChrome") &&
      placeBody.includes("avoid") &&
      placeBody.includes(".fit-issue-label, .fit-dim-label"),
    "the dock call passes topChrome and avoid from the in-scene labels",
  );
  check(
    "guide:dialog-scroll-reseats",
    guideSrc.includes('"scroll"') &&
      guideSrc.includes("capture: true") &&
      guideSrc.includes("this.reposition()"),
    "a capture scroll listener re-seats the ring with its button",
  );
  const frameAt = mainSource.indexOf("private frame()");
  const frameBody = frameAt < 0 ? "" : mainSource.slice(frameAt, frameAt + 6000);
  check(
    "guide:frame-redocks",
    frameBody.includes("this.fitOverlay.update(") &&
      frameBody.includes("this.guideView?.redock()") &&
      frameBody.indexOf("this.guideView?.redock()") > frameBody.indexOf("this.fitOverlay.update("),
    "frame() calls this.guideView?.redock() after this.fitOverlay.update(",
  );
  check(
    "guide:frame-never-repositions",
    !mainSource.includes("guideView?.reposition(") && !mainSource.includes("guideView.reposition("),
    "main.ts re-picks the dock via redock(), never reposition()",
  );
  const styleSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "style.css"),
    "utf8",
  );
  check(
    "guide:moment-1-inline-style",
    styleSrc.includes('.guide-bubble[data-inline="true"]') &&
      /\.guide-bubble\[data-inline="true"\]\s*\{[^}]*position:\s*relative/.test(styleSrc),
    "style.css docks moment 1 in the dialog flow",
  );
}

if (failures > 0) process.exit(1);
console.log("guide: all checks passed");
