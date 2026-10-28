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
import {
  MINI_PLAN_FRAME_MARGIN,
  miniPlanData,
} from "../src/editor/photo-confirm.js";
import { createRectangleRoom } from "@fitroom/shared";
import { LETTER_TO_WALL_ID } from "@fitroom/shared";

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

// ---- Item 1: the step bar reads like the photo and tape steps ----
const flowStepsUses = (confirm.match(/FLOW_STEPS\.entries\(\)/g) ?? []).length;
check(
  "confirm view renders the shared stepper once",
  flowStepsUses === 1 && confirm.includes("FLOW_STEPS, LEAVE,"),
  `FLOW_STEPS.entries() × ${String(flowStepsUses)}`,
);
check(
  "step bar is built once",
  (confirm.match(/className = "photo-steps"/g) ?? []).length === 1,
  "photo-confirm.ts",
);
check(
  "step bar sits in a full-width top bar outside every column",
  confirm.includes('className = "photo-confirm-top"') &&
    confirm.includes("top.appendChild(steps)") &&
    confirm.includes("this.element.appendChild(top)"),
  "photo-confirm.ts",
);
check(
  "step bar Leave sits at the bar's right from the copy module",
  confirm.includes("top.appendChild(leave)") && confirm.includes("leave.textContent = LEAVE"),
  "photo-confirm.ts",
);
const leaveUses = (confirm.match(/LEAVE/g) ?? []).length;
check("the confirm view carries one Leave", leaveUses === 2, `LEAVE × ${String(leaveUses)}`);
check(
  "the action row's second Leave hides in the confirm view (its Undo stays)",
  src("editor/editor.ts").includes("cancelBtn.style.display") &&
    src("editor/editor.ts").includes('photo ? "none" : ""') &&
    src("editor/editor.ts").includes("onLeave: () => this.callbacks.onCancel()"),
  "editor.ts",
);
check("unviewed chip invites one tap", confirm.includes("Select to view it"), "photo-confirm.ts");
check("viewed walls keep Active/Done", confirm.includes("wallCardStatus"), "photo-confirm.ts");

// ---- Item 4: the wall chips say only the finding ----
{
  // Bar: the confirm-walls check asserts the chips' text — the unviewed
  // chip reads exactly the found summary ("1 window found"), never the
  // wall name again (the card's title already names the wall).
  const wallsAt = confirm.indexOf("private renderWalls(");
  const wallsBlock = wallsAt >= 0 ? confirm.slice(wallsAt, wallsAt + 2200) : "";
  check(
    "the unviewed chip says only the finding",
    wallsBlock.includes("status.textContent = found") &&
      !wallsBlock.includes("status.textContent = `${wallLetterLabel") &&
      wallsBlock.includes("wallChipFound(doors, windows)"),
    "photo-confirm.ts renderWalls",
  );
  check(
    "the chip keeps the wall name in its accessible name",
    wallsBlock.includes("Select to view it") &&
      wallsBlock.includes("wallLetterLabel(this.store.room, letter)"),
    "photo-confirm.ts renderWalls",
  );
  check(
    "no openings reads without the wall name",
    wallChipFound(0, 0) === "no openings found",
    wallChipFound(0, 0),
  );
  check(
    "one window reads without the wall name",
    wallChipFound(0, 1) === "1 window found",
    wallChipFound(0, 1),
  );
}

