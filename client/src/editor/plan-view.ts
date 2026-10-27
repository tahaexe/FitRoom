/**
 * Top-down plan hero for the room editor: walls, openings with door swing
 * arcs, own pieces, and an editable length pill per wall.
 *
 * Plan centimetres map to SVG units 1:1 (x east, y = -z so north is up).
 * Openings drag along their wall as one undo step; pills and clicks select.
 */

import type { ExistingPiece, Opening, RoomLayout, Wall } from "@fitroom/shared";
import type { EditorSelection, EditorStore } from "./editor-store";

export interface EditorPlanActions {
  select(selection: Exclude<EditorSelection, null>): void;
  clearSelection(): void;
  setWallLength(wallId: string, lengthCm: number): void;
  beginDrag(): void;
  previewOpeningOffset(openingId: string, offsetCm: number): void;
  endDrag(): void;
  cancelDrag(): void;
  removeOpening(openingId: string): void;
  removePiece(pieceId: string): void;
}

export function openingName(room: RoomLayout, opening: Opening): string {
  const wallIndex = room.walls.findIndex((w) => w.id === opening.wallId) + 1;
  const kind = opening.type === "door" ? "Door" : "Window";
  return `${kind} on wall ${String(wallIndex)}, ${String(Math.round(opening.width))} cm`;
}

export function pieceName(piece: ExistingPiece): string {
  const label = piece.label === "" ? "My piece" : piece.label;
  return `${label}, ${String(Math.round(piece.footprint.w))} by ${String(Math.round(piece.footprint.d))} cm`;
}

const NS = "http://www.w3.org/2000/svg";
const PAD_CM = 70;
const WALL_STROKE_CM = 7;
const HIT_STROKE_CM = 26;

interface Vec {
  x: number;
  z: number;
}

function wallDir(wall: Wall): Vec {
  const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z) || 1;
  return { x: (wall.end.x - wall.start.x) / len, z: (wall.end.z - wall.start.z) / len };
}

function wallLen(wall: Wall): number {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z);
}

function centroidOf(room: RoomLayout): Vec {
  let x = 0;
  let z = 0;
  for (const wall of room.walls) {
    x += wall.start.x + wall.end.x;
    z += wall.start.z + wall.end.z;
  }
  const n = Math.max(1, room.walls.length * 2);
  return { x: x / n, z: z / n };
}

function inwardOf(wall: Wall, centroid: Vec): Vec {
  const d = wallDir(wall);
  const mx = (wall.start.x + wall.end.x) / 2;
  const mz = (wall.start.z + wall.end.z) / 2;
  const cx = centroid.x - mx;
  const cz = centroid.z - mz;
  if (cx * -d.z + cz * d.x >= 0) return { x: -d.z, z: d.x };
  return { x: d.z, z: -d.x };
}

function along(wall: Wall, offsetCm: number): Vec {
  const d = wallDir(wall);
  return { x: wall.start.x + d.x * offsetCm, z: wall.start.z + d.z * offsetCm };
}

