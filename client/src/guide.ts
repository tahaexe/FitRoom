/**
 * Four-moment first-visit guide: one bubble at a time, each shown only when
 * its screen is there, never as an upfront slideshow. The state machine
 * below is pure (headless-testable; `check:guide` pins it) and the small
 * `GuideView` next to it only renders a bubble plus a soft ring around the
 * target — the rest of the page stays usable, nothing is blocked or dimmed.
 *
 * Moments:
 *  1. On the first-run dialog: "Start here: try it with our example photos,
 *     or enter your own room size." → the "Try with example photos" button.
 *  2. A room on screen with no piece: "Add a piece from the catalog."
 *     (phones: "Open the catalog and add a piece.") → the catalog (the left
 *     panel on desktops; the Catalog tab or the open sheet on phones).
 *     Adding a piece moves on.
 *  3. A piece in the room: "Drag it around. Its outline shows whether it
 *     fits." → the placed piece's fit status (the fit badge). Moving a piece
 *     moves on.
 *  4. "Let AI furnish the room for you." → the AI actions (Recommend and
 *     Arrange on desktops; the AI tab on phones). "Got it" ends the guide.
 *
 * Storage: the outcome is `fitroom.guide` = `done` or `skipped`. A visitor
 * who already has the retired `fitroom.coach-seen = 1` counts as seen.
 */

export const GUIDE_KEY = "fitroom.guide";
export const GUIDE_LEGACY_KEY = "fitroom.coach-seen";

export type GuideOutcome = "done" | "skipped";
export type GuideMoment = 1 | 2 | 3 | 4;

export const GUIDE_MOMENTS: readonly GuideMoment[] = [1, 2, 3, 4];

/** Bubble fade + slight slide, inside the required 200–250 ms window. */
export const GUIDE_TRANSITION_MS = 220;
/** The bubble never touches the window edge (8 px margin, flips side). */
export const GUIDE_MARGIN_PX = 8;
/** Gap between the target's ring and the bubble. */
export const GUIDE_GAP_PX = 10;

export const GUIDE_TEXT_1 =
  "Start here: try it with our example photos, or enter your own room size.";
export const GUIDE_TEXT_2 = "Add a piece from the catalog.";
export const GUIDE_TEXT_2_PHONE = "Open the catalog and add a piece.";
export const GUIDE_TEXT_3 = "Drag it around. Its outline shows whether it fits.";
export const GUIDE_TEXT_4 = "Let AI furnish the room for you.";

/** Widest the bubble ever paints (mirrors the CSS `max-width`). */
export const GUIDE_BUBBLE_MAX_W_PX = 340;
/** Fallback bubble height when nothing is measurable (hidden bubble). */
export const GUIDE_BUBBLE_FALLBACK_H_PX = 140;

/**
 * Measurable bubble size: a hidden bubble reports 0 × 0 (`display: none`),
 * so fall back to the widest the bubble can paint — still clamped inside
 * the window with the 8 px margin — instead of centring a 1 px box and
 * overflowing the real bubble past the edge.
 */
export function bubbleMeasuredSize(
  measuredW: number,
  measuredH: number,
  viewportW: number,
  margin: number = GUIDE_MARGIN_PX,
): { w: number; h: number } {
  const vw = Math.max(1, viewportW);
  const fallbackW = Math.min(GUIDE_BUBBLE_MAX_W_PX, Math.max(1, vw - margin * 2));
  const w = measuredW > 0 ? measuredW : fallbackW;
  const h = measuredH > 0 ? measuredH : GUIDE_BUBBLE_FALLBACK_H_PX;
  return { w, h };
}

/** Bubble text for a moment (the catalog moment reads differently on phones). */
export function guideText(moment: GuideMoment, isPhone: boolean): string {
  if (moment === 1) return GUIDE_TEXT_1;
  if (moment === 2) return isPhone ? GUIDE_TEXT_2_PHONE : GUIDE_TEXT_2;
  if (moment === 3) return GUIDE_TEXT_3;
  return GUIDE_TEXT_4;
}

/** Progress mark inside the bubble ("2 of 4"). */
export function guideProgress(moment: GuideMoment): string {
  return `${String(moment)} of 4`;
}

/** The action button reads "Got it" on the last moment, "Next" before. */
export function guideAction(moment: GuideMoment): string {
  return moment === 4 ? "Got it" : "Next";
}

