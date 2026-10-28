import * as THREE from "three";
import type { RoomLayout } from "@fitroom/shared";
import { cmToMeters, planWallLabel } from "@fitroom/shared";
import { pointAlongWall } from "./room";

/** Shopper-words opening label, e.g. "Door · 90 cm" or "Window · 120 cm". */
export function openingLabel(type: string, widthCm: number): string {
  const kind = type === "door" ? "Door" : "Window";
  return `${kind} · ${Math.round(widthCm)} cm`;
}

/**
 * Screen side of a wall in the main Plan view. The plan camera sits above
 * the room centre looking down with up `-z` (screen up is world `-z`) and
 * screen right world `+x`, so a south wall (world `-z` of centre) reads at
 * the top. Pure plan maths, headless-testable.
 */
export function planWallSide(
  room: RoomLayout,
  wallId: string,
): "top" | "right" | "bottom" | "left" | null {
  let cx = 0;
  let cz = 0;
  for (const wall of room.walls) {
    cx += (wall.start.x + wall.end.x) / 2;
    cz += (wall.start.z + wall.end.z) / 2;
  }
  cx /= Math.max(1, room.walls.length);
  cz /= Math.max(1, room.walls.length);
  const wall = room.walls.find((w) => w.id === wallId);
  if (wall === undefined) return null;
  const dx = (wall.start.x + wall.end.x) / 2 - cx;
  const dz = (wall.start.z + wall.end.z) / 2 - cz;
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? "right" : "left";
  return dz < 0 ? "top" : "bottom";
}

/**
 * Top plan overlay: SVG labels in shopper words (±1cm rounding). Wall
 * lengths in cm sit OUTSIDE their wall ("Door wall · 420 cm"); opening
 * labels ("Door · 90 cm", "Window · 120 cm") sit INSIDE the room beside
 * their opening — never ids like `door-1`. A screen-space declutter pass
 * pushes overlapping labels apart, then every label is clamped inside the
 * visible view so none hides under an open side panel or past the edge.
 */
export class PlanOverlay {
  readonly svg: SVGSVGElement;
  private wallTexts: SVGTextElement[] = [];
  private openingTexts: SVGTextElement[] = [];
  private openingChips: SVGRectElement[] = [];

