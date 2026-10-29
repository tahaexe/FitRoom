import type { CatalogItem } from "@fitroom/shared";
import { formatCatalogPrice, formatCatalogSize } from "./catalog-ui";

export interface StoreProduct {
  status: "ok";
  id: string;
  name: string;
  sizeText: string;
  priceText: string;
  credit: string;
  thumbnail: string;
  addHref: string;
}

export interface StoreUnknown {
  status: "unknown";
  id: string | null;
}

export type StoreModel = StoreProduct | StoreUnknown;

/** Link from a product page into the app: highlights, never places. */
export function storeAddHref(id: string): string {
  return `/?add=${encodeURIComponent(id)}`;
}

/**
 * Pure model for the demo product page. Sizes and prices come from the one
 * formatter in `catalog-ui.ts`; the credit is the catalog's own line, so
 * the page can never drift from the app.
 */
export function storeModelFor(catalog: readonly CatalogItem[], id: string | null): StoreModel {
  const entry = catalog.find((item) => item.id === id);
  if (entry === undefined) return { status: "unknown", id };
  return {
    status: "ok",
    id: entry.id,
    name: entry.name,
    sizeText: formatCatalogSize(entry.size.w, entry.size.d, entry.size.h),
    priceText: formatCatalogPrice(entry.price),
    credit: entry.credit,
    thumbnail: entry.thumbnail,
    addHref: storeAddHref(entry.id),
  };
}