/** What the guide needs to know about the screen (built by the app). */
export interface GuideScreen {
  /** The first-run dialog is open. */
  firstOpenVisible: boolean;
  /** The "Try with example photos" button is on screen (the cards view, not the size form). */
  exampleActionVisible: boolean;
  /** The 3D room is on screen (no dialog, no editor, no photo flow). */
  roomVisible: boolean;
  /** Placed pieces in the room. */
  itemCount: number;
  /** The AI actions are on screen (desktop toolbar, phone AI tab). */
  aiVisible: boolean;
  isPhone: boolean;
}

/** True when a moment's target exists on the given screen. */
export function momentFits(moment: GuideMoment, screen: GuideScreen): boolean {
  if (moment === 1) return screen.firstOpenVisible && screen.exampleActionVisible;
  if (moment === 2) return !screen.firstOpenVisible && screen.roomVisible && screen.itemCount === 0;
  // Moments 3 and 4 both need a piece: a room change to an empty room never
  // shows them (the tour falls back to moment 2 there).
  if (moment === 3) return !screen.firstOpenVisible && screen.roomVisible && screen.itemCount > 0;
  return !screen.firstOpenVisible && screen.roomVisible && screen.itemCount > 0 && screen.aiVisible;
}

/** Earliest moment at or after `from` whose target is on screen, if any. */
export function fittingMoment(screen: GuideScreen, from: GuideMoment = 1): GuideMoment | null {
  for (const moment of GUIDE_MOMENTS) {
    if (moment >= from && momentFits(moment, screen)) return moment;
  }
  return null;
}

/** The current moment if it still fits, else the earliest fitting one. */
export function resolveMoment(screen: GuideScreen, current: GuideMoment): GuideMoment | null {
  if (momentFits(current, screen)) return current;
  return fittingMoment(screen, 1);
}

/** Minimal key-value store so the machine stays headless-testable. */
export interface GuideStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** `window.localStorage`, swallowing private-mode errors (tour replays). */
export function localGuideStorage(): GuideStorage {
  return {
    get(key: string): string | null {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Private mode: the tour simply shows again next visit.
      }
    },
    remove(key: string): void {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Private mode: nothing stored, nothing to clear.
      }
    },
  };
}

/**
 * The tour itself: `start` on first paint, `reevaluate` on every room change
 * (room menu, photo build, reload), explicit `next`/`skip`/`finish`, and the
 * two real actions (adding a piece, moving a piece) moving on. Once started,
 * the tour stays active across screens that fit no moment (the size form,
 * the plan editor, the photo flow) and resumes when a moment fits again.
 * Help (`restart`) starts the tour again at the moment that fits the screen,
 * even after `done`/`skipped` or the retired coach-mark key.
 */
export class Guide {
  moment: GuideMoment | null = null;
  private active = false;
  /** Moment parked by a screen that fits nothing (the size form, the plan
   * editor, the photo flow): the tour resumes there instead of rewinding. */
  private paused: GuideMoment | null = null;
  /** Moments dismissed with Next: never shown again until Help restarts. */
  private done = new Set<GuideMoment>();

  constructor(private readonly storage: GuideStorage = localGuideStorage()) {}

  outcome(): GuideOutcome | null {
    const value = this.storage.get(GUIDE_KEY);
    return value === "done" || value === "skipped" ? value : null;
  }

  legacySeen(): boolean {
    return this.storage.get(GUIDE_LEGACY_KEY) === "1";
  }

  /** A stored outcome or the retired key counts as seen. */
  hasSeen(): boolean {
    return this.outcome() !== null || this.legacySeen();
  }

  /** True once `start`/`restart` ran and neither `skip` nor `finish` did. */
  get started(): boolean {
    return this.active;
  }

  /** True while a bubble belongs on screen. */
  get showing(): boolean {
    return this.active && this.moment !== null;
  }

  /** Earliest fitting moment that Next has not dismissed yet. */
  private fittingUndone(screen: GuideScreen, from: GuideMoment = 1): GuideMoment | null {
    for (const moment of GUIDE_MOMENTS) {
      if (moment >= from && !this.done.has(moment) && momentFits(moment, screen)) return moment;
    }
    return null;
  }

