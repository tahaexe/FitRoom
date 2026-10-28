/**
 * `npm run check:toolbar` — bottom-toolbar groups check (no browser,
 * no Meta calls).
 *
 * - The AI actions (Recommend, Arrange, Visualise) sit together in one
 *   group carrying a small "AI" tag; Orbit and Plan form one two-way
 *   switch; Clearance and Reset view form the view tools; Rotate and Delete
 *   live in a selection group that stays hidden until a piece is selected;
 * - every toolbar label renders from `client/src/copy.ts` (the HTML shows
 *   the same words and `main.ts` assigns each button from its constant);
 * - the switch announces its state (`data-active` + `aria-pressed` per side);
 * - the whole bar fits one row at 1366 px, computed from the CSS: the
 *   stylesheet forces a single row (`flex-wrap: nowrap`) and the check adds
 *   the worst-case widths (labels at 8 px/char plus the real padding, tag,
 *   switch, dividers, gaps and the measure slot) against the room-view
 *   width at 1366 px.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOLBAR_AI_TAG,
  TOOLBAR_ARRANGE,
  TOOLBAR_CLEARANCE,
  TOOLBAR_DELETE,
  TOOLBAR_GROUP_AI,
  TOOLBAR_GROUP_SELECTION,
  TOOLBAR_GROUP_TOOLS,
  TOOLBAR_GROUP_VIEW,
  TOOLBAR_ORBIT,
  TOOLBAR_PLAN,
  TOOLBAR_RECOMMEND,
  TOOLBAR_RESET_VIEW,
  TOOLBAR_ROTATE_LEFT,
  TOOLBAR_ROTATE_RIGHT,
  TOOLBAR_VISUALISE,
} from "../src/copy.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "src", "style.css"), "utf8");
const main = readFileSync(join(root, "src", "main.ts"), "utf8");
const copy = readFileSync(join(root, "src", "copy.ts"), "utf8");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const toolbarHtml = html.slice(html.indexOf("bottom-toolbar"), html.indexOf("measure-readout"));

// Groups with names, in order: AI actions, view switch, view tools, selection.
const groupOrder = ["ai", "view", "tools", "selection"];
const groupIndex = groupOrder.map((group) => toolbarHtml.indexOf(`data-group="${group}"`));
check(
  "toolbar has the four named groups in order",
  groupIndex.every((at) => at >= 0) &&
    [...groupIndex].sort((a, b) => a - b).every((at, i) => at === groupIndex[i]),
  groupOrder.join(", "),
);
check(
  "AI group is named from copy",
  toolbarHtml.includes(`data-label="${TOOLBAR_GROUP_AI}"`),
  TOOLBAR_GROUP_AI,
);
check(
  "view group is named from copy",
  toolbarHtml.includes(`data-label="${TOOLBAR_GROUP_VIEW}"`),
  TOOLBAR_GROUP_VIEW,
);
check(
  "tools group is named from copy",
  toolbarHtml.includes(`data-label="${TOOLBAR_GROUP_TOOLS}"`),
  TOOLBAR_GROUP_TOOLS,
);
check(
  "selection group is named from copy",
  toolbarHtml.includes(`data-label="${TOOLBAR_GROUP_SELECTION}"`),
  TOOLBAR_GROUP_SELECTION,
);

// The AI tag on the AI group: Recommend, Arrange, Visualise together.
check(
  "AI group carries the AI tag",
  toolbarHtml.includes(`class="toolbar-tag"`) && toolbarHtml.includes(`>${TOOLBAR_AI_TAG}<`),
  TOOLBAR_AI_TAG,
);
const aiGroup = toolbarHtml.slice(
  toolbarHtml.indexOf('data-group="ai"'),
  toolbarHtml.indexOf('data-group="view"'),
);
check("AI group holds Recommend", aiGroup.includes('id="tool-recommend"'), "tool-recommend");
check("AI group holds Arrange", aiGroup.includes('id="tool-assistant"'), "tool-assistant");
check("AI group holds Visualise", aiGroup.includes('id="tool-render"'), "tool-render");

// Orbit and Plan as one two-way switch.
const switchAt = toolbarHtml.indexOf("toolbar-switch");
check("Orbit/Plan form one switch", switchAt >= 0, "toolbar-switch");
const switchHtml = toolbarHtml.slice(switchAt, toolbarHtml.indexOf('data-group="tools"'));
check(
  "switch holds Orbit and Plan",
  switchHtml.includes('id="tool-orbit"') && switchHtml.includes('id="tool-plan"'),
  "tool-orbit + tool-plan",
);
check(
  "switch is labelled View",
  toolbarHtml.includes('class="toolbar-switch" role="group" aria-label="View"'),
  "role=group aria-label=View",
);
check(
  "switch announces Orbit state",
  main.includes('this.setToggle("tool-orbit", mode === "orbit")'),
  "main.ts setMode",
);
check(
  "switch announces Plan state",
  main.includes('this.setToggle("tool-plan", mode === "plan")'),
  "main.ts setMode",
);

// Clearance and Reset view as the view tools.
const toolsGroup = toolbarHtml.slice(
  toolbarHtml.indexOf('data-group="tools"'),
  toolbarHtml.indexOf('data-group="selection"'),
);
check("tools group holds Clearance", toolsGroup.includes('id="tool-clearance"'), "tool-clearance");
check(
  "tools group holds Reset view",
  toolsGroup.includes('id="tool-reset-view"'),
  "tool-reset-view",
);

// Selection tools only while a piece is selected (as today).
check(
  "Rotate left starts hidden",
  toolbarHtml.includes('id="tool-rot-left"') && /id="tool-rot-left"[^>]*hidden/.test(toolbarHtml),
  "tool-rot-left",
);
check(
  "Rotate right starts hidden",
  /id="tool-rot-right"[^>]*hidden/.test(toolbarHtml),
  "tool-rot-right",
);
check("Delete starts hidden", /id="tool-delete"[^>]*hidden/.test(toolbarHtml), "tool-delete");
check(
  "selection tools toggle on selection",
  main.includes('for (const id of ["tool-rot-left", "tool-rot-right", "tool-delete"])') &&
    main.includes('el.setAttribute("hidden", "")'),
  "updateSelectionTools",
);

// Every label from copy.ts.
const labels: Array<[string, string]> = [
  ["tool-recommend", TOOLBAR_RECOMMEND],
  ["tool-assistant", TOOLBAR_ARRANGE],
  ["tool-render", TOOLBAR_VISUALISE],
  ["tool-orbit", TOOLBAR_ORBIT],
  ["tool-plan", TOOLBAR_PLAN],
  ["tool-clearance", TOOLBAR_CLEARANCE],
  ["tool-reset-view", TOOLBAR_RESET_VIEW],
  ["tool-rot-left", TOOLBAR_ROTATE_LEFT],
  ["tool-rot-right", TOOLBAR_ROTATE_RIGHT],
  ["tool-delete", TOOLBAR_DELETE],
];
for (const [id, text] of labels) {
  check(`toolbar shows the copy label for ${id}`, toolbarHtml.includes(text), text);
  check(`main.ts renders ${id} from copy`, main.includes(`label("${id}", TOOLBAR_`), id);
}
check("copy owns the AI tag", copy.includes('TOOLBAR_AI_TAG = "AI"'), "copy.ts");

// One row at 1366 px, from the CSS.
check(
  "toolbar never wraps",
  /\.bottom-toolbar\s*\{[^}]*flex-wrap:\s*nowrap/.test(css),
  ".bottom-toolbar flex-wrap",
);
check(
  "toolbar clips horizontally instead of wrapping",
  /\.bottom-toolbar\s*\{[^}]*overflow-x:\s*auto/.test(css),
  ".bottom-toolbar overflow-x",
);
const measureWidth = /\.measure\s*\{[^}]*width:\s*(\d+)px/.exec(css)?.[1];
check(
  "measure slot stays compact",
  measureWidth !== undefined && Number(measureWidth) <= 240,
  `${measureWidth ?? "?"}px`,
);

const catalogWidth = Number(/--catalog-width:\s*(\d+)px/.exec(css)?.[1] ?? 300);
const gap = Number(/--gap:\s*(\d+)px/.exec(css)?.[1] ?? 16);
const sceneWidth = 1366 - (catalogWidth + gap * 2) - gap;
const barWidth = sceneWidth - 16;
const buttonPad = 12 * 2 + 2;
const charWidth = 8;
const visibleLabels = [
  TOOLBAR_RECOMMEND,
  TOOLBAR_ARRANGE,
  TOOLBAR_VISUALISE,
  TOOLBAR_ORBIT,
  TOOLBAR_PLAN,
  TOOLBAR_CLEARANCE,
  TOOLBAR_RESET_VIEW,
];
const buttonsWidth = visibleLabels.reduce(
  (sum, text) => sum + text.length * charWidth + buttonPad,
  0,
);
const tagWidth = TOOLBAR_AI_TAG.length * charWidth + 12;
const estimate =
  buttonsWidth + tagWidth + 6 + 2 * (8 + 4 + 1) + 30 + 12 + Number(measureWidth ?? 200);
check(
  `toolbar fits one row at 1366px (${String(estimate)}px of ${String(barWidth)}px)`,
  estimate <= barWidth,
  `scene ${String(sceneWidth)}px, bar ${String(barWidth)}px`,
);

if (failures > 0) {
  console.log(`check:toolbar: ${String(failures)} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("check:toolbar: all checks passed");
}
