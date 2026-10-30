/**
 * `npm run check:toolbar` — bottom-toolbar groups check (no browser,
 * no Meta calls).
 *
 * - The AI actions (Recommend, Arrange, Visualise) sit together in one
 *   group carrying a small "AI" tag; Orbit and Plan form one two-way
 *   switch; Clearance and Reset view form the view tools; the selection
 *   group's Rotate and Delete stay hidden at every size — the Inspector
 *   carries its own quick rotate buttons beside its Rotation field and
 *   Delete instead (keyboard shortcuts still apply);
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

const editorCss = readFileSync(join(root, "src", "editor", "editor.css"), "utf8");
const assistantSrc = readFileSync(join(root, "src", "assistant", "panel.ts"), "utf8");
const recommendSrc = readFileSync(join(root, "src", "recommend", "panel.ts"), "utf8");
const inspectorSrc = readFileSync(join(root, "src", "inspector.ts"), "utf8");
const guideSrc = readFileSync(join(root, "src", "guide.ts"), "utf8");

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

// Selection tools never reach the toolbar: hidden at every size, even
// with a piece selected. The Inspector carries the quick rotate buttons.
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
{
  const selAt = main.indexOf("private updateSelectionTools(");
  const selEnd = main.indexOf("\n  private ", selAt + 1);
  const selBody = selAt < 0 ? "" : main.slice(selAt, selEnd < 0 ? selAt + 2000 : selEnd);
  check(
    "selection tools stay hidden on selection",
    selBody.includes('for (const id of ["tool-rot-left", "tool-rot-right", "tool-delete"])') &&
      selBody.includes('el.setAttribute("hidden", "")') &&
      !selBody.includes('removeAttribute("hidden")'),
    "updateSelectionTools",
  );
}
check(
  "rotate and delete shortcuts stay on the keyboard",
  main.includes('event.key === "Delete"') && main.includes('"r"') && main.includes("nudgeRotate"),
  "Delete/Backspace and R still rotate and delete the selection",
);
// The Inspector's quick rotate buttons show at every size, beside its
// Rotation field with Delete below — not hidden on desktop any more.
{
  const baseCss = css.slice(0, css.indexOf("@media (max-width: 720px)"));
  check(
    "inspector quick rotate shows on desktop too",
    inspectorSrc.includes("inspector-actions") &&
      inspectorSrc.includes('"⟲ −15°"') &&
      inspectorSrc.includes('"⟳ +15°"') &&
      !/\.inspector-actions\s*\{[^}]*display:\s*none/.test(baseCss),
    ".inspector-actions must not hide outside the phone layout",
  );
  const actionsAt = inspectorSrc.indexOf("inspector-actions");
  const rotAt = inspectorSrc.indexOf("Rotation (°)");
  const delAt = inspectorSrc.indexOf('"Delete (Del)"');
  check(
    "inspector quick rotate sits beside Rotation and Delete",
    actionsAt >= 0 && rotAt >= 0 && delAt >= 0 && rotAt < actionsAt && actionsAt < delAt,
    "actions render after the Rotation field and before Delete",
  );
}

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

// One side panel at a time: opening Recommend, Arrange, Visualise, the
// Inspector or the fit list closes every other side panel.
check(
  "opening a side panel hides the fit list",
  main.includes(
    'private showSidePanel(name: "inspector" | "recommend" | "assistant" | "cart" | "none")',
  ) && main.includes('document.getElementById("fit-list")?.setAttribute("hidden", "")'),
  "main.ts showSidePanel",
);
check(
  "opening a side panel closes Visualise",
  main.includes("this.renderViewer?.close()"),
  "main.ts showSidePanel",
);
check(
  "opening Visualise closes the side panels and the fit list",
  main.includes("private openVisualise()") &&
    main.includes('document.getElementById("fit-list")?.setAttribute("hidden", "")'),
  "main.ts openVisualise",
);
check(
  "opening the fit list closes the side panels and Visualise",
  main.includes("private openFitList()") &&
    main.includes('this.showSidePanel("none")') &&
    main.includes('document.getElementById("render-viewer")?.setAttribute("hidden", "")'),
  "main.ts openFitList",
);
check(
  "the fit badge opens the list exclusively",
  main.includes('if (list.hasAttribute("hidden")) this.openFitList();'),
  "main.ts fit-badge",
);
check(
  "adding a piece opens the list on desktop only (phones keep the room)",
  /private async addItem\([\s\S]{0,2500}this\.openFitList\(\)/.test(main) &&
    /private async addItem\([\s\S]{0,2500}!isPhoneViewport\(\)/.test(main),
  "main.ts addItem phone guard",
);
check(
  "a panel close button drops the app side state",
  main.includes("private watchPanelClose()") &&
    main.includes('this.setToggle("tool-recommend", false)'),
  "main.ts watchPanelClose",
);
// The cart is one side panel among the others: opening it closes the fit
// list, the recommend/assistant/inspector panels and Visualise, and opening
// any of them closes the cart; Esc closes it too.
check(
  "opening the cart closes the fit list",
  main.includes('this.showSidePanel("cart")') &&
    main.includes('document.getElementById("fit-list")?.setAttribute("hidden", "")'),
  "main.ts showSidePanel cart",
);
check(
  "opening the cart closes Visualise",
  main.includes('this.showSidePanel("cart")') && main.includes("this.renderViewer?.close()"),
  "main.ts showSidePanel cart",
);
check(
  "opening another panel closes the cart",
  main.includes('["recommend-panel", "recommend"]') &&
    main.includes('["assistant-panel", "assistant"]') &&
    main.includes('["inspector", "inspector"]') &&
    main.includes('["cart-panel", "cart"]'),
  "main.ts watchPanelClose cart",
);
check(
  "Escape closes the cart",
  main.includes('if (this.sidePanel === "cart" || this.sheets?.isOpen("cart") === true)') &&
    main.includes('this.showSidePanel("none")'),
  "main.ts bindKeys cart",
);
check(
  "the photo flow closes the cart and the editor takes its place",
  main.includes("private openPhotoFlow()") &&
    main.includes("this.closeCart()") &&
    main.includes("private openEditor()") &&
    main.includes('this.showSidePanel("none")'),
  "main.ts openPhotoFlow/openEditor",
);
check(
  "the phone cart opens the cart as a bottom sheet",
  main.includes('showSidePanel("cart")') &&
    (main.includes('this.sheets?.open("cart"') ||
      main.includes('this.sheets.open("cart"') ||
      main.includes("this.sheets?.open(name") ||
      main.includes("this.sheets.open(name")),
  "main.ts phone cart sheet",
);
// Panels float over the 3D view: the stage keeps its size, so the room
// always keeps at least half its width with any panel open.
check(
  "side panels float over the stage",
  /#recommend-panel\s*\{[^}]*position:\s*fixed/.test(css) &&
    /#assistant-panel\s*\{[^}]*position:\s*fixed/.test(css) &&
    /#inspector\s*\{[^}]*position:\s*fixed/.test(css),
  "style.css fixed panels",
);
check(
  "the stage offset never narrows the room under a panel",
  /Side panels (live|float) over the 3D (stage|view)/.test(main) ||
    main.includes("Panels float over the 3D view"),
  "main.ts showSidePanel",
);
check(
  "the cart floats over the stage like the other panels",
  /#cart-panel\s*\{[^}]*position:\s*fixed/.test(css) &&
    main.includes('document.getElementById("cart-panel")') &&
    html.includes('id="cart-panel"'),
  "cart-panel fixed",
);
check(
  "the phone cart is a button",
  /<button[^>]*id="phone-cart"[^>]*type="button"/.test(html) &&
    main.includes('document.getElementById("phone-cart")'),
  "index.html phone-cart",
);
check(
  "the phone bar tracks the cart sheet",
  main.includes('"cart"') && main.includes("syncPhoneBar"),
  "main.ts syncPhoneBar cart",
);
check(
  "the phone sheets know the cart",
  readFileSync(join(root, "src", "phone-sheet.ts"), "utf8").includes('"cart"') &&
    main.includes('cart: document.getElementById("cart-panel")'),
  "phone-sheet.ts PhoneSheetName",
);

// The phone bar hides while the photo flow or the confirm view is open.
check(
  "the phone bar hides in the flow and in the confirm view",
  main.includes("private syncFlowChrome()") &&
    main.includes('document.body.setAttribute("data-flow-open", "true")') &&
    main.includes("this.photoFlow !== null || this.editing") &&
    (main.match(/this\.syncFlowChrome\(\)/g) ?? []).length >= 4,
  "main.ts syncFlowChrome",
);
check(
  "the phone bar CSS hides on the flow flag",
  /body\[data-flow-open="true"\]\s*#phone-bar\s*\{[^}]*display:\s*none/.test(css),
  "style.css body[data-flow-open]",
);
// The cart summary never cuts at 390 px: the short "4 · $3,280" stays
// visible, with the full "4 items · $3,280" as its accessible name.
check(
  "the phone cart keeps the full summary as its accessible name",
  main.includes("phoneCart.setAttribute(") &&
    main.includes('"aria-label"') &&
    main.includes("in your cart"),
  "main.ts phoneCart",
);
{
  const short = "4 · $3,280";
  const long = "4 items · $3,280";
  const usesShort =
    main.includes("`${String(count)} · ${formatCatalogPrice(total)}`") &&
    main.includes("phoneCart.textContent = short");
  const usesLongName =
    main.includes("phoneCart.setAttribute(") && main.includes("formatTopBar(count, total)");
  check(
    `the phone cart reads "${short}" with "${long}" as its name`,
    usesShort && usesLongName,
    "main.ts phoneCart",
  );
  const barPad = 8 * 2;
  const barGaps = 4 * 3;
  const charW = 8;
  const btnPad = 4 * 2 + 2;
  const buttons = ["Catalog", "AI", "Visualise"];
  const buttonsWidth = buttons.reduce((sum, text) => sum + text.length * charW + btnPad, 0);
  const cartWidth = short.length * charW + 8;
  const estimate = buttonsWidth + cartWidth + barGaps + barPad;
  check(
    `the phone bar fits 390px (${String(Math.round(estimate))}px of 390px)`,
    estimate <= 390,
    `buttons ${String(Math.round(buttonsWidth))}px, cart ${String(Math.round(cartWidth))}px`,
  );
  for (const label of [...buttons, short]) {
    check(
      `the phone bar fits "${label}" in its equal share`,
      label.length * 8 + 10 <= (390 - 16 - 12) / 4,
      `${label} needs ${String(label.length * 8 + 10)}px of ${String((390 - 16 - 12) / 4)}px`,
    );
  }
}

// Every button, chip, toggle and handle answers in at least 44 x 44 px at
// 390 px: one blanket rule covers every button by tag on a phone, and each
// non-button target carries its own 44 px rule or hit area.
const phoneCss = (() => {
  const start = css.indexOf("@media (max-width: 720px), (max-height: 500px)");
  return start < 0 ? "" : css.slice(start);
})();
// The phone block alone (up to the landscape block), comments stripped.
const phoneBlock = (() => {
  const start = css.indexOf("@media (max-width: 720px), (max-height: 500px)");
  if (start < 0) return "";
  const end = css.indexOf("@media (max-height: 500px) and (orientation: landscape) {", start);
  return css.slice(start, end < 0 ? undefined : end).replace(/\/\*[\s\S]*?\*\//g, "");
})();

/** The last value the phone block gives `property` in a rule that lists `selector`. */
function phoneDecl(selector: string, property: string): string | null {
  let value: string | null = null;
  for (const rule of phoneBlock.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (rule[1] ?? "").split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const decl = new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;]+);`).exec(rule[2] ?? "");
    if (decl?.[1] !== undefined) value = decl[1].trim();
  }
  return value;
}
for (const selector of [".setup-sub", ".setup-card-title", ".guide-text"]) {
  check(
    `phone ${selector} is 16px`,
    phoneDecl(selector, "font-size") === "16px",
    `font-size: ${phoneDecl(selector, "font-size") ?? "missing"}`,
  );
}
for (const selector of [
  ".setup-card-text",
  ".size-label",
  ".size-echo",
  ".size-error",
  ".size-hint",
  ".size-build-reason",
  ".size-slip-text",
  ".guide-progress",
  "#cart-panel p",
  ".cart-name",
  ".catalog-dims",
  ".catalog-price",
  ".inspector-row",
  ".inspector-note",
  ".door-tip",
  ".delete-toast",
  ".photo-draft-band",
  ".photo-step",
  ".photo-blurb",
  ".photo-lens",
  ".photo-note",
  ".photo-example-note",
  ".editor-hint",
  ".recommend-empty",
  ".recommend-reason",
  ".assistant-empty",
  ".assistant-summary",
  ".assistant-user",
  ".assistant-did",
  ".render-empty",
  ".catalog-empty",
  ".furnish-hint",
  ".furnish-live-note",
  ".furnish-demo-note",
  ".furnish-progress",
  ".furnish-name",
  ".furnish-price",
]) {
  check(
    `phone ${selector} is 15px`,
    phoneDecl(selector, "font-size") === "15px",
    `font-size: ${phoneDecl(selector, "font-size") ?? "missing"}`,
  );
}
for (const selector of [
  ".cart-dims",
  ".cart-price",
  ".cart-variant",
  ".setup-thumb-size",
  ".photo-example-caption",
  ".photo-drop-hint",
  ".finishes-label",
]) {
  check(
    `phone ${selector} is 14px`,
    phoneDecl(selector, "font-size") === "14px",
    `font-size: ${phoneDecl(selector, "font-size") ?? "missing"}`,
  );
}
check(
  "phone bar buttons carry 15px labels",
  phoneDecl("#phone-bar > button", "font-size") === "15px",
  `font-size: ${phoneDecl("#phone-bar > button", "font-size") ?? "missing"}`,
);
for (const selector of ["#tool-undo", "#tool-redo"]) {
  check(
    `phone ${selector} is 64px wide, 16px bold`,
    phoneDecl(selector, "min-width") === "64px" &&
      phoneDecl(selector, "font-size") === "16px" &&
      phoneDecl(selector, "font-weight") === "700",
    `min-width: ${phoneDecl(selector, "min-width") ?? "missing"}, font-size: ${phoneDecl(selector, "font-size") ?? "missing"}, font-weight: ${phoneDecl(selector, "font-weight") ?? "missing"}`,
  );
}
for (const selector of [".guide-next", ".guide-skip"]) {
  check(
    `phone ${selector} is 48px tall, 16px`,
    phoneDecl(selector, "min-height") === "48px" &&
      phoneDecl(selector, "padding") === "10px 20px" &&
      phoneDecl(selector, "font-size") === "16px",
    `min-height: ${phoneDecl(selector, "min-height") ?? "missing"}, padding: ${phoneDecl(selector, "padding") ?? "missing"}, font-size: ${phoneDecl(selector, "font-size") ?? "missing"}`,
  );
}
check(
  "phone confirm pills carry 16px labels on 48px targets",
  phoneDecl("button.editor-pill", "min-height") === "48px" &&
    phoneDecl("button.editor-pill", "padding") === "10px 18px" &&
    phoneDecl("button.editor-pill", "font-size") === "16px",
  `min-height: ${phoneDecl("button.editor-pill", "min-height") ?? "missing"}, padding: ${phoneDecl("button.editor-pill", "padding") ?? "missing"}, font-size: ${phoneDecl("button.editor-pill", "font-size") ?? "missing"}`,
);
for (const selector of [".delete-toast button", ".setup-go", ".setup-secondary"]) {
  check(
    `phone ${selector} is 16px`,
    phoneDecl(selector, "font-size") === "16px",
    `font-size: ${phoneDecl(selector, "font-size") ?? "missing"}`,
  );
}
check(
  "every phone button answers 44 x 44 px",
  /button\s*\{[^}]*min-height:\s*44px[^}]*min-width:\s*44px/.test(phoneCss),
  "style.css phone button rule",
);
check(
  "phone fields stay 44 px tall",
  /input,\s*select,\s*textarea\s*\{[^}]*min-height:\s*44px/.test(phoneCss),
  "style.css phone input rule",
);
check(
  "the sheet handle answers 44 px",
  /\.sheet-handle\s*\{[^}]*min-height:\s*44px/.test(phoneCss),
  "style.css .sheet-handle",
);
check(
  "the labelled keep toggle answers 44 px tall",
  /\.furnish-keep\s*\{[^}]*min-height:\s*44px/.test(phoneCss),
  "style.css .furnish-keep",
);
check(
  "the details toggle answers 44 px tall",
  /\.assistant-did summary\s*\{[^}]*min-height:\s*44px/.test(phoneCss),
  "style.css .assistant-did summary",
);
check(
  "the phone fit list scrolls inside 40% of the room area",
  /\.fit-list\s*\{[^}]*max-height:\s*40%[^}]*overflow-y:\s*auto/s.test(phoneCss),
  "style.css phone .fit-list",
);
check(
  "phone text runs bigger (pills 15px, size tag 14px, Undo/Redo 16px)",
  /\.fit-issue-label,\s*\.fit-dim-label\s*\{[^}]*font-size:\s*15px[^}]*padding:\s*4px 12px/s.test(
    phoneCss,
  ) &&
    /#size-tag\.size-tag\s*\{[^}]*font-size:\s*14px[^}]*padding:\s*3px 10px/s.test(phoneCss) &&
    /\.editor-pill,\s*\.photo-draft-tape,\s*\.fit-list button\s*\{[^}]*font-size:\s*15px/s.test(
      phoneCss,
    ) &&
    /#tool-undo,\s*#tool-redo\s*\{[^}]*font-size:\s*16px/s.test(phoneCss),
  "style.css phone text sizes",
);
check(
  "corner handles keep their 28 px dot with a 44 px hit area",
  /\.photo-handle\s*\{[^}]*width:\s*28px/.test(phoneCss) &&
    /\.photo-handle::after\s*\{[^}]*inset:\s*-8px/s.test(editorCss),
  "style.css + editor.css .photo-handle",
);
check(
  "resize grips keep their 20 px look with a 44 px hit area",
  /\.photo-grip::after\s*\{[^}]*inset:\s*-12px/s.test(editorCss),
  "editor.css .photo-grip::after",
);
// The previously small targets are buttons, so the blanket rule covers
// them: header Undo/Redo, the fit badge, the guide Next/Skip, every panel
// ×, chips, style chips, seat steppers, swatches and catalog cards.
for (const [name, src, token] of [
  ["recommend close", recommendSrc, "recommend-close"],
  ["assistant close", assistantSrc, "assistant-close"],
  ["variant swatch", inspectorSrc, '"swatch"'],
  ["guide next", guideSrc, "guide-next"],
  ["guide skip", guideSrc, "guide-skip"],
] as const) {
  check(
    `the ${name} is a button (blanket 44 px rule covers it)`,
    src.includes('document.createElement("button")') && src.includes(token),
    token,
  );
}
check(
  "the fit badge is a button (blanket 44 px rule covers it)",
  html.includes('id="fit-badge"') && html.includes("<button"),
  "index.html fit-badge",
);

// Landscape (844 x 390): the catalog sheet starts closed (a "Catalog"
// button opens it) or peeks at most 25 % of the height.
{
  const landscapeAt = css.indexOf("@media (max-height: 500px) and (orientation: landscape)");
  const landscape = landscapeAt < 0 ? "" : css.slice(landscapeAt, landscapeAt + 800);
  const peek = /--sheet-peek:\s*(\d+)dvh/.exec(landscape)?.[1];
  check(
    "the landscape sheet peeks at most 25% of the height",
    peek !== undefined && Number(peek) <= 25,
    `--sheet-peek: ${peek ?? "?"}dvh`,
  );
  check(
    "the landscape guard keeps auto-open sheets closed",
    main.includes("private isLandscapeShort()") &&
      main.includes("(max-height: 500px) and (orientation: landscape)") &&
      (main.match(/!this\.isLandscapeShort\(\)/g) ?? []).length >= 2,
    "main.ts isLandscapeShort",
  );
  check(
    "crossing to a phone hides the catalog until Catalog opens it",
    main.includes('document.getElementById("catalog")?.setAttribute("hidden", "")'),
    "main.ts syncBreakpoint",
  );
  check(
    "the phone bar still offers Catalog in landscape",
    html.includes('id="phone-catalog"'),
    "index.html phone-catalog",
  );
}

if (failures > 0) {
  console.log(`check:toolbar: ${String(failures)} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("check:toolbar: all checks passed");
}