  /** The current moment if it still fits, else the earliest undismissed one. */
  private resolveUndone(screen: GuideScreen, current: GuideMoment): GuideMoment | null {
    if (!this.done.has(current) && momentFits(current, screen)) return current;
    return this.fittingUndone(screen, 1);
  }

  /** First paint: nothing when already seen, else the fitting moment only. */
  start(screen: GuideScreen): GuideMoment | null {
    if (this.hasSeen()) {
      this.active = false;
      this.moment = null;
      this.paused = null;
      this.done.clear();
      return null;
    }
    this.active = true;
    this.paused = null;
    this.done.clear();
    this.moment = this.fittingUndone(screen, 1);
    return this.moment;
  }

  /** Help: the tour again at the moment that fits the screen. */
  restart(screen: GuideScreen): GuideMoment | null {
    this.active = true;
    this.paused = null;
    this.done.clear();
    this.storage.remove(GUIDE_KEY);
    this.moment = this.fittingUndone(screen, 1);
    return this.moment;
  }

  /** Room changes (menu, photo build, reload): never a missing target. */
  reevaluate(screen: GuideScreen): GuideMoment | null {
    if (!this.active) return null;
    if (this.paused !== null && this.done.has(this.paused)) this.paused = null;
    if (this.moment !== null) {
      if (this.done.has(this.moment)) {
        this.moment = this.fittingUndone(screen, 1);
        return this.moment;
      }
      if (momentFits(this.moment, screen)) {
        this.paused = null;
        return this.moment;
      }
      this.paused = this.moment;
      this.moment = this.fittingUndone(screen, 1);
      // A room change rewinds the tour (empty room falls back to moment 2);
      // a mere detour keeps the parked moment for the way back.
      if (this.moment !== null && this.moment < (this.paused ?? 0)) this.paused = null;
      return this.moment;
    }
    if (this.paused !== null && momentFits(this.paused, screen)) {
      this.moment = this.paused;
      this.paused = null;
      return this.moment;
    }
    this.moment = this.fittingUndone(screen, 1);
    return this.moment;
  }

  /** "Next": the shown moment is done; the next undismissed fitting moment shows. */
  next(screen: GuideScreen): GuideMoment | null {
    if (!this.active || this.moment === null) return this.moment;
    const current = this.moment;
    this.done.add(current);
    this.paused = null;
    this.moment = this.fittingUndone(screen, (current + 1) as GuideMoment);
    return this.moment;
  }

  /** Adding a piece moves on from the catalog moment. */
  advanceOnItemsAdded(screen: GuideScreen): GuideMoment | null {
    if (this.active && this.moment === 2 && screen.itemCount > 0) {
      this.moment = this.resolveUndone(screen, 3);
    }
    return this.moment;
  }

  /** Moving a piece moves on from the drag moment. */
  advanceOnPieceMoved(screen: GuideScreen): GuideMoment | null {
    if (this.active && this.moment === 3) {
      this.moment = this.resolveUndone(screen, 4);
    }
    return this.moment;
  }

  /** Escape / "Skip tour": the room keeps working as before. */
  skip(): void {
    this.active = false;
    this.moment = null;
    this.paused = null;
    this.done.clear();
    this.storage.set(GUIDE_KEY, "skipped");
  }

  /** "Got it": the tour is done. */
  finish(): void {
    this.active = false;
    this.moment = null;
    this.paused = null;
    this.done.clear();
    this.storage.set(GUIDE_KEY, "done");
  }
}

export interface GuideRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GuidePlaced {
  left: number;
  top: number;
  side: "above" | "below";
}

/**
 * Bubble placement (pure): below the target when it fits, above when it
 * does not, shifted sideways to stay inside the window with an 8 px margin.
 * The bubble box itself is always fully inside the window.
 */
export interface GuideDock {
  /** Chrome reserved at the viewport bottom (bottom bar plus an open sheet). */
  bottomChrome: number;
  /**
   * Bottom edge of the room view's top row (fit badge, photo pill); the
   * top dock sits `gap` below it.
   */
  topChrome?: number;
  /** Boxes the docked bubble must not cover: in-scene problem pills and distance tags. */
  avoid?: readonly GuideRect[];
}

