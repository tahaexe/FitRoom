/**
 * `npm run check:cart` — the cart panel's pure model (no browser, no Meta calls).
 *
 * - `buildCartModel` (`client/src/cart-model.ts`) derives the rows, the total
 *   and the fit flags from the store items, the catalog and the fit engine
 *   (`checkFit` via `FitEngine.analyze`): three scenes — the sample scene
 *   (`shared/samples/fit-tests/valid.json`: 4 items, $3,280), a fit-error
 *   scene (`overlap.json`) and an empty room.
 * - The total is the same sum as the top bar (`formatTopBar`).
 * - A variant name shows only when the product itself has variants: the
 *   sample pieces carry `"default"`, which is never shown.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FitEngine } from "@fitroom/shared";
import type { CatalogItem, FitIssue, RoomLayout, SceneItem, SceneState } from "@fitroom/shared";
import { buildCartModel, cartVariantLabel } from "../src/cart-model.js";
import { CART_EMPTY, CART_FIT_OK, cartFitError } from "../src/copy.js";
import { formatTopBar } from "../src/catalog-ui.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharedRoot = join(root, "..", "shared");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const catalog = JSON.parse(
  readFileSync(join(sharedRoot, "catalog", "catalog.json"), "utf8"),
) as CatalogItem[];
const catalogMap = new Map(catalog.map((entry) => [entry.id, entry]));
const products = new Map(
  catalog.map((entry) => [
    entry.id,
    { size: entry.size, category: entry.category, name: entry.name },
  ]),
);
const room = JSON.parse(
  readFileSync(join(sharedRoot, "samples", "living-420x360.json"), "utf8"),
) as RoomLayout;
const validScene = JSON.parse(
  readFileSync(join(sharedRoot, "samples", "fit-tests", "valid.json"), "utf8"),
) as SceneState;
const overlapScene = JSON.parse(
  readFileSync(join(sharedRoot, "samples", "fit-tests", "overlap.json"), "utf8"),
) as SceneState;

const engine = new FitEngine(room, products);

/** Mirrors the fit badge in `main.ts` refreshIssues (errors name pieces). */
function badgeFor(issues: readonly FitIssue[]): { text: string; state: string } {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warns = issues.length - errors;
  if (errors > 0 && warns > 0) {
    return {
      text: `✕ ${String(errors)} problem${errors === 1 ? "" : "s"} · ${String(warns)} warning${warns === 1 ? "" : "s"}`,
      state: "bad",
    };
  }
  if (errors > 0) {
    return {
      text: `✕ ${String(errors)} problem${errors === 1 ? "" : "s"}`,
      state: "bad",
    };
  }
  if (warns > 0) {
    return { text: `! ${String(warns)} warning${warns === 1 ? "" : "s"}`, state: "warn" };
  }
  return { text: CART_FIT_OK, state: "good" };
}

function item(productId: string, variant: string): SceneItem {
  return {
    instanceId: `probe-${productId}`,
    productId,
    position: { x: 0, z: 0 },
    rotationY: 0,
    variant,
  } as SceneItem;
}

