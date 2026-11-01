/**
 * One name per action + every judge-path state in plain words.
 *
 * Pure TypeScript, no DOM: every label below is the single source of truth.
 * UI modules (`flow.ts`, `photo-confirm.ts`, `editor.ts`, `main.ts`,
 * `catalog-ui.ts`, `assistant/panel.ts`, `recommend/panel.ts`,
 * `render/viewer.ts`, `first-open.ts`, `finishes.ts`, `plan-view.ts`,
 * `api.ts`) render from these constants, and `check:labels` /
 * `check:states` pin them. The README's conventions table mirrors
 * `STATES` (same order, same words).
 */

/** Stepper on every screen of the photo flow, confirm view included. */
export const FLOW_STEPS = ["Photograph", "Measure", "Confirm"] as const;

/** The flow's exit, everywhere. */
export const LEAVE = "Leave";

/** Header cart pill. Disabled while the photo flow or confirm view is open. */
export const ADD_TO_CART = "Add to cart";
export const CART_DISABLED_REASON = "Finish the photo flow first, then add to cart.";

/** Tape step's single forward button. */
export const TAPE_NEXT = "Next: confirm";

/** The confirm view (and size form) keeps this build name. */
export const BUILD_MY_ROOM = "Build my room";

/** Size form's plan-editor link: openings and exact walls, not rectangles. */
export const SHAPE_IN_EDITOR = "Doors, windows and exact walls: adjust them in the plan editor";

/** The one demo-miss / capped way out, named the same in every card. */
export const USE_SAMPLE_ROOM = "Use the sample room";
export const TURN_ON_LIVE = "Turn on Live AI";

/** Demo-miss + capped sentences name the same action as their button. */
export const DEMO_MISS_MESSAGE = `This answer isn't in the demo yet. ${USE_SAMPLE_ROOM} or turn on Live AI.`;
export const CAPPED_MESSAGE = `The live AI is resting. ${USE_SAMPLE_ROOM} or try again later.`;
export const NOT_READY_MESSAGE = `Not ready yet. ${USE_SAMPLE_ROOM} or turn on Live AI.`;

/** Photo flow copy. */
export const PHOTO_PICK = "Take or pick a photo";
export const PHOTO_READING = "Reading your photo…";
export const PHOTO_ANALYSING = "Analysing your photo…";
export const PHOTO_DEMO_MISS = "Measuring your photos uses Live AI (it calls Meta's models).";
export const TAPE_TITLE = "Two tape values";
export const TAPE_NOTE =
  "Measure at floor level, corner to corner. Leave one empty to estimate it from the photos.";
export const BUILD_SOLVING = "Solving your room…";
export const RETRY = "Try again";
export const RETAKE = "Retake";

/** Empty room + empty cart. */
export const EMPTY_ROOM_LEAD = "This room is empty. Add furniture from the catalog, or ";
export const EMPTY_ROOM_ACTION = "Furnish it for me";
export const CART_EMPTY = "Your cart is empty. Add furniture from the catalog.";
export const CART_EMPTY_ACTION = "Add furniture to the room first";

/** Demo-store line shown in the cart panel (and the demo product page). */
export const DEMO_STORE_LINE = "Demo store · invented products and prices";

/** Demo product page (`store.html`) and the `?add=` entry hint. */
export const STORE_SEE_IT = "See it in your room";
export const STORE_UNKNOWN = "That piece isn't in the demo store.";
export const STORE_OPEN_APP = "Open FitRoom";

/** Entry hint for a catalog card: names the piece, never a bare id. */
export function storeAddHint(name: string): string {
  return `Press + Add to put the ${name} in your room`;
}

/** Example photo view: the placed pieces drawn into the wall photo. */
export const PHOTO_VIEW_BUTTON = "See it in your photo";
export const PHOTO_VIEW_LINE =
  "Pieces drawn at true size, with the camera measured from this photo.";
export const PHOTO_VIEW_CLOSE = "Close photo view";

/** Portrait-phone hint under the photo: sideways is bigger. */
export const PHOTO_VIEW_ROTATE = "Turn your phone sideways for a bigger view.";

/** One line counting the pieces outside the current photo. */
export function photoViewOutside(count: number): string {
  if (count === 1) return "1 piece is outside this photo";
  return `${String(count)} pieces are outside this photo`;
}

/** Cart side panel and its actions. */
export const CART_PANEL_TITLE = "Your cart";
export const CART_CLOSE = "Close cart";
export const CART_DOWNLOAD = "Download list";
export const CART_DOWNLOAD_TITLE = "Download your cart as JSON";
export const CART_BROWSE_CATALOG = "Browse the catalog";
export const CART_FIT_OK = "✓ Everything fits";

