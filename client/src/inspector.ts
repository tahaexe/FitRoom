import type { CatalogItem, SceneItem } from "@fitroom/shared";

/** Right inspector: selection details, transform fields, variant swatches. */
export class Inspector {
  private selected: SceneItem | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly catalog: Map<string, CatalogItem>,
    private readonly opts: {
      onMove: (id: string, x: number, z: number) => void;
      onRotate: (id: string, deg: number) => void;
      onVariant: (id: string, variant: string) => void;
      onDelete: (id: string) => void;
    },
  ) {}

  setSelection(item: SceneItem | null): void {
    this.selected = item;
    this.render();
  }

  render(): void {
    this.root.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = "Inspector";
    this.root.appendChild(title);
    const item = this.selected;
    if (item === null) {
      const p = document.createElement("p");
      p.textContent = "Select a piece to edit it.";
      this.root.appendChild(p);
      return;
    }
    const entry = this.catalog.get(item.productId);
    const name = document.createElement("p");
    name.className = "inspector-name";
    name.textContent = entry?.name ?? item.productId;
    this.root.appendChild(name);
    if (entry !== undefined) {
      const dims = document.createElement("p");
      dims.textContent = `Size ${Math.round(entry.size.w)}×${Math.round(entry.size.d)}×${Math.round(entry.size.h)}cm · $${entry.price}`;
      this.root.appendChild(dims);
    }

    const posRow = document.createElement("div");
    posRow.className = "inspector-row";
    const xLabel = document.createElement("label");
    xLabel.textContent = "X (cm) ";
    const xInput = document.createElement("input");
    xInput.type = "number";
    xInput.name = "position-x-cm";
    xInput.step = "5";
    xInput.value = String(Math.round(item.position.x));
    xInput.addEventListener("change", () => {
      this.opts.onMove(item.instanceId, Number(xInput.value), item.position.z);
    });
    const zLabel = document.createElement("label");
    zLabel.textContent = "Z (cm) ";
    const zInput = document.createElement("input");
    zInput.type = "number";
    zInput.name = "position-z-cm";
    zInput.step = "5";
    zInput.value = String(Math.round(item.position.z));
    zInput.addEventListener("change", () => {
      this.opts.onMove(item.instanceId, item.position.x, Number(zInput.value));
    });
    posRow.append(xLabel, xInput, zLabel, zInput);
    this.root.appendChild(posRow);

    const rotRow = document.createElement("div");
    rotRow.className = "inspector-row";
    const rLabel = document.createElement("label");
    rLabel.textContent = "Rotation (°) ";
    const rInput = document.createElement("input");
    rInput.type = "number";
    rInput.name = "rotation-deg";
    rInput.step = "15";
    rInput.value = String(Math.round(item.rotationY));
    rInput.addEventListener("change", () => {
      this.opts.onRotate(item.instanceId, Number(rInput.value));
    });
    rotRow.append(rLabel, rInput);
    this.root.appendChild(rotRow);

    if (entry !== undefined && entry.variants.length > 0) {
      const vTitle = document.createElement("h3");
      vTitle.textContent = "Variant";
      this.root.appendChild(vTitle);
      const swatches = document.createElement("div");
      swatches.className = "swatches";
      for (const v of entry.variants) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "swatch";
        b.title = v.name;
        b.dataset["active"] = String(item.variant === v.name);
        b.style.background = v.swatch;
        b.setAttribute("aria-label", `Variant ${v.name}`);
        b.addEventListener("click", () => this.opts.onVariant(item.instanceId, v.name));
        swatches.appendChild(b);
      }
      this.root.appendChild(swatches);
      const current = document.createElement("p");
      current.textContent = `Current: ${item.variant === "" ? "(default)" : item.variant}`;
      this.root.appendChild(current);
    }

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "Delete (Del)";
    del.addEventListener("click", () => this.opts.onDelete(item.instanceId));
    this.root.appendChild(del);
  }
}
