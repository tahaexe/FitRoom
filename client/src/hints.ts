/**
 * Post-build hint rules (pure, headless-testable; `check:guidance` pins
 * them). After "Build my room" only the empty-room hint shows: the door
 * tip appears only when the room has no door and no window. The four-moment
 * guide (`guide.ts`) decides its own moments; while its bubble shows, both
 * hints below stay hidden (`check:guidance` pins the three never show
 * together).
 */

import type { Opening } from "@fitroom/shared";

/** Empty-room hint lead-in: no "on the left" (the catalog is a bottom sheet on phones). */
export const EMPTY_HINT_TEXT = "This room is empty. Add furniture from the catalog, or ";

/** True when the "add your door and windows" tip applies: no door and no window yet. */
export function needsDoorTip(openings: Array<Pick<Opening, "type">>): boolean {
  return !openings.some((o) => o.type === "door" || o.type === "window");
}