/** Error fit line naming the count of pieces that name errors. */
export function cartFitError(count: number): string {
  if (count === 1) return "1 piece doesn't fit yet: fix it or add anyway";
  return `${String(count)} pieces don't fit yet: fix them or add anyway`;
}

/** Share-this-layout block in the cart panel. */
export const CART_SHARE_TITLE = "Share this layout";
export const CART_COPY_LINK = "Copy link";
export const CART_LINK_COPIED = "Link copied";
export const CART_SHARE_LABEL = "Shareable link";
export const SHARE_DIALOG_TEXT =
  "Open the shared layout? It replaces your current room; the sample room stays in the room menu.";
export const SHARE_OPEN = "Open";
export const SHARE_KEEP = "Keep my room";
export const SHARE_INVALID = "That share link didn't work. Use the sample room to start again.";

/** Arrange input placeholder: short enough to fit the field at 390 px. */
export const ARRANGE_PLACEHOLDER = "Arrange my room…";

/** Catalog search with no result. */
export function catalogEmptyText(query: string): string {
  const q = query.trim();
  if (q === "") return "Nothing in this category yet — try All.";
  return `No matches for “${q}”. Try a category: Sofas, Armchairs, Dining tables, Dining chairs, Coffee tables, Side tables, Beds, Wardrobes, Cabinets, Bookcases, Storage, TV units, Shelves, Decor or Rugs.`;
}

/** Live error notices always say what to do next. */
export const AI_UNREACHABLE = "The AI service is unreachable. Please try again.";
export const RENDER_FAILED = "The visualiser couldn't make an image just now. Please try again.";
export const RENDER_CAPTURE_FAILED = "The visualiser couldn't capture the view. Please try again.";
export const ASSISTANT_LOADING = "Asking Muse Spark…";
export const RECOMMEND_LOADING = "Asking Muse Spark…";
export const VISUALISING_PREFIX = "Visualising…";
export const RENDER_HIDE = "Hide";
export const RENDER_STILL_BUSY = "Still making your picture. It will appear here.";

/**
 * Unviewed confirm-view wall chip: what was found on that wall, one tap to
 * view it. `doors`/`windows` count the draft openings on the wall.
 */
export function wallFoundSummary(doors: number, windows: number): string {
  const total = doors + windows;
  if (total === 0) return "no openings found";
  const parts: string[] = [];
  if (doors === 1) parts.push("1 door");
  else if (doors > 1) parts.push(`${String(doors)} doors`);
  if (windows === 1) parts.push("1 window");
  else if (windows > 1) parts.push(`${String(windows)} windows`);
  return `${String(total)} opening${total === 1 ? "" : "s"} found (${parts.join(", ")})`;
}

/** Short chip variant used on the wall card itself. */
export function wallChipFound(doors: number, windows: number): string {
  const total = doors + windows;
  if (total === 0) return "no openings found";
  if (total === 1) return doors === 1 ? "1 door found" : "1 window found";
  return `${String(total)} openings found`;
}

/**
 * Bottom toolbar: every label renders from here (`main.ts` sets each
 * button's text from these constants; `check:toolbar` pins the markup,
 * the AI tag, the Orbit/Plan switch and the one-row width from the CSS).
 */
export const TOOLBAR_RECOMMEND = "Recommend";
export const TOOLBAR_ARRANGE = "Arrange";
export const TOOLBAR_VISUALISE = "Visualise";
export const TOOLBAR_AI_TAG = "AI";
export const TOOLBAR_GROUP_AI = "AI tools";
export const TOOLBAR_GROUP_VIEW = "View";
export const TOOLBAR_GROUP_TOOLS = "View tools";
export const TOOLBAR_GROUP_SELECTION = "Selection";
export const TOOLBAR_ORBIT = "Orbit";
export const TOOLBAR_PLAN = "Plan";
export const TOOLBAR_CLEARANCE = "Clearance";
export const TOOLBAR_RESET_VIEW = "Reset view";
export const TOOLBAR_ROTATE_LEFT = "⟲ 15°";
export const TOOLBAR_ROTATE_RIGHT = "⟳ 15°";
export const TOOLBAR_DELETE = "Delete";

export type WallLetter = "A" | "B" | "C" | "D";

/** Accessible name always starts with the visible words. */
export function resetTintLabel(): { visible: string; accessible: string } {
  return { visible: "Reset tint", accessible: "Reset tint: remove the wall tint" };
}

/** Plan-editor opening: visible `Door · 100 cm`, name starts with it. */
export function planOpeningName(kind: "door" | "window", letter: string, widthCm: number): string {
  const visible = `${kind === "door" ? "Door" : "Window"} · ${String(Math.round(widthCm))} cm`;
  return `${visible} on wall ${letter}`;
}

/** Confirm-view opening box: visible `Door 100 × 210`, name starts with it. */
export function confirmOpeningLabel(
  kind: "door" | "window",
  wall: WallLetter,
  visibleTag: string,
): string {
  return `${visibleTag} on wall ${wall}`;
}

