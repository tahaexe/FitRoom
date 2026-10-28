/**
 * Photo confirm view ("AI drafts, you confirm"): for a photo-built room the
 * shopper sees what the solver found on each photo and fixes it by dragging.
 *
 * Left: four wall cards (thumbnail, wall name, Active/Done). Centre: the
 * active wall's photo large with round white corner handles, four edge lines,
 * coral opening boxes labelled "Window 120 ± 3 × 140" (measured openings
 * read "Window 120 × 140") and wall-length pills with each wall's source
 * and ± under it ("Wall B · estimated 362 ± 9 cm", plus "· truth 360 cm"
 * in the example). Right: the plan as a compact card (active wall
 * highlighted, measured/estimated legend, amber band under it). "Build my
 * room" stays in the editor foot. Rooms without photos keep today's editor.
 */

import { applyHomography, wallHomography, type RoomLayout } from "@fitroom/shared";
import {
  EXAMPLE_TAPE_A,
  EXAMPLE_TAPE_B,
  exampleBadge,
  exampleMeasuredLine,
  isExampleRoom,
} from "../photo-room/example";
import type { EditorStore, PhotoSession } from "./editor-store";
import { renderFinishesPicker } from "./finishes";
import type { PhotoDraftMeta } from "../photo-room/flow";
import { photoBandText } from "./source-mark";
import { FLOW_STEPS, confirmOpeningLabel, wallChipFound } from "../copy";

export type WallLetter = "A" | "B" | "C" | "D";
export const WALL_ORDER: WallLetter[] = ["A", "B", "C", "D"];

/**
 * Model credit in the confirm plan legend: the corners, floor line, doors
 * and windows came from SAM 3.1 segmentation and the labels from Muse
 * Spark. Same small credit style as the Visualise dialog's model line.
 */
export const PHOTO_MODEL_LINE =
  "Corners, floor line, door and windows found by SAM 3.1 · labels by Muse Spark";
export type CornerId = "m1" | "m2" | "m3" | "m4";
export const CORNER_IDS: CornerId[] = ["m1", "m2", "m3", "m4"];

const CORNER_NAME: Record<CornerId, string> = {
  m1: "top left",
  m2: "top right",
  m3: "bottom left",
  m4: "bottom right",
};

/**
 * The drawn wall outline in solver corner order: `m1` top left, `m2` top
 * right, `m3` bottom left, `m4` bottom right (see `solve.ts`, which builds
 * the corners as ceiling-left, ceiling-right, floor-left, floor-right, and
 * the `wallHomography` table, which maps them to the wall rectangle's
 * top-left, top-right, bottom-left and bottom-right). Top, right, bottom,
 * then left: a simple quadrilateral, never a bowtie.
 */
export const WALL_EDGE_CYCLE: Array<[CornerId, CornerId]> = [
  ["m1", "m2"],
  ["m2", "m4"],
  ["m4", "m3"],
  ["m3", "m1"],
];

/** Focusable corner handle name: "Corner top left of wall B". Pure. */
export function cornerHandleLabel(corner: CornerId, wall: WallLetter): string {
  return `Corner ${CORNER_NAME[corner] ?? corner} of wall ${wall}`;
}

/**
 * Focusable opening box name: starts with the visible tag ("Window 120 ×
 * 140"), then the wall. Pure.
 */
export function openingBoxLabel(
  type: "door" | "window",
  wall: WallLetter,
  widthCm: number,
  heightCm?: number,
  visibleTag?: string,
): string {
  if (visibleTag !== undefined && visibleTag !== "")
    return confirmOpeningLabel(type, wall, visibleTag);
  const kind = type === "door" ? "Door" : "Window";
  if (heightCm === undefined) return `${kind} ${String(Math.round(widthCm))} cm on wall ${wall}`;
  return `${kind} ${String(Math.round(widthCm))} × ${String(Math.round(heightCm))} on wall ${wall}`;
}

/** Opening box text: "Window 120 × 140". Pure. */
export function openingBoxText(type: "door" | "window", widthCm: number, heightCm: number): string {
  const kind = type === "door" ? "Door" : "Window";
  return `${kind} ${String(Math.round(widthCm))} × ${String(Math.round(heightCm))}`;
}

/**
 * Opening box text with its width ±: "Door 100 ± 3 × 210". A measured
 * opening (no width ±) reads exactly like `openingBoxText`. Pure.
 */
export function openingBoxTextWithPm(
  type: "door" | "window",
  widthCm: number,
  heightCm: number,
  widthPm?: number,
): string {
  if (widthPm === undefined) return openingBoxText(type, widthCm, heightCm);
  const kind = type === "door" ? "Door" : "Window";
  return `${kind} ${String(Math.round(widthCm))} ± ${String(Math.round(widthPm))} × ${String(Math.round(heightCm))}`;
}

/**
 * Wall pill text with its source and ±, and in the example the truth beside
 * it: "Wall B · estimated 362 ± 9 cm · truth 360 cm". A measured wall reads
 * "Wall A · measured 420 cm" (plus " · truth 420 cm" in the example). Pure.
 */
export function wallPillText(
  letter: WallLetter,
  lengthCm: number,
  source: "measured" | "estimated",
  plusMinus?: number,
  truthCm?: number,
): string {
  const len = String(Math.round(lengthCm));
  const base =
    source === "estimated" && plusMinus !== undefined
      ? `Wall ${letter} · estimated ${len} ± ${String(Math.round(plusMinus))} cm`
      : `Wall ${letter} · ${source} ${len} cm`;
  if (truthCm === undefined) return base;
  return `${base} · truth ${String(Math.round(truthCm))} cm`;
}

/** The example's true wall length per letter (A/C 420, B/D 360). Pure. */
export function exampleTruthFor(letter: WallLetter): number {
  const tapeA = Number(EXAMPLE_TAPE_A);
  const tapeB = Number(EXAMPLE_TAPE_B);
  return letter === "A" || letter === "C" ? tapeA : tapeB;
}

/**
 * Wall card status: the wall on screen reads Active, a wall the shopper has
 * opened reads Done, and an unopened wall reads To do. Pure.
 */
export function wallCardStatus(active: boolean, seen: boolean): "Active" | "Done" | "To do" {
  if (active) return "Active";
  return seen ? "Done" : "To do";
}

export interface PhotoConfirmActions {
  onSelectWall(wall: WallLetter): void;
  onCornersDrag(
    wall: WallLetter,
    corners: Record<CornerId, [number, number]>,
    phase: "preview" | "commit",
  ): void;
  onOpeningMove(openingId: string, offsetCm: number, phase: "preview" | "commit"): void;
  onOpeningResize(
    openingId: string,
    offsetCm: number,
    widthCm: number,
    phase: "preview" | "commit",
  ): void;
  onOpeningVertical(
    openingId: string,
    sillCm: number,
    heightCm: number,
    phase: "preview" | "commit",
  ): void;
  onSelectOpening(openingId: string): void;
  onCancelDrag(): void;
}

