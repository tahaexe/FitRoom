import type { CatalogItem, SceneItem } from "@fitroom/shared";

export interface InspectorBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Right inspector: selection details, transform fields, variant swatches. */
export class Inspector {
  private selected: SceneItem | null = null;
  private bounds: InspectorBounds | null = null;
  private lastId: string | null = null;
  private note: string | null = null;

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

  /** Room floor bounds in centimetres (updates when the room is rebuilt). */
  setBounds(bounds: InspectorBounds): void {
    this.bounds = { ...bounds };
    this.render();
  }

  setSelection(item: SceneItem | null): void {
    const id = item?.instanceId ?? null;
    if (id !== this.lastId) {
      this.lastId = id;
      this.note = null;
    }
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

    const bounds = this.bounds;
    const minX = bounds?.minX ?? 0;
    const minZ = bounds?.minZ ?? 0;
    const widthCm = bounds === null ? 0 : Math.round(bounds.maxX - bounds.minX);
    const depthCm = bounds === null ? 0 : Math.round(bounds.maxZ - bounds.minZ);

    const posRow = document.createElement("div");
    posRow.className = "inspector-row";
    const xLabel = document.createElement("label");
    xLabel.textContent = `From left wall (cm${bounds === null ? "" : `, 0–${widthCm}`}) `;
    const xInput = document.createElement("input");
    xInput.type = "number";
    xInput.name = "position-x-cm";
    xInput.step = "1";
    xInput.min = "0";
    if (bounds !== null) xInput.max = String(widthCm);
    xInput.value = String(Math.round(item.position.x - minX));
    xInput.setAttribute("aria-label", "From left wall in centimetres");
    xInput.addEventListener("change", () => {
      const raw = xInput.value.trim();
      if (raw === "") {
        // Empty field restores the previous value: no commit.
        xInput.value = String(Math.round(item.position.x - minX));
        return;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        xInput.value = String(Math.round(item.position.x - minX));
        return;
      }
      const dist = Math.round(parsed);
      const absolute = minX + dist;
      const clampedX =
        bounds === null ? absolute : Math.min(bounds.maxX, Math.max(bounds.minX, absolute));
      if (clampedX !== absolute && bounds !== null) {
        this.note = `Clamped to the room (0–${widthCm} cm from the left wall).`;
      } else {
        this.note = null;
      }
      this.renderNote();
      this.opts.onMove(item.instanceId, clampedX, item.position.z);
    });
    const zLabel = document.createElement("label");
    zLabel.textContent = `From door wall (cm${bounds === null ? "" : `, 0–${depthCm}`}) `;
    const zInput = document.createElement("input");
    zInput.type = "number";
    zInput.name = "position-z-cm";
    zInput.step = "1";
    zInput.min = "0";
    if (bounds !== null) zInput.max = String(depthCm);
    zInput.value = String(Math.round(item.position.z - minZ));
    zInput.setAttribute("aria-label", "From door wall in centimetres");
    zInput.addEventListener("change", () => {
      const raw = zInput.value.trim();
      if (raw === "") {
        zInput.value = String(Math.round(item.position.z - minZ));
        return;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        zInput.value = String(Math.round(item.position.z - minZ));
        return;
      }
      const dist = Math.round(parsed);
      const absolute = minZ + dist;
      const clampedZ =
        bounds === null ? absolute : Math.min(bounds.maxZ, Math.max(bounds.minZ, absolute));
      if (clampedZ !== absolute && bounds !== null) {
        this.note = `Clamped to the room (0–${depthCm} cm from the door wall).`;
      } else {
        this.note = null;
      }
      this.renderNote();
      this.opts.onMove(item.instanceId, item.position.x, clampedZ);
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
      const raw = rInput.value.trim();
      if (raw === "") {
        rInput.value = String(Math.round(item.rotationY));
        return;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        rInput.value = String(Math.round(item.rotationY));
        return;
      }
      this.opts.onRotate(item.instanceId, parsed);
    });
    rotRow.append(rLabel, rInput);
    this.root.appendChild(rotRow);

    this.renderNote();

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

  private renderNote(): void {
    this.root.querySelector(".inspector-note")?.remove();
    if (this.note === null) return;
    const note = document.createElement("p");
    note.className = "inspector-note";
    note.setAttribute("role", "status");
    note.textContent = this.note;
    this.root.appendChild(note);
  }
}