export function placeBubble(
  target: GuideRect,
  bubble: GuideRect,
  viewport: GuideRect,
  margin: number = GUIDE_MARGIN_PX,
  gap: number = GUIDE_GAP_PX,
  dock?: GuideDock,
): GuidePlaced {
  const vw = Math.max(1, viewport.w);
  const vh = Math.max(1, viewport.h);
  if (dock !== undefined) {
    // Phones, moments 2-4: dock 8 px above the bottom bar or the open sheet,
    // full width less 8 px a side; when a problem pill or distance tag sits
    // there, dock under the room view's top row, whichever covers less.
    const bh = Math.max(1, Math.min(bubble.h, vh - margin * 2));
    const bottom = Math.max(0, dock.bottomChrome);
    const low = Math.max(margin, vh - bottom - margin - bh);
    const avoid = dock.avoid ?? [];
    const covered = (top: number): number => {
      let area = 0;
      for (const r of avoid) {
        const w = Math.min(vw - margin, r.x + r.w) - Math.max(margin, r.x);
        const h = Math.min(top + bh, r.y + r.h) - Math.max(top, r.y);
        if (w > 0 && h > 0) area += w * h;
      }
      return area;
    };
    const lowCover = covered(low);
    if (dock.topChrome === undefined || lowCover === 0) {
      return { left: margin, top: Math.round(low), side: "below" };
    }
    const high = Math.max(margin, Math.min(dock.topChrome + gap, vh - margin - bh));
    if (covered(high) < lowCover) return { left: margin, top: Math.round(high), side: "above" };
    return { left: margin, top: Math.round(low), side: "below" };
  }
  const bw = Math.max(1, Math.min(bubble.w, vw - margin * 2));
  const bh = Math.max(1, Math.min(bubble.h, vh - margin * 2));
  let left = target.x + target.w / 2 - bw / 2;
  left = Math.max(margin, Math.min(left, vw - bw - margin));
  let top = target.y + target.h + gap;
  let side: "above" | "below" = "below";
  if (top + bh > vh - margin) {
    const above = target.y - gap - bh;
    if (above >= margin) {
      top = above;
      side = "above";
    } else {
      top = Math.max(margin, Math.min(top, vh - bh - margin));
    }
  }
  if (top < margin) top = margin;
  return { left: Math.round(left), top: Math.round(top), side };
}

/**
 * Target lookup, first visible candidate wins. Desktop and phone targets:
 *  1. the "Try with example photos" button in the first-run dialog (both);
 *  2. the catalog: the left panel on desktops, the open sheet or the
 *     Catalog tab on phones;
 *  3. the placed piece's fit status: the fit badge (both);
 *  4. the AI actions: Arrange/Recommend on desktops, the AI tab on phones.
 */
export function guideTargetCandidates(moment: GuideMoment, isPhone: boolean): string[] {
  if (moment === 1) return [".first-open .setup-try-example"];
  if (moment === 2) {
    return isPhone ? ["#catalog", "#phone-catalog"] : ["#catalog"];
  }
  if (moment === 3) return ["#fit-badge"];
  return isPhone ? ["#phone-ai"] : ["#tool-assistant", "#tool-recommend"];
}

