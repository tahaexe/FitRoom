/**
 * Four-moment first-visit guide: one bubble at a time, each shown only when
 * its screen is there, never as an upfront slideshow. The state machine
 * below is pure (headless-testable; `check:guide` pins it) and the small
 * `GuideView` next to it only renders a bubble plus a soft ring around the
 * target — the rest of the page stays usable, nothing is blocked or dimmed.
 *
 * Moments:
 *  1. On the first-run dialog: "Start here: try the example room, or enter
 *     your own room size." → the "Try the example room" button.
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

export const GUIDE_TEXT_1 = "Start here: try the example room, or enter your own room size.";
export const GUIDE_TEXT_2 = "Add a piece from the catalog.";
export const GUIDE_TEXT_2_PHONE = "Open the catalog and add a piece.";
export const GUIDE_TEXT_3 = "Drag it around. Its outline shows whether it fits.";
export const GUIDE_TEXT_4 = "Let AI furnish the room for you.";

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
  /** The "Try the example room" button is on screen (the cards view, not the size form). */
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

  /** First paint: nothing when already seen, else the fitting moment only. */
  start(screen: GuideScreen): GuideMoment | null {
    if (this.hasSeen()) {
      this.active = false;
      this.moment = null;
      this.paused = null;
      return null;
    }
    this.active = true;
    this.paused = null;
    this.moment = fittingMoment(screen, 1);
    return this.moment;
  }

  /** Help: the tour again at the moment that fits the screen. */
  restart(screen: GuideScreen): GuideMoment | null {
    this.active = true;
    this.paused = null;
    this.storage.remove(GUIDE_KEY);
    this.moment = fittingMoment(screen, 1);
    return this.moment;
  }

  /** Room changes (menu, photo build, reload): never a missing target. */
  reevaluate(screen: GuideScreen): GuideMoment | null {
    if (!this.active) return null;
    if (this.moment !== null) {
      if (momentFits(this.moment, screen)) {
        this.paused = null;
        return this.moment;
      }
      this.paused = this.moment;
      this.moment = fittingMoment(screen, 1);
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
    this.moment = fittingMoment(screen, 1);
    return this.moment;
  }

  /** "Next": the next fitting moment (the real action also moves on). */
  next(screen: GuideScreen): GuideMoment | null {
    if (!this.active || this.moment === null) return this.moment;
    const following = fittingMoment(screen, (this.moment + 1) as GuideMoment);
    if (following !== null) this.moment = following;
    return this.moment;
  }

  /** Adding a piece moves on from the catalog moment. */
  advanceOnItemsAdded(screen: GuideScreen): GuideMoment | null {
    if (this.active && this.moment === 2 && screen.itemCount > 0) {
      this.moment = resolveMoment(screen, 3);
    }
    return this.moment;
  }

  /** Moving a piece moves on from the drag moment. */
  advanceOnPieceMoved(screen: GuideScreen): GuideMoment | null {
    if (this.active && this.moment === 3) {
      this.moment = resolveMoment(screen, 4);
    }
    return this.moment;
  }

  /** Escape / "Skip tour": the room keeps working as before. */
  skip(): void {
    this.active = false;
    this.moment = null;
    this.paused = null;
    this.storage.set(GUIDE_KEY, "skipped");
  }

  /** "Got it": the tour is done. */
  finish(): void {
    this.active = false;
    this.moment = null;
    this.paused = null;
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
export function placeBubble(
  target: GuideRect,
  bubble: GuideRect,
  viewport: GuideRect,
  margin: number = GUIDE_MARGIN_PX,
  gap: number = GUIDE_GAP_PX,
): GuidePlaced {
  const vw = Math.max(1, viewport.w);
  const vh = Math.max(1, viewport.h);
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
 *  1. the "Try the example room" button in the first-run dialog (both);
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
    this.ensure();
    const content = guideBubble(moment, isPhone);
    const text = this.bubble?.querySelector(".guide-text");
    if (text !== null && text !== undefined) text.textContent = content.text;
    const progress = this.bubble?.querySelector(".guide-progress");
    if (progress !== null && progress !== undefined) progress.textContent = content.progress;
    const action = this.bubble?.querySelector(".guide-next");
    if (action instanceof HTMLButtonElement) action.textContent = content.action;
    this.place();
    this.bubble?.removeAttribute("hidden");
    this.ring?.removeAttribute("hidden");
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

  private place(): void {
    if (this.bubble === null || this.ring === null || this.target === null) return;
    const rect = this.target.getBoundingClientRect();
    const pad = 6;
    this.ring.style.left = `${String(Math.max(2, rect.left - pad))}px`;
    this.ring.style.top = `${String(Math.max(2, rect.top - pad))}px`;
    this.ring.style.width = `${String(Math.max(1, rect.width + pad * 2))}px`;
    this.ring.style.height = `${String(Math.max(1, rect.height + pad * 2))}px`;
    const placed = placeBubble(
      { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      { x: 0, y: 0, w: this.bubble.offsetWidth, h: this.bubble.offsetHeight },
      { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight },
    );
    this.bubble.style.left = `${String(placed.left)}px`;
    this.bubble.style.top = `${String(placed.top)}px`;
    this.bubble.dataset["side"] = placed.side;
  }
}
