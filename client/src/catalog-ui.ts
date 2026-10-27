import type { CatalogCategory, CatalogItem } from "@fitroom/shared";

export const CATEGORIES: Array<CatalogCategory | "all"> = [
  "all",
  "sofa",
  "armchair",
  "ottoman",
  "coffee-table",
  "side-table",
  "tv-unit",
  "shelf",
  "decor",
];

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
    const q = this.query.trim().toLowerCase();
    return this.items.filter((item) => {
      if (this.chip !== "all" && item.category !== this.chip) return false;
      if (q === "") return true;
      const hay =
        `${item.name} ${item.category} ${item.styleTags.join(" ")} ${item.colors.join(" ")}`.toLowerCase();
      return hay.includes(q);
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
      b.textContent = c;
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
    for (const item of this.filtered()) {
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