export interface StateRow {
  id: string;
  where: string;
  text: string;
  action: string;
}

/**
 * Every empty, loading and error state on the judge path, in README order.
 * `text` is the exact sentence the screen shows (dynamic slots filled with
 * the example values below); `action` is the next step's button, or the
 * sentence's own verb when no button exists.
 */
export const STATES: StateRow[] = [
  {
    id: "setup",
    where: "First-run dialog",
    text: "Set up your room. Tell us your room size, use photos, or explore the sample room.",
    action: "Enter my room size",
  },
  {
    id: "setup-size",
    where: "Size form",
    text: "Enter your width and length to build your room.",
    action: BUILD_MY_ROOM,
  },
  {
    id: "photo-pick",
    where: "Photo flow",
    text: "Get both corners and the floor line in view.",
    action: PHOTO_PICK,
  },
  {
    id: "photo-reading",
    where: "Photo flow",
    text: PHOTO_READING,
    action: "Wait while Reading your photo",
  },
  {
    id: "photo-analysing",
    where: "Photo flow",
    text: PHOTO_ANALYSING,
    action: "Wait while Analysing your photo",
  },
  {
    id: "photo-no-wall",
    where: "Photo check",
    text: "We couldn't find a solid wall. Photograph a wall that isn't all window or curtain, then retake.",
    action: RETAKE,
  },
  {
    id: "photo-no-floor",
    where: "Photo check",
    text: "We couldn't find the floor. Get the floor in front of the wall in view and well lit, then retake.",
    action: RETAKE,
  },
  {
    id: "photo-error",
    where: "Photo check",
    text: "The request timed out. Try again.",
    action: RETRY,
  },
  {
    id: "photo-demo-miss",
    where: "Photo check",
    text: PHOTO_DEMO_MISS,
    action: TURN_ON_LIVE,
  },
  {
    id: "tape",
    where: "Tape step",
    text: TAPE_NOTE,
    action: TAPE_NEXT,
  },
  {
    id: "build-solving",
    where: "Build step",
    text: BUILD_SOLVING,
    action: "Wait while Solving your room",
  },
  {
    id: "build-error",
    where: "Build step",
    text: "Solving failed just now. Please try again.",
    action: RETRY,
  },
  {
    id: "confirm-todo",
    where: "Confirm view",
    text: "Wall C · 1 window found. Select the wall to view it.",
    action: "Wall C · 1 window found",
  },
  {
    id: "confirm-missing-photo",
    where: "Confirm view",
    text: "Wall C photo is not available. Select another wall.",
    action: "Select another wall",
  },
  {
    id: "empty-room",
    where: "Empty room",
    text: `${EMPTY_ROOM_LEAD}${EMPTY_ROOM_ACTION}.`,
    action: EMPTY_ROOM_ACTION,
  },
  {
    id: "catalog-empty",
    where: "Catalog search",
    text: catalogEmptyText("zzz-no-such-piece"),
    action: "Try a category",
  },
  {
    id: "assistant-loading",
    where: "AI panel",
    text: ASSISTANT_LOADING,
    action: "Wait while Asking Muse Spark",
  },
  {
    id: "assistant-demo-miss",
    where: "AI panel",
    text: DEMO_MISS_MESSAGE,
    action: USE_SAMPLE_ROOM,
  },
  {
    id: "assistant-error",
    where: "AI panel",
    text: AI_UNREACHABLE,
    action: "Please try again",
  },
  {
    id: "assistant-capped",
    where: "AI panel",
    text: CAPPED_MESSAGE,
    action: USE_SAMPLE_ROOM,
  },
  {
    id: "visualising",
    where: "Visualise",
    text: `${VISUALISING_PREFIX} 0s`,
    action: "Wait while Visualising",
  },
  {
    id: "visualise-failed",
    where: "Visualise",
    text: RENDER_FAILED,
    action: RETRY,
  },
  {
    id: "cart-empty",
    where: "Empty cart",
    text: CART_EMPTY,
    action: CART_EMPTY_ACTION,
  },
  {
    id: "cart-browse",
    where: "Cart panel",
    text: CART_EMPTY,
    action: CART_BROWSE_CATALOG,
  },
  {
    id: "share-invalid",
    where: "Shared layout link",
    text: SHARE_INVALID,
    action: USE_SAMPLE_ROOM,
  },
];

/** Inspector row that opens the piece in AR (AR-capable browsers only). */
export const INSPECTOR_SEE_IN_AR = "See it in AR";

/** AR layer: the tap opens it, Back closes it. */
export const AR_BACK_TO_ROOM = "Back to the room";

/** AR layer title names the piece shown at true size. */
export function arLayerTitle(name: string): string {
  return `${name} in your room`;
}
