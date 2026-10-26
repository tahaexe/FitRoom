/**
 * The nothing-fits message: when a request has no candidates the panel
 * makes no model call and instead says why, with real sizes — the longest
 * free wall run and its usable depth, the smallest product of that category
 * with its footprint, and the 45 cm a seat needs in front. When an item of
 * that category is already in the room the panel additionally offers
 * "Replace the <name>", which runs the replacement flow.
 */

import type { CatalogItem, RoomLayout, SceneState } from "../types.js";
import { wallDisplayName } from "./walls.js";
import type { FreeRun, FreeSpace } from "./types.js";

function round0(value: number): number {
  return Math.round(value);
}

/** Smallest product of a category by footprint (area, then width, then catalog order). */
export function smallestOfCategory(catalog: CatalogItem[], category: string): CatalogItem | null {
  let best: CatalogItem | null = null;
  let bestKey = Number.POSITIVE_INFINITY;
  for (const item of catalog) {
    if (item.category !== category) continue;
    const key = item.size.w * item.size.d + item.size.w / 1e6;
    if (key < bestKey) {
      bestKey = key;
      best = item;
    }
  }
  return best;
}

/** Longest free wall run (ties keep room order). */
export function longestRun(freeSpace: FreeSpace): FreeRun | null {
  let best: FreeRun | null = null;
  for (const run of freeSpace.runs) {
    if (best === null || run.length_cm > best.length_cm) best = run;
  }
  return best;
}

/**
 * Local nothing-fits text with sizes. Never mentions `wall-N` ids: runs
 * are cited by their people-friendly wall name.
 */
export function nothingFitsMessage(
  category: string,
  room: RoomLayout,
  freeSpace: FreeSpace,
  catalog: CatalogItem[],
): string {
  const run = longestRun(freeSpace);
  const smallest = smallestOfCategory(catalog, category);
  const runText =
    run === null
      ? "No free wall runs right now."
      : `Longest free wall run: ${wallDisplayName(room, run.wall)} · ${String(round0(run.length_cm))} cm (${String(round0(run.depth_cm))} cm deep).`;
  const smallestText =
    smallest === null
      ? `No ${category} in the catalog.`
      : `Smallest ${category}: ${smallest.name}, ${String(round0(smallest.size.w))} × ${String(round0(smallest.size.d))} × ${String(round0(smallest.size.h))} cm.`;
  return (
    `No fitting ${category} right now. ${runText} ${smallestText} ` +
    `Seats need 45 cm of clear space in front.`
  );
}

/** First placed item of a category (scene order), for the "Replace the <name>" offer. */
export function replacementOfferFor(
  category: string,
  scene: SceneState,
  catalog: CatalogItem[],
): { instanceId: string; productId: string; name: string } | null {
  const names = new Map(catalog.map((c) => [c.id, c]));
  for (const item of scene.items) {
    const entry = names.get(item.productId);
    if (entry !== undefined && entry.category === category) {
      return { instanceId: item.instanceId, productId: item.productId, name: entry.name };
    }
  }
  return null;
}