// ---- scene 1: the sample scene (4 items, $3,280) ----
{
  const issues = engine.analyze(validScene).issues;
  const badge = badgeFor(issues);
  const model = buildCartModel(validScene.items, catalogMap, issues, badge.text, badge.state);
  check("valid scene has 4 rows", model.rows.length === 4, String(model.rows.length));
  check("valid scene counts 4", model.count === 4, String(model.count));
  check("valid scene totals $3,280", model.total === 3280, String(model.total));
  check(
    "valid total matches the top-bar sum",
    model.total ===
      validScene.items.reduce(
        (sum, entry) => sum + (catalogMap.get(entry.productId)?.price ?? 0),
        0,
      ),
    String(model.total),
  );
  check(
    "valid top bar reads 4 items · $3,280",
    formatTopBar(model.count, model.total) === "4 items · $3,280",
    formatTopBar(model.count, model.total),
  );
  for (const row of model.rows) {
    const entry = catalogMap.get(row.productId);
    check(
      `row ${row.productId} names the catalog piece`,
      entry !== undefined && row.name === entry.name,
      row.name,
    );
    check(
      `row ${row.productId} shows no default variant`,
      row.variant === null,
      JSON.stringify(row.variant),
    );
    check(
      `row ${row.productId} carries catalog size and price`,
      entry !== undefined &&
        row.w === entry.size.w &&
        row.d === entry.size.d &&
        row.h === entry.size.h &&
        row.price === entry.price,
      `${String(row.w)}×${String(row.d)}×${String(row.h)} $${String(row.price)}`,
    );
    check(`row ${row.productId} carries a thumbnail`, row.thumbnail !== "", row.thumbnail);
  }
  check(
    "valid scene raises no error issues",
    issues.filter((i) => i.severity === "error").length === 0,
  );
  check(
    "valid fit line matches the badge",
    model.fit.line === badge.text && (model.fit.kind === "ok" || model.fit.kind === "warnings"),
    `${model.fit.kind}: ${model.fit.line}`,
  );
  if (issues.length === 0) {
    check("valid fit line is the ok sentence", model.fit.line === CART_FIT_OK, model.fit.line);
  }
  console.log(
    `valid rows: ${model.rows.map((row) => `${row.name} $${String(row.price)}`).join(" | ")} — total $${String(model.total)} — ${model.fit.line}`,
  );
}

// ---- scene 2: a fit-error scene (overlap.json) ----
{
  const issues = engine.analyze(overlapScene).issues;
  const badge = badgeFor(issues);
  const model = buildCartModel(overlapScene.items, catalogMap, issues, badge.text, badge.state);
  const errorIds = issues
    .filter((issue) => issue.severity === "error")
    .flatMap((issue) => issue.itemIds)
    .filter((id) => overlapScene.items.some((entry) => entry.instanceId === id));
  const uniqueErrors = [...new Set(errorIds)];
  check("overlap scene has error issues", uniqueErrors.length > 0, uniqueErrors.join(","));
  check("overlap fit flags errors", model.fit.kind === "errors", model.fit.kind);
  check(
    "overlap fit line names the error count",
    model.fit.line === cartFitError(uniqueErrors.length),
    model.fit.line,
  );
  check(
    "overlap total stays $3,280",
    model.count === 4 && model.total === 3280,
    `${String(model.count)} items $${String(model.total)}`,
  );
  for (const row of model.rows) {
    check(
      `overlap row ${row.productId} marks exactly the error pieces`,
      row.fitError === uniqueErrors.includes(row.instanceId),
      `${row.instanceId} fitError=${String(row.fitError)}`,
    );
  }
  console.log(
    `overlap rows: ${model.rows.map((row) => `${row.name}${row.fitError ? " ✕" : ""}`).join(" | ")} — total $${String(model.total)} — ${model.fit.line}`,
  );
}

// ---- scene 3: an empty room ----
{
  const empty: SceneState = { ...validScene, items: [] };
  const issues = engine.analyze(empty).issues;
  const badge = badgeFor(issues);
  const model = buildCartModel(empty.items, catalogMap, issues, badge.text, badge.state);
  check("empty room has no rows", model.rows.length === 0);
  check("empty room totals $0", model.count === 0 && model.total === 0);
  check("empty room shows the empty sentence", model.fit.line === CART_EMPTY, model.fit.line);
  check("empty fit kind is empty", model.fit.kind === "empty", model.fit.kind);
}