function guideTargetVisible(el: Element | null): el is Element {
  if (el === null || !(el instanceof HTMLElement)) return false;
  if (el.hasAttribute("hidden")) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** The moment's target element, or null when it is missing (show nothing). */
export function queryGuideTarget(moment: GuideMoment, isPhone: boolean): Element | null {
  for (const selector of guideTargetCandidates(moment, isPhone)) {
    const el = document.querySelector(selector);
    if (guideTargetVisible(el)) return el;
  }
  return null;
}

export interface GuideBubbleText {
  text: string;
  progress: string;
  action: string;
}

/** One bubble's content (single line of text, Next/Got it, Skip, "n of 4"). */
export function guideBubble(moment: GuideMoment, isPhone: boolean): GuideBubbleText {
  return {
    text: guideText(moment, isPhone),
    progress: guideProgress(moment),
    action: guideAction(moment),
  };
}

/**
 * The small view: one bubble plus a soft coral ring around the target. The
 * ring and the bubble never intercept the page (`pointer-events` stays off
 * the ring; only the bubble's own buttons take clicks), so the rest of the
 * page stays usable while the bubble shows.
 */
export class GuideView {
  private bubble: HTMLElement | null = null;
  private ring: HTMLElement | null = null;
  private target: Element | null = null;
  private shownMoment: GuideMoment | null = null;
  private isPhone = false;

  constructor(private readonly handlers: { onNext: () => void; onSkip: () => void }) {}

  get visible(): boolean {
    return this.bubble !== null && !this.bubble.hasAttribute("hidden");
  }

  get current(): GuideMoment | null {
    return this.shownMoment;
  }

  /** Show (or move) the bubble at the moment's target; hide when null. */
  render(
    moment: GuideMoment | null,
    isPhone: boolean,
    resolveTarget: (moment: GuideMoment) => Element | null = (m) => queryGuideTarget(m, isPhone),
  ): void {
    if (moment === null) {
      this.hide();
      return;
    }
    const target = resolveTarget(moment);
    if (target === null) {
      // Never a moment whose target is missing.
      this.hide();
      return;
    }
    this.target = target;
    this.shownMoment = moment;
    this.isPhone = isPhone;
    this.ensure();
    const content = guideBubble(moment, isPhone);
    const text = this.bubble?.querySelector(".guide-text");
    if (text !== null && text !== undefined) text.textContent = content.text;
    const progress = this.bubble?.querySelector(".guide-progress");
    if (progress !== null && progress !== undefined) progress.textContent = content.progress;
    const action = this.bubble?.querySelector(".guide-next");
    if (action instanceof HTMLButtonElement) action.textContent = content.action;
    // Unhide before measuring: a hidden bubble reports 0 × 0 and the
    // clamped position would belong to a 1 px box, overflowing the real
    // bubble past the window edge once shown.
    this.bubble?.removeAttribute("hidden");
    this.ring?.removeAttribute("hidden");
    this.place();
    // Two frames: the bubble paints at its spot, then fades + slides in.
    const bubble = this.bubble;
    const ring = this.ring;
    if (bubble !== null) {
      bubble.dataset["show"] = "false";
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          bubble.dataset["show"] = "true";
        });
      });
    }
    if (ring !== null) ring.dataset["show"] = "true";
  }

  /** Re-seat the bubble by the target (window resize, sheet open/close). */
  reposition(): void {
    if (this.bubble === null || this.bubble.hasAttribute("hidden")) return;
    this.place();
  }

  /** Phones, moments 2-4: re-pick the dock after the in-scene labels moved. */
  redock(): void {
    if (!this.isPhone || this.shownMoment === null || this.shownMoment === 1) return;
    this.reposition();
  }

  hide(): void {
    this.shownMoment = null;
    this.target = null;
    this.bubble?.setAttribute("hidden", "");
    this.ring?.setAttribute("hidden", "");
    if (this.bubble !== null) this.bubble.dataset["show"] = "false";
    if (this.ring !== null) this.ring.dataset["show"] = "false";
  }

  private ensure(): void {
    if (this.bubble === null) {
      const bubble = document.createElement("div");
      bubble.className = "guide-bubble";
      bubble.setAttribute("role", "dialog");
      bubble.setAttribute("aria-label", "Room tour");
      bubble.setAttribute("hidden", "");
      const text = document.createElement("p");
      text.className = "guide-text";
      const row = document.createElement("div");
      row.className = "guide-row";
      const progress = document.createElement("span");
      progress.className = "guide-progress";
      progress.setAttribute("aria-live", "polite");
      const next = document.createElement("button");
      next.type = "button";
      next.className = "guide-next";
      next.addEventListener("click", () => this.handlers.onNext());
      const skip = document.createElement("button");
      skip.type = "button";
      skip.className = "guide-skip";
      skip.textContent = "Skip tour";
      skip.addEventListener("click", () => this.handlers.onSkip());
      row.append(progress, next, skip);
      bubble.append(text, row);
      document.body.appendChild(bubble);
      this.bubble = bubble;
      document.addEventListener(
        "scroll",
        () => {
          if (this.isPhone) this.reposition();
        },
        { capture: true, passive: true },
      );
    }
    if (this.ring === null) {
      const ring = document.createElement("div");
      ring.className = "guide-ring";
      ring.setAttribute("hidden", "");
      ring.setAttribute("aria-hidden", "true");
      document.body.appendChild(ring);
      this.ring = ring;
    }
  }

  /** Free area left of the open right-hand panel (the whole window when none). */
  private freeViewport(): GuideRect {
    const h = window.innerHeight;
    let freeW = Math.max(1, window.innerWidth);
    for (const id of ["inspector", "recommend-panel", "assistant-panel", "cart-panel"]) {
      const el = document.getElementById(id);
      if (el === null || el.hasAttribute("hidden")) continue;
      const left = el.getBoundingClientRect().left;
      if (Number.isFinite(left) && left > 0) freeW = Math.min(freeW, left);
    }
    return { x: 0, y: 0, w: Math.max(1, freeW), h: Math.max(1, h) };
  }

  private place(): void {
    if (this.bubble === null || this.ring === null || this.target === null) return;
    const rect = this.target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      // A missing or zero-size target hides the bubble: never a ring
      // parked at the top-left corner.
      this.hide();
      return;
    }
    const pad = 6;
    this.ring.style.left = `${String(Math.max(2, rect.left - pad))}px`;
    this.ring.style.top = `${String(Math.max(2, rect.top - pad))}px`;
    this.ring.style.width = `${String(Math.max(1, rect.width + pad * 2))}px`;
    this.ring.style.height = `${String(Math.max(1, rect.height + pad * 2))}px`;
    // Phones, moment 1: the bubble joins the first-run dialog's flow right
    // after the card that holds its button, so it covers no card; the ring
    // stays on the button.
    if (this.isPhone && this.shownMoment === 1) {
      const card = this.target.closest(".setup-card");
      if (card !== null) {
        if (this.bubble.previousElementSibling !== card) card.after(this.bubble);
        this.bubble.dataset["inline"] = "true";
        this.bubble.style.left = "";
        this.bubble.style.top = "";
        this.bubble.style.width = "";
        this.bubble.style.maxWidth = "";
        this.bubble.dataset["side"] = "below";
        return;
      }
    }
    if (this.bubble.dataset["inline"] === "true") {
      this.bubble.removeAttribute("data-inline");
      document.body.appendChild(this.bubble);
    }
    const viewport = this.freeViewport();
    const measured = bubbleMeasuredSize(
      this.bubble.offsetWidth,
      this.bubble.offsetHeight,
      viewport.w,
    );
    // Phones, moments 2-4: dock the bubble at the bottom of the free room
    // area, 8 px above the bottom bar or the open sheet, full width less
    // 8 px a side; moment 1 sits in the dialog's flow (see above). The ring
    // above already highlights the target.
    if (this.isPhone && this.shownMoment !== null && this.shownMoment !== 1) {
      const vw = Math.max(1, window.innerWidth);
      const vh = Math.max(1, window.innerHeight);
      this.bubble.style.width = `${String(Math.max(1, vw - GUIDE_MARGIN_PX * 2))}px`;
      this.bubble.style.maxWidth = "none";
      const docked = bubbleMeasuredSize(this.bubble.offsetWidth, this.bubble.offsetHeight, vw);
      let bottomChrome = 56;
      try {
        if (document.body.getAttribute("data-sheet-open") === "true") {
          const size = document.body.getAttribute("data-sheet-size");
          bottomChrome += (size === "full" ? 0.88 : 0.4) * vh;
        }
      } catch {
        // DOM may be unavailable; the bottom bar still reserves 56 px.
      }
      const avoid: GuideRect[] = [];
      const labels = document.querySelectorAll<HTMLElement>(".fit-issue-label, .fit-dim-label");
      for (const label of labels) {
        if (label.style.display === "none") continue;
        const box = label.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          avoid.push({ x: box.left, y: box.top, w: box.width, h: box.height });
        }
      }
      let topChrome = document.getElementById("scene-container")?.getBoundingClientRect().top ?? 0;
      for (const id of ["fit-badge", "photo-view-button"]) {
        const el = document.getElementById(id);
        if (el === null || el.hasAttribute("hidden")) continue;
        const box = el.getBoundingClientRect();
        if (box.height > 0) topChrome = Math.max(topChrome, box.bottom);
      }
      const placed = placeBubble(
        { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
        { x: 0, y: 0, w: docked.w, h: docked.h },
        { x: 0, y: 0, w: vw, h: vh },
        GUIDE_MARGIN_PX,
        GUIDE_GAP_PX,
        { bottomChrome, topChrome, avoid },
      );
      this.bubble.style.left = `${String(placed.left)}px`;
      this.bubble.style.top = `${String(placed.top)}px`;
      this.bubble.dataset["side"] = placed.side;
      return;
    }
    this.bubble.style.width = "";
    this.bubble.style.maxWidth = "";
    const placed = placeBubble(
      { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      { x: 0, y: 0, w: measured.w, h: measured.h },
      viewport,
    );
    this.bubble.style.left = `${String(placed.left)}px`;
    this.bubble.style.top = `${String(placed.top)}px`;
    this.bubble.dataset["side"] = placed.side;
  }
}

