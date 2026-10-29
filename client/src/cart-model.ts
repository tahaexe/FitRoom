import type { CatalogItem, FitIssue, SceneItem } from "@fitroom/shared";
import { CART_EMPTY, CART_FIT_OK, cartFitError } from "./copy";

export interface CartRowModel {
  instanceId: string;
  productId: string;
  name: string;
  price: number;
  /** Display variant name, or null when the product has no variants to show. */
  variant: string | null;
  w: number;
  d: number;
  h: number;
  thumbnail: string;
  position: { x: number; z: number };
  rotationY: number;
  fitError: boolean;
}

export interface CartFitModel {
  kind: "empty" | "ok" | "errors" | "warnings";
  line: string;
  errorIds: string[];
}

export interface CartModel {
  rows: CartRowModel[];
  count: number;
  total: number;
  fit: CartFitModel;
}

/** Display variant only when the product itself has variants to choose from. */
export function cartVariantLabel(item: SceneItem, entry: CatalogItem | undefined): string | null {
  if (entry === undefined) return null;
  if (entry.variants.length === 0) return null;
  const v = item.variant.trim();
  if (v === "" || v === "default") return null;
  return v;
}

/**
 * Pure, DOM-free cart model: rows, the total (the same sum as the top bar)
 * and the fit flags. The fit line says exactly `CART_FIT_OK` when the fit
 * badge does, the error sentence when error issues name pieces, else the
 * badge's own warning words.
 */
export function buildCartModel(
  items: readonly SceneItem[],
  catalog: ReadonlyMap<string, CatalogItem>,
  issues: readonly FitIssue[],
  badgeText: string,
  badgeState: string,
): CartModel {
  const errorIds: string[] = [];
  for (const issue of issues) {
    if (issue.severity !== "error") continue;
    for (const id of issue.itemIds) {
      if (items.some((item) => item.instanceId === id) && !errorIds.includes(id)) {
        errorIds.push(id);
      }
    }
  }
  const rows: CartRowModel[] = items.map((item) => {
    const entry = catalog.get(item.productId);
    return {
      instanceId: item.instanceId,
      productId: item.productId,
      name: entry?.name ?? item.productId,
      price: entry?.price ?? 0,
      variant: entry === undefined ? null : cartVariantLabel(item, entry),
      w: entry?.size.w ?? 0,
      d: entry?.size.d ?? 0,
      h: entry?.size.h ?? 0,
      thumbnail: entry?.thumbnail ?? "",
      position: { ...item.position },
      rotationY: item.rotationY,
      fitError: errorIds.includes(item.instanceId),
    };
  });
  const total = rows.reduce((sum, row) => sum + row.price, 0);
  let fit: CartFitModel;
  if (rows.length === 0) {
    fit = { kind: "empty", line: CART_EMPTY, errorIds: [] };
  } else if (errorIds.length > 0) {
    fit = { kind: "errors", line: cartFitError(errorIds.length), errorIds };
  } else if (badgeState === "good" || badgeText === CART_FIT_OK) {
    fit = { kind: "ok", line: CART_FIT_OK, errorIds: [] };
  } else {
    fit = { kind: "warnings", line: badgeText, errorIds: [] };
  }
  return { rows, count: rows.length, total, fit };
}