// ---- variant rule: only real variant names show ----
{
  const sheen = catalogMap.get("SheenChair");
  check("SheenChair test entry has variants", (sheen?.variants.length ?? 0) > 0);
  if (sheen !== undefined) {
    check(
      "a named variant shows",
      cartVariantLabel(item("SheenChair", "Mango Velvet"), sheen) === "Mango Velvet",
    );
    check(
      "default never shows on a variant product",
      cartVariantLabel(item("SheenChair", "default"), sheen) === null,
    );
  }
  const sofa = catalogMap.get("sofa_02");
  check("sofa_02 test entry has no variants", sofa?.variants.length === 0);
  if (sofa !== undefined) {
    check(
      "default never shows on a variant-free product",
      cartVariantLabel(item("sofa_02", "default"), sofa) === null,
    );
  }
  check(
    "unknown products show no variant",
    cartVariantLabel(item("nope", "X"), undefined) === null,
  );
}

// ---- Cart rows build only while the panel is visible ----
{
  const mainSrc = readFileSync(join(root, "src", "main.ts"), "utf8");
  const showAt = mainSrc.indexOf("private showSidePanel(");
  const nextAt = mainSrc.indexOf("\n  private ", showAt + 1);
  const showBody = showAt < 0 ? "" : mainSrc.slice(showAt, nextAt < 0 ? showAt + 6000 : nextAt);
  const cartUnhide = showBody.indexOf('cart?.removeAttribute("hidden")');
  const sheetOpen = showBody.indexOf("this.sheets.open(");
  const renders: number[] = [];
  let from = 0;
  while (true) {
    const idx = showBody.indexOf("renderCartPanel()", from);
    if (idx < 0) break;
    renders.push(idx);
    from = idx + 1;
  }
  check(
    "cart:showSidePanel-unhide-found",
    showBody.length > 0 && cartUnhide >= 0 && sheetOpen >= 0,
    "showSidePanel must unhide the cart panel and open its sheet",
  );
  check(
    "cart:render-after-visible",
    renders.length > 0 &&
      renders.every((idx) => idx > cartUnhide || (idx > sheetOpen && idx < cartUnhide)),
    'renderCartPanel() inside showSidePanel must run after the cart panel\'s removeAttribute("hidden") (desktop) or after its sheet is open (phone)',
  );
}

// ---- Cart chrome hides during setup and the photo walkthrough ----
{
  const mainSrc = readFileSync(join(root, "src", "main.ts"), "utf8");
  const topBarAt = mainSrc.indexOf("private updateTopBar(");
  const topBarEnd = mainSrc.indexOf("\n  private ", topBarAt + 1);
  const topBarBody =
    topBarAt < 0 ? "" : mainSrc.slice(topBarAt, topBarEnd < 0 ? topBarAt + 8000 : topBarEnd);
  check(
    "cart:setup-hides",
    topBarBody.includes("firstOpen") &&
      topBarBody.includes("cart-total") &&
      topBarBody.includes("tool-cart") &&
      topBarBody.includes("phone-cart") &&
      topBarBody.includes('"none"'),
    "updateTopBar must hide #cart-total, #tool-cart and #phone-cart while the first-run dialog is open",
  );
  check(
    "cart:photos-hide",
    topBarBody.includes("photoFlow") &&
      topBarBody.includes("cart-total") &&
      topBarBody.includes("tool-cart") &&
      topBarBody.includes("phone-cart"),
    "updateTopBar must hide the same three nodes while the photo walkthrough is open",
  );
  check(
    "cart:confirm-hides",
    topBarBody.includes("editing") &&
      topBarBody.includes("cart-total") &&
      topBarBody.includes("tool-cart") &&
      topBarBody.includes("phone-cart") &&
      topBarBody.includes('"none"'),
    "updateTopBar must hide the same three nodes while the confirm view is open",
  );
  check(
    "cart:room-shows-again",
    topBarBody.includes('""') && topBarBody.includes('"none"'),
    "updateTopBar must bring the three nodes back when the room view is back",
  );
  check("cart:empty-room-zero", formatTopBar(0, 0) === "0 items · $0", formatTopBar(0, 0));
}

if (failures > 0) {
  console.log(`check:cart: ${String(failures)} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("check:cart: all checks passed");
}
