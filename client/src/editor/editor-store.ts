/**
 * Editor store: the plan editor's working copy of a RoomLayout with undo.
 *
 * Every edit commits one undo step; a pointer drag previews without pushing
 * and settles as a single step on release. `onCommitted` fires for edits the
 * 3D room must follow at once (commits, drag releases, undo) but not for
 * in-drag previews.
 */

import type { RoomLayout } from "@fitroom/shared";

export type EditorSelection =
  | { kind: "wall"; id: string }
  | { kind: "opening"; id: string }
  | { kind: "piece"; id: string }
  | null;

function cloneRoom(room: RoomLayout): RoomLayout {
  return JSON.parse(JSON.stringify(room)) as RoomLayout;
}

export class EditorStore {
  room: RoomLayout;
  selection: EditorSelection = null;
  private past: RoomLayout[] = [];
  private listeners = new Set<() => void>();
  private committedListeners = new Set<(room: RoomLayout) => void>();

  constructor(initial: RoomLayout) {
    this.room = cloneRoom(initial);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Fires when the 3D room must follow the edit at once. */
  onCommitted(fn: (room: RoomLayout) => void): () => void {
    this.committedListeners.add(fn);
    return () => {
      this.committedListeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private emitCommitted(): void {
    for (const fn of this.committedListeners) fn(this.room);
  }

  /** Replace the working copy (room switch); clears undo and selection. */
  load(room: RoomLayout): void {
    this.room = cloneRoom(room);
    this.past = [];
    this.selection = null;
    this.emit();
  }

  /** One undo step around a pure room transform. */
  commit(next: RoomLayout): void {
    this.past.push(cloneRoom(this.room));
    if (this.past.length > 60) this.past.shift();
    this.room = next;
    this.emit();
    this.emitCommitted();
  }

  /** Push the pre-drag state so the whole drag undoes as one edit. */
  checkpoint(): void {
    this.past.push(cloneRoom(this.room));
    if (this.past.length > 60) this.past.shift();
  }

  /** In-drag preview: new state, no undo step, 3D follows on release. */
  preview(next: RoomLayout): void {
    this.room = next;
    this.emit();
  }

  /** Settle a drag: the 3D room follows, undo still reverts the whole drag. */
  finishDrag(): void {
    this.emitCommitted();
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.room = prev;
    if (this.selection !== null && !hasId(this.room, this.selection)) {
      this.selection = null;
    }
    this.emit();
    this.emitCommitted();
    return true;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  select(selection: EditorSelection): void {
    this.selection = selection;
    this.emit();
  }
}

function hasId(room: RoomLayout, selection: Exclude<EditorSelection, null>): boolean {
  if (selection.kind === "wall") return room.walls.some((w) => w.id === selection.id);
  if (selection.kind === "opening") return room.openings.some((o) => o.id === selection.id);
  return room.existing.some((p) => p.id === selection.id);
}
