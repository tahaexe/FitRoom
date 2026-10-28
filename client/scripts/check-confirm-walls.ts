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
  "badge sits at the photo's bottom-left corner",
  /\.photo-stage\s+\.photo-example-badge\s*\{[^}]*bottom\s*:\s*8px[^}]*left\s*:\s*8px/s.test(
    confirmCss,
  ),
  "editor.css",
);
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

if (failures > 0) process.exit(1);
console.log("confirm walls ok");
