import type { CatalogItem, SceneItem } from "@fitroom/shared";
import { formatCatalogPrice, formatCatalogSize } from "./catalog-ui";
import { clampFootprintToRoom } from "./state";

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
  private expanded = false;

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
      this.expanded = false;
    }
    this.selected = item;
    this.render();
  }

  render(): void {
    this.root.innerHTML = "";
    if (this.expanded) this.root.setAttribute("data-expanded", "true");
    else this.root.removeAttribute("data-expanded");
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
      dims.textContent = `Size ${formatCatalogSize(entry.size.w, entry.size.d, entry.size.h)} · ${formatCatalogPrice(entry.price)}`;
      this.root.appendChild(dims);
    }

    // Position fields sit behind "More" on a phone; desktop shows all.
    const more = document.createElement("button");
    more.type = "button";
    more.className = "inspector-more";
    more.textContent = this.expanded ? "Less" : "More";
    more.setAttribute("aria-expanded", String(this.expanded));
    more.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.render();
    });
    this.root.appendChild(more);

    const bounds = this.bounds;
    const minX = bounds?.minX ?? 0;
    const minZ = bounds?.minZ ?? 0;
    const widthCm = bounds === null ? 0 : Math.round(bounds.maxX - bounds.minX);
    const depthCm = bounds === null ? 0 : Math.round(bounds.maxZ - bounds.minZ);

    // Labels sit above their fields, one line each; the room range is a
    // hint, and the clamp keeps the whole rotated footprint inside.
    const sizeW = entry?.size.w ?? 60;
    const sizeD = entry?.size.d ?? 60;
    const clampCentre = (x: number, z: number): { x: number; z: number } =>
      bounds === null ? { x, z } : clampFootprintToRoom(x, z, sizeW, sizeD, item.rotationY, bounds);
    const posCol = document.createElement("div");
    posCol.className = "inspector-pos";
    const makeField = (
      labelText: string,
      hintText: string,
      ariaText: string,
      inputName: string,
      value: number,
      onCommit: (distCm: number) => void,
    ): void => {
      const field = document.createElement("div");
      field.className = "inspector-field";
      const label = document.createElement("label");
      label.textContent = `${labelText} `;
      const hint = document.createElement("span");
      hint.className = "inspector-hint";
      hint.textContent = hintText;
      label.appendChild(hint);
      const input = document.createElement("input");
      input.type = "number";
      input.name = inputName;
      input.step = "1";
      input.min = "0";
      input.value = String(Math.round(value));
      input.setAttribute("aria-label", ariaText);
      input.addEventListener("change", () => {
        const raw = input.value.trim();
        if (raw === "" || !Number.isFinite(Number(raw))) {
          // Empty or invalid field restores the previous value: no commit.
          input.value = String(Math.round(value));
          return;
        }
        onCommit(Math.round(Number(raw)));
      });
      field.append(label, input);
      posCol.appendChild(field);
    };
    makeField(
      "From left wall · cm",
      bounds === null ? "" : `0–${widthCm}`,
      "From left wall in centimetres",
      "position-x-cm",
      item.position.x - minX,
      (dist) => {
        const next = clampCentre(minX + dist, item.position.z);
        const moved = Math.round(next.x) !== Math.round(minX + dist);
        this.note = moved
          ? `Kept the whole piece inside the room (0–${widthCm} cm from the left wall).`
          : null;
        this.renderNote();
        this.opts.onMove(item.instanceId, Math.round(next.x), item.position.z);
      },
    );
    makeField(
      "From door wall · cm",
      bounds === null ? "" : `0–${depthCm}`,
      "From door wall in centimetres",
      "position-z-cm",
      item.position.z - minZ,
      (dist) => {
        const next = clampCentre(item.position.x, minZ + dist);
        const moved = Math.round(next.z) !== Math.round(minZ + dist);
        this.note = moved
          ? `Kept the whole piece inside the room (0–${depthCm} cm from the door wall).`
          : null;
        this.renderNote();
        this.opts.onMove(item.instanceId, item.position.x, Math.round(next.z));
      },
    );
    this.root.appendChild(posCol);

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

    // Quick rotate steps beside the Rotation field, at every size; the
    // toolbar no longer carries them and Delete follows below.
    const actions = document.createElement("div");
    actions.className = "inspector-actions";
    for (const [label, delta] of [
      ["⟲ −15°", -15],
      ["⟳ +15°", 15],
    ] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-secondary";
      b.textContent = label;
      b.setAttribute("aria-label", `Rotate ${delta} degrees`);
      b.addEventListener("click", () =>
        this.opts.onRotate(item.instanceId, item.rotationY + delta),
      );
      actions.appendChild(b);
    }
    this.root.appendChild(actions);

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
