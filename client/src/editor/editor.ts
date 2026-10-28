/**
 * The 2D plan editor screen: wall cards left, plan hero centre, selected
 * item fields right, add/undo pills on top and the coral build button.
 *
 * Every typed value is measured (see `source-mark`); every edit commits one
 * undo step and the 3D room follows committed edits at once.
 */

import type { DoorOpening, ExistingPiece, Opening, RoomLayout } from "@fitroom/shared";
import {
  LETTER_TO_WALL_ID,
  setRectangleWallLength,
  validateRoomLayout,
  WALL_ID_TO_LETTER,
  wallDisplayName,
  type WallLetter,
} from "@fitroom/shared";
import { EditorPlanView } from "./plan-view";
import { BUILD_MY_ROOM, LEAVE } from "../copy";
import { renderFinishesPicker } from "./finishes";
import { photoBandText, sourceMark, tapeWallLabel } from "./source-mark";
import { EditorStore, type PhotoSession } from "./editor-store";
import { draftMeta, type PhotoDraftMeta, type WallSourceMark } from "../photo-room/flow";
import { PhotoConfirmView, type WallLetter as ConfirmWallLetter } from "./photo-confirm";
import { loadPhoto } from "../photo-room/photo-store";
import { resolveRoomFromCorners } from "@fitroom/shared";

export interface RoomEditorCallbacks {
  onBuild: () => void;
  onCancel: () => void;
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
  private readonly cancelBtn: HTMLButtonElement;
  private readonly buildBtn: HTMLButtonElement;
  private readonly noteEl: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private readonly bandEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private readonly gridEl: HTMLElement;
  private readonly confirmHost: HTMLElement;
  private confirmView: PhotoConfirmView | null = null;
  private confirmCheckpointed = false;
  private draft: PhotoDraftMeta | null = null;
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

    this.bandEl = document.createElement("div");
    this.bandEl.className = "photo-draft-band";
    this.bandEl.setAttribute("hidden", "");

    // Scrolling body: everything above the foot scrolls, while the foot
    // ("Build my room") stays pinned at the bottom of the editor, always in
    // view without scrolling.
    const scroll = document.createElement("div");
    scroll.className = "editor-scroll";
    scroll.appendChild(this.bandEl);

    const actions = document.createElement("div");
    actions.className = "editor-actions";
    const addDoor = this.pill("Add door", () => this.addOpening("door"));
    const addWindow = this.pill("Add window", () => this.addOpening("window"));
    const addPiece = this.pill("Add my own piece", () => this.addPiece());
    this.undoBtn = this.pill("Undo", () => this.store.undo());
    this.cancelBtn = this.pill(LEAVE, () => this.callbacks.onCancel());
    actions.append(addDoor, addWindow, addPiece, this.undoBtn, this.cancelBtn);
    this.actionsEl = actions;
    scroll.appendChild(actions);

    const grid = document.createElement("div");
    grid.className = "editor-grid";
    this.gridEl = grid;

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
    scroll.appendChild(grid);

    // The confirm view's step bar reads first: its host sits before the
    // estimate banner and the action row, so the view's first row is the
    // step bar with Leave. Hidden while the plain plan editor is open.
    this.confirmHost = document.createElement("div");
    this.confirmHost.className = "photo-confirm-host";
    this.confirmHost.setAttribute("hidden", "");
    scroll.insertBefore(this.confirmHost, scroll.firstChild);
    this.element.appendChild(scroll);
    this.confirmView = new PhotoConfirmView(
      this.store,
      {
        onLeave: () => this.callbacks.onCancel(),
        onSelectWall: (wall) => this.selectPhotoWall(wall),
        onCornersDrag: (wall, corners, phase) => this.dragPhotoCorners(wall, corners, phase),
        onOpeningMove: (openingId, offsetCm, phase) =>
          this.dragPhotoOpening(openingId, { offset: offsetCm }, phase),
        onOpeningResize: (openingId, offsetCm, widthCm, phase) =>
          this.dragPhotoOpening(openingId, { offset: offsetCm, width: widthCm }, phase),
        onOpeningVertical: (openingId, sillCm, heightCm, phase) =>
          this.dragPhotoOpening(openingId, { sillHeight: sillCm, height: heightCm }, phase),
        onSelectOpening: (openingId) => this.store.select({ kind: "opening", id: openingId }),
        onCancelDrag: () => this.cancelPhotoDrag(),
      },
      async (wall) => {
        try {
          const stored = await loadPhoto(wall as "A" | "B" | "C" | "D");
          const rec = stored as unknown as {
            labelUrl?: string;
            url?: string;
            segWidth?: number;
            segHeight?: number;
            width?: number;
            height?: number;
          } | null;
          if (rec === null || rec === undefined) return null;
          const url = rec.labelUrl ?? rec.url ?? "";
          if (url === "") return null;
          return {
            url,
            width: rec.segWidth ?? rec.width ?? 1280,
            height: rec.segHeight ?? rec.height ?? 960,
          };
        } catch {
          return null;
        }
      },
    );
    this.confirmHost.appendChild(this.confirmView.element);