// ---- Item 3: the header's Undo and Redo hide on every photo-flow screen ----
{
  const app = src("main.ts");
  // The header hides both buttons while the photo flow (photo, tape and
  // build screens) or the confirm view (the plan editor) is open.
  const hideBlock = app.includes("const inFlow = this.photoFlow !== null || this.editing");
  check(
    "the header hides Undo and Redo in the flow and in the confirm view",
    hideBlock &&
      app.includes('el.style.display = inFlow ? "none" : ""') &&
      app.includes("tool-undo") &&
      app.includes("tool-redo"),
    "main.ts updateUndoRedo",
  );
  // Each screen transition refreshes the header: opening/closing the flow
  // (photo and tape steps) and opening/closing the editor (confirm view).
  const openFlowAt = app.indexOf("private openPhotoFlow");
  const openFlowBlock = openFlowAt >= 0 ? app.slice(openFlowAt, openFlowAt + 1200) : "";
  check(
    "opening the photo flow refreshes the header",
    openFlowBlock.includes("this.updateUndoRedo()"),
    "main.ts openPhotoFlow",
  );
  const closeFlowAt = app.indexOf("private closePhotoFlow");
  const closeFlowBlock = closeFlowAt >= 0 ? app.slice(closeFlowAt, closeFlowAt + 600) : "";
  check(
    "closing the photo flow refreshes the header",
    closeFlowBlock.includes("this.updateUndoRedo()"),
    "main.ts closePhotoFlow",
  );
  const openEditorAt = app.indexOf("private openEditor");
  const openEditorBlock = openEditorAt >= 0 ? app.slice(openEditorAt, openEditorAt + 900) : "";
  check(
    "opening the confirm view refreshes the header",
    openEditorBlock.includes("this.updateUndoRedo()"),
    "main.ts openEditor",
  );
  const closeEditorAt = app.indexOf("private closeEditor");
  const closeEditorBlock =
    closeEditorAt >= 0 ? app.slice(closeEditorAt, closeEditorAt + 600) : "";
  check(
    "closing the confirm view refreshes the header",
    closeEditorBlock.includes("this.updateUndoRedo()"),
    "main.ts closeEditor",
  );
  // The confirm view keeps its own Undo: the editor hides only the second
  // Leave in the confirm view, never the Undo button.
  const editorSrc = src("editor/editor.ts");
  check(
    "the confirm view keeps its own Undo",
    editorSrc.includes("this.undoBtn") &&
      !editorSrc.includes("undoBtn.style.display") &&
      editorSrc.includes("cancelBtn.style.display"),
    "editor.ts",
  );
}

const editor = src("editor/editor.ts");
check(
  "Build my room stays one click",
  editor.includes("() => this.callbacks.onBuild()") && !editor.includes("window.confirm("),
  "editor.ts",
);

// ---- Item 2: one scroll, columns at both sizes, footer pinned ----
const css = src("editor/editor.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** Rule block(s) for one selector (combined selectors included). */
function blocksFor(selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const selectors = (match[1] ?? "").split(",").map((s) => s.trim());
    if (selectors.includes(selector)) out.push(match[2] ?? "");
  }
  return out;
}

for (const inner of [
  ".photo-confirm-walls",
  ".photo-confirm-right",
  ".photo-confirm-centre",
  ".photo-confirm-stage",
]) {
  const nested = blocksFor(inner).some((body) => /overflow\s*:\s*(auto|scroll)/.test(body));
  check(`no nested scroll box on ${inner}`, !nested, "editor.css");
}

const foot = blocksFor(".editor-foot").join("\n");
check(
  "Build my room stays visible in a sticky footer",
  /position\s*:\s*sticky/.test(foot) && /bottom\s*:\s*0/.test(foot),
  "editor.css",
);