interface ActivePhoto {
  url: string;
  width: number;
  height: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function wallLengthOf(room: RoomLayout, wallId: string): number {
  const wall = room.walls.find((w) => w.id === wallId);
  if (wall === undefined) return 0;
  return Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z);
}

function letterToWallId(letter: WallLetter, session: PhotoSession): string {
  const draft = session.draft as unknown as {
    letterToWallId?: Record<string, string>;
  };
  return draft.letterToWallId?.[letter] ?? `wall-${String(WALL_ORDER.indexOf(letter) + 1)}`;
}

function wallToLetter(wallId: string, session: PhotoSession): WallLetter | null {
  for (const letter of WALL_ORDER) {
    if (letterToWallId(letter, session) === wallId) return letter;
  }
  return null;
}

/**
 * Inverse of a 3x3 row-major homography (null when the quad is degenerate).
 * The wall homography maps photo px to wall cm; its inverse maps wall-cm
 * points back to photo px, with the same perspective divide.
 */
function invertHomography(h: number[]): number[] | null {
  const a = h[0] as number;
  const b = h[1] as number;
  const c = h[2] as number;
  const d = h[3] as number;
  const e = h[4] as number;
  const f = h[5] as number;
  const g = h[6] as number;
  const hh = h[7] as number;
  const i = h[8] as number;
  const A = e * i - f * hh;
  const B = c * hh - b * i;
  const C = b * f - c * e;
  const det = a * A + d * B + g * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    A / det,
    B / det,
    C / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * hh - e * g) / det,
    (b * g - a * hh) / det,
    (a * e - b * d) / det,
  ];
}

export interface WallPhotoMapping {
  /** Wall cm for a photo point (the wall homography itself). */
  toWall(x: number, y: number): [number, number];
  /** Photo point for a wall-cm point (through the inverse homography). */
  toPhoto(uCm: number, vCm: number): [number, number];
  wallLenCm: number;
  ceilCm: number;
}

/**
 * The wall's own homography for the confirm view, built exactly as the
 * solver builds it: the record's corners straight into `wallHomography`.
 */
