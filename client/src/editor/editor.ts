/**
 * The 2D plan editor screen: wall cards left, plan hero centre, selected
 * item fields right, add/undo pills on top and the coral build button.
 *
 * Every typed value is measured (see `source-mark`); every edit commits one
 * undo step and the 3D room follows committed edits at once.
 */

import type { DoorOpening, ExistingPiece, Opening, RoomLayout } from "@fitroom/shared";
import { setRectangleWallLength, validateRoomLayout, wallDisplayName } from "@fitroom/shared";
import { EditorPlanView } from "./plan-view";
import { sourceMark } from "./source-mark";
import { EditorStore } from "./editor-store";

export interface RoomEditorCallbacks {
  onBuild: () => void;
}

function cloneRoom(room: RoomLayout): RoomLayout {
  return JSON.parse(JSON.stringify(room)) as RoomLayout;
}

function uid(prefix: string, room: RoomLayout): string {
  const taken = new Set<string>([
    ...room.openings.map((o) => o.id),
    ...room.existing.map((p) => p.id),
  ]);
  let n = taken.size + 1;
  while (taken.has(`${prefix}-${String(n)}`)) n += 1;
  return `${prefix}-${String(n)}`;
}

function wallLengthOf(room: RoomLayout, wallId: string): number {
  const wall = room.walls.find((w) => w.id === wallId);
  if (wall === undefined) return 0;
  return Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z);
}

function clampOffset(offset: number, width: number, wallLength: number): number {
  return Math.min(Math.max(0, Math.round(offset)), Math.max(0, Math.round(wallLength - width)));
}

/** First offset where a span fits without overlapping its neighbours. */
function firstFreeOffset(room: RoomLayout, wallId: string, width: number): number {
  const len = Math.round(wallLengthOf(room, wallId));
  const taken = room.openings
    .filter((o) => o.wallId === wallId)
    .sort((a, b) => a.offset - b.offset);
  for (let offset = 10; offset + width <= len - 10; offset += 10) {
    if (!taken.some((o) => offset < o.offset + o.width && o.offset < offset + width)) {
      return offset;
    }
  }
  return clampOffset(Math.round((len - width) / 2), width, len);
}

