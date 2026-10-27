/**
 * Who owns this pointer: the piece drag or the camera?
 *
 * Pure (no DOM, no three): the canvas handlers own a pointer the moment it
 * goes down on a piece or on the rotate handle (mouse, pen or touch), and
 * the camera controls ignore that pointer until it is released or
 * cancelled. A second finger that goes down while a piece is held is owned
 * too, so the camera stays locked until every held pointer is released.
 * `pointercancel`, `lostpointercapture` and window blur also end the drag.
 *
 * The rule is deliberately tiny so the headless `check:pointer-ownership`
 * drives the same code as the canvas: `cameraMayMove` is false while any
 * piece pointer is held and true again after every release.
 */

export interface DownRecord {
  x: number;
  y: number;
}

export class PointerOwnership {
  private owned = new Set<number>();
  private downPos = new Map<number, DownRecord>();

  /** Own a pointer that went down on a piece or the rotate handle. */
  own(pointerId: number, x: number, y: number): void {
    this.owned.add(pointerId);
    this.downPos.set(pointerId, { x, y });
  }

  /** Note a pointer that went down on empty space (camera may move). */
  noteEmptyDown(pointerId: number, x: number, y: number): void {
    this.downPos.set(pointerId, { x, y });
  }

  /** Release a pointer (pointerup). Returns true when it was owned. */
  release(pointerId: number): boolean {
    const was = this.owned.delete(pointerId);
    return was;
  }

  /** Cancel a pointer (pointercancel / lostpointercapture / blur). */
  cancel(pointerId: number): void {
    this.owned.delete(pointerId);
    this.downPos.delete(pointerId);
  }

  /** Forget empty-space down records (pointerup on empty space). */
  forget(pointerId: number): void {
    this.downPos.delete(pointerId);
  }

  /** Window blur: every drag ends. */
  clear(): void {
    this.owned.clear();
    this.downPos.clear();
  }

  isOwned(pointerId: number): boolean {
    return this.owned.has(pointerId);
  }

  /** True while any piece pointer is held (camera must stay locked). */
  get locked(): boolean {
    return this.owned.size > 0;
  }

  /** The camera may move only while no piece is held. */
  cameraMayMove(): boolean {
    return this.owned.size === 0;
  }

  downRecord(pointerId: number): DownRecord | undefined {
    return this.downPos.get(pointerId);
  }

  /** True when up lands within `thresholdPx` of down (a click, not a drag). */
  static isClick(down: DownRecord | undefined, upX: number, upY: number, thresholdPx = 5): boolean {
    if (down === undefined) return false;
    return Math.hypot(upX - down.x, upY - down.y) <= thresholdPx;
  }
}
