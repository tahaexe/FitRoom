import type { CatalogCategory, CatalogItem } from "@fitroom/shared";

export const CATEGORIES: Array<CatalogCategory | "all"> = [
  "all",
  "sofa",
  "armchair",
  "dining-table",
  "dining-chair",
  "coffee-table",
  "side-table",
  "bed",
  "wardrobe",
  "cabinet",
  "bookcase",
  "storage",
  "tv-unit",
  "ottoman",
  "shelf",
  "decor",
];

/** Readable chip names (never the raw slugs). */
export const CATEGORY_LABELS: Record<CatalogCategory | "all", string> = {
  all: "All",
  sofa: "Sofas",
  armchair: "Armchairs",
  ottoman: "Ottomans",
  "coffee-table": "Coffee tables",
  "side-table": "Side tables",
  "tv-unit": "TV units",
  shelf: "Shelves",
  decor: "Decor",
  "dining-table": "Dining tables",
  "dining-chair": "Dining chairs",
  bed: "Beds",
  wardrobe: "Wardrobes",
  cabinet: "Cabinets",
  bookcase: "Bookcases",
  storage: "Storage",
};

/** Common words mapped onto the catalog's own vocabulary. */
const SYNONYMS: Array<{ words: string[]; match: (item: CatalogItem) => boolean }> = [
  { words: ["couch", "couches", "sofa", "sofas"], match: (item) => item.category === "sofa" },
  {
    words: ["chair", "chairs", "armchair", "armchairs"],
    match: (item) => item.category === "armchair",
  },
  {
    words: ["table", "tables"],
    match: (item) => item.category === "coffee-table" || item.category === "side-table",
  },
  { words: ["plant", "plants"], match: (item) => item.category === "decor" },
  {
    words: ["cabinet", "cabinets", "stand", "stands", "console", "consoles"],
    match: (item) =>
      item.category === "tv-unit" || item.category === "cabinet" || item.category === "storage",
  },
  {
    words: ["bookcase", "bookcases", "bookshelf", "bookshelves"],
    match: (item) => item.category === "shelf" || item.category === "bookcase",
  },
  {
    words: ["bed", "beds"],
    match: (item) => item.category === "bed",
  },
  {
    words: ["wardrobe", "wardrobes", "armoire", "armoires"],
    match: (item) => item.category === "wardrobe",
  },
  {
    words: ["dining"],
    match: (item) => item.category === "dining-table" || item.category === "dining-chair",
  },
  {
    words: ["storage", "dresser", "drawers", "chest"],
    match: (item) => item.category === "storage",
  },
  { words: ["ottoman", "ottomans", "footstool"], match: (item) => item.category === "ottoman" },
];

/** True when the item matches a free-text query, including common synonyms. */
export function matchesCatalogQuery(item: CatalogItem, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (q === "") return true;
  const hay =
    `${item.name} ${item.category} ${item.styleTags.join(" ")} ${item.colors.join(" ")}`.toLowerCase();
  if (hay.includes(q)) return true;
  const tokens = q.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  return SYNONYMS.some(
    (group) =>
      (tokens.some((token) => group.words.includes(token)) ||
        group.words.some((word) => q.includes(word))) &&
      group.match(item),
  );
}

/** Top bar readout: "4 items · $3,280" (never a bare "$3,280 · 4"). */
export function formatTopBar(count: number, total: number): string {
  return `${String(count)} ${count === 1 ? "item" : "items"} · $${total.toLocaleString("en-US")}`;
}

/** Status pill for the selected piece, in plain words (never symbols). */
export function formatMeasure(
  name: string,
  widthCm: number,
  depthCm: number,
  wallCm: number,
  rotationDeg: number,
): string {
  return (
    `${name} ${String(Math.round(widthCm))}×${String(Math.round(depthCm))}cm · ` +
    `${String(Math.round(wallCm))} cm from the wall · ${String(Math.round(rotationDeg))}°`
  );
}

/** Left catalog panel: search + category chips + product cards. */
export class CatalogPanel {
  private query = "";
  private chip: CatalogCategory | "all" = "all";

  constructor(
    private readonly root: HTMLElement,
    private readonly items: CatalogItem[],
    private readonly onAdd: (item: CatalogItem) => void,
  ) {
    this.render();
  }

  private filtered(): CatalogItem[] {
    return this.items.filter((item) => {
      if (this.chip !== "all" && item.category !== this.chip) return false;
      return matchesCatalogQuery(item, this.query);
    });
  }

  render(): void {
    this.root.innerHTML = "";
    const search = document.createElement("input");
    search.type = "search";
    search.name = "catalog-search";
    search.placeholder = "Search catalog…";
    search.setAttribute("aria-label", "Search catalog");
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList();
    });
    this.root.appendChild(search);

    const chips = document.createElement("div");
    chips.className = "chips";
    for (const c of CATEGORIES) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = CATEGORY_LABELS[c];
      b.dataset["category"] = c;
      b.dataset["active"] = String(c === this.chip);
      b.addEventListener("click", () => {
        this.chip = c;
        this.render();
      });
      chips.appendChild(b);
    }
    this.root.appendChild(chips);

    const list = document.createElement("div");
    list.className = "catalog-list";
    this.root.appendChild(list);
    this.renderList(list);
  }

  private renderList(list?: HTMLElement): void {
    const host = list ?? this.root.querySelector(".catalog-list");
    if (host === null || host === undefined) return;
    host.innerHTML = "";
    const matches = this.filtered();
    if (matches.length === 0) {
      const empty = document.createElement("p");
      empty.className = "catalog-empty";
      const q = this.query.trim();
      empty.textContent =
        q === ""
          ? "Nothing in this category yet — try All."
          : `No matches for “${q}”. Try a category: Sofas, Armchairs, Dining tables, Dining chairs, Coffee tables, Side tables, Beds, Wardrobes, Cabinets, Bookcases, Storage, TV units, Shelves or Decor.`;
      host.appendChild(empty);
      return;
    }
    for (const item of matches) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "catalog-card";
      const thumb = document.createElement("img");
      thumb.src = item.thumbnail;
      thumb.alt = item.name;
      thumb.loading = "lazy";
      const meta = document.createElement("span");
      meta.className = "catalog-meta";
      const dims = `${Math.round(item.size.w)}×${Math.round(item.size.d)}×${Math.round(item.size.h)}cm`;
      const name = document.createElement("span");
      name.className = "catalog-name";
      name.textContent = item.name;
      const dimsEl = document.createElement("span");
      dimsEl.className = "catalog-dims";
      dimsEl.textContent = dims;
      const price = document.createElement("span");
      price.className = "catalog-price";
      price.textContent = `$${item.price}`;
      meta.append(name, dimsEl, price);
      card.appendChild(thumb);
      card.appendChild(meta);
      card.title = `Add ${item.name} (${dims})`;
      card.addEventListener("click", () => this.onAdd(item));
      host.appendChild(card);
    }
  }
}