    const foot = document.createElement("div");
    foot.className = "editor-foot";
    this.noteEl = document.createElement("p");
    this.noteEl.className = "editor-note";
    this.buildBtn = document.createElement("button");
    this.buildBtn.type = "button";
    this.buildBtn.className = "editor-build";
    this.buildBtn.textContent = BUILD_MY_ROOM;
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
    // Undo restores the room and its marks together: follow the store.
    this.unsubscribe = this.store.subscribe(() => {
      this.draft = this.store.draft;
      this.renderPanels();
    });
    this.renderPanels();
  }

  destroy(): void {
    this.unsubscribe?.();
    this.plan?.destroy();
    this.confirmView?.destroy();
    this.element.remove();
  }

  /** Photo draft sources: every value renders its measured/estimated mark. */
  setPhotoDraft(draft: PhotoDraftMeta | null): void {
    this.draft = draft;
    this.store.setDraft(draft);
    this.renderPanels();
  }

  /** Active wall switching marks the wall seen; view state only, no undo step. */
  private selectPhotoWall(wall: ConfirmWallLetter): void {
    const session = this.store.photo;
    if (session === null) return;
    const next: PhotoSession = JSON.parse(JSON.stringify(session)) as PhotoSession;
    next.activeWall = wall as PhotoSession["activeWall"];
    if (!next.seen.includes(next.activeWall)) next.seen = [...next.seen, next.activeWall];
    this.store.setPhoto(next);
  }

  private estimatedFromMeta(meta: PhotoDraftMeta | null): Partial<Record<string, number>> {
    const estimated: Partial<Record<string, number>> = {};
    if (meta === null) return estimated;
    for (const [wallId, mark] of Object.entries(meta.walls)) {
      if (mark.source === "estimated") {
        const letter = WALL_ID_TO_LETTER[wallId] as string | undefined;
        if (letter !== undefined) estimated[letter] = mark.plusMinus ?? 8;
      }
    }
    return estimated as Partial<Record<string, number>>;
  }

  private tapesOf(session: PhotoSession): { tapeA: number; tapeB: number } {
    const draft = session.draft as unknown as {
      wallLengths: Record<string, { value: number }>;
    };
    return {
      tapeA: Math.round(draft.wallLengths["A"]?.value ?? 400),
      tapeB: Math.round(draft.wallLengths["B"]?.value ?? 350),
    };
  }

  /**
   * A cancelled photo drag (pointercancel, lost capture, Esc) restores the
   * pre-drag state: the lazy checkpoint is popped, so the drag adds no undo
   * step. A no-op without a checkpointed drag.
   */
  private cancelPhotoDrag(): void {
    if (!this.confirmCheckpointed) return;
    this.confirmCheckpointed = false;
    this.store.undo();
  }

  /** Corner/edge drags re-solve live; one drag is one undo step. */
  private dragPhotoCorners(
    wall: ConfirmWallLetter,
    corners: Record<string, [number, number]>,
    phase: "preview" | "commit",
  ): void {
    const session = this.store.photo;
    if (session === null) return;
    const letter = wall as PhotoSession["activeWall"];
    const { tapeA, tapeB } = this.tapesOf(session);
    let result: PhotoSession["draft"];
    try {
      result = resolveRoomFromCorners({
        base: session.draft,
        corners: {
          [letter]: corners as unknown as import("@fitroom/shared").PhotoCorners,
        },
        sizes: session.sizes,
        tapeA,
        tapeB,
      }) as unknown as PhotoSession["draft"];
    } catch {
      return;
    }
    const estimated = this.estimatedFromMeta(this.draft);
    const nextMeta = draftMeta(
      result as unknown as Parameters<typeof draftMeta>[0],
      estimated as unknown as Parameters<typeof draftMeta>[1],
    );
    const nextSession: PhotoSession = {
      ...(JSON.parse(JSON.stringify(session)) as PhotoSession),
      draft: result,
    };
    if (phase === "preview") {
      if (!this.confirmCheckpointed) {
        this.store.checkpoint();
        this.confirmCheckpointed = true;
      }
      this.store.preview(result.layout as unknown as RoomLayout);
      return;
    }
    if (this.confirmCheckpointed) {
      this.confirmCheckpointed = false;
      this.store.settleDrag(result.layout as unknown as RoomLayout, nextMeta, nextSession);
      this.draft = nextMeta;
    } else {
      this.store.commit(result.layout as unknown as RoomLayout, nextMeta, nextSession);
      this.draft = nextMeta;
    }
    this.renderPanels();
  }

  /** Opening drags move the plan opening and the photo box together. */
  private dragPhotoOpening(
    openingId: string,
    patch: { offset?: number; width?: number; sillHeight?: number; height?: number },
    phase: "preview" | "commit",
  ): void {
    const session = this.store.photo;
    const next = cloneRoom(this.store.room);
    const opening = next.openings.find((o) => o.id === openingId);
    if (opening === undefined) return;
    const wallLen = Math.round(wallLengthOf(next, opening.wallId));
    if (patch.offset !== undefined) {
      opening.offset = clampOffset(patch.offset, opening.width, wallLen);
    }
    if (patch.width !== undefined) {
      const w = Math.min(Math.max(30, Math.round(patch.width)), Math.max(30, wallLen));
      opening.width = w;
      opening.offset = clampOffset(opening.offset, w, wallLen);
    }
    if (patch.sillHeight !== undefined || patch.height !== undefined) {
      const wall = next.walls.find((w) => w.id === opening.wallId);
      const wallHeight = wall?.height ?? 250;
      const sill =
        patch.sillHeight === undefined
          ? opening.sillHeight
          : Math.max(0, Math.round(patch.sillHeight));
      const h = patch.height === undefined ? opening.height : Math.max(1, Math.round(patch.height));
      if (sill + h > wallHeight) {
        if (patch.height !== undefined) {
          opening.height = Math.max(1, Math.round(wallHeight - sill));
          opening.sillHeight = sill;
        } else {
          opening.sillHeight = Math.max(0, Math.round(wallHeight - h));
          opening.height = h;
        }
      } else {
        opening.sillHeight = sill;
        opening.height = h;
      }
    }
    if (phase === "preview") {
      if (!this.confirmCheckpointed) {
        this.store.checkpoint();
        this.confirmCheckpointed = true;
      }
      this.store.preview(next);
      return;
    }
    const nextDraft = session === null ? undefined : this.measuredOpeningDraft(openingId);
    if (session !== null) {
      const draftClone = JSON.parse(JSON.stringify(session.draft)) as unknown as {
        openings: Array<{
          id: string;
          offset: { value: number };
          width: { value: number };
          sillHeight: { value: number };
          height: { value: number };
        }>;
      };
      const draftOpening = draftClone.openings.find((o) => o.id === openingId);
      if (draftOpening !== undefined) {
        draftOpening.offset.value = Math.round(opening.offset);
        draftOpening.width.value = Math.round(opening.width);
        draftOpening.sillHeight.value = Math.round(opening.sillHeight);
        draftOpening.height.value = Math.round(opening.height);
      }
      const nextSession: PhotoSession = {
        ...(JSON.parse(JSON.stringify(session)) as PhotoSession),
        draft: {
          ...session.draft,
          openings: draftClone.openings as unknown as PhotoSession["draft"]["openings"],
        },
      };
      if (this.confirmCheckpointed) {
        this.confirmCheckpointed = false;
        this.store.settleDrag(next, nextDraft ?? this.draft, nextSession);
        if (nextDraft !== undefined && nextDraft !== null) this.draft = nextDraft;
      } else {
        this.store.commit(next, nextDraft ?? this.draft, nextSession);
        if (nextDraft !== undefined && nextDraft !== null) this.draft = nextDraft;
      }
    } else if (this.confirmCheckpointed) {
      this.confirmCheckpointed = false;
      this.store.settleDrag(next, nextDraft ?? this.draft, undefined);
      if (nextDraft !== undefined && nextDraft !== null) this.draft = nextDraft;
    } else {
      this.store.commit(next, nextDraft ?? this.draft);
      if (nextDraft !== undefined && nextDraft !== null) this.draft = nextDraft;
    }
    this.renderPanels();
  }

  /** A dragged opening reads measured afterwards, like a typed value. */
  private measuredOpeningDraft(openingId: string): PhotoDraftMeta | null | undefined {
    if (this.draft === null) return undefined;
    const next: PhotoDraftMeta = JSON.parse(JSON.stringify(this.draft)) as PhotoDraftMeta;
    const marks = next.openings[openingId];
    if (marks === undefined) return next;
    marks.offset = { source: "measured" };
    marks.width = { source: "measured" };
    marks.height = { source: "measured" };
    marks.sill = { source: "measured" };
    return next;
  }

  private markFor(mark: WallSourceMark | undefined): HTMLElement {
    if (mark === undefined) return sourceMark("measured");
    if (mark.source === "measured") return sourceMark("measured", mark.plusMinus);
    return sourceMark("estimated", mark.plusMinus);
  }

  /**
   * A typed wall length turns measured (± 0.5 cm): the opposite wall shares
   * the tape, so both flip and the amber band counts down. The rectangle
   * resize itself re-solves every dependent wall, opening and piece.
   */
  private measuredDraftFor(wallId: string): PhotoDraftMeta | null | undefined {
    if (this.draft === null) return undefined;
    const letter = WALL_ID_TO_LETTER[wallId] as WallLetter | undefined;
    if (letter === undefined) return this.draft;
    const opposite: WallLetter =
      letter === "A" ? "C" : letter === "C" ? "A" : letter === "B" ? "D" : "B";
    const next: PhotoDraftMeta = JSON.parse(JSON.stringify(this.draft)) as PhotoDraftMeta;
    for (const wall of [LETTER_TO_WALL_ID[letter], LETTER_TO_WALL_ID[opposite]]) {
      if (wall === undefined) continue;
      next.walls[wall] = { source: "measured", plusMinus: 0.5 };
    }
    const estimated = Object.values(next.walls).filter((w) => w.source === "estimated");
    next.estimatedWallCount = estimated.length;
    next.estimatedWallPm =
      estimated.length > 0 ? Math.max(...estimated.map((w) => w.plusMinus ?? 0)) : 0;
    return next;
  }

  private renderBand(): void {
    this.bandEl.innerHTML = "";
    const count = this.draft?.estimatedWallCount ?? 0;
    if (this.draft === null || count <= 0) {
      this.bandEl.setAttribute("hidden", "");
      return;
    }
    this.bandEl.removeAttribute("hidden");
    const text = document.createElement("span");
    text.textContent = photoBandText(count, this.draft.estimatedWallPm);
    const nextId =
      (["wall-1", "wall-2", "wall-3", "wall-4"] as const).find(
        (id) => this.draft?.walls[id]?.source === "estimated",
      ) ?? "wall-1";
    const nextLetter = (WALL_ID_TO_LETTER[nextId] as WallLetter | undefined) ?? "A";
    const tape = document.createElement("button");
    tape.type = "button";
    tape.className = "photo-draft-tape";
    tape.textContent = tapeWallLabel(nextLetter);
    tape.addEventListener("click", () => this.store.select({ kind: "wall", id: nextId }));
    this.bandEl.append(text, tape);
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
    const nextDraft = this.measuredDraftFor(wallId);
    const session = this.store.photo;
    if (session === null) {
      this.store.commit(
        setRectangleWallLength(this.store.room, wallId, lengthCm),
        ...(nextDraft === undefined ? [] : [nextDraft]),
      );
      if (nextDraft !== undefined && nextDraft !== null) this.draft = nextDraft;
      return;
    }
    const letter = WALL_ID_TO_LETTER[wallId] as ConfirmWallLetter | undefined;
    const nextSession: PhotoSession = JSON.parse(JSON.stringify(session)) as PhotoSession;
    if (letter !== undefined) {
      const opposite: ConfirmWallLetter =
        letter === "A" ? "C" : letter === "C" ? "A" : letter === "B" ? "D" : "B";
      const draftRec = nextSession.draft as unknown as {
        wallLengths: Record<string, { value: number; plusMinus: number; source: string }>;
      };
      for (const l of [letter, opposite]) {
        if (draftRec.wallLengths[l] !== undefined) {
          draftRec.wallLengths[l] = {
            value: Math.round(lengthCm),
            plusMinus: 0,
            source: "taped",
          };
        }
      }
    }
    this.store.commit(
      setRectangleWallLength(this.store.room, wallId, lengthCm),
      ...(nextDraft === undefined ? [] : [nextDraft]),
      nextSession,
    );
    if (nextDraft !== undefined && nextDraft !== null) this.draft = nextDraft;
  }

  private setCeilingHeight(heightCm: number): void {
    if (!Number.isFinite(heightCm)) return;
    const next = cloneRoom(this.store.room);
    const height = Math.min(320, Math.max(200, Math.round(heightCm)));
    for (const wall of next.walls) wall.height = height;
    this.store.commit(next);
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
    const photo = this.store.photo !== null;
    // The confirm view's own step bar carries the one Leave, so the action
    // row's second Leave hides while the confirm view is open (its own
    // Undo stays).
    this.cancelBtn.style.display = photo ? "none" : "";
    this.gridEl.style.display = photo ? "none" : "";
    if (photo) this.confirmHost.removeAttribute("hidden");
    else this.confirmHost.setAttribute("hidden", "");
    // Confirm order: step bar, estimate banner, action row, columns. The
    // banner and the actions live inside the confirm view between its top
    // bar and its columns while the confirm view is open, so they sit
    // right under the step bar without scrolling; otherwise they sit in
    // the scrolling body above the plain plan grid.
    const view = this.confirmView?.element ?? null;
    if (photo && view !== null) {
      const anchor = view.querySelector(".photo-confirm-walls");
      if (anchor !== null) {
        if (this.bandEl.parentElement !== view) view.insertBefore(this.bandEl, anchor);
        if (this.actionsEl.parentElement !== view) view.insertBefore(this.actionsEl, anchor);
      }
    } else {
      const scroll = this.element.querySelector(".editor-scroll");
      if (scroll !== null) {
        if (this.bandEl.parentElement !== scroll) scroll.insertBefore(this.bandEl, scroll.firstChild);
        if (this.actionsEl.parentElement !== scroll)
          scroll.insertBefore(this.actionsEl, this.gridEl);
      }
    }
    const active = document.activeElement;
    const focusKey = active instanceof HTMLInputElement ? active.dataset["key"] : undefined;
    const focusValue = active instanceof HTMLInputElement ? active.value : undefined;
    this.renderBand();
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
      card.append(head, row, this.markFor(this.draft?.walls[wall.id]));
      this.wallsEl.appendChild(card);
    });
    if (this.draft !== null) this.renderCeiling(room);
  }

  /** Ceiling height with its source mark (photo drafts only). */
  private renderCeiling(room: RoomLayout): void {
    const height = room.walls[0]?.height ?? 250;
    const card = document.createElement("div");
    card.className = "editor-wall-card";
    const head = document.createElement("div");
    head.className = "editor-wall-head";
    head.textContent = "Ceiling height";
    const row = document.createElement("div");
    row.className = "editor-field-row";
    const label = document.createElement("label");
    label.textContent = "Height ";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "200";
    input.max = "320";
    input.step = "1";
    input.value = String(Math.round(height));
    input.dataset["key"] = "ceiling-height";
    input.setAttribute("aria-label", "Ceiling height in centimetres");
    input.addEventListener("change", () => this.setCeilingHeight(Number(input.value)));
    const unit = document.createElement("span");
    unit.textContent = "cm";
    label.append(input, unit);
    row.appendChild(label);
    card.append(head, row, this.markFor(this.draft?.ceiling));
    this.wallsEl.appendChild(card);
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
      renderFinishesPicker(this.store, this.fieldsEl);
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
      this.fieldsEl.appendChild(this.markFor(this.draft?.walls[wall.id]));
      renderFinishesPicker(this.store, this.fieldsEl);
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
      const marks = this.draft?.openings[opening.id];
      this.toggleRow("Type", ["door", "window"], opening.type, (type) =>
        this.commitOpeningType(opening.id, type as "door" | "window"),
      );
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
      if (marks !== undefined) this.fieldsEl.appendChild(this.markFor(marks.offset));
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
      if (marks !== undefined) this.fieldsEl.appendChild(this.markFor(marks.width));
      this.numberField(
        this.fieldsEl,
        `height-${opening.id}`,
        "Height (cm)",
        opening.height,
        30,
        250,
        (value) => this.commitOpeningHeight(opening.id, value),
      );
      if (marks !== undefined) this.fieldsEl.appendChild(this.markFor(marks.height));
      this.numberField(
        this.fieldsEl,
        `sill-${opening.id}`,
        "Sill height (cm)",
        opening.sillHeight,
        0,
        250,
        (value) => this.commitOpeningHeight(opening.id, undefined, value),
      );
      if (marks !== undefined) this.fieldsEl.appendChild(this.markFor(marks.sill));
      else this.fieldsEl.appendChild(sourceMark("measured"));
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
      renderFinishesPicker(this.store, this.fieldsEl);
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
    renderFinishesPicker(this.store, this.fieldsEl);
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

  private commitOpeningType(openingId: string, type: "door" | "window"): void {
    const next = cloneRoom(this.store.room);
    const index = next.openings.findIndex((o) => o.id === openingId);
    const current = next.openings[index];
    if (current === undefined) return;
    const wall = next.walls.find((w) => w.id === current.wallId);
    const wallHeight = wall?.height ?? 250;
    if (current.type === type) return;
    if (type === "door") {
      const height = Math.min(210, wallHeight);
      next.openings[index] = {
        id: current.id,
        wallId: current.wallId,
        type: "door",
        offset: current.offset,
        width: Math.min(Math.max(30, Math.round(current.width)), 120),
        height,
        sillHeight: 0,
        hinge: "left",
        swing: "in",
      } as Opening;
    } else {
      const height = Math.min(140, Math.max(1, wallHeight - 90));
      next.openings[index] = {
        id: current.id,
        wallId: current.wallId,
        type: "window",
        offset: current.offset,
        width: Math.min(Math.max(30, Math.round(current.width)), 200),
        height,
        sillHeight: Math.min(90, Math.max(0, wallHeight - height)),
      } as Opening;
    }
    const session = this.store.photo;
    if (session === null) {
      this.store.commit(next);
      return;
    }
    const nextDraft = this.measuredOpeningDraft(openingId) ?? this.draft;
    const nextSession: PhotoSession = JSON.parse(JSON.stringify(session)) as PhotoSession;
    const draftClone = nextSession.draft as unknown as {
      openings: Array<{
        id: string;
        type: string;
        offset: { value: number };
        width: { value: number };
        sillHeight: { value: number };
        height: { value: number };
      }>;
    };
    const updated = next.openings[index];
    if (updated !== undefined) {
      const draftOpening = draftClone.openings.find((o) => o.id === openingId);
      if (draftOpening !== undefined) {
        draftOpening.type = updated.type;
        draftOpening.offset.value = Math.round(updated.offset);
        draftOpening.width.value = Math.round(updated.width);
        draftOpening.sillHeight.value = Math.round(updated.sillHeight);
        draftOpening.height.value = Math.round(updated.height);
      }
    }
    this.store.commit(next, nextDraft ?? this.draft, nextSession);
    if (nextDraft !== undefined && nextDraft !== null) this.draft = nextDraft;
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
    const session = this.store.photo;
    if (session === null) {
      this.store.commit(next);
      return;
    }
    const nextDraft = this.measuredOpeningDraft(openingId) ?? this.draft;
    const draftClone = JSON.parse(JSON.stringify(session.draft)) as unknown as {
      openings: Array<{ id: string; offset: { value: number }; width: { value: number } }>;
    };
    const draftOpening = draftClone.openings.find((o) => o.id === openingId);
    if (draftOpening !== undefined) {
      draftOpening.offset.value = Math.round(opening.offset);
      draftOpening.width.value = Math.round(opening.width);
    }
    const nextSession: PhotoSession = {
      ...(JSON.parse(JSON.stringify(session)) as PhotoSession),
      draft: {
        ...session.draft,
        openings: draftClone.openings as unknown as PhotoSession["draft"]["openings"],
      },
    };
    this.store.commit(next, nextDraft ?? this.draft, nextSession);
    if (nextDraft !== undefined && nextDraft !== null) this.draft = nextDraft;
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
    const session = this.store.photo;
    if (session === null) {
      this.store.commit(next);
      return;
    }
    const nextDraft = this.measuredOpeningDraft(openingId) ?? this.draft;
    const draftClone = JSON.parse(JSON.stringify(session.draft)) as unknown as {
      openings: Array<{ id: string; sillHeight: { value: number }; height: { value: number } }>;
    };
    const draftOpening = draftClone.openings.find((o) => o.id === openingId);
    if (draftOpening !== undefined) {
      draftOpening.sillHeight.value = Math.round(opening.sillHeight);
      draftOpening.height.value = Math.round(opening.height);
    }
    const nextSession: PhotoSession = {
      ...(JSON.parse(JSON.stringify(session)) as PhotoSession),
      draft: {
        ...session.draft,
        openings: draftClone.openings as unknown as PhotoSession["draft"]["openings"],
      },
    };
    this.store.commit(next, nextDraft ?? this.draft, nextSession);
    if (nextDraft !== undefined && nextDraft !== null) this.draft = nextDraft;
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