export class RoomEditor {
  readonly element: HTMLElement;
  private readonly wallsEl: HTMLElement;
  private readonly fieldsEl: HTMLElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly buildBtn: HTMLButtonElement;
  private readonly noteEl: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private plan: EditorPlanView | null = null;
  private planHost: HTMLElement;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly store: EditorStore,
    private readonly callbacks: RoomEditorCallbacks,
  ) {
    this.element = document.createElement("div");
    this.element.className = "room-editor";
    this.element.setAttribute("hidden", "");

    const actions = document.createElement("div");
    actions.className = "editor-actions";
    const addDoor = this.pill("Add door", () => this.addOpening("door"));
    const addWindow = this.pill("Add window", () => this.addOpening("window"));
    const addPiece = this.pill("Add my own piece", () => this.addPiece());
    this.undoBtn = this.pill("Undo", () => this.store.undo());
    actions.append(addDoor, addWindow, addPiece, this.undoBtn);
    this.element.appendChild(actions);

    const grid = document.createElement("div");
    grid.className = "editor-grid";

    const wallsCard = document.createElement("aside");
    wallsCard.className = "editor-walls";
    wallsCard.setAttribute("aria-label", "Walls");
    this.wallsEl = document.createElement("div");
    this.wallsEl.className = "editor-wall-cards";
    wallsCard.appendChild(this.wallsEl);
    grid.appendChild(wallsCard);

    this.planHost = document.createElement("section");
    this.planHost.className = "editor-plan";
    this.planHost.setAttribute("aria-label", "Room plan");
    this.summaryEl = document.createElement("p");
    this.summaryEl.className = "editor-summary";
    this.planHost.appendChild(this.summaryEl);
    grid.appendChild(this.planHost);

    const fieldsCard = document.createElement("aside");
    fieldsCard.className = "editor-fields";
    fieldsCard.setAttribute("aria-label", "Selected item");
    this.fieldsEl = document.createElement("div");
    fieldsCard.appendChild(this.fieldsEl);
    grid.appendChild(fieldsCard);

    this.element.appendChild(grid);

    const foot = document.createElement("div");
    foot.className = "editor-foot";
    this.noteEl = document.createElement("p");
    this.noteEl.className = "editor-note";
    this.buildBtn = document.createElement("button");
    this.buildBtn.type = "button";
    this.buildBtn.className = "editor-build";
    this.buildBtn.textContent = "Build my room";
    this.buildBtn.addEventListener("click", () => this.callbacks.onBuild());
    foot.append(this.noteEl, this.buildBtn);
    this.element.appendChild(foot);

    // A drag checkpoints lazily on its first actual move, so a plain tap
    // selects without pushing a no-op undo step.
    let dragCheckpointed = false;
    this.plan = new EditorPlanView(this.planHost, this.store, {
      select: (selection) => this.store.select(selection),
      clearSelection: () => this.store.select(null),
      setWallLength: (wallId, lengthCm) => this.setWallLength(wallId, lengthCm),
      beginDrag: () => {
        dragCheckpointed = false;
      },
      previewOpeningOffset: (openingId, offsetCm) => {
        if (!dragCheckpointed) {
          this.store.checkpoint();
          dragCheckpointed = true;
        }
        const next = cloneRoom(this.store.room);
        const opening = next.openings.find((o) => o.id === openingId);
        if (opening === undefined) return;
        opening.offset = clampOffset(offsetCm, opening.width, wallLengthOf(next, opening.wallId));
        this.store.preview(next);
      },
      endDrag: () => {
        if (!dragCheckpointed) return;
        dragCheckpointed = false;
        this.store.finishDrag();
      },
      cancelDrag: () => {
        if (!dragCheckpointed) return;
        dragCheckpointed = false;
        this.store.undo();
      },
      removeOpening: (openingId) => this.removeOpening(openingId),
      removePiece: (pieceId) => this.removePiece(pieceId),
    });
    this.unsubscribe = this.store.subscribe(() => this.renderPanels());
    this.renderPanels();
  }

  destroy(): void {
    this.unsubscribe?.();
    this.plan?.destroy();
    this.element.remove();
  }

  private pill(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor-pill";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  private setWallLength(wallId: string, lengthCm: number): void {
    if (!Number.isFinite(lengthCm)) return;
    this.store.commit(setRectangleWallLength(this.store.room, wallId, lengthCm));
  }

  private addOpening(type: "door" | "window"): void {
    const room = this.store.room;
    const selection = this.store.selection;
    const wallId =
      (selection?.kind === "opening"
        ? room.openings.find((o) => o.id === selection.id)?.wallId
        : selection?.kind === "wall"
          ? selection.id
          : undefined) ?? "wall-1";
    const next = cloneRoom(room);
    const width = type === "door" ? 90 : 120;
    const offset = firstFreeOffset(next, wallId, width);
    const id = uid(type === "door" ? "door" : "window", next);
    const opening: Opening =
      type === "door"
        ? {
            id,
            wallId,
            type: "door",
            offset,
            width,
            height: 210,
            sillHeight: 0,
            hinge: "left",
            swing: "in",
          }
        : {
            id,
            wallId,
            type: "window",
            offset,
            width,
            height: 140,
            sillHeight: 90,
          };
    // Clamp vertically against the wall height so validation always passes.
    const wall = next.walls.find((w) => w.id === wallId);
    const wallHeight = wall?.height ?? 250;
    if (opening.sillHeight + opening.height > wallHeight) {
      opening.height = Math.max(1, Math.round(wallHeight - opening.sillHeight));
    }
    next.openings.push(opening);
    this.store.commit(next);
    this.store.select({ kind: "opening", id });
  }

  private addPiece(): void {
    const next = cloneRoom(this.store.room);
    const id = uid("piece", next);
    const w = 100;
    const d = 60;
    const width = Math.round(wallLengthOf(next, "wall-1"));
    const depth = Math.round(wallLengthOf(next, "wall-2"));
    next.existing.push({
      id,
      label: "My piece",
      footprint: {
        x: Math.max(0, Math.round((width - w) / 2)),
        z: Math.max(0, Math.round((depth - d) / 2)),
        w,
        d,
        rotationY: 0,
      },
      height: 75,
    });
    this.store.commit(next);
    this.store.select({ kind: "piece", id });
  }

  /** Same removal as the Details "Remove this …" button, for the plan's Delete key. */
  private removeOpening(openingId: string): void {
    const next = cloneRoom(this.store.room);
    if (!next.openings.some((o) => o.id === openingId)) return;
    next.openings = next.openings.filter((o) => o.id !== openingId);
    this.store.commit(next);
    this.store.select(null);
  }

  /** Same removal as the Details "Remove this piece" button, for the plan's Delete key. */
  private removePiece(pieceId: string): void {
    const next = cloneRoom(this.store.room);
    if (!next.existing.some((p) => p.id === pieceId)) return;
    next.existing = next.existing.filter((p) => p.id !== pieceId);
    this.store.commit(next);
    this.store.select(null);
  }

  private renderPanels(): void {
    const room = this.store.room;
    const active = document.activeElement;
    const focusKey = active instanceof HTMLInputElement ? active.dataset["key"] : undefined;
    const focusValue = active instanceof HTMLInputElement ? active.value : undefined;
    this.renderWalls(room);
    this.renderFields(room);
    this.undoBtn.disabled = !this.store.canUndo;
    const size = {
      w: Math.round(wallLengthOf(room, "wall-1")),
      d: Math.round(wallLengthOf(room, "wall-2")),
    };
    this.summaryEl.textContent = `${room.name} · ${String(size.w)} × ${String(size.d)} cm`;
    const validation = validateRoomLayout(room);
    if (validation.ok) {
      this.noteEl.textContent = "";
      this.buildBtn.disabled = false;
    } else {
      this.noteEl.textContent = validation.errors[0]?.message ?? "This plan is not valid yet.";
      this.buildBtn.disabled = true;
    }
    if (focusKey !== undefined) {
      const again = this.element.querySelector<HTMLInputElement>(`input[data-key="${focusKey}"]`);
      if (again !== null) {
        if (focusValue !== undefined) again.value = focusValue;
        again.focus();
      }
    }
  }

  private renderWalls(room: RoomLayout): void {
    this.wallsEl.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = "Walls";
    this.wallsEl.appendChild(title);
    room.walls.forEach((wall, index) => {
      const card = document.createElement("div");
      card.className =
        this.store.selection?.kind === "wall" && this.store.selection.id === wall.id
          ? "editor-wall-card selected"
          : "editor-wall-card";
      const head = document.createElement("button");
      head.type = "button";
      head.className = "editor-wall-head";
      head.textContent = `Wall ${String(index + 1)} · ${wallDisplayName(room, wall.id)}`;
      head.addEventListener("click", () => this.store.select({ kind: "wall", id: wall.id }));
      const row = document.createElement("div");
      row.className = "editor-field-row";
      const label = document.createElement("label");
      label.textContent = "Length ";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "50";
      input.max = "2000";
      input.step = "5";
      input.value = String(Math.round(wallLengthOf(room, wall.id)));
      input.dataset["key"] = `wall-${wall.id}`;
      input.setAttribute("aria-label", `Length of wall ${String(index + 1)} in centimetres`);
      input.addEventListener("change", () => this.setWallLength(wall.id, Number(input.value)));
      const unit = document.createElement("span");
      unit.textContent = "cm";
      label.append(input, unit);
      row.appendChild(label);
      card.append(head, row, sourceMark("measured"));
      this.wallsEl.appendChild(card);
    });
  }

  private renderFields(room: RoomLayout): void {
    this.fieldsEl.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = "Details";
    this.fieldsEl.appendChild(title);
    const selection = this.store.selection;
    if (selection === null) {
      const hint = document.createElement("p");
      hint.className = "editor-hint";
      hint.textContent = "Select a wall, a door, a window or one of your pieces to edit its sizes.";
      this.fieldsEl.appendChild(hint);
      return;
    }
    if (selection.kind === "wall") {
      const wall = room.walls.find((w) => w.id === selection.id);
      if (wall === undefined) return;
      const index = room.walls.indexOf(wall) + 1;
      this.fieldHeading(`Wall ${String(index)} · ${wallDisplayName(room, wall.id)}`);
      this.numberField(
        this.fieldsEl,
        `wall-${wall.id}`,
        "Length (cm)",
        wallLengthOf(room, wall.id),
        50,
        2000,
        (value) => this.setWallLength(wall.id, value),
      );
      this.fieldsEl.appendChild(sourceMark("measured"));
      return;
    }
    if (selection.kind === "opening") {
      const opening = room.openings.find((o) => o.id === selection.id);
      if (opening === undefined) return;
      const wallIndex = room.walls.findIndex((w) => w.id === opening.wallId) + 1;
      this.fieldHeading(
        `${opening.type === "door" ? "Door" : "Window"} · wall ${String(wallIndex)}`,
      );
      const wallLen = wallLengthOf(room, opening.wallId);
      this.numberField(
        this.fieldsEl,
        `offset-${opening.id}`,
        "Offset along the wall (cm)",
        opening.offset,
        0,
        Math.max(0, wallLen - opening.width),
        (value) =>
          this.commitOpening(opening.id, { offset: clampOffset(value, opening.width, wallLen) }),
      );
      this.numberField(
        this.fieldsEl,
        `width-${opening.id}`,
        "Width (cm)",
        opening.width,
        30,
        Math.max(30, wallLen),
        (value) =>
          this.commitOpening(opening.id, this.clampedSpan(opening, wallLen, value, opening.offset)),
      );
      this.numberField(
        this.fieldsEl,
        `height-${opening.id}`,
        "Height (cm)",
        opening.height,
        30,
        250,
        (value) => this.commitOpeningHeight(opening.id, value),
      );
      this.numberField(
        this.fieldsEl,
        `sill-${opening.id}`,
        "Sill height (cm)",
        opening.sillHeight,
        0,
        250,
        (value) => this.commitOpeningHeight(opening.id, undefined, value),
      );
      this.fieldsEl.appendChild(sourceMark("measured"));
      if (opening.type === "door") {
        this.toggleRow("Hinge", ["left", "right"], opening.hinge, (hinge) =>
          this.commitOpening(opening.id, { hinge: hinge as DoorOpening["hinge"] }),
        );
        this.toggleRow("Swing", ["in", "out"], opening.swing, (swing) =>
          this.commitOpening(opening.id, { swing: swing as DoorOpening["swing"] }),
        );
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = `Remove this ${opening.type === "door" ? "door" : "window"}`;
      remove.addEventListener("click", () => {
        const next = cloneRoom(this.store.room);
        next.openings = next.openings.filter((o) => o.id !== opening.id);
        this.store.commit(next);
        this.store.select(null);
      });
      this.fieldsEl.appendChild(remove);
      return;
    }
    const piece = room.existing.find((p) => p.id === selection.id);
    if (piece === undefined) return;
    this.fieldHeading(piece.label === "" ? "My piece" : piece.label);
    this.textField(this.fieldsEl, `name-${piece.id}`, "Name", piece.label, (value) =>
      this.commitPiece(piece.id, { label: value }),
    );
    this.numberField(
      this.fieldsEl,
      `w-${piece.id}`,
      "Width (cm)",
      piece.footprint.w,
      10,
      1000,
      (value) =>
        this.commitPiece(piece.id, { footprint: { ...piece.footprint, w: Math.round(value) } }),
    );
    this.numberField(
      this.fieldsEl,
      `d-${piece.id}`,
      "Depth (cm)",
      piece.footprint.d,
      10,
      1000,
      (value) =>
        this.commitPiece(piece.id, { footprint: { ...piece.footprint, d: Math.round(value) } }),
    );
    this.numberField(
      this.fieldsEl,
      `h-${piece.id}`,
      "Height (cm)",
      piece.height,
      10,
      260,
      (value) => this.commitPiece(piece.id, { height: Math.round(value) }),
    );
    this.numberField(
      this.fieldsEl,
      `r-${piece.id}`,
      "Rotation (°)",
      piece.footprint.rotationY,
      0,
      360,
      (value) =>
        this.commitPiece(piece.id, {
          footprint: { ...piece.footprint, rotationY: ((Math.round(value) % 360) + 360) % 360 },
        }),
    );
    this.fieldsEl.appendChild(sourceMark("measured"));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Remove this piece";
    remove.addEventListener("click", () => {
      const next = cloneRoom(this.store.room);
      next.existing = next.existing.filter((p) => p.id !== piece.id);
      this.store.commit(next);
      this.store.select(null);
    });
    this.fieldsEl.appendChild(remove);
  }

  private clampedSpan(
    opening: Opening,
    wallLen: number,
    width: number,
    offset: number,
  ): { width: number; offset: number } {
    const w = Math.min(Math.max(30, Math.round(width)), Math.max(30, Math.round(wallLen)));
    return { width: w, offset: clampOffset(offset, w, wallLen) };
  }

  private commitOpening(openingId: string, patch: Partial<Opening>): void {
    const next = cloneRoom(this.store.room);
    const opening = next.openings.find((o) => o.id === openingId);
    if (opening === undefined) return;
    Object.assign(opening, patch);
    const wall = next.walls.find((w) => w.id === opening.wallId);
    const wallHeight = wall?.height ?? 250;
    if (opening.sillHeight + opening.height > wallHeight) {
      opening.height = Math.max(1, Math.round(wallHeight - opening.sillHeight));
    }
    this.store.commit(next);
  }

  private commitOpeningHeight(openingId: string, height?: number, sill?: number): void {
    const next = cloneRoom(this.store.room);
    const opening = next.openings.find((o) => o.id === openingId);
    const wall = next.walls.find((w) => w.id === opening?.wallId);
    if (opening === undefined || wall === undefined) return;
    const nextHeight = height === undefined ? opening.height : Math.max(1, Math.round(height));
    const nextSill = sill === undefined ? opening.sillHeight : Math.max(0, Math.round(sill));
    if (nextSill + nextHeight > wall.height) {
      if (height !== undefined) {
        opening.height = Math.max(1, Math.round(wall.height - nextSill));
        opening.sillHeight = nextSill;
      } else {
        opening.sillHeight = Math.max(0, Math.round(wall.height - nextHeight));
        opening.height = nextHeight;
      }
    } else {
      opening.height = nextHeight;
      opening.sillHeight = nextSill;
    }
    this.store.commit(next);
  }

  private commitPiece(pieceId: string, patch: Partial<ExistingPiece>): void {
    const next = cloneRoom(this.store.room);
    const piece = next.existing.find((p) => p.id === pieceId);
    if (piece === undefined) return;
    Object.assign(piece, patch);
    this.store.commit(next);
  }

  private fieldHeading(text: string): void {
    const heading = document.createElement("h3");
    heading.textContent = text;
    this.fieldsEl.appendChild(heading);
  }

  private numberField(
    parent: HTMLElement,
    key: string,
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (value: number) => void,
  ): void {
    const row = document.createElement("div");
    row.className = "editor-field-row";
    const lab = document.createElement("label");
    lab.textContent = `${label} `;
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = min >= 50 ? "5" : "1";
    input.value = String(Math.round(value));
    input.dataset["key"] = key;
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) return;
      onChange(Math.min(max, Math.max(min, parsed)));
    });
    lab.appendChild(input);
    row.appendChild(lab);
    parent.appendChild(row);
  }

  private textField(
    parent: HTMLElement,
    key: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
  ): void {
    const row = document.createElement("div");
    row.className = "editor-field-row";
    const lab = document.createElement("label");
    lab.textContent = `${label} `;
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.dataset["key"] = key;
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => onChange(input.value));
    lab.appendChild(input);
    row.appendChild(lab);
    parent.appendChild(row);
  }

  private toggleRow(
    label: string,
    options: string[],
    current: string,
    onPick: (value: string) => void,
  ): void {
    const row = document.createElement("div");
    row.className = "editor-toggle-row";
    const name = document.createElement("span");
    name.textContent = label;
    row.appendChild(name);
    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "editor-toggle";
      button.textContent =
        option === "in" ? "In" : option === "out" ? "Out" : option === "left" ? "Left" : "Right";
      button.setAttribute("aria-pressed", String(option === current));
      button.dataset["active"] = String(option === current);
      const labelled = `${label} ${option}`;
      button.setAttribute("aria-label", labelled);
      button.title = labelled;
      button.addEventListener("click", () => onPick(option));
      row.appendChild(button);
    }
    this.fieldsEl.appendChild(row);
  }
}
