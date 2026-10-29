/**
 * Phone bottom sheets: on a phone every panel (catalog, Inspector,
 * Recommend, Arrange/Furnish, Visualise) opens as a bottom sheet with a
 * drag handle, three heights (closed, peek about 40 %, full about 88 %),
 * swipe-down or Esc to close, one sheet at a time, and the room stays
 * visible and usable above a peek sheet.
 *
 * Pure DOM (no three.js): the app routes its panel state through
 * `PhoneSheets` when `isPhoneViewport()` matches (width ≤ 720 px, or
 * landscape height ≤ 500 px); the desktop path never touches it.
 */

/** Phone = width ≤ 720 px, or landscape height ≤ 500 px. */
export const PHONE_MEDIA = "(max-width: 720px), (max-height: 500px) and (orientation: landscape)";

/** Bottom-bar buttons on a phone: Catalog, AI, Visualise, cart summary. */
export const PHONE_BAR_LABELS = ["Catalog", "AI", "Visualise"] as const;

/** The ⋯ menu in the 48 px phone top bar. */
export const PHONE_MENU_LABELS = [
  "Plan",
  "Clearance",
  "Reset view",
  "Edit room",
  "Credits",
] as const;

/** The AI menu in the 56 px phone bottom bar. */
export const PHONE_AI_MENU_LABELS = ["Arrange", "Furnish", "Recommend"] as const;

/** Inspector toggle for the position fields on a phone. */
export const INSPECTOR_MORE_LABEL = "More";

export type PhoneSheetName =
  "catalog" | "inspector" | "recommend" | "assistant" | "render" | "cart";
export type PhoneSheetSize = "peek" | "full";

export function isPhoneViewport(): boolean {
  try {
    return window.matchMedia(PHONE_MEDIA).matches;
  } catch {
    return false;
  }
}

/** Bottom-sheet state for the five phone panels. */
export class PhoneSheets {
  private openName: PhoneSheetName | null = null;
  private size: PhoneSheetSize = "peek";
  private dragY: number | null = null;
  private dragged = false;

  constructor(private readonly els: Record<PhoneSheetName, HTMLElement | null>) {
    for (const name of Object.keys(els) as PhoneSheetName[]) {
      const el = els[name];
      if (el !== null) this.ensureHandle(el, name);
    }
    // A panel's own × button hides it directly: drop the sheet state too.
    const sync = (): void => {
      const open = this.openName;
      if (open !== null) {
        const el = this.els[open];
        if (el !== null && el.hasAttribute("hidden")) {
          this.openName = null;
          this.syncBody();
        }
      }
    };
    for (const el of Object.values(els)) {
      if (el !== null) {
        new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ["hidden"] });
      }
    }
  }

  isOpen(name: PhoneSheetName): boolean {
    return this.openName === name;
  }

  /** Open one sheet at peek (closing any other), or full. */
  open(name: PhoneSheetName, size: PhoneSheetSize = "peek"): void {
    if (!isPhoneViewport()) return;
    for (const key of Object.keys(this.els) as PhoneSheetName[]) {
      if (key !== name) this.els[key]?.setAttribute("hidden", "");
    }
    const el = this.els[name];
    if (el === null) return;
    el.removeAttribute("hidden");
    el.dataset["sheet"] = size;
    this.openName = name;
    this.size = size;
    this.syncBody();
  }

  close(): boolean {
    if (this.openName === null) return false;
    this.els[this.openName]?.setAttribute("hidden", "");
    this.els[this.openName]?.removeAttribute("data-sheet");
    this.openName = null;
    this.syncBody();
    return true;
  }

  toggle(name: PhoneSheetName, size: PhoneSheetSize = "peek"): void {
    if (this.openName === name) {
      this.close();
    } else {
      this.open(name, size);
    }
  }

  /** Desktop again: drop every sheet attribute so panels act as before. */
  resetToDesktop(): void {
    for (const el of Object.values(this.els)) el?.removeAttribute("data-sheet");
    this.openName = null;
    document.body.removeAttribute("data-sheet-open");
    document.body.removeAttribute("data-sheet-size");
  }

  private syncBody(): void {
    if (this.openName === null) {
      document.body.removeAttribute("data-sheet-open");
      document.body.removeAttribute("data-sheet-size");
    } else {
      document.body.setAttribute("data-sheet-open", "true");
      document.body.setAttribute("data-sheet-size", this.size);
    }
  }

  private ensureHandle(el: HTMLElement, name: PhoneSheetName): void {
    if (el.querySelector(":scope > .sheet-handle") !== null) return;
    const handle = document.createElement("div");
    handle.className = "sheet-handle";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", "Drag to resize the panel");
    handle.addEventListener("pointerdown", (event) => {
      if (!isPhoneViewport()) return;
      this.dragY = event.clientY;
      this.dragged = false;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Capture may be unavailable; the drag still ends on pointerup.
      }
    });
    handle.addEventListener("pointermove", (event) => {
      if (this.dragY === null || !isPhoneViewport()) return;
      if (Math.abs(event.clientY - this.dragY) > 8) this.dragged = true;
    });
    handle.addEventListener("pointerup", (event) => {
      if (this.dragY === null || !isPhoneViewport()) return;
      const dy = event.clientY - this.dragY;
      this.dragY = null;
      if (!this.dragged) {
        // Tap the handle: peek ↔ full.
        this.open(name, this.size === "peek" ? "full" : "peek");
        return;
      }
      this.dragged = false;
      if (dy > 80) this.close();
      else if (dy < -80) this.open(name, "full");
    });
    el.prepend(handle);
  }
}