/**
 * Portrait-phone room framing (pure, no DOM): the room fills the free area
 * (the scene container less an open sheet) instead of a third of it.
 *
 * - `PHONE_FRAME_WIDTH_SHARE`: the room's projected box spans 92 % of the
 *   free area's width;
 * - `PHONE_FRAME_HEIGHT_SHARE`: ... or 80 % of its height, whichever comes
 *   first.
 * - The picture's centre sits in the middle of the free area through a
 *   same-size `setViewOffset` window shifted up by half the sheet height,
 *   so the camera never moves for it (the shopper's orbit and zoom stay).
 */
export const PHONE_FRAME_WIDTH_SHARE = 0.92;
export const PHONE_FRAME_HEIGHT_SHARE = 0.8;

export interface PhoneFrameBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PhoneFrameArea {
  w: number;
  h: number;
}

export interface PhoneViewOffset {
  fullW: number;
  fullH: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PhoneFrameFit {
  /** Grow the projected box by this (move the camera closer by 1/scale). */
  scale: number;
  /** Free area: the container less the open sheet. */
  free: PhoneFrameArea;
  /** Same-size `setViewOffset` arguments centring the free area. */
  viewOffset: PhoneViewOffset;
  /** Predicted box on the canvas after scaling and the view offset. */
  screen: PhoneFrameBox;
}

/** Free area for a container with an open sheet of `sheetH` px (0 closed). */
export function phoneFreeArea(area: PhoneFrameArea, sheetH: number): PhoneFrameArea {
  const sheet = Number.isFinite(sheetH) ? Math.max(0, sheetH) : 0;
  return { w: Math.max(1, area.w), h: Math.max(1, area.h - sheet) };
}

/**
 * Same-size `setViewOffset` arguments keeping the picture's centre in the
 * middle of the free area. The window keeps the container's size (no
 * stretch); shifting it up by half the sheet height moves the picture up
 * by the same amount, landing its centre on the free area's centre.
 */
export function phoneViewOffset(areaW: number, areaH: number, sheetH: number): PhoneViewOffset {
  const w = Math.max(1, areaW);
  const h = Math.max(1, areaH);
  const sheet = Number.isFinite(sheetH) ? Math.max(0, sheetH) : 0;
  return { fullW: w, fullH: h, x: 0, y: sheet / 2, w, h };
}

/**
 * Fit a projected room box to the free area: move along the view direction
 * until the box spans 92 % of the free width or 80 % of the free height,
 * whichever comes first. Scaling happens about the image centre (where the
 * orbit target projects); the returned view offset then carries the picture
 * to the free area's middle.
 */
export function fitBoxToArea(
  box: PhoneFrameBox,
  area: PhoneFrameArea,
  sheetH: number,
): PhoneFrameFit {
  const free = phoneFreeArea(area, sheetH);
  const bw = Math.max(1, box.w);
  const bh = Math.max(1, box.h);
  const widthScale = (PHONE_FRAME_WIDTH_SHARE * free.w) / bw;
  const heightScale = (PHONE_FRAME_HEIGHT_SHARE * free.h) / bh;
  const scale =
    Number.isFinite(widthScale) && Number.isFinite(heightScale)
      ? Math.max(0.01, Math.min(widthScale, heightScale))
      : 1;
  const imgCx = Math.max(1, area.w) / 2;
  const imgCy = Math.max(1, area.h) / 2;
  const boxCx = box.x + box.w / 2;
  const boxCy = box.y + box.h / 2;
  const sheet = Number.isFinite(sheetH) ? Math.max(0, sheetH) : 0;
  const scaledCx = imgCx + (boxCx - imgCx) * scale;
  const scaledCy = imgCy + (boxCy - imgCy) * scale;
  const viewOffset = phoneViewOffset(area.w, area.h, sheetH);
  const screen: PhoneFrameBox = {
    w: box.w * scale,
    h: box.h * scale,
    x: scaledCx - (box.w * scale) / 2,
    y: scaledCy - (box.h * scale) / 2 - sheet / 2,
  };
  return { scale, free, viewOffset, screen };
}

/**
 * Smallest laid-out container a phone frame may use (px). Below this the
 * container is not laid out yet (0 × 0 at boot): the camera keeps its pose
 * and the frame runs again on the next resize or layout.
 */
export const PHONE_FRAME_MIN_PX = 100;

/** True when the container has its laid-out size for phone framing. */
export function phoneFrameReady(areaW: number, areaH: number): boolean {
  return (
    Number.isFinite(areaW) &&
    Number.isFinite(areaH) &&
    areaW >= PHONE_FRAME_MIN_PX &&
    areaH >= PHONE_FRAME_MIN_PX
  );
}

/** The phone framing distance never drops below the bounding-sphere radius
 * plus this (m), so the camera can never sit inside the room. */
export const PHONE_FRAME_CLEAR_M = 0.5;

/** Closest the framing camera may sit to the room target (m). */
export function phoneFrameMinDistance(radiusM: number): number {
  return radiusM + PHONE_FRAME_CLEAR_M;
}

/** Farthest the framing camera ever moves from the target (m). */
export const PHONE_FRAME_MAX_M = 18;

/** Bounding-sphere margin before the iterative fit (12 % stand-off). */
export const PHONE_FRAME_FIT_MARGIN = 1.12;

/**
 * Widening factor when a step cannot narrow: a corner behind the camera or
 * a box with no finite size moves the camera away instead of closer
 * (dividing by a number below one grows the distance).
 */
export const PHONE_FRAME_WIDEN_STEP = 0.8;

/** One framing-camera measurement: the projected box and every corner's
 * depth in front of the camera (positive = in front, metres). */
export interface PhoneFrameProjection {
  box: PhoneFrameBox;
  /** Eight depths, one per room corner; positive while in front. */
  depths: number[];
}

/**
 * Iterative phone framing distance (pure, no DOM): start at the
 * bounding-sphere stand-off, then move along the view direction until the
 * projected box spans the free area's share. A step with a corner behind
 * the camera (non-positive depth) or a non-finite box widens instead of
 * narrowing; the distance never drops below the bounding-sphere radius
 * plus 0.5 m, so the camera never ends up inside the room.
 */
export function solvePhoneFrame(
  radiusM: number,
  fitFovRad: number,
  area: PhoneFrameArea,
  sheetH: number,
  project: (distM: number) => PhoneFrameProjection,
  maxSteps = 4,
): number {
  const minDist = phoneFrameMinDistance(radiusM);
  const standOff = radiusM / Math.sin(fitFovRad / 2);
  let dist =
    Number.isFinite(standOff) && standOff > 0
      ? Math.min(PHONE_FRAME_MAX_M, Math.max(minDist, standOff * PHONE_FRAME_FIT_MARGIN))
      : minDist;
  for (let step = 0; step < maxSteps; step += 1) {
    const proj = project(dist);
    const finiteBox =
      Number.isFinite(proj.box.x) &&
      Number.isFinite(proj.box.y) &&
      Number.isFinite(proj.box.w) &&
      Number.isFinite(proj.box.h) &&
      proj.box.w > 0 &&
      proj.box.h > 0;
    const allInFront =
      proj.depths.length === 8 && proj.depths.every((depth) => Number.isFinite(depth) && depth > 0);
    const fit = finiteBox ? fitBoxToArea(proj.box, area, sheetH) : null;
    if (!allInFront || fit === null || !Number.isFinite(fit.scale) || fit.scale <= 0) {
      dist = Math.min(PHONE_FRAME_MAX_M, dist / PHONE_FRAME_WIDEN_STEP);
      continue;
    }
    dist = Math.min(PHONE_FRAME_MAX_M, Math.max(minDist, dist / fit.scale));
    if (Math.abs(fit.scale - 1) < 0.01) break;
  }
  return dist;
}

/**
 * Half height (m) for the plan camera so the whole room fits: the larger
 * room side plus a 1 m margin vertically, and the room width plus a 1 m
 * margin horizontally given the container aspect. Never smaller than the
 * desktop framing (`max(wM, dM) / 2 + 1`).
 */
export function planHalfHeight(wM: number, dM: number, aspect: number): number {
  const safeAspect = Math.max(0.01, aspect);
  return Math.max(Math.max(wM, dM) / 2 + 1, (wM / 2 + 1) / safeAspect);
}
