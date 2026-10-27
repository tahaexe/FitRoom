/**
 * Furnishing briefs: the shopper says what the room needs (seats, style,
 * budget) and the assistant furnishes it from the store's catalog.
 *
 * A brief travels on the assistant request (`AssistantRequest.brief`) and in
 * the shared executor context, so the client, the demo recorder and the
 * headless checks all agree on budgets, seat counts and the result card.
 */

import { checkFit } from "../fit.js";
import type { CatalogItem, RoomLayout, SceneItem, SceneState } from "../types.js";

/** Style the shopper asked for; "any" matches every catalog tag. */
export type BriefStyle = "any" | "modern" | "classic" | "scandinavian";

export const BRIEF_STYLES: BriefStyle[] = ["any", "modern", "classic", "scandinavian"];

export function isBriefStyle(style: string): style is BriefStyle {
  return (BRIEF_STYLES as string[]).includes(style);
}

/** Optional `POST /api/assistant` brief: what the room needs. */
export interface AssistantBrief {
  /** Seats the room must offer (integer 1-8). */
  seats: number;
  /** Style group the pieces should match ("any" takes everything). */
  style: BriefStyle;
  /** New pieces' total at most this many whole USD (300-20000). */
  budget: number;
  /** False starts the draft empty before the first round. */
  keepExisting: boolean;
}

/**
 * Catalog tags per style group (matched case-insensitively). A piece tagged
 * "any" matches every style.
 */
export const BRIEF_STYLE_TAGS: Record<Exclude<BriefStyle, "any">, string[]> = {
  modern: ["modern", "mid-century modern", "mid-century"],
  classic: ["classic", "traditional", "French provincial", "chesterfield"],
  scandinavian: ["Scandinavian", "simple"],
};

/** True when a piece's tags match the brief's style. */
export function briefStyleMatches(style: BriefStyle, tags: string[]): boolean {
  if (style === "any") return true;
  const lower = tags.map((tag) => tag.toLowerCase());
  if (lower.includes("any")) return true;
  const group = BRIEF_STYLE_TAGS[style].map((tag) => tag.toLowerCase());
  return lower.some((tag) => group.includes(tag));
}

/** Friendly reason why a brief value is invalid, or null. */
export function briefError(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "The furnishing brief must be an object with seats, style, budget and keepExisting.";
  }
  const record = value as Record<string, unknown>;
  const seats = record["seats"];
  if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 1 || seats > 8) {
    return "The brief needs seats from 1 to 8.";
  }
  const style = record["style"];
  if (typeof style !== "string" || !isBriefStyle(style)) {
    return "The brief style is any, modern, classic or scandinavian.";
  }
  const budget = record["budget"];
  if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 300 || budget > 20000) {
    return "The brief needs a budget from $300 to $20,000.";
  }
  if (typeof record["keepExisting"] !== "boolean") {
    return "The brief needs keepExisting true or false.";
  }
  return null;
}

export function isAssistantBrief(value: unknown): value is AssistantBrief {
  return briefError(value) === null;
}

/** Whole USD with a thousands separator: 2500 -> "$2,500". */
export function formatUsd(value: number): string {
  return `$${String(Math.round(value).toLocaleString("en-US"))}`;
}

/**
 * The request text for a brief turn: the brief sentence plus the shopper's
 * optional note (at most 200 characters — the panel enforces the length).
 */
export function buildBriefRequest(brief: AssistantBrief, note?: string): string {
  const people = brief.seats === 1 ? "1 person" : `${String(brief.seats)} people`;
  const sentence =
    `Furnish this room for ${people}, ${brief.style} style, ` +
    `new pieces up to ${formatUsd(brief.budget)}.`;
  const trimmed = (note ?? "").trim().slice(0, 200);
  return trimmed === "" ? sentence : `${sentence} ${trimmed}`;
}

/** Seats of one catalog product (absent `seats` counts 0). */
export function seatsOf(entry: CatalogItem | undefined): number {
  return entry?.seats ?? 0;
}

/** Seat count of a scene: every placed piece's seats added up. */
export function briefSeatCount(catalog: CatalogItem[], items: SceneItem[]): number {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  return items.reduce((sum, item) => sum + seatsOf(byId.get(item.productId)), 0);
}

