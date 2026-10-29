/**
 * `npm run check:labels` — every action has one name, from one module.
 * Headless (no browser, no Meta calls).
 *
 * - Pins the canonical labels in `client/src/copy.ts` (stepper
 *   Photograph → Measure → Confirm, "Next: confirm", "Build my room",
 *   "Leave", "Add to cart", "Use the sample room" named alike in the
 *   demo-miss / capped sentence and its button).
 * - Asserts the UI renders from that module (every screen imports it) and
 *   no two screens name one action differently (stale literals are gone:
 *   "Check" step, "Build room" button, "Cancel" exit, "Reset to the demo
 *   room" / "try the demo room" copy, per-screen "Turn on Live AI" /
 *   "Use the sample room" / "Build my room" literals).
 * - Asserts every accessible name starts with its visible words (plan
 *   openings, confirm opening boxes, "Reset tint") and the wall-tint chip
 *   is a button with a name or carries none.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADD_TO_CART,
  BUILD_MY_ROOM,
  CAPPED_MESSAGE,
  CART_BROWSE_CATALOG,
  CART_CLOSE,
  CART_COPY_LINK,
  CART_DISABLED_REASON,
  CART_DOWNLOAD,
  CART_DOWNLOAD_TITLE,
  CART_EMPTY,
  CART_EMPTY_ACTION,
  CART_FIT_OK,
  CART_LINK_COPIED,
  CART_PANEL_TITLE,
  CART_SHARE_LABEL,
  CART_SHARE_TITLE,
  DEMO_MISS_MESSAGE,
  DEMO_STORE_LINE,
  FLOW_STEPS,
  LEAVE,
  SHARE_DIALOG_TEXT,
  SHARE_INVALID,
  SHARE_KEEP,
  SHARE_OPEN,
  STORE_OPEN_APP,
  STORE_SEE_IT,
  STORE_UNKNOWN,
  TAPE_NEXT,
  TURN_ON_LIVE,
  USE_SAMPLE_ROOM,
  cartFitError,
  planOpeningName,
  resetTintLabel,
  storeAddHint,
} from "../src/copy.js";
import { openingName } from "../src/editor/plan-view.js";
import { openingBoxLabel } from "../src/editor/photo-confirm.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = root;
const src = (rel: string): string => readFileSync(join(clientRoot, "src", rel), "utf8");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

check(
  "stepper is Photograph → Measure → Confirm",
  FLOW_STEPS.join(" → ") === "Photograph → Measure → Confirm",
);
check("tape button is Next: confirm", TAPE_NEXT === "Next: confirm");
check("confirm keeps Build my room", BUILD_MY_ROOM === "Build my room");
check("exit is Leave everywhere", LEAVE === "Leave");
check("header cart is Add to cart", ADD_TO_CART === "Add to cart");
check(
  "disabled cart names the photo flow",
  CART_DISABLED_REASON === "Finish the photo flow first, then add to cart.",
);
check("demo-miss names its button action", DEMO_MISS_MESSAGE.includes(USE_SAMPLE_ROOM));
check("capped names its button action", CAPPED_MESSAGE.includes(USE_SAMPLE_ROOM));
check("live switch is one name", TURN_ON_LIVE === "Turn on Live AI");

const flow = src("photo-room/flow.ts");
check("flow renders the shared stepper", flow.includes("FLOW_STEPS"), "flow.ts");
check("flow exit renders Leave", flow.includes("LEAVE"), "flow.ts");
check("flow tape button renders Next: confirm", flow.includes("TAPE_NEXT"), "flow.ts");
check("flow stale step label gone", !flow.includes('label: "Check"'), "flow.ts");
check("flow stale build label gone", !flow.includes('"Build room"'), "flow.ts");
check("flow stale continue-to-tape gone", !flow.includes('"Continue to tape"'), "flow.ts");

const confirm = src("editor/photo-confirm.ts");
check("confirm view keeps the stepper", confirm.includes("FLOW_STEPS"), "photo-confirm.ts");

const editor = src("editor/editor.ts");
check("editor exit renders Leave", editor.includes("LEAVE"), "editor.ts");
check("editor exit Cancel gone", !editor.includes('pill("Cancel"'), "editor.ts");
check("editor build renders Build my room", editor.includes("BUILD_MY_ROOM"), "editor.ts");

const main = src("main.ts");
check("header cart renders from the module", main.includes("ADD_TO_CART"), "main.ts");
check(
  "header cart disabled in flow and confirm",
  main.includes("CART_DISABLED_REASON") && main.includes("photoFlow !== null || this.editing"),
  "main.ts",
);

// The cart panel and the share block: every new label lives in copy.ts,
// the panel renders from the module, and no screen carries its own literal.
check("cart panel title is Your cart", CART_PANEL_TITLE === "Your cart");
check("cart close is Close cart", CART_CLOSE === "Close cart");
check("cart download is Download list", CART_DOWNLOAD === "Download list");
check("cart download title names the JSON", CART_DOWNLOAD_TITLE === "Download your cart as JSON");
check("cart empty reads the empty-cart sentence", CART_EMPTY.startsWith("Your cart is empty."));
check(
  "cart empty action opens the catalog",
  CART_EMPTY_ACTION === "Add furniture to the room first",
);
check("cart browse opens the catalog", CART_BROWSE_CATALOG === "Browse the catalog");
check("cart fit ok matches the badge", CART_FIT_OK === "✓ Everything fits");
check(
  "cart fit error names the count",
  cartFitError(1) === "1 piece doesn't fit yet: fix it or add anyway" &&
    cartFitError(2) === "2 pieces don't fit yet: fix them or add anyway",
  `${cartFitError(1)} / ${cartFitError(2)}`,
);
check(
  "demo store line is the invented-products sentence",
  DEMO_STORE_LINE === "Demo store · invented products and prices",
);
check("share title is Share this layout", CART_SHARE_TITLE === "Share this layout");
check("share copy is Copy link", CART_COPY_LINK === "Copy link");
check("share copied reads Link copied", CART_LINK_COPIED === "Link copied");
check("share field is labelled", CART_SHARE_LABEL === "Shareable link");
check(
  "share dialog keeps the sample room",
  SHARE_DIALOG_TEXT.includes("the sample room stays in the room menu") &&
    SHARE_OPEN === "Open" &&
    SHARE_KEEP === "Keep my room",
  SHARE_DIALOG_TEXT,
);
check("share invalid names the sample room", SHARE_INVALID.includes(USE_SAMPLE_ROOM));
for (const token of [
  "CART_PANEL_TITLE",
  "CART_CLOSE",
  "CART_DOWNLOAD",
  "CART_DOWNLOAD_TITLE",
  "CART_BROWSE_CATALOG",
  "CART_FIT_OK",
  "DEMO_STORE_LINE",
  "CART_SHARE_TITLE",
  "CART_COPY_LINK",
  "CART_LINK_COPIED",
  "CART_SHARE_LABEL",
  "SHARE_DIALOG_TEXT",
  "SHARE_OPEN",
  "SHARE_KEEP",
  "SHARE_INVALID",
  "CART_EMPTY",
]) {
  check(`cart panel renders ${token} from the module`, main.includes(token), "main.ts");
}
check("cart badge renders CART_FIT_OK from the module", main.includes("CART_FIT_OK"), "main.ts");
{
  // Comments may quote the words; only code may not carry its own literal.
  const cartCodeFiles = [
    "photo-room/flow.ts",
    "editor/photo-confirm.ts",
    "editor/editor.ts",
    "editor/finishes.ts",
    "editor/plan-view.ts",
    "main.ts",
    "catalog-ui.ts",
    "cart-model.ts",
    "layout-share.ts",
    "assistant/panel.ts",
    "recommend/panel.ts",
    "render/viewer.ts",
    "first-open.ts",
    "api.ts",
  ];
  const cartLiterals = [
    "Your cart",
    "Close cart",
    "Download list",
    "Download your cart as JSON",
    "Browse the catalog",
    "✓ Everything fits",
    "pieces don't fit yet",
    "Demo store · invented products and prices",
    "Share this layout",
    "Copy link",
    "Link copied",
    "Shareable link",
    "Open the shared layout?",
    "Keep my room",
    "That share link didn't work",
    "Your cart is empty. Add furniture from the catalog.",
  ];
  for (const file of cartCodeFiles) {
    const code = src(file)
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
      })
      .join("\n");
    for (const literal of cartLiterals) {
      check(
        `${file} carries no cart literal "${literal.slice(0, 24)}"`,
        !code.includes(literal),
        file,
      );
    }
  }
}

for (const file of [
  "photo-room/flow.ts",
  "editor/photo-confirm.ts",
  "editor/editor.ts",
  "editor/finishes.ts",
  "editor/plan-view.ts",
  "main.ts",
  "catalog-ui.ts",
  "assistant/panel.ts",
  "recommend/panel.ts",
  "render/viewer.ts",
  "first-open.ts",
  "api.ts",
]) {
  const body = src(file);
  check(
    `${file} carries no per-screen Live AI literal`,
    !body.includes('textContent = "Turn on Live AI"'),
    file,
  );
  check(
    `${file} carries no per-screen sample-room literal`,
    !body.includes('textContent = "Use the sample room"'),
    file,
  );
}
for (const file of [
  "photo-room/flow.ts",
  "editor/editor.ts",
  "first-open.ts",
  "main.ts",
  "assistant/panel.ts",
  "recommend/panel.ts",
  "render/viewer.ts",
]) {
  // Comments may quote the name; only code may not carry its own literal.
  const code = src(file)
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
  check(
    `${file} carries no per-screen Build my room literal`,
    !code.includes('"Build my room"'),
    file,
  );
}
const sharedApi = readFileSync(join(root, "..", "shared", "src", "schemas", "api.ts"), "utf8");
check(
  "shared gateway copy names Use the sample room",
  sharedApi.includes("Use the sample room") &&
    !sharedApi.includes("Reset to the demo room") &&
    !sharedApi.includes("try the demo room"),
);
for (const file of ["assistant/panel.ts", "recommend/panel.ts", "render/viewer.ts", "api.ts"]) {
  const body = src(file);
  check(
    `${file} carries no reset-to-demo-room copy`,
    !body.includes("reset to the demo room") && !body.includes("try the demo room"),
    file,
  );
}

// Accessible names start with their visible words.
const room = {
  walls: [{ id: "wall-2", start: { x: 0, z: 0 }, end: { x: 100, z: 0 } }],
  openings: [],
};
const planName = openingName(
  room as unknown as Parameters<typeof openingName>[0],
  { wallId: "wall-2", type: "door", width: 100 } as unknown as Parameters<typeof openingName>[1],
);
check(
  "plan opening name starts with its visible words",
  planName.startsWith("Door · 100 cm"),
  planName,
);
const boxName = openingBoxLabel("window", "C", 120, 140, "Window 120 × 140");
check(
  "confirm opening name starts with its visible tag",
  boxName.startsWith("Window 120 × 140"),
  boxName,
);
const directName = planOpeningName("door", "A", 145);
check(
  "plan helper starts with its visible words",
  directName.startsWith("Door · 145 cm"),
  directName,
);
// ---- Item 4: names, not ids ----
const surfacesPath = join(clientRoot, "..", "shared", "src", "photo-room", "surfaces.ts");
const surfaces = readFileSync(surfacesPath, "utf8");
const finishIdPattern =
  /"(WoodFloor\d+|Tiles\d+|Carpet\d+|Concrete\d+|PaintedPlaster\d+|Wallpaper[A-Z0-9]+)"/g;
const finishIds = [...surfaces.matchAll(finishIdPattern)].map((m) => m[1] as string);
check("finish ids found for the name check", finishIds.length >= 12, String(finishIds.length));
let namesSection = "";
const namesAt = surfaces.indexOf("FINISH_NAMES");
if (namesAt >= 0) namesSection = surfaces.slice(namesAt, namesAt + 2000);
for (const id of finishIds) {
  const named = new RegExp(`${id}:\\s*"([^"]+)"`).exec(namesSection);
  check(
    `finish ${id} has a short readable name`,
    named !== null &&
      (named[1] ?? "").length > 0 &&
      (named[1] ?? "") !== id &&
      !/\d/.test(named[1] ?? ""),
    named?.[1] ?? "missing",
  );
}
const finishesSrc = src("editor/finishes.ts");
const mainSrc = src("main.ts");
check(
  "floor swatches render names, never asset ids",
  finishesSrc.includes("`Floor: ${finishName(id)}`") &&
    !finishesSrc.includes("`Floor finish ${id}`"),
  "finishes.ts",
);
check(
  "wall swatches render names, never asset ids",
  finishesSrc.includes("`Wall: ${finishName(id)}`") && !finishesSrc.includes("`Wall finish ${id}`"),
  "finishes.ts",
);
check(
  "swatch tooltips and accessible names carry no asset id",
  !finishesSrc.includes("finish ${id}") &&
    !finishesSrc.includes("Floor finish") &&
    !finishesSrc.includes("Wall finish") &&
    !/title = `[^`]*\$\{id\}[^`]*`/.test(finishesSrc) &&
    !/aria-label", `[^`]*\$\{id\}[^`]*`/.test(finishesSrc),
  "finishes.ts",
);
check(
  "the header hides Undo and Redo in the photo flow",
  mainSrc.includes("this.photoFlow !== null || this.editing") &&
    mainSrc.includes('el.style.display = inFlow ? "none" : ""'),
  "main.ts",
);

const tint = resetTintLabel();
check(
  "Reset tint name starts with its visible words",
  tint.accessible.startsWith(tint.visible),
  tint.accessible,
);
const finishes = src("editor/finishes.ts");
check("tint reset renders from the module", finishes.includes("resetTintLabel"), "finishes.ts");
check("tint reset stale name gone", !finishes.includes('"Reset wall tint"'), "finishes.ts");
check(
  "wall-tint chip carries no name",
  finishes.includes('setAttribute("aria-hidden", "true")') &&
    !finishes.includes('chip.setAttribute("aria-label"'),
  "finishes.ts",
);

// ---- Form fields carry a stable id or name ----
// Every `input`, `select` and `textarea` the client creates (templates and
// `createElement` calls) carries a stable `id` or `name`, so the browser's
// Issues panel reports no form-field problem. Where a field has an `id`,
// its label points at it with `for`; otherwise the wrapping label or
// accessible name applies.
const fieldSourceFiles: string[] = [];
{
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) fieldSourceFiles.push(full);
    }
  };
  walk(join(clientRoot, "src"));
}
const createFieldRe = /document\.createElement\(\s*["'](input|select|textarea)["']\s*\)/g;
const methodStartRe =
  /^ {2}(?:private |protected |public |static |async |get |set |constructor)*[A-Za-z_$][\w$]*\s*\(/;
for (const file of fieldSourceFiles) {
  const body = readFileSync(file, "utf8");
  const lines = body.split("\n");
  const rel = file.slice(clientRoot.length + 1).replace(/\\/g, "/");
  let match: RegExpExecArray | null;
  createFieldRe.lastIndex = 0;
  while ((match = createFieldRe.exec(body)) !== null) {
    const offset = match.index;
    const matchLine = body.slice(0, offset).split("\n").length - 1;
    const varOnLine = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[matchLine] ?? "");
    if (varOnLine === null) {
      check(`field creation assigns to a named variable`, false, `${rel}:${matchLine + 1}`);
      continue;
    }
    const name = varOnLine[1] as string;
    let methodStart = 0;
    for (let i = matchLine; i >= 0; i -= 1) {
      if (methodStartRe.test(lines[i] ?? "")) {
        methodStart = i;
        break;
      }
      if (/^}/.test(lines[i] ?? "") && i !== matchLine) break;
    }
    let methodEnd = lines.length - 1;
    for (let i = matchLine; i < lines.length; i += 1) {
      if (/^ {2}\}$/.test(lines[i] ?? "")) {
        methodEnd = i;
        break;
      }
    }
    const scope = lines.slice(methodStart, methodEnd + 1).join("\n");
    const idAssigned = new RegExp(`\\b${name}\\s*\\.\\s*id\\s*=`).test(scope);
    const nameAssigned = new RegExp(`\\b${name}\\s*\\.\\s*name\\s*=`).test(scope);
    const attrAssigned = new RegExp(
      `\\b${name}\\s*\\.\\s*setAttribute\\s*\\(\\s*["'](?:id|name)["']`,
    ).test(scope);
    check(
      `${rel}:${matchLine + 1} field carries an id or name`,
      idAssigned || nameAssigned || attrAssigned,
      `${rel}:${matchLine + 1}`,
    );
    if (idAssigned || attrAssigned) {
      check(
        `${rel}:${matchLine + 1} label points at the field id`,
        /\.htmlFor\s*=|setAttribute\(\s*["']for["']/.test(scope),
        `${rel}:${matchLine + 1}`,
      );
    }
  }
}
const templateTagRe = /<(input|select|textarea)(?=[\s/>])[^>]*>/g;
for (const file of [...fieldSourceFiles, join(clientRoot, "index.html")]) {
  const body = readFileSync(file, "utf8");
  const rel =
    file === join(clientRoot, "index.html")
      ? "index.html"
      : file.slice(clientRoot.length + 1).replace(/\\/g, "/");
  let tag: RegExpExecArray | null;
  templateTagRe.lastIndex = 0;
  while ((tag = templateTagRe.exec(body)) !== null) {
    const line = body.slice(0, tag.index).split("\n").length;
    check(
      `${rel}:${line} template field carries an id or name`,
      /\s(?:id|name)=/.test(tag[0]),
      `${rel}:${line} ${tag[0].slice(0, 60)}`,
    );
  }
}

// ---- Demo store page + `?add=` entry: every new label lives in copy.ts ----
check("store button is See it in your room", STORE_SEE_IT === "See it in your room");
check(
  "store missing names the demo store",
  STORE_UNKNOWN === "That piece isn't in the demo store.",
);
check("store way back opens the app", STORE_OPEN_APP === "Open FitRoom");
check(
  "store entry hint names the piece",
  storeAddHint("Chester Leather Sofa") ===
    "Drag the Chester Leather Sofa into your room, or press + Add",
  storeAddHint("Chester Leather Sofa"),
);
{
  // Comments may quote the words; only code may not carry its own literal.
  const storeFiles = ["store.ts", "store-model.ts", "store-add.ts", "main.ts", "catalog-ui.ts"];
  const storeLiterals = [
    "See it in your room",
    "That piece isn't in the demo store.",
    "Open FitRoom",
    "into your room, or press",
  ];
  for (const file of storeFiles) {
    const code = src(file)
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
      })
      .join("\n");
    for (const literal of storeLiterals) {
      check(
        `${file} carries no store literal "${literal.slice(0, 24)}"`,
        !code.includes(literal),
        file,
      );
    }
  }
  const storeHtml = readFileSync(join(clientRoot, "store.html"), "utf8");
  for (const literal of [...storeLiterals, "Demo store · invented products and prices"]) {
    check(
      `store.html carries no store literal "${literal.slice(0, 24)}"`,
      !storeHtml.includes(literal),
      "store.html",
    );
  }
}

if (failures > 0) process.exit(1);
console.log("labels ok");
