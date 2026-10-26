/**
 * Which placed items the fit check leaves out when siting a candidate.
 *
 * - Replacement (`replace`): the selected instance itself — it vacates its
 *   spot while candidates are tried there (same centre and orientation, or
 *   slid along its wall run).
 * - Seat accessories (coffee-table, ottoman, side-table): placed items of
 *   the requested category. The shopper is rethinking that slot (a coffee
 *   table goes where the coffee table goes); "Place it" replaces a
 *   conflicting same-category piece as the same undo step.
 * - Everything else: nothing is left out; wall-run spots must fit the
 *   room as it stands.
 *
 * One implementation shared by the client panel, the demo-request builder
 * and `check:recommend`, so all three agree on what "fits" means.
 */

import type { CatalogItem, SceneState } from "../types.js";
import type { RecommendCategory } from "./types.js";

export const SEAT_ACCESSORY_CATEGORIES: ReadonlyArray<string> = [
  "coffee-table",
  "ottoman",
  "side-table",
];

export interface IgnoreQuery {
  category: RecommendCategory;
  replace?: { productId: string };
}

/** Instance ids the fit check must skip for this recommendation query. */
export function recommendIgnoreIds(
  scene: SceneState,
  catalog: CatalogItem[],
  query: IgnoreQuery,
): string[] {
  if (query.replace !== undefined) {
    const selected = scene.items.find((i) => i.productId === query.replace?.productId);
    return selected === undefined ? [] : [selected.instanceId];
  }
  if (SEAT_ACCESSORY_CATEGORIES.includes(query.category)) {
    const categories = new Map(catalog.map((c) => [c.id, c.category]));
    return scene.items
      .filter((i) => categories.get(i.productId) === query.category)
      .map((i) => i.instanceId);
  }
  return [];
}