/** Corners of an own piece (centre-based, same convention as the fit engine). */
function pieceCorners(piece: ExistingPiece): Vec[] {
  const fp = piece.footprint;
  const cx = fp.x + fp.w / 2;
  const cz = fp.z + fp.d / 2;
  const rad = (fp.rotationY * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = fp.w / 2;
  const hd = fp.d / 2;
  return [
    { x: -hw, z: -hd },
    { x: hw, z: -hd },
    { x: hw, z: hd },
    { x: -hw, z: hd },
  ].map((p) => ({
    x: cx + p.x * cos + p.z * sin,
    z: cz - p.x * sin + p.z * cos,
  }));
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

export class EditorPlanView {
  readonly element: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly pills: HTMLElement;
  private drag: { openingId: string; wallId: string; grabOffset: number } | null = null;
  private dragMoved = false;
  private captured = false;
  private suppressClick = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly store: EditorStore,
    private readonly actions: EditorPlanActions,
  ) {
    this.element = document.createElement("div");
    this.element.className = "editor-plan-wrap";
    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("class", "editor-plan-svg");
    this.svg.setAttribute("role", "img");
    this.svg.setAttribute("aria-label", "Room plan, top down");
    this.element.appendChild(this.svg);
    this.pills = document.createElement("div");
    this.pills.className = "editor-plan-pills";
    this.element.appendChild(this.pills);
    parent.appendChild(this.element);

    this.svg.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.svg.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.svg.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.svg.addEventListener("pointercancel", () => this.onPointerCancel());
    this.svg.addEventListener("click", (event) => this.onBackgroundClick(event));
    this.unsubscribe = this.store.subscribe(() => this.render());
    this.render();
  }

  destroy(): void {
    this.unsubscribe?.();
    this.element.remove();
  }

  private viewBox(room: RoomLayout): [number, number, number, number] {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const wall of room.walls) {
      for (const p of [wall.start, wall.end]) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
    }
    if (!Number.isFinite(minX)) {
      minX = 0;
      maxX = 400;
      minZ = 0;
      maxZ = 350;
    }
    const centroid = centroidOf(room);
    const grow = (x: number, z: number): void => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    };
    // Door swing arcs sweep a full quadrant of radius `width` around the
    // hinge: include the whole disc so an outward swing is never cut, and
    // the opening label sitting clear of the leaf and arc.
    for (const opening of room.openings) {
      const wall = room.walls.find((w) => w.id === opening.wallId);
      if (wall === undefined) continue;
      if (opening.type === "door") {
        const hingeAt = opening.hinge === "left" ? opening.offset : opening.offset + opening.width;
        const hinge = along(wall, hingeAt);
        const r = opening.width;
        grow(hinge.x - r, hinge.z - r);
        grow(hinge.x + r, hinge.z + r);
      }
      const inward = inwardOf(wall, centroid);
      const mid = along(wall, opening.offset + opening.width / 2);
      grow(mid.x + inward.x * 60, mid.z + inward.z * 60);
    }
    // Length pills sit 42 cm outside each wall: include their anchors with
    // room for the whole pill.
    for (const wall of room.walls) {
      const len = wallLen(wall);
      if (len < 1) continue;
      const mid = along(wall, len / 2);
      let ox = mid.x - centroid.x;
      let oz = mid.z - centroid.z;
      const outLen = Math.hypot(ox, oz) || 1;
      ox /= outLen;
      oz /= outLen;
      grow(mid.x + ox * 110, mid.z + oz * 110);
    }
    // SVG y runs down: y = -z, so the top is -(maxZ + pad).
    return [minX - PAD_CM, -(maxZ + PAD_CM), maxX - minX + PAD_CM * 2, maxZ - minZ + PAD_CM * 2];
  }

  private render(): void {
    const room = this.store.room;
    const selection = this.store.selection;
    const centroid = centroidOf(room);
    const [vx, vy, vw, vh] = this.viewBox(room);
    this.svg.setAttribute("viewBox", `${fmt(vx)} ${fmt(vy)} ${fmt(vw)} ${fmt(vh)}`);
    this.svg.innerHTML = "";

    const floor = document.createElementNS(NS, "polygon");
    floor.setAttribute("class", "editor-floor");
    floor.setAttribute(
      "points",
      room.walls.map((w) => `${fmt(w.start.x)},${fmt(-w.start.z)}`).join(" "),
    );
    this.svg.appendChild(floor);

    for (const wall of room.walls) {
      this.svg.appendChild(
        this.wallLine(wall, selection?.kind === "wall" && selection.id === wall.id),
      );
    }
    for (const opening of room.openings) {
      const wall = room.walls.find((w) => w.id === opening.wallId);
      if (wall === undefined) continue;
      const selected = selection?.kind === "opening" && selection.id === opening.id;
      this.svg.appendChild(this.openingGroup(room, opening, wall, centroid, selected));
    }
    for (const piece of room.existing) {
      const selected = selection?.kind === "piece" && selection.id === piece.id;
      this.svg.appendChild(this.pieceNode(piece, selected));
    }
    this.renderPills(room, selection, [vx, vy, vw, vh]);
  }

  private wallLine(wall: Wall, selected: boolean): SVGElement {
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", fmt(wall.start.x));
    line.setAttribute("y1", fmt(-wall.start.z));
    line.setAttribute("x2", fmt(wall.end.x));
    line.setAttribute("y2", fmt(-wall.end.z));
    line.setAttribute("class", selected ? "editor-wall selected" : "editor-wall");
    const hit = document.createElementNS(NS, "line");
    hit.setAttribute("x1", fmt(wall.start.x));
    hit.setAttribute("y1", fmt(-wall.start.z));
    hit.setAttribute("x2", fmt(wall.end.x));
    hit.setAttribute("y2", fmt(-wall.end.z));
    hit.setAttribute("class", "editor-hit");
    hit.setAttribute("stroke-width", String(HIT_STROKE_CM));
    const group = document.createElementNS(NS, "g");
    group.dataset["wallId"] = wall.id;
    group.appendChild(hit);
    group.appendChild(line);
    return group;
  }

  private openingNodes(
    opening: Opening,
    wall: Wall,
    centroid: Vec,
    selected: boolean,
  ): SVGElement[] {
    const nodes: SVGElement[] = [];
    const d = wallDir(wall);
    const inward = inwardOf(wall, centroid);
    const p0 = along(wall, opening.offset);
    const p1 = along(wall, opening.offset + opening.width);
    const mid = along(wall, opening.offset + opening.width / 2);

    // Gap cut through the wall, then the opening mark.
    const gap = document.createElementNS(NS, "line");
    gap.setAttribute("x1", fmt(p0.x));
    gap.setAttribute("y1", fmt(-p0.z));
    gap.setAttribute("x2", fmt(p1.x));
    gap.setAttribute("y2", fmt(-p1.z));
    gap.setAttribute("class", "editor-gap");
    gap.setAttribute("stroke-width", String(WALL_STROKE_CM + 3));
    nodes.push(gap);

    // Fixed-thickness transparent hit line for drag + touch selection,
    // the same easy grab as the walls' hit lines.
    const hit = document.createElementNS(NS, "line");
    hit.setAttribute("x1", fmt(p0.x));
    hit.setAttribute("y1", fmt(-p0.z));
    hit.setAttribute("x2", fmt(p1.x));
    hit.setAttribute("y2", fmt(-p1.z));
    hit.setAttribute("class", "editor-hit");
    hit.setAttribute("stroke-width", String(HIT_STROKE_CM));
    hit.dataset["openingId"] = opening.id;
    nodes.push(hit);

    if (opening.type === "door") {
      const hingeAt = opening.hinge === "left" ? opening.offset : opening.offset + opening.width;
      const hinge = along(wall, hingeAt);
      const s = opening.hinge === "left" ? 1 : -1;
      const leaf: Vec = { x: s * d.x, z: s * d.z };
      const side = opening.swing === "in" ? inward : { x: -inward.x, z: -inward.z };
      // Leaf ajar at 30 degrees from the wall towards the swing side.
      const rad = (30 * Math.PI) / 180;
      const leafDir: Vec = {
        x: leaf.x * Math.cos(rad) + side.x * Math.sin(rad),
        z: leaf.z * Math.cos(rad) + side.z * Math.sin(rad),
      };
      const leafEnd: Vec = {
        x: hinge.x + leafDir.x * (opening.width - 4),
        z: hinge.z + leafDir.z * (opening.width - 4),
      };
      const leafLine = document.createElementNS(NS, "line");
      leafLine.setAttribute("x1", fmt(hinge.x));
      leafLine.setAttribute("y1", fmt(-hinge.z));
      leafLine.setAttribute("x2", fmt(leafEnd.x));
      leafLine.setAttribute("y2", fmt(-leafEnd.z));
      leafLine.setAttribute("class", selected ? "editor-leaf selected" : "editor-leaf");
      nodes.push(leafLine);
      nodes.push(this.swingArc(hinge, leaf, side, opening.width, selected));
    } else {
      // Window: two thin lines across the gap.
      for (const off of [-2.2, 2.2]) {
        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", fmt(p0.x + inward.x * off));
        line.setAttribute("y1", fmt(-(p0.z + inward.z * off)));
        line.setAttribute("x2", fmt(p1.x + inward.x * off));
        line.setAttribute("y2", fmt(-(p1.z + inward.z * off)));
        line.setAttribute("class", selected ? "editor-window selected" : "editor-window");
        nodes.push(line);
      }
    }

    // Labels always sit on the inward side so they never sit under the
    // outward wall-length pills; the swing arc stays on its own side.
    const labelSide = inward;
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", fmt(mid.x + labelSide.x * 34));
    label.setAttribute("y", fmt(-(mid.z + labelSide.z * 34)));
    label.setAttribute(
      "class",
      selected ? "editor-opening-label selected" : "editor-opening-label",
    );
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("dominant-baseline", "middle");
    label.textContent = `${opening.type === "door" ? "Door" : "Window"} · ${String(Math.round(opening.width))} cm`;
    nodes.push(label);
    return nodes;
  }

  /** Quarter-disc swing arc from the closed leaf to the swing side. */
  private swingArc(
    hinge: Vec,
    leaf: Vec,
    side: Vec,
    radius: number,
    selected: boolean,
  ): SVGPathElement {
    // SVG coords (y down): convert, then sweep the quadrant between leaf and side.
    const lx = leaf.x;
    const ly = -leaf.z;
    const sx = side.x;
    const sy = -side.z;
    const a0 = Math.atan2(ly, lx);
    let a1 = Math.atan2(sy, sx);
    while (a1 - a0 > Math.PI / 2 + 1e-6) a1 -= 2 * Math.PI;
    while (a1 - a0 < -Math.PI / 2 - 1e-6) a1 += 2 * Math.PI;
    const steps = 20;
    let dAttr = "";
    for (let i = 0; i <= steps; i += 1) {
      const a = a0 + ((a1 - a0) * i) / steps;
      const px = hinge.x + Math.cos(a) * radius;
      const py = -hinge.z + Math.sin(a) * radius;
      dAttr += `${i === 0 ? "M" : "L"}${fmt(px)},${fmt(py)}`;
    }
    const arc = document.createElementNS(NS, "path");
    arc.setAttribute("d", dAttr);
    arc.setAttribute("class", selected ? "editor-swing selected" : "editor-swing");
    return arc;
  }

  /** Focusable wrapper for one opening: Enter/Space selects, Delete removes like the Details button. */
  private openingGroup(
    room: RoomLayout,
    opening: Opening,
    wall: Wall,
    centroid: Vec,
    selected: boolean,
  ): SVGElement {
    const group = document.createElementNS(NS, "g");
    group.dataset["openingId"] = opening.id;
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute("aria-label", openingName(room, opening));
    group.setAttribute("class", selected ? "editor-focusable selected" : "editor-focusable");
    for (const node of this.openingNodes(opening, wall, centroid, selected)) {
      group.appendChild(node);
    }
    group.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.actions.select({ kind: "opening", id: opening.id });
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        this.actions.removeOpening(opening.id);
      }
    });
    return group;
  }

  private pieceNode(piece: ExistingPiece, selected: boolean): SVGElement {
    const group = document.createElementNS(NS, "g");
    group.dataset["pieceId"] = piece.id;
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute("aria-label", pieceName(piece));
    group.setAttribute("class", selected ? "editor-focusable selected" : "editor-focusable");
    group.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.actions.select({ kind: "piece", id: piece.id });
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        this.actions.removePiece(piece.id);
      }
    });
    const corners = pieceCorners(piece);
    const poly = document.createElementNS(NS, "polygon");
    poly.setAttribute("points", corners.map((c) => `${fmt(c.x)},${fmt(-c.z)}`).join(" "));
    poly.setAttribute("class", selected ? "editor-piece selected" : "editor-piece");
    group.appendChild(poly);
    const cx = corners.reduce((sum, c) => sum + c.x, 0) / Math.max(1, corners.length);
    const cz = corners.reduce((sum, c) => sum + c.z, 0) / Math.max(1, corners.length);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", fmt(cx));
    label.setAttribute("y", fmt(-cz));
    label.setAttribute("class", "editor-piece-label");
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("dominant-baseline", "middle");
    label.textContent = piece.label;
    group.appendChild(label);
    return group;
  }

  private renderPills(
    room: RoomLayout,
    selection: EditorSelection,
    viewBox: [number, number, number, number],
  ): void {
    const [vx, vy, vw, vh] = viewBox;
    const centroid = centroidOf(room);
    this.pills.innerHTML = "";
    for (const wall of room.walls) {
      if (wallLen(wall) < 1) continue;
      const mid = along(wall, wallLen(wall) / 2);
      // Outward side (centre-based), pills sit outside the wall.
      let ox = mid.x - centroid.x;
      let oz = mid.z - centroid.z;
      const len = Math.hypot(ox, oz) || 1;
      ox /= len;
      oz /= len;
      const anchor = { x: mid.x + ox * 42, z: mid.z + oz * 42 };
      const leftPct = ((anchor.x - vx) / vw) * 100;
      const topPct = ((-anchor.z - vy) / vh) * 100;
      const pill = document.createElement("label");
      pill.className =
        selection?.kind === "wall" && selection.id === wall.id ? "plan-pill selected" : "plan-pill";
      pill.style.left = `${String(leftPct)}%`;
      pill.style.top = `${String(topPct)}%`;
      pill.title = "Wall length in centimetres";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "50";
      input.max = "2000";
      input.step = "5";
      input.value = String(Math.round(wallLen(wall)));
      input.dataset["key"] = `plan-wall-${wall.id}`;
      input.setAttribute("aria-label", `Length of ${wall.id} in centimetres`);
      input.addEventListener("pointerdown", (event) => event.stopPropagation());
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("change", () => {
        this.actions.setWallLength(wall.id, Number(input.value));
      });
      const unit = document.createElement("span");
      unit.textContent = "cm";
      pill.append(input, unit);
      pill.addEventListener("pointerdown", (event) => event.stopPropagation());
      pill.addEventListener("click", (event) => {
        event.stopPropagation();
        this.actions.select({ kind: "wall", id: wall.id });
      });
      this.pills.appendChild(pill);
    }
  }

  private toPlan(event: PointerEvent): Vec | null {
    const ctm = this.svg.getScreenCTM();
    if (ctm === null) return null;
    const inverse = ctm.inverse();
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse);
    return { x: point.x, z: -point.y };
  }

  private openingAt(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    const hit = target.closest("[data-opening-id]");
    const id = hit?.getAttribute("data-opening-id");
    return id ?? null;
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const openingId = this.openingAt(event.target);
    if (openingId === null) return;
    const room = this.store.room;
    const opening = room.openings.find((o) => o.id === openingId);
    const wall = room.walls.find((w) => w.id === opening?.wallId);
    if (opening === undefined || wall === undefined) return;
    const point = this.toPlan(event);
    if (point === null) return;
    const d = wallDir(wall);
    const t = (point.x - wall.start.x) * d.x + (point.z - wall.start.z) * d.z;
    this.drag = { openingId, wallId: wall.id, grabOffset: t - opening.offset };
    this.dragMoved = false;
    this.captured = false;
    this.actions.beginDrag();
    event.preventDefault();
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.drag === null) return;
    if (!this.captured) {
      try {
        this.svg.setPointerCapture(event.pointerId);
      } catch {
        // No pointer capture outside a browser pointer gesture; dragging still works.
      }
      this.captured = true;
    }
    const room = this.store.room;
    const wall = room.walls.find((w) => w.id === this.drag?.wallId);
    const opening = room.openings.find((o) => o.id === this.drag?.openingId);
    if (wall === undefined || opening === undefined) return;
    const point = this.toPlan(event);
    if (point === null) return;
    const d = wallDir(wall);
    const t = (point.x - wall.start.x) * d.x + (point.z - wall.start.z) * d.z;
    const len = wallLen(wall);
    const offset = Math.min(
      Math.max(0, Math.round(t - this.drag.grabOffset)),
      Math.max(0, Math.round(len) - Math.round(opening.width)),
    );
    if (offset !== opening.offset) {
      this.dragMoved = true;
      this.actions.previewOpeningOffset(opening.id, offset);
    }
    event.preventDefault();
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.drag === null) return;
    const { openingId } = this.drag;
    this.drag = null;
    this.captured = false;
    this.actions.endDrag();
    if (this.dragMoved) {
      // Pointer capture retargets the following click at the svg root: eat
      // it so a finished drag never clears the selection.
      this.suppressClick = true;
    } else {
      this.actions.select({ kind: "opening", id: openingId });
    }
    event.preventDefault();
  }

  private onPointerCancel(): void {
    if (this.drag === null) return;
    this.drag = null;
    this.captured = false;
    this.actions.cancelDrag();
  }

  private onBackgroundClick(event: MouseEvent): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-wall-id],[data-opening-id],[data-piece-id]") !== null) {
      const wallHit = target.closest("[data-wall-id]");
      const pieceHit = target.closest("[data-piece-id]");
      const wallId = wallHit?.getAttribute("data-wall-id");
      const pieceId = pieceHit?.getAttribute("data-piece-id");
      // Opening taps are handled on pointer-up (drag vs tap); walls and
      // pieces select on click.
      if (wallId !== null && wallId !== undefined) {
        this.actions.select({ kind: "wall", id: wallId });
      } else if (pieceId !== null && pieceId !== undefined) {
        this.actions.select({ kind: "piece", id: pieceId });
      }
      return;
    }
    this.actions.clearSelection();
  }
}
