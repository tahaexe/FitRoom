/**
 * Example room: four generated photoreal photos of the sample room that a
 * visitor in demo mode can try at zero cost.
 *
 * The photos live in `client/public/assets/example-room/` (`a.webp` … is
 * wall A, `b.webp` wall B, `c.webp` wall C, `d.webp` wall D; every wall here
 * uses its generated photo). The flow analyses the matching `-seg.jpg`
 * (1280 px) and `-label.jpg` (640 px) JPEGs derived from those photos, whose
 * segment and label answers are recorded in the demo store — so the example
 * replays with no upstream call. Tapes come from the example's own tape
 * measurements (420 and 360).
 */

import type { WallLetter } from "@fitroom/shared";

/** Name of the room built from the example photos. */
export const EXAMPLE_ROOM_NAME = "Example room (generated photos)";

/** Tape values from the example's tape measurements. */
export const EXAMPLE_TAPE_A = "420";
export const EXAMPLE_TAPE_B = "360";

/** Tape note shown with the prefilled example value (B stays empty to estimate). */
export const EXAMPLE_TAPE_NOTE =
  "420 from the example's tape measurement. Wall B stays empty to estimate from the photos.";

/** Confirm-view line naming the example's true size. */
export const EXAMPLE_TRUE_SIZE_LINE = "the example room is 420 × 360 cm";

export interface ExampleWall {
  /** Example photo file (`a` is wall A) under `assets/example-room/`. */
  file: string;
  /** Badge on every example photo. */
  badge: "Generated example" | "Rendered example";
}

export const EXAMPLE_WALLS: Record<WallLetter, ExampleWall> = {
  A: { file: "a", badge: "Generated example" },
  B: { file: "b", badge: "Generated example" },
  C: { file: "c", badge: "Generated example" },
  D: { file: "d", badge: "Generated example" },
};

/** Downscaled example frames (every wall shares one frame). */
export const EXAMPLE_SEG_SIZE = { width: 1280, height: 951 };
export const EXAMPLE_LABEL_SIZE = { width: 640, height: 476 };

export function exampleWebpUrl(letter: WallLetter): string {
  return `assets/example-room/${EXAMPLE_WALLS[letter]?.file ?? letter.toLowerCase()}.webp`;
}

export function exampleSegUrl(letter: WallLetter): string {
  return `assets/example-room/${EXAMPLE_WALLS[letter]?.file ?? letter.toLowerCase()}-seg.jpg`;
}

export function exampleLabelUrl(letter: WallLetter): string {
  return `assets/example-room/${EXAMPLE_WALLS[letter]?.file ?? letter.toLowerCase()}-label.jpg`;
}

export function exampleBadge(letter: WallLetter): string {
  return EXAMPLE_WALLS[letter]?.badge ?? "Generated example";
}

export function isExampleRoom(name: string): boolean {
  return name === EXAMPLE_ROOM_NAME;
}

/** Confirm-view measured line with the app's own numbers. */
export function exampleMeasuredLine(measuredA: number, measuredB: number): string {
  return `Measured ${String(Math.round(measuredA))} × ${String(Math.round(measuredB))} cm · ${EXAMPLE_TRUE_SIZE_LINE}`;
}