  constructor(parent: HTMLElement, room: RoomLayout) {
    const NS = "http://www.w3.org/2000/svg";
    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("class", "plan-overlay");
    parent.appendChild(this.svg);
    for (const wall of room.walls) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("class", "plan-wall-label");
      t.textContent = planWallLabel(room, wall.id);
      this.svg.appendChild(t);
      this.wallTexts.push(t);
    }
    for (const o of room.openings) {
      const chip = document.createElementNS(NS, "rect");
      chip.setAttribute("class", "plan-opening-chip");
      this.svg.appendChild(chip);
      this.openingChips.push(chip);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("class", "plan-opening-label");
      // The label's y marks the chip's vertical centre while SVG text
      // draws from its baseline: shift down ~0.35em so cap-height text
      // sits centred in the chip instead of on its top edge.
      t.setAttribute("dy", "0.35em");
      t.textContent = openingLabel(o.type, o.width);
      this.svg.appendChild(t);
      this.openingTexts.push(t);
    }
  }

  setVisible(v: boolean): void {
    this.svg.style.display = v ? "block" : "none";
  }

  update(camera: THREE.Camera, room: RoomLayout, width: number, height: number): void {
    this.svg.setAttribute("width", String(width));
    this.svg.setAttribute("height", String(height));
    const v = new THREE.Vector3();
    const project = (xM: number, yM: number, zM: number): { x: number; y: number } => {
      v.set(xM, yM, zM).project(camera);
      return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
    };

    // Room centre for outward/inward sides (robust for any winding).
    let cx = 0;
    let cz = 0;
    for (const wall of room.walls) {
      cx += (wall.start.x + wall.end.x) / 2;
      cz += (wall.start.z + wall.end.z) / 2;
    }
    cx /= Math.max(1, room.walls.length);
    cz /= Math.max(1, room.walls.length);

    const WALL_OUT_CM = 30;
    const OPENING_IN_CM = 15;
    const spots: Array<{ el: SVGTextElement; x: number; y: number }> = [];

    room.walls.forEach((wall, i) => {
      const el = this.wallTexts[i];
      if (el === undefined) return;
      const mx = (wall.start.x + wall.end.x) / 2;
      const mz = (wall.start.z + wall.end.z) / 2;
      const outward = this.outwardOf(mx, mz, cx, cz);
      // East/west walls: anchor the text edge at the wall so the label
      // extends outward and can never straddle the wall line.
      const anchor =
        Math.abs(outward.x) >= Math.abs(outward.z) ? (outward.x > 0 ? "start" : "end") : "middle";
      el.setAttribute("text-anchor", anchor);
      const p = project(
        cmToMeters(mx + outward.x * WALL_OUT_CM),
        0.05,
        cmToMeters(mz + outward.z * WALL_OUT_CM),
      );
      spots.push({ el, x: p.x, y: p.y });
    });
    room.openings.forEach((o, i) => {
      const el = this.openingTexts[i];
      if (el === undefined) return;
      const wall = room.walls.find((w) => w.id === o.wallId);
      if (wall === undefined) return;
      const p0 = pointAlongWall(wall, o.offset + o.width / 2);
      const mx = (wall.start.x + wall.end.x) / 2;
      const mz = (wall.start.z + wall.end.z) / 2;
      const outward = this.outwardOf(mx, mz, cx, cz);
      // Mirror of the walls: opening labels extend inward from their anchor.
      const anchor =
        Math.abs(outward.x) >= Math.abs(outward.z) ? (outward.x > 0 ? "end" : "start") : "middle";
      el.setAttribute("text-anchor", anchor);
      const p = project(
        cmToMeters(p0.x - outward.x * OPENING_IN_CM),
        0.05,
        cmToMeters(p0.z - outward.z * OPENING_IN_CM),
      );
      spots.push({ el, x: p.x, y: p.y });
    });

    // Screen-space declutter: no label box may overlap another.
    this.separate(spots);
    // Keep every label inside the visible view: a label pushed past the
    // edge (or under an open side panel) is clamped back so it stays readable.
    this.clampIntoView(spots, width, height);
    // Light chips behind the opening labels: dark text on the chip reads at
    // well over 4.5:1 whatever floor lies under it (no outline halo).
    const chipBoxes = new Map<SVGTextElement, { w: number; h: number }>();
    room.openings.forEach((_unused, i) => {
      const el = this.openingTexts[i];
      const chip = this.openingChips[i];
      if (el === undefined || chip === undefined) return;
      const spot = spots.find((s) => s.el === el);
      if (spot === undefined) return;
      const box = this.labelBox(spot, chipBoxes);
      const padX = 6;
      const padY = 3;
      chip.setAttribute("x", (box.x0 - padX).toFixed(1));
      chip.setAttribute("y", (box.y0 - padY).toFixed(1));
      chip.setAttribute("width", (box.x1 - box.x0 + padX * 2).toFixed(1));
      chip.setAttribute("height", (box.y1 - box.y0 + padY * 2).toFixed(1));
      chip.setAttribute("rx", "7");
    });
    for (const s of spots) {
      // Never write NaN coordinates: a failed projection keeps its last good
      // spot instead of logging an SVG attribute error.
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      s.el.setAttribute("x", s.x.toFixed(1));
      s.el.setAttribute("y", s.y.toFixed(1));
    }
  }

  private labelBox(
    s: { el: SVGTextElement; x: number; y: number },
    boxes: Map<SVGTextElement, { w: number; h: number }>,
  ): { x0: number; y0: number; x1: number; y1: number } {
    let size = boxes.get(s.el);
    if (size === undefined) {
      let w: number;
      try {
        w = s.el.getComputedTextLength();
      } catch {
        w = Number.NaN;
      }
      if (!(w > 0)) w = (s.el.textContent?.length ?? 8) * 8;
      size = { w, h: 16 };
      boxes.set(s.el, size);
    }
    // Respect the per-label text anchor (east/west walls anchor an edge).
    const anchor = s.el.getAttribute("text-anchor") ?? "middle";
    const x0 = anchor === "start" ? s.x : anchor === "end" ? s.x - size.w : s.x - size.w / 2;
    return { x0, y0: s.y - size.h / 2, x1: x0 + size.w, y1: s.y + size.h / 2 };
  }

  /** Centre-based outward side of a wall midpoint (robust for any winding). */
  private outwardOf(mx: number, mz: number, cx: number, cz: number): { x: number; z: number } {
    let ox = mx - cx;
    let oz = mz - cz;
    const len = Math.hypot(ox, oz) || 1;
    ox /= len;
    oz /= len;
    return { x: ox, z: oz };
  }

  /** Clamp every label box inside the view (with a small margin). */
  private clampIntoView(
    spots: Array<{ el: SVGTextElement; x: number; y: number }>,
    width: number,
    height: number,
  ): void {
    const MARGIN = 6;
    for (const s of spots) {
      let w: number;
      try {
        w = s.el.getComputedTextLength();
      } catch {
        w = Number.NaN;
      }
      if (!(w > 0)) w = (s.el.textContent?.length ?? 8) * 8;
      const anchor = s.el.getAttribute("text-anchor") ?? "middle";
      // The anchor edge stays fixed; only the free extent is clamped.
      if (anchor === "start") {
        s.x = Math.min(Math.max(s.x, MARGIN), Math.max(MARGIN, width - w - MARGIN));
      } else if (anchor === "end") {
        s.x = Math.min(Math.max(s.x, w + MARGIN), Math.max(w + MARGIN, width - MARGIN));
      } else {
        s.x = Math.min(
          Math.max(s.x, w / 2 + MARGIN),
          Math.max(w / 2 + MARGIN, width - w / 2 - MARGIN),
        );
      }
      s.y = Math.min(Math.max(s.y, 14 + MARGIN), Math.max(14 + MARGIN, height - MARGIN));
    }
  }

  /** Iterative repulsion until no two label boxes overlap (or it converges). */
  private separate(spots: Array<{ el: SVGTextElement; x: number; y: number }>): void {
    const boxes = new Map<SVGTextElement, { w: number; h: number }>();
    const GAP = 5;
    for (let round = 0; round < 80; round += 1) {
      let moved = false;
      for (let i = 0; i < spots.length; i += 1) {
        for (let j = i + 1; j < spots.length; j += 1) {
          const a = spots[i];
          const b = spots[j];
          if (a === undefined || b === undefined) continue;
          const ba = this.labelBox(a, boxes);
          const bb = this.labelBox(b, boxes);
          const overlapX = Math.min(ba.x1, bb.x1) - Math.max(ba.x0, bb.x0) + GAP;
          const overlapY = Math.min(ba.y1, bb.y1) - Math.max(ba.y0, bb.y0) + GAP;
          if (overlapX <= 0 || overlapY <= 0) continue;
          moved = true;
          if (overlapX < overlapY) {
            const dir = a.x <= b.x ? -1 : 1;
            a.x += (dir * overlapX) / 2;
            b.x -= (dir * overlapX) / 2;
          } else {
            const dir = a.y <= b.y ? -1 : 1;
            a.y += (dir * overlapY) / 2;
            b.y -= (dir * overlapY) / 2;
          }
        }
      }
      if (!moved) return;
    }
  }
}
