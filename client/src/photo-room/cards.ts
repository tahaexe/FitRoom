/**
 * Photo check card copy and recovery rules. Pure TypeScript, no DOM: the
 * flow (`flow.ts`) renders from these and `check:photo-cards` pins them.
 *
 * - An empty `wall` or `floor` segment answer means the photo must be
 *   retaken (a retry would send the same request for the same answer), so
 *   the card shows the retake copy below with no "Try again". Time-outs,
 *   network errors and caps keep "Try again".
 * - The floor fallback asks once more with the concept `carpet`
 *   (`FLOOR_FALLBACK_CONCEPT`), only on an empty floor answer; the carpet
 *   text is decoded with `FALLBACK_DECODE_CONCEPT` so its instances join
 *   the floor mask. When both answers are empty and the photo is larger,
 *   the flow asks `floor` once more at up to 1920 px (`needsFloorSecondTry`)
 *   before the retake card shows.
 * - "Next wall" is the primary button only when every check passes; any
 *   ✕ makes "Retake" primary and "Next wall" secondary.
 */

/** Empty-wall answer: the photo needs retaking, not retrying. */
export const NO_WALL_MESSAGE =
  "We couldn't find a solid wall. Photograph a wall that isn't all window or curtain, then retake.";

/** Empty-floor answer (even after the carpet fallback): retake, don't retry. */
export const NO_FLOOR_MESSAGE =
  "We couldn't find the floor. Get the floor in front of the wall in view and well lit, then retake.";

/** Concept the server segments for the one-shot floor fallback. */
export const FLOOR_FALLBACK_CONCEPT = "carpet";

/**
 * The floor second try re-asks the `floor` concept itself (not the carpet
 * fallback), once, with the photo at up to 1920 px on its long side.
 */
export const FLOOR_SECOND_TRY_CONCEPT = "floor";

/**
 * True when the flow owes the photo one more floor call at a larger size:
 * the 1280 px `floor` and `carpet` answers both came back empty and a
 * larger photo exists. One extra call, only on that path.
 */
export function needsFloorSecondTry(
  floorEmpty: boolean,
  carpetEmpty: boolean,
  hasLargerPhoto: boolean,
): boolean {
  return floorEmpty && carpetEmpty && hasLargerPhoto;
}

/**
 * Concept the fallback text is decoded with, so its instances join the
 * floor mask the solver and the surface colours read.
 */
export const FALLBACK_DECODE_CONCEPT = "floor";

/** True for a null, missing or whitespace-only segment answer text. */
export function isEmptyAnswerText(text: string | null): boolean {
  return text === null || text.trim().length === 0;
}

/**
 * After an error the card offers "retry" (re-send the same request) or
 * "retake" (a new photo) only. Empty wall/floor answers are retake-only;
 * time-outs, network errors, caps and anything else keep the retry.
 */
export function errorRecovery(message: string): "retry" | "retake" {
  return message === NO_WALL_MESSAGE || message === NO_FLOOR_MESSAGE ? "retake" : "retry";
}

/** Corner row copy when the solver sees two walls in one frame. */
export const TWO_WALLS_COPY = "Two walls in view: stand square to one wall";

/** Amber row copy when the range edge lands on a door's jamb. */
export const EDGE_AT_DOOR_COPY = "A door is at the wall's edge: check that corner in the next step";

/**
 * True when the card may claim both corners: the corners sit inside the
 * frame and the solver did not flag two walls in view (a quad across the
 * corner never reads "Both corners found").
 */
export function bothCornersOk(bothFound: boolean, twoWallsInView: boolean): boolean {
  return bothFound && !twoWallsInView;
}

export interface CheckVerdict {
  bothCornersFound: boolean;
  floorLineFound: boolean;
}

/**
 * True when "Next wall" stays the primary button: every check passed. Any
 * ✕ makes "Retake" primary and "Next wall" secondary.
 */
export function nextIsPrimary(checks: CheckVerdict): boolean {
  return checks.bothCornersFound && checks.floorLineFound;
}