export function wallPhotoMapping(
  corners: Record<CornerId, [number, number]>,
  wallLenCm: number,
  ceilCm: number,
): WallPhotoMapping | null {
  const h = wallHomography(corners.m1, corners.m2, corners.m3, corners.m4, wallLenCm, ceilCm);
  const inv = invertHomography(h);
  if (inv === null) return null;
  return {
    toWall: (x, y) => applyHomography(h, x, y),
    toPhoto: (uCm, vCm) => applyHomography(inv, uCm, vCm),
    wallLenCm,
    ceilCm,
  };
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

export interface MiniPlanEdgeDatum {
  letter: WallLetter;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  active: boolean;
  lengthCm: number;
  label: string;
  labelX: number;
  labelY: number;
  anchor: "start" | "middle" | "end";
  side: "top" | "right" | "bottom" | "left";
}

export interface MiniPlanOpeningDatum {
  id: string;
  letter: WallLetter;
  kind: "door" | "window";
  gx1: number;
  gy1: number;
  gx2: number;
  gy2: number;
  hx: number;
  hy: number;
  leafX: number;
  leafY: number;
  arcD: string | null;
  arc: boolean;
  windowLines: Array<[number, number, number, number]>;
  selected: boolean;
}

export interface MiniPlanData {
  viewBox: [number, number, number, number];
  edges: MiniPlanEdgeDatum[];
  openings: MiniPlanOpeningDatum[];
  aSide: "top" | "right" | "bottom" | "left";
}

/**
 * The confirm view's small plan as drawing data: the real room at its own
 * wall lengths (A wide, B deep), wall A at the top like the main Plan
 * view, every wall with its length, and doors (leaf + swing arc) drawn
 * apart from windows (double line). Pure, headless-testable.
 */
export function miniPlanData(
  room: RoomLayout,
  session: PhotoSession,
  selectedOpeningId: string | null = null,
): MiniPlanData | null {
  const wallIdOf = (letter: WallLetter): string => letterToWallId(letter, session);
  const lenOf = (letter: WallLetter): number =>
    Math.max(1, Math.round(wallLengthOf(room, wallIdOf(letter))));
  const W = lenOf("A");
  const D = lenOf("B");
  if (!(W > 0) || !(D > 0)) return null;
  const VB_W = 120;
  const VB_H = 96;
  const scale = Math.min((VB_W - 44) / W, (VB_H - 44) / D);
  const rw = W * scale;
  const rh = D * scale;
  const x0 = (VB_W - rw) / 2;
  const y0 = (VB_H - rh) / 2;
  const cx = x0 + rw / 2;
  const cy = y0 + rh / 2;
  // Wall A (entrance door) at the top like the main Plan view, C opposite
  // at the bottom, D (east) right, B (west) left. Each edge runs in its
  // wall's start->end direction so opening offsets map straight on.
  const raw: Array<{
    letter: WallLetter;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    side: "top" | "right" | "bottom" | "left";
  }> = [
    { letter: "A", x1: x0, y1: y0, x2: x0 + rw, y2: y0, side: "top" },
    { letter: "C", x1: x0 + rw, y1: y0 + rh, x2: x0, y2: y0 + rh, side: "bottom" },
    { letter: "D", x1: x0 + rw, y1: y0, x2: x0 + rw, y2: y0 + rh, side: "right" },
    { letter: "B", x1: x0, y1: y0 + rh, x2: x0, y2: y0, side: "left" },
  ];
  const edges: MiniPlanEdgeDatum[] = raw.map((e) => {
    const lengthCm = lenOf(e.letter);
    const label = `${e.letter} · ${String(lengthCm)} cm`;
    const midX = (e.x1 + e.x2) / 2;
    const midY = (e.y1 + e.y2) / 2;
    const labelX = e.side === "right" ? midX + 3 : e.side === "left" ? midX - 3 : midX;
    const labelY = e.side === "top" ? midY - 5 : e.side === "bottom" ? midY + 7 : midY;
    const anchor = e.side === "right" ? "start" : e.side === "left" ? "end" : "middle";
    return {
      letter: e.letter,
      x1: e.x1,
      y1: e.y1,
      x2: e.x2,
      y2: e.y2,
      active: e.letter === session.activeWall,
      lengthCm,
      label,
      labelX,
      labelY,
      anchor,
      side: e.side,
    };
  });
  const openings: MiniPlanOpeningDatum[] = [];
  for (const opening of room.openings) {
    const letter = wallToLetter(opening.wallId, session);
    if (letter === null) continue;
    const edge = raw.find((e) => e.letter === letter);
    if (edge === undefined) continue;
    const wallLen = lenOf(letter);
    const u0 = Math.min(1, Math.max(0, opening.offset / wallLen));
    const u1 = Math.min(1, Math.max(0, (opening.offset + opening.width) / wallLen));
    const gx1 = edge.x1 + (edge.x2 - edge.x1) * u0;
    const gy1 = edge.y1 + (edge.y2 - edge.y1) * u0;
    const gx2 = edge.x1 + (edge.x2 - edge.x1) * u1;
    const gy2 = edge.y1 + (edge.y2 - edge.y1) * u1;
    const base = {
      id: opening.id,
      letter,
      kind: opening.type,
      gx1,
      gy1,
      gx2,
      gy2,
      selected: selectedOpeningId === opening.id,
    } as const;
    if (opening.type !== "door") {
      const ex = edge.x2 - edge.x1;
      const ey = edge.y2 - edge.y1;
      const el = Math.hypot(ex, ey) || 1;
      const px = (-ey / el) * 1.1;
      const py = (ex / el) * 1.1;
      openings.push({
        ...base,
        hx: gx1,
        hy: gy1,
        leafX: gx2,
        leafY: gy2,
        arcD: null,
        arc: false,
        windowLines: [
          [gx1 + px, gy1 + py, gx2 + px, gy2 + py],
          [gx1 - px, gy1 - py, gx2 - px, gy2 - py],
        ],
      });
      continue;
    }
    // Door: hinge at the wall-end side for "left" (room terms), else the
    // wall-start side; leaf ajar 30 degrees toward the room, arc from the
    // closed leaf to the swing side.
    const ex = edge.x2 - edge.x1;
    const ey = edge.y2 - edge.y1;
    const el = Math.hypot(ex, ey) || 1;
    const ux = ex / el;
    const uy = ey / el;
    const atEnd = opening.hinge === "left";
    const hx = atEnd ? gx2 : gx1;
    const hy = atEnd ? gy2 : gy1;
    const s = atEnd ? -1 : 1;
    const r = Math.max(2, Math.hypot(gx2 - gx1, gy2 - gy1));
    let ix = cx - hx;
    let iy = cy - hy;
    const il = Math.hypot(ix, iy) || 1;
    ix /= il;
    iy /= il;
    const rad = (30 * Math.PI) / 180;
    let lx = s * ux * Math.cos(rad) + ix * Math.sin(rad);
    let ly = s * uy * Math.cos(rad) + iy * Math.sin(rad);
    const ll = Math.hypot(lx, ly) || 1;
    lx /= ll;
    ly /= ll;
    const v0x = (s * ux) / (Math.hypot(s * ux, s * uy) || 1);
    const v0y = (s * uy) / (Math.hypot(s * ux, s * uy) || 1);
    const a0 = Math.atan2(v0y, v0x);
    const a1 = Math.atan2(iy, ix);
    let delta = a1 - a0;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const sweep = delta > 0 ? 1 : 0;
    const p0x = hx + v0x * r;
    const p0y = hy + v0y * r;
    const p1x = hx + ix * r;
    const p1y = hy + iy * r;
    openings.push({
      ...base,
      hx,
      hy,
      leafX: hx + lx * r * 0.92,
      leafY: hy + ly * r * 0.92,
      arcD: `M${fmt(p0x)},${fmt(p0y)}A${fmt(r)},${fmt(r)} 0 0 ${String(sweep)} ${fmt(p1x)},${fmt(p1y)}`,
      arc: true,
      windowLines: [],
    });
  }
  const aEdge = raw.find((e) => e.letter === "A");
  const aSide: "top" | "right" | "bottom" | "left" =
    aEdge !== undefined && aEdge.y1 <= cy ? "top" : "bottom";
  return { viewBox: [0, 0, VB_W, VB_H], edges, openings, aSide };
}

export class PhotoConfirmView {
  readonly element: HTMLElement;
  private readonly wallsEl: HTMLElement;
  private readonly stageEl: HTMLElement;
  private readonly planEl: HTMLElement;
  private readonly thumbs = new Map<WallLetter, string>();
  private thumbsKey: string | null = null;
  private thumbsLoading = false;
  private photo: ActivePhoto | null = null;
  private raf = 0;
  private pending: Record<CornerId, [number, number]> | null = null;
  private dragCorner: CornerId | null = null;
  private dragEdge: 0 | 1 | 2 | 3 | null = null;
  private dragOpening: string | null = null;
  private dragHandle: "move" | "left" | "right" | "top" | "bottom" | null = null;
  private dragStartClient: { x: number; y: number } | null = null;
  private grabOffsetCm = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly store: EditorStore,
    private readonly actions: PhotoConfirmActions,
    private readonly loadPhoto: (wall: WallLetter) => Promise<ActivePhoto | null>,
  ) {
    this.element = document.createElement("div");
    this.element.className = "photo-confirm";
    // Same stepper as the photo flow (Confirm is current here), so the
    // three steps read the same on every screen of the flow.
    const steps = document.createElement("ol");
    steps.className = "photo-steps";
    steps.setAttribute("aria-label", "Progress");
    for (const [index, label] of FLOW_STEPS.entries()) {
      const li = document.createElement("li");
      li.className = "photo-step";
      li.dataset["state"] = index < FLOW_STEPS.length - 1 ? "done" : "current";
      li.textContent = index < FLOW_STEPS.length - 1 ? `✓ ${label}` : label;
      steps.appendChild(li);
      if (index < FLOW_STEPS.length - 1) {
        const arrow = document.createElement("li");
        arrow.className = "photo-step-arrow";
        arrow.textContent = "→";
        arrow.setAttribute("aria-hidden", "true");
        steps.appendChild(arrow);
      }
    }
    this.element.appendChild(steps);
    const left = document.createElement("aside");
    left.className = "photo-confirm-walls";
    left.setAttribute("aria-label", "Walls");
    this.wallsEl = document.createElement("div");
    this.wallsEl.className = "photo-confirm-cards";
    left.appendChild(this.wallsEl);
    const centre = document.createElement("section");
    centre.className = "photo-confirm-centre";
    centre.setAttribute("aria-label", "Active wall photo");
    this.stageEl = document.createElement("div");
    this.stageEl.className = "photo-confirm-stage";
    centre.appendChild(this.stageEl);
    const right = document.createElement("aside");
    right.className = "photo-confirm-right";
    right.setAttribute("aria-label", "Room plan");
    this.planEl = document.createElement("div");
    this.planEl.className = "photo-confirm-plan";
    right.appendChild(this.planEl);
    this.element.append(left, centre, right);
    this.unsubscribe = this.store.subscribe(() => this.render());
    this.render();
  }

  destroy(): void {
    this.unsubscribe?.();
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.element.remove();
  }

  private thumbKeyFor(session: PhotoSession): string {
    return session.draft.photos.map((p) => p.wall).join(",");
  }

  /**
   * Thumbnails come from the photo store, which only holds photos once the
   * shopper has taken them — long after this view is built. Reload them
   * for each new photo session; a wall without a stored photo keeps its
   * letter placeholder.
   */
  private refreshThumbs(session: PhotoSession): void {
    const key = this.thumbKeyFor(session);
    if (key === this.thumbsKey || this.thumbsLoading) return;
    this.thumbsLoading = true;
    void this.loadThumbs().then(() => {
      this.thumbsKey = key;
      this.thumbsLoading = false;
      this.render();
    });
  }

  private async loadThumbs(): Promise<void> {
    for (const letter of WALL_ORDER) {
      try {
        const photo = await this.loadPhoto(letter);
        if (photo !== null) this.thumbs.set(letter, photo.url);
      } catch {
        // A missing thumbnail keeps its placeholder; the large photo matters.
      }
    }
  }

  private session(): PhotoSession | null {
    return this.store.photo;
  }

  private activeCorners(): Record<CornerId, [number, number]> | null {
    const session = this.session();
    if (session === null) return null;
    const photo = session.draft.photos.find((p) => p.wall === session.activeWall) as
      { corners: Record<CornerId, [number, number]> } | undefined;
    return photo?.corners ?? null;
  }

  private dragging(): boolean {
    return this.dragCorner !== null || this.dragEdge !== null || this.dragOpening !== null;
  }

  /**
   * True while a corner, edge or opening drag is in progress. The editor's
   * own Esc handler must leave the keypress alone while this is true: Esc
   * then cancels only the drag (see `onEscape` above).
   */
  isDragging(): boolean {
    return this.dragging();
  }

  private render(): void {
    const session = this.session();
    if (session === null) {
      // Between photo rooms the stored photos change with the walls, so
      // the next session reloads its thumbnails from the photo store.
      this.thumbsKey = null;
      return;
    }
    this.refreshThumbs(session);
    this.renderWalls(session);
    // Rebuilding the photo stage mid-drag would drop pointer capture, so the
    // handles follow the pointer directly while the plan and pills update.
    if (!this.dragging()) void this.renderStage(session);
    this.renderPlan(session, this.store.draft);
  }

  private openingsOn(letter: WallLetter): { doors: number; windows: number } {
    const draft = this.session()?.draft as unknown as
      { openings: Array<{ wall: string; type: string }> } | undefined;
    let doors = 0;
    let windows = 0;
    for (const opening of draft?.openings ?? []) {
      if (opening.wall !== letter) continue;
      if (opening.type === "door") doors += 1;
      else if (opening.type === "window") windows += 1;
    }
    return { doors, windows };
  }

  private renderWalls(session: PhotoSession): void {
    this.wallsEl.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = "Walls";
    this.wallsEl.appendChild(title);
    for (const letter of WALL_ORDER) {
      const card = document.createElement("button");
      card.type = "button";
      card.className =
        session.activeWall === letter ? "photo-wall-card selected" : "photo-wall-card";
      const thumb = document.createElement("span");
      thumb.className = "photo-wall-thumb";
      const url = this.thumbs.get(letter);
      if (url !== undefined) {
        thumb.style.backgroundImage = `url("${url}")`;
        thumb.setAttribute("aria-hidden", "true");
      } else {
        thumb.textContent = letter;
      }
      const name = document.createElement("span");
      name.className = "photo-wall-name";
      name.textContent = `Wall ${letter}`;
      const status = document.createElement("span");
      const active = session.activeWall === letter;
      const seen = session.seen.includes(letter);
      // Unviewed walls say what the solver found on them (one tap views
      // it); viewed walls keep Active/Done.
      if (!active && !seen) {
        const { doors, windows } = this.openingsOn(letter);
        const found = wallChipFound(doors, windows);
        status.className = "photo-wall-status todo";
        status.textContent = `Wall ${letter} · ${found}`;
        card.append(thumb, name, status);
        card.setAttribute("aria-label", `Wall ${letter} · ${found}. Select to view it.`);
      } else {
        const state = wallCardStatus(active, seen);
        status.className =
          state === "Active"
            ? "photo-wall-status active"
            : state === "Done"
              ? "photo-wall-status done"
              : "photo-wall-status todo";
        status.textContent = state;
        card.append(thumb, name, status);
        card.setAttribute("aria-label", `Wall ${letter}, ${state.toLowerCase()}`);
      }
      card.addEventListener("click", () => this.actions.onSelectWall(letter));
      this.wallsEl.appendChild(card);
    }
  }

  private async renderStage(session: PhotoSession): Promise<void> {
    const letter = session.activeWall;
    if (this.photo === null || this.stageEl.dataset["wall"] !== letter) {
      try {
        const loaded = await this.loadPhoto(letter);
        if (loaded !== null) this.photo = loaded;
      } catch {
        this.photo = null;
      }
      this.stageEl.dataset["wall"] = letter;
    }
    this.stageEl.innerHTML = "";
    const corners = this.activeCorners();
    if (this.photo === null || corners === null) {
      const missing = document.createElement("p");
      missing.className = "photo-confirm-hint";
      missing.textContent = `Wall ${letter} photo is not available.`;
      this.stageEl.appendChild(missing);
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "photo-stage";
    const img = document.createElement("img");
    img.className = "photo-stage-img";
    img.src = this.photo.url;
    img.alt = isExampleRoom(this.store.room.name)
      ? `Wall ${letter} generated example photo`
      : `Wall ${letter} photo`;
    img.draggable = false;
    wrap.appendChild(img);
    if (isExampleRoom(this.store.room.name)) {
      const badge = document.createElement("span");
      badge.className = "photo-example-badge";
      badge.textContent = exampleBadge(session.activeWall);
      wrap.appendChild(badge);
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "photo-stage-svg");
    svg.setAttribute("viewBox", `0 0 ${String(this.photo.width)} ${String(this.photo.height)}`);
    // One corner order everywhere: the solver's (see WALL_EDGE_CYCLE).
    WALL_EDGE_CYCLE.forEach(([a, b], index) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(corners[a][0]));
      line.setAttribute("y1", String(corners[a][1]));
      line.setAttribute("x2", String(corners[b][0]));
      line.setAttribute("y2", String(corners[b][1]));
      line.setAttribute("class", "photo-edge");
      line.dataset["edge"] = String(index);
      svg.appendChild(line);
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "line");
      hit.setAttribute("x1", String(corners[a][0]));
      hit.setAttribute("y1", String(corners[a][1]));
      hit.setAttribute("x2", String(corners[b][0]));
      hit.setAttribute("y2", String(corners[b][1]));
      hit.setAttribute("class", "photo-edge-hit");
      hit.dataset["edge"] = String(index);
      svg.appendChild(hit);
    });
    wrap.appendChild(svg);
    this.renderHandles(wrap, session, corners);
    this.renderOpeningBoxes(wrap, session, corners);
    const lens = document.createElement("div");
    lens.className = "photo-magnifier";
    lens.setAttribute("hidden", "");
    lens.setAttribute("aria-hidden", "true");
    wrap.appendChild(lens);
    this.stageEl.appendChild(wrap);
    this.attachStagePointer(wrap, lens, session, corners);
    this.renderPills(session, this.store.draft);
  }

  private renderPills(session: PhotoSession, meta: PhotoDraftMeta | null): void {
    const pills = document.createElement("div");
    pills.className = "photo-pills";
    const example = isExampleRoom(this.store.room.name);
    for (const letter of WALL_ORDER) {
      const wallId = letterToWallId(letter, session);
      const len = Math.round(wallLengthOf(this.store.room, wallId));
      const mark = meta?.walls[wallId];
      const source = mark?.source ?? "measured";
      const truth = example ? exampleTruthFor(letter) : undefined;
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = letter === session.activeWall ? "photo-pill selected" : "photo-pill";
      pill.textContent = wallPillText(letter, len, source, mark?.plusMinus, truth);
      pill.setAttribute("aria-label", pill.textContent);
      pill.addEventListener("click", () => this.actions.onSelectWall(letter));
      pills.appendChild(pill);
    }
    this.stageEl.appendChild(pills);
  }

  private renderHandles(
    wrap: HTMLElement,
    session: PhotoSession,
    corners: Record<CornerId, [number, number]>,
  ): void {
    const size = session.sizes[session.activeWall];
    for (const id of CORNER_IDS) {
      const [x, y] = corners[id];
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "photo-handle";
      handle.style.left = `${String((x / size.width) * 100)}%`;
      handle.style.top = `${String((y / size.height) * 100)}%`;
      handle.setAttribute("aria-label", cornerHandleLabel(id, session.activeWall));
      handle.dataset["corner"] = id;
      handle.addEventListener("keydown", (event) => {
        const step = event.shiftKey ? 10 : 1;
        let dx = 0;
        let dy = 0;
        if (event.key === "ArrowLeft") dx = -step;
        else if (event.key === "ArrowRight") dx = step;
        else if (event.key === "ArrowUp") dy = -step;
        else if (event.key === "ArrowDown") dy = step;
        else return;
        event.preventDefault();
        const next = { ...corners, [id]: [x + dx, y + dy] as [number, number] };
        this.actions.onCornersDrag(session.activeWall, next, "commit");
      });
      wrap.appendChild(handle);
    }
  }

  private renderOpeningBoxes(
    wrap: HTMLElement,
    session: PhotoSession,
    corners: Record<CornerId, [number, number]>,
  ): void {
    const draft = session.draft as unknown as {
      openings: Array<{
        id: string;
        wall: string;
        type: "door" | "window";
        offset: { value: number; plusMinus: number; source: string };
        width: { value: number; plusMinus: number; source: string };
        height: { value: number; plusMinus: number; source: string };
        sillHeight: { value: number; plusMinus: number; source: string };
      }>;
      wallLengths: Record<string, { value: number }>;
      ceilingHeight: { value: number };
    };
    // Each box is the opening's wall-cm rectangle mapped through the wall's
    // own homography, so it sits on its opening.
    const mapping = this.mappingFor(session, corners);
    if (mapping === null) return;
    const size = session.sizes[session.activeWall];
    for (const opening of draft.openings) {
      if (opening.wall !== session.activeWall) continue;
      // The plan (`store.room`) is the re-solved truth; the draft copy can
      // lag it after a corner re-solve. Read the box numbers from the room
      // when it knows this opening, so the visible tag always shows the same
      // numbers as the accessible name and the plan.
      const roomOpening = this.store.room.openings.find((o) => o.id === opening.id);
      const kind = roomOpening?.type ?? opening.type;
      const offsetCm = roomOpening?.offset ?? opening.offset.value;
      const widthCm = roomOpening?.width ?? opening.width.value;
      const sillCm = roomOpening?.sillHeight ?? opening.sillHeight.value;
      const heightCm = roomOpening?.height ?? opening.height.value;
      const x0 = clamp(offsetCm, 0, mapping.wallLenCm);
      const x1 = clamp(offsetCm + widthCm, 0, mapping.wallLenCm);
      const y0 = clamp(sillCm, 0, mapping.ceilCm);
      const y1 = clamp(sillCm + heightCm, 0, mapping.ceilCm);
      const quad = [
        mapping.toPhoto(x0, y0),
        mapping.toPhoto(x1, y0),
        mapping.toPhoto(x1, y1),
        mapping.toPhoto(x0, y1),
      ];
      const xs = quad.map(([x]) => x);
      const ys = quad.map(([, y]) => y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const left = (minX / size.width) * 100;
      const top = (minY / size.height) * 100;
      const widthPct = ((maxX - minX) / size.width) * 100;
      const heightPct = ((maxY - minY) / size.height) * 100;
      const box = document.createElement("div");
      box.className = "photo-opening";
      box.style.left = `${String(left)}%`;
      box.style.top = `${String(top)}%`;
      box.style.width = `${String(Math.max(2, widthPct))}%`;
      box.style.height = `${String(Math.max(3, heightPct))}%`;
      box.tabIndex = 0;
      box.setAttribute("role", "button");
      box.dataset["opening"] = opening.id;
      const tag = document.createElement("span");
      tag.className = "photo-opening-tag";
      const widthPm = opening.width.source === "taped" ? undefined : opening.width.plusMinus;
      tag.textContent = openingBoxTextWithPm(kind, widthCm, heightCm, widthPm);
      box.setAttribute(
        "aria-label",
        openingBoxLabel(kind, session.activeWall, widthCm, heightCm, tag.textContent),
      );
      box.appendChild(tag);
      for (const side of ["left", "right", "top", "bottom"] as const) {
        const grip = document.createElement("span");
        grip.className = `photo-grip ${side}`;
        grip.dataset["grip"] = side;
        grip.dataset["opening"] = opening.id;
        box.appendChild(grip);
      }
      box.addEventListener("keydown", (event) => {
        const wallId = letterToWallId(session.activeWall, session);
        const wallLenCm = Math.max(60, Math.round(wallLengthOf(this.store.room, wallId)));
        const pxCm = wallLenCm / Math.max(1, size.width);
        const stepPx = event.shiftKey ? 10 : 1;
        const stepCm = Math.max(1, Math.round(stepPx * pxCm));
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const dir = event.key === "ArrowLeft" ? -1 : 1;
          const next = clamp(offsetCm + dir * stepCm, 0, Math.max(0, wallLenCm - widthCm));
          this.actions.onOpeningMove(opening.id, Math.round(next), "commit");
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.actions.onSelectOpening(opening.id);
        }
      });
      wrap.appendChild(box);
    }
  }

  private toPhoto(
    wrap: HTMLElement,
    clientX: number,
    clientY: number,
  ): { x: number; y: number; rect: DOMRect } | null {
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || this.photo === null) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * this.photo.width,
      y: ((clientY - rect.top) / rect.height) * this.photo.height,
      rect,
    };
  }

  private showLens(
    lens: HTMLElement,
    wrap: HTMLElement,
    clientX: number,
    clientY: number,
    photoX: number,
    photoY: number,
  ): void {
    if (this.photo === null) return;
    const rect = wrap.getBoundingClientRect();
    lens.removeAttribute("hidden");
    lens.style.backgroundImage = `url("${this.photo.url}")`;
    lens.style.backgroundSize = `${String(rect.width * 3)}px ${String(rect.height * 3)}px`;
    const bx = (photoX / this.photo.width) * rect.width * 3 - 60;
    const by = (photoY / this.photo.height) * rect.height * 3 - 60;
    lens.style.backgroundPosition = `-${String(bx)}px -${String(by)}px`;
    // Offset up-left so the finger never covers the magnifier.
    lens.style.left = `${String(clientX - rect.left - 84)}px`;
    lens.style.top = `${String(clientY - rect.top - 148)}px`;
  }

  private hideLens(lens: HTMLElement): void {
    lens.setAttribute("hidden", "");
  }

  private attachStagePointer(
    wrap: HTMLElement,
    lens: HTMLElement,
    session: PhotoSession,
    corners: Record<CornerId, [number, number]>,
  ): void {
    const size = session.sizes[session.activeWall];
    let start: Record<CornerId, [number, number]> | null = null;
    let openingStart: { offset: number; width: number; sill: number; height: number } | null = null;
    let lastClient: { x: number; y: number } | null = null;
    // Fixed for this render: the wall's own homography maps every pointer
    // between photo px and wall cm, like the solver.
    const mapping = this.mappingFor(session, corners);

    const photoFromEvent = (event: PointerEvent): { x: number; y: number } | null => {
      const p = this.toPhoto(wrap, event.clientX, event.clientY);
      return p === null ? null : { x: p.x, y: p.y };
    };

    // Esc cancels the drag wherever focus sits and stops there: the store
    // restores the pre-drag state with no new undo step, and the editor's
    // own Esc handler never runs, so the editor stays open. Capture phase
    // runs before any bubble-phase editor handler on the same keypress.
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        finish(false);
      }
    };

    // Last corners already previewed: a release after the preview flushed
    // still settles the checkpointed drag as its single undo step.
    let sentCorners: Record<CornerId, [number, number]> | null = null;
    const scheduleResolve = (next: Record<CornerId, [number, number]>): void => {
      this.pending = next;
      if (this.raf !== 0) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        const queued = this.pending;
        this.pending = null;
        if (queued !== null) {
          sentCorners = queued;
          this.actions.onCornersDrag(session.activeWall, queued, "preview");
        }
      });
    };

    wrap.addEventListener("pointerdown", (event) => {
      const target = event.target as HTMLElement | null;
      const cornerId = target?.closest?.("[data-corner]")?.getAttribute("data-corner") as
        CornerId | null | undefined;
      const edgeAttr = (event.target as Element | null)?.closest?.("[data-edge]");
      const grip = target?.closest?.("[data-grip]") as HTMLElement | null;
      const box = target?.closest?.("[data-opening]") as HTMLElement | null;
      this.dragStartClient = { x: event.clientX, y: event.clientY };
      if (cornerId !== null && cornerId !== undefined && CORNER_IDS.includes(cornerId)) {
        this.dragCorner = cornerId;
        this.dragEdge = null;
        this.dragOpening = null;
        start = { ...corners };
        document.addEventListener("keydown", onEscape, true);
        try {
          wrap.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is best-effort; dragging still works.
        }
        event.preventDefault();
        return;
      }
      if (grip !== null && box !== null) {
        const openingId = box.dataset["opening"];
        if (openingId === undefined) return;
        this.dragOpening = openingId;
        this.dragHandle = (grip.dataset["grip"] ?? "move") as
          "move" | "left" | "right" | "top" | "bottom";
        this.dragCorner = null;
        this.dragEdge = null;
        openingStart = this.openingNumbers(openingId);
        if (openingStart !== null && mapping !== null) {
          const p = photoFromEvent(event);
          if (p !== null) {
            const [wallX] = mapping.toWall(p.x, p.y);
            this.grabOffsetCm = wallX - openingStart.offset;
          }
        }
        document.addEventListener("keydown", onEscape, true);
        try {
          wrap.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is best-effort; dragging still works.
        }
        event.preventDefault();
        return;
      }
      if (box !== null && grip === null) {
        const openingId = box.dataset["opening"];
        if (openingId === undefined) return;
        this.dragOpening = openingId;
        this.dragHandle = "move";
        this.dragCorner = null;
        this.dragEdge = null;
        openingStart = this.openingNumbers(openingId);
        if (openingStart !== null && mapping !== null) {
          const p = photoFromEvent(event);
          if (p !== null) {
            const [wallX] = mapping.toWall(p.x, p.y);
            this.grabOffsetCm = wallX - openingStart.offset;
          }
        }
        document.addEventListener("keydown", onEscape, true);
        try {
          wrap.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is best-effort; dragging still works.
        }
        event.preventDefault();
        return;
      }
      if (edgeAttr !== null && edgeAttr !== undefined) {
        const index = Number(edgeAttr.getAttribute("data-edge"));
        if (Number.isInteger(index) && index >= 0 && index <= 3) {
          this.dragEdge = index as 0 | 1 | 2 | 3;
          this.dragCorner = null;
          this.dragOpening = null;
          start = { ...corners };
          document.addEventListener("keydown", onEscape, true);
          try {
            wrap.setPointerCapture(event.pointerId);
          } catch {
            // Pointer capture is best-effort; dragging still works.
          }
          event.preventDefault();
        }
      }
    });

    wrap.addEventListener("pointermove", (event) => {
      const p = photoFromEvent(event);
      if (p === null) return;
      lastClient = { x: event.clientX, y: event.clientY };
      if (this.dragCorner === null && this.dragEdge === null && this.dragOpening === null) return;
      this.showLens(lens, wrap, event.clientX, event.clientY, p.x, p.y);
      if (this.dragCorner !== null && start !== null) {
        const next = { ...start };
        next[this.dragCorner] = [
          clamp(p.x, 0, Math.max(1, size.width - 1)),
          clamp(p.y, 0, Math.max(1, size.height - 1)),
        ];
        this.moveHandleDom(wrap, size, this.dragCorner, next[this.dragCorner]);
        scheduleResolve(next);
        event.preventDefault();
        return;
      }
      if (this.dragEdge !== null && start !== null) {
        const next = { ...start };
        // The dragged edge's own corners, in solver order (WALL_EDGE_CYCLE).
        const ids: CornerId[] = [...(WALL_EDGE_CYCLE[this.dragEdge] ?? ["m1", "m2"])];
        const keep = { ...corners };
        const first = ids[0] ?? "m1";
        const second = ids[1] ?? "m2";
        for (const id of ids) {
          const [ox, oy] = keep[id];
          const horiz =
            Math.abs(corners[first][0] - corners[second][0]) >=
            Math.abs(corners[first][1] - corners[second][1]);
          next[id] = horiz
            ? [ox, clamp(p.y, 0, Math.max(1, size.height - 1))]
            : [clamp(p.x, 0, Math.max(1, size.width - 1)), oy];
          const moved = next[id];
          if (moved !== undefined) this.moveHandleDom(wrap, size, id, moved);
        }
        scheduleResolve(next);
        event.preventDefault();
        return;
      }
      if (this.dragOpening !== null && openingStart !== null && mapping !== null) {
        const wallId = letterToWallId(session.activeWall, session);
        const wallLenCm = Math.max(60, Math.round(wallLengthOf(this.store.room, wallId)));
        // Back through the wall homography: photo px to wall cm.
        const [wallX, wallY] = mapping.toWall(p.x, p.y);
        const u = wallX;
        const v = wallY / mapping.ceilCm;
        const ceil = mapping.ceilCm;
        this.shiftBoxDom(wrap, this.dragOpening, event);
        if (this.dragHandle === "move" || this.dragHandle === null) {
          const next = clamp(u - this.grabOffsetCm, 0, Math.max(0, wallLenCm - openingStart.width));
          this.actions.onOpeningMove(this.dragOpening, Math.round(next), "preview");
        } else if (this.dragHandle === "left" || this.dragHandle === "right") {
          const span = this.spanFromPointer(openingStart, u, wallLenCm, this.dragHandle);
          this.actions.onOpeningResize(this.dragOpening, span.offset, span.width, "preview");
        } else {
          const vert = this.verticalFromPointer(openingStart, v, ceil, this.dragHandle);
          this.actions.onOpeningVertical(this.dragOpening, vert.sill, vert.height, "preview");
        }
        event.preventDefault();
      }
    });

    const finish = (commit: boolean): void => {
      if (!this.dragging()) return;
      this.hideLens(lens);
      document.removeEventListener("keydown", onEscape, true);
      if (this.raf !== 0) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
      const queued = this.pending;
      this.pending = null;
      if (!commit) {
        // Cancelled (pointercancel, lost capture, Esc): the store restores
        // the pre-drag state and the cancelled drag adds no undo step.
        this.actions.onCancelDrag();
      } else if (this.dragCorner !== null || this.dragEdge !== null) {
        const target = queued ?? sentCorners;
        if (target !== null) {
          this.actions.onCornersDrag(session.activeWall, target, "commit");
        }
      } else if (this.dragOpening !== null && openingStart !== null && mapping !== null) {
        if (lastClient !== null) {
          const p = this.toPhoto(wrap, lastClient.x, lastClient.y);
          if (p !== null) {
            const wallId = letterToWallId(session.activeWall, session);
            const wallLenCm = Math.max(60, Math.round(wallLengthOf(this.store.room, wallId)));
            // Back through the wall homography: photo px to wall cm.
            const [wallX, wallY] = mapping.toWall(p.x, p.y);
            const u = wallX;
            const v = wallY / mapping.ceilCm;
            const ceil = mapping.ceilCm;
            if (this.dragHandle === "move" || this.dragHandle === null) {
              const next = clamp(
                u - this.grabOffsetCm,
                0,
                Math.max(0, wallLenCm - openingStart.width),
              );
              this.actions.onOpeningMove(this.dragOpening, Math.round(next), "commit");
            } else if (this.dragHandle === "left" || this.dragHandle === "right") {
              const span = this.spanFromPointer(openingStart, u, wallLenCm, this.dragHandle);
              this.actions.onOpeningResize(this.dragOpening, span.offset, span.width, "commit");
            } else {
              const vert = this.verticalFromPointer(openingStart, v, ceil, this.dragHandle);
              this.actions.onOpeningVertical(this.dragOpening, vert.sill, vert.height, "commit");
            }
          }
        }
      }
      this.dragCorner = null;
      this.dragEdge = null;
      this.dragOpening = null;
      this.dragHandle = null;
      start = null;
      openingStart = null;
      lastClient = null;
      sentCorners = null;
      this.dragStartClient = null;
      // A commit dispatches while the drag flags are still set, so the store
      // subscription's render skips the stage (to protect pointer capture).
      // Rebuild here, with the flags cleared, so every opening's visible box
      // label follows the re-solve like its accessible name and the plan.
      this.render();
    };

    wrap.addEventListener("pointerup", () => finish(true));
    wrap.addEventListener("pointercancel", () => finish(false));
    // A lost capture outside pointerup (the browser took it back) cancels.
    wrap.addEventListener("lostpointercapture", () => finish(false));
  }

  private moveHandleDom(
    wrap: HTMLElement,
    size: { width: number; height: number },
    id: CornerId,
    point: [number, number],
  ): void {
    const handle = wrap.querySelector(`[data-corner="${id}"]`);
    if (handle instanceof HTMLElement) {
      handle.style.left = `${String((point[0] / size.width) * 100)}%`;
      handle.style.top = `${String((point[1] / size.height) * 100)}%`;
    }
  }

  private shiftBoxDom(wrap: HTMLElement, openingId: string, event: PointerEvent): void {
    if (this.dragStartClient === null) return;
    const box = wrap.querySelector(`[data-opening="${openingId}"]`);
    if (!(box instanceof HTMLElement)) return;
    const dx = event.clientX - this.dragStartClient.x;
    const dy = event.clientY - this.dragStartClient.y;
    if (this.dragHandle === "left" || this.dragHandle === "right") {
      box.style.transform = `translateX(${String(dx)}px)`;
    } else if (this.dragHandle === "top" || this.dragHandle === "bottom") {
      box.style.transform = `translateY(${String(dy)}px)`;
    } else {
      box.style.transform = `translate(${String(dx)}px, ${String(dy)}px)`;
    }
  }

  private openingNumbers(openingId: string): {
    offset: number;
    width: number;
    sill: number;
    height: number;
  } | null {
    const opening = this.store.room.openings.find((o) => o.id === openingId);
    if (opening === undefined) return null;
    return {
      offset: opening.offset,
      width: opening.width,
      sill: opening.sillHeight,
      height: opening.height,
    };
  }

  /**
   * The active wall's photo<->wall-cm mapping from the solver's own
   * homography inputs (the draft's wall length and ceiling height).
   */
  private mappingFor(
    session: PhotoSession,
    corners: Record<CornerId, [number, number]>,
  ): WallPhotoMapping | null {
    const draft = session.draft as unknown as {
      wallLengths?: Record<string, { value: number }>;
      ceilingHeight?: { value: number };
    };
    const wallLen = draft.wallLengths?.[session.activeWall]?.value;
    const ceil = draft.ceilingHeight?.value;
    if (wallLen === undefined || ceil === undefined || !(wallLen > 0) || !(ceil > 0)) {
      return null;
    }
    return wallPhotoMapping(corners, wallLen, Math.max(200, ceil));
  }

  private spanFromPointer(
    start: { offset: number; width: number },
    uCm: number,
    wallLenCm: number,
    side: "left" | "right",
  ): { offset: number; width: number } {
    if (side === "right") {
      const width = clamp(Math.round(uCm - start.offset), 30, wallLenCm - start.offset);
      return { offset: Math.round(start.offset), width };
    }
    const offset = clamp(
      Math.round(Math.min(uCm, start.offset + start.width - 30)),
      0,
      wallLenCm - 30,
    );
    const width = clamp(Math.round(start.offset + start.width - offset), 30, wallLenCm - offset);
    return { offset, width };
  }

  private verticalFromPointer(
    start: { sill: number; height: number },
    vFrac: number,
    ceilCm: number,
    side: "top" | "bottom",
  ): { sill: number; height: number } {
    const posCm = clamp(Math.round(vFrac * ceilCm), 0, ceilCm);
    if (side === "top") {
      const height = clamp(posCm - start.sill, 10, ceilCm - start.sill);
      return { sill: Math.round(start.sill), height };
    }
    const sill = clamp(Math.min(posCm, start.sill + start.height - 10), 0, ceilCm - 10);
    const height = clamp(start.sill + start.height - sill, 10, ceilCm - sill);
    return { sill, height };
  }

  /**
   * The confirmed plan's drawing data: the real room at its own wall
   * lengths (A wide, B deep), wall A at the top like the main Plan view,
   * every wall with its length, and doors (leaf + swing arc) drawn apart
   * from windows (double line). Pure data, headless-testable.
   */
  private renderPlan(session: PhotoSession, meta: PhotoDraftMeta | null): void {
    this.planEl.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = "Plan";
    this.planEl.appendChild(title);
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    const selectedOpeningId =
      this.store.selection?.kind === "opening" ? this.store.selection.id : null;
    const data = miniPlanData(this.store.room, session, selectedOpeningId);
    if (data === null) return;
    svg.setAttribute(
      "viewBox",
      `${fmt(data.viewBox[0])} ${fmt(data.viewBox[1])} ${fmt(data.viewBox[2])} ${fmt(data.viewBox[3])}`,
    );
    svg.setAttribute("class", "photo-mini-room");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Room plan with the active wall highlighted");
    for (const edge of data.edges) {
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", fmt(edge.x1));
      line.setAttribute("y1", fmt(edge.y1));
      line.setAttribute("x2", fmt(edge.x2));
      line.setAttribute("y2", fmt(edge.y2));
      const active = edge.letter === session.activeWall;
      line.setAttribute("stroke", active ? "#f54e49" : "#2b2c30");
      line.setAttribute("stroke-width", active ? "3" : "1.8");
      line.setAttribute("stroke-linecap", "round");
      svg.appendChild(line);
    }
    for (const opening of data.openings) {
      const gap = document.createElementNS(svgNS, "line");
      gap.setAttribute("x1", fmt(opening.gx1));
      gap.setAttribute("y1", fmt(opening.gy1));
      gap.setAttribute("x2", fmt(opening.gx2));
      gap.setAttribute("y2", fmt(opening.gy2));
      gap.setAttribute("stroke", "#ffffff");
      gap.setAttribute("stroke-width", "4");
      gap.setAttribute("stroke-linecap", "round");
      svg.appendChild(gap);
      if (opening.kind === "door") {
        const leaf = document.createElementNS(svgNS, "line");
        leaf.setAttribute("x1", fmt(opening.hx));
        leaf.setAttribute("y1", fmt(opening.hy));
        leaf.setAttribute("x2", fmt(opening.leafX));
        leaf.setAttribute("y2", fmt(opening.leafY));
        leaf.setAttribute("stroke", opening.selected ? "#f54e49" : "#b3261e");
        leaf.setAttribute("stroke-width", opening.selected ? "2" : "1.4");
        leaf.setAttribute("stroke-linecap", "round");
        svg.appendChild(leaf);
        if (opening.arcD !== null) {
          const arc = document.createElementNS(svgNS, "path");
          arc.setAttribute("d", opening.arcD);
          arc.setAttribute("fill", "none");
          arc.setAttribute("stroke", opening.selected ? "#f54e49" : "#b3261e");
          arc.setAttribute("stroke-width", opening.selected ? "2" : "1.4");
          svg.appendChild(arc);
        }
      } else {
        for (const [ox1, oy1, ox2, oy2] of opening.windowLines) {
          const line = document.createElementNS(svgNS, "line");
          line.setAttribute("x1", fmt(ox1));
          line.setAttribute("y1", fmt(oy1));
          line.setAttribute("x2", fmt(ox2));
          line.setAttribute("y2", fmt(oy2));
          line.setAttribute("stroke", opening.selected ? "#f54e49" : "#2b2c30");
          line.setAttribute("stroke-width", opening.selected ? "1.8" : "1.1");
          line.setAttribute("stroke-linecap", "round");
          svg.appendChild(line);
        }
      }
    }
    for (const edge of data.edges) {
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", fmt(edge.labelX));
      label.setAttribute("y", fmt(edge.labelY));
      label.setAttribute("text-anchor", edge.anchor);
      label.setAttribute("dominant-baseline", "middle");
      label.setAttribute("font-size", "5.5");
      label.setAttribute("font-weight", "700");
      label.setAttribute("fill", "#2b2c30");
      label.textContent = edge.label;
      svg.appendChild(label);
    }
    this.planEl.appendChild(svg);
    const legend = document.createElement("div");
    legend.className = "photo-legend";
    const measured = document.createElement("span");
    measured.className = "source-mark";
    measured.dataset["source"] = "measured";
    measured.textContent = "Measured: typed by you";
    const estimated = document.createElement("span");
    estimated.className = "source-mark";
    estimated.dataset["source"] = "estimated";
    estimated.textContent = "Estimated: from the photos";
    legend.append(measured, estimated);
    this.planEl.appendChild(legend);
    const models = document.createElement("p");
    models.className = "photo-model-line render-model";
    models.textContent = PHOTO_MODEL_LINE;
    this.planEl.appendChild(models);
    if (isExampleRoom(this.store.room.name)) {
      const truth = document.createElement("p");
      truth.className = "photo-example-note";
      const wallA = letterToWallId("A", session);
      const wallB = letterToWallId("B", session);
      truth.textContent = exampleMeasuredLine(
        wallLengthOf(this.store.room, wallA),
        wallLengthOf(this.store.room, wallB),
      );
      this.planEl.appendChild(truth);
    }
    if (meta !== null && meta.estimatedWallCount > 0) {
      const band = document.createElement("div");
      band.className = "photo-draft-band";
      const text = document.createElement("span");
      text.textContent = photoBandText(meta.estimatedWallCount, meta.estimatedWallPm);
      band.appendChild(text);
      this.planEl.appendChild(band);
    }
    renderFinishesPicker(this.store, this.planEl);
  }
}