const confirmBlock = blocksFor(".photo-confirm").join("\n");
const minCols = (confirmBlock.match(/minmax\(320px/g) ?? []).length;
check(
  "two columns with no column narrower than 320 px",
  minCols >= 2 && confirmBlock.includes('"walls plan"') && confirmBlock.includes('"photo plan"'),
  "editor.css",
);
// ---- Item 3 (structural): badge, labels and handle hit areas ----
const confirmCss = css;
check(
  "the example credit reads as a caption line above the photo",
  /\.photo-example-caption\s*\{[^}]*margin\s*:\s*0 0 8px/s.test(confirmCss),
  "editor.css",
);
check(
  "the caption is not positioned over the photo",
  !/\.photo-example-caption\s*\{[^}]*position\s*:\s*absolute/s.test(confirmCss) &&
    !/\.photo-stage\s+\.photo-example-badge/s.test(confirmCss),
  "editor.css",
);
{
  // Bar: the badge leaves the image — no example badge element is created
  // inside the photo's positioned box (confirm stage or flow preview);
  // the caption sits in normal flow just above it.
  const stageAt = confirm.indexOf("private async renderStage");
  const stageBlock =
    stageAt >= 0 ? confirm.slice(stageAt, stageAt + 2500) : "";
  const captionAbove =
    stageBlock.includes("photo-example-caption") &&
    stageBlock.indexOf("photo-example-caption") < stageBlock.indexOf("className = \"photo-stage\"") &&
    !stageBlock.includes("photo-example-badge");
  check(
    "the confirm badge is not inside the photo's positioned box",
    captionAbove,
    "photo-confirm.ts renderStage",
  );
  const flowSrc = src("photo-room/flow.ts");
  const previewAt = flowSrc.indexOf("private preview(");
  const previewBlock =
    previewAt >= 0 ? flowSrc.slice(previewAt, previewAt + 2500) : "";
  const flowCaptionAbove =
    previewBlock.includes("photo-example-caption") &&
    previewBlock.includes("host.appendChild(caption)") &&
    previewBlock.includes("host.appendChild(wrap)") &&
    !previewBlock.includes("photo-example-badge");
  check(
    "the flow badge is not inside the photo's positioned box",
    flowCaptionAbove,
    "flow.ts preview",
  );
  check(
    "the flow caption has a static caption style",
    /\.photo-example-caption\s*\{[^}]*margin\s*:\s*0 0 8px/s.test(
      src("photo-room/photo-room.css").replace(/\/\*[\s\S]*?\*\//g, ""),
    ),
    "photo-room.css",
  );
}
check(
  "box labels sit above the top edge",
  /\.photo-opening-tag\s*\{[^}]*bottom\s*:\s*calc\(100% \+ 14px\)/s.test(confirmCss),
  "editor.css",
);
check(
  "box labels flip inside with no room above",
  confirm.includes('tag.classList.add("inside")') &&
    /\.photo-opening-tag\.inside\s*\{[^}]*top\s*:\s*12px/s.test(confirmCss),
  "photo-confirm.ts + editor.css",
);
check(
  "corner handles answer 44 px with a 28 px dot",
  /\.photo-handle\s*\{[^}]*width\s*:\s*28px/s.test(confirmCss) &&
    /\.photo-handle::after\s*\{[^}]*inset\s*:\s*-8px/s.test(confirmCss),
  "editor.css",
);

const mediaAt = css.indexOf("@media (max-width: 720px)");
const media = mediaAt < 0 ? "" : css.slice(mediaAt);
const topAt = media.indexOf('"top"');
const photoAt = media.indexOf('"photo"');
const wallsAt = media.indexOf('"walls"');
const planAt = media.indexOf('"plan"');
check(
  "narrow screens stack photo, walls, plan",
  topAt >= 0 && photoAt > topAt && wallsAt > photoAt && planAt > wallsAt,
  "editor.css",
);

// ---- Item 1: the small plan's labels fit inside its frame ----
{
  // The example room at its own wall lengths (A/C 420, B/D 360), with a
  // window on a side wall so a side name runs long ("Wall B · left wall").
  const room = createRectangleRoom({
    widthCm: 420,
    depthCm: 360,
    heightCm: 250,
    id: "photos-room",
    name: "Example room (generated photos)",
  });
  room.openings.push({
    id: "door-1",
    wallId: "wall-1",
    type: "door",
    offset: 40,
    width: 90,
    height: 210,
    sillHeight: 0,
    hinge: "left",
    swing: "in",
  });
  room.openings.push({
    id: "window-1",
    wallId: "wall-4",
    type: "window",
    offset: 100,
    width: 120,
    height: 140,
    sillHeight: 90,
  });
  const session = {
    draft: { letterToWallId: { ...LETTER_TO_WALL_ID }, photos: [] },
    sizes: {
      A: { width: 1280, height: 960 },
      B: { width: 1280, height: 960 },
      C: { width: 1280, height: 960 },
      D: { width: 1280, height: 960 },
    },
    activeWall: "A",
    seen: ["A"],
  } as unknown as Parameters<typeof miniPlanData>[1];
  const data = miniPlanData(room, session);
  check("the example small plan builds", data !== null);
  if (data !== null) {
    const [vx, vy, vw, vh] = data.viewBox;
    // Side labels stack on two lines (name over length), never one long line.
    for (const edge of data.edges) {
      check(
        `wall ${edge.letter} labels the name over its length`,
        edge.lines.length === 2 &&
          edge.lines[1] === `${String(edge.lengthCm)} cm` &&
          edge.label === `${edge.lines[0]} · ${edge.lines[1]}`,
        edge.label,
      );
      // Label type runs no larger than the walls list's text (14 px): the
      // svg units over the fitted frame stay at or under 14 px at the
      // desktop (~540 px plan) and phone (~326 px plan) widths.
      for (const displayWidth of [540, 326]) {
        const px = (edge.fontSize / vw) * displayWidth;
        check(
          `wall ${edge.letter} label fits 14 px at ${String(displayWidth)} px wide`,
          px <= 14,
          `${px.toFixed(2)} px`,
        );
      }
      // Each label's box (font size × about 0.6 em a character, per line)
      // lies inside the plan's frame (the frame carries a small margin).
      const charW = edge.fontSize * 0.6;
      const textW = Math.max(edge.lines[0].length, edge.lines[1].length) * charW;
      const textH = edge.lineHeight * edge.lines.length;
      const [bx0, by0, bx1, by1] = edge.labelBox;
      const boxW = bx1 - bx0;
      const boxH = by1 - by0;
      check(
        `wall ${edge.letter} label box matches its text size`,
        Math.abs(boxW - textW) < 0.01 && Math.abs(boxH - textH) < 0.01,
        `${boxW.toFixed(2)}×${boxH.toFixed(2)} vs ${textW.toFixed(2)}×${textH.toFixed(2)}`,
      );
      const inside =
        bx0 >= vx - 1e-9 &&
        by0 >= vy - 1e-9 &&
        bx1 <= vx + vw + 1e-9 &&
        by1 <= vy + vh + 1e-9;
      check(`wall ${edge.letter} label sits inside the plan frame`, inside, edge.label);
    }
    // The frame fits the room plus its labels with a small margin: every
    // room corner and every label box keeps at least the margin inside,
    // and the frame is no more than a second margin larger than needed.
    const need = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const edge of data.edges) {
      for (const [px, py] of [
        [edge.x1, edge.y1],
        [edge.x2, edge.y2],
      ] as Array<[number, number]>) {
        if (px < need.x0) need.x0 = px;
        if (py < need.y0) need.y0 = py;
        if (px > need.x1) need.x1 = px;
        if (py > need.y1) need.y1 = py;
      }
      const [bx0, by0, bx1, by1] = edge.labelBox;
      if (bx0 < need.x0) need.x0 = bx0;
      if (by0 < need.y0) need.y0 = by0;
      if (bx1 > need.x1) need.x1 = bx1;
      if (by1 > need.y1) need.y1 = by1;
    }
    const m = MINI_PLAN_FRAME_MARGIN;
    const tight =
      Math.abs(vx - (need.x0 - m)) < 0.01 &&
      Math.abs(vy - (need.y0 - m)) < 0.01 &&
      Math.abs(vx + vw - (need.x1 + m)) < 0.01 &&
      Math.abs(vy + vh - (need.y1 + m)) < 0.01;
    check("the plan frame fits the room plus its labels with a margin", tight, data.viewBox.join(","));
  }
}

if (failures > 0) process.exit(1);
console.log("confirm walls ok");