/** Priced total of scene items (missing products count $0). */
export function briefPricedTotal(catalog: CatalogItem[], items: SceneItem[]): number {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  return items.reduce((sum, item) => sum + (byId.get(item.productId)?.price ?? 0), 0);
}

/**
 * The draft a brief turn works on: a copy of the live scene, or an empty
 * draft (same room and camera) when the brief starts from an empty room.
 */
export function startBriefDraft(start: SceneState, brief?: AssistantBrief): SceneState {
  if (brief === undefined || brief.keepExisting) {
    return JSON.parse(JSON.stringify(start)) as SceneState;
  }
  return { ...(JSON.parse(JSON.stringify(start)) as SceneState), items: [] };
}

/**
 * The turn's new pieces: with `keepExisting` false the draft started empty,
 * so every end-scene piece is new; otherwise the end items no start
 * instanceId names.
 */
export function briefNewItems(
  start: SceneState,
  end: SceneState,
  brief?: AssistantBrief,
): SceneItem[] {
  if (brief !== undefined && !brief.keepExisting) return [...end.items];
  const before = new Set(start.items.map((i) => i.instanceId));
  return end.items.filter((item) => !before.has(item.instanceId));
}

/** "Over budget: Rhythm TV Unit ($860) would make $2,710 of $2,500; $650 left." */
export function overBudgetError(
  name: string,
  price: number,
  totalNow: number,
  budget: number,
): string {
  return (
    `Over budget: ${name} (${formatUsd(price)}) would make ` +
    `${formatUsd(totalNow + price)} of ${formatUsd(budget)}; ${formatUsd(budget - totalNow)} left.`
  );
}

export interface BriefCardRow {
  instanceId: string;
  productId: string;
  name: string;
  price: number;
  thumbnail: string;
  /** True when the piece matches the brief's style (never for "any"). */
  styleMatch: boolean;
}

export interface BriefCard {
  seats: number;
  seatsAsked: number;
  /** True when the room seats fewer than asked (amber headline part). */
  seatsShort: boolean;
  newCount: number;
  total: number;
  budget: number;
  fitErrors: number;
  headline: string;
  rows: BriefCardRow[];
}

/**
 * The result card, computed from the end scene — never from the model's
 * text: "Seats 4 of 4 · 4 new pieces · $2,050 of $2,500 · ✓ Fits".
 */
export function briefResultCard(
  start: SceneState,
  end: SceneState,
  room: RoomLayout,
  catalog: CatalogItem[],
  brief: AssistantBrief,
): BriefCard {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const seats = briefSeatCount(catalog, end.items);
  const fresh = briefNewItems(start, end, brief);
  const total = briefPricedTotal(catalog, fresh);
  const products = new Map(
    catalog.map((c) => [c.id, { size: { ...c.size }, category: c.category, name: c.name }]),
  );
  const fitErrors = checkFit(room, end, products).filter((i) => i.severity === "error").length;
  const pieceWord = fresh.length === 1 ? "1 new piece" : `${String(fresh.length)} new pieces`;
  const fits =
    fitErrors === 0 ? "✓ Fits" : `✕ ${String(fitErrors)} problem${fitErrors === 1 ? "" : "s"}`;
  const headline =
    `Seats ${String(seats)} of ${String(brief.seats)} · ${pieceWord} · ` +
    `${formatUsd(total)} of ${formatUsd(brief.budget)} · ${fits}`;
  const rows: BriefCardRow[] = fresh.map((item) => {
    const entry = byId.get(item.productId);
    return {
      instanceId: item.instanceId,
      productId: item.productId,
      name: entry?.name ?? item.productId,
      price: entry?.price ?? 0,
      thumbnail: entry?.thumbnail ?? "",
      styleMatch: brief.style !== "any" && briefStyleMatches(brief.style, entry?.styleTags ?? []),
    };
  });
  return {
    seats,
    seatsAsked: brief.seats,
    seatsShort: seats < brief.seats,
    newCount: fresh.length,
    total,
    budget: brief.budget,
    fitErrors,
    headline,
    rows,
  };
}

/** Capitalized style word for a row chip ("Classic ✓"). */
export function briefStyleChip(style: BriefStyle): string {
  return `${style.charAt(0).toUpperCase()}${style.slice(1)} ✓`;
}
