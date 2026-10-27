/**
 * `npm run check:photo-cards` — headless photo check card rules (no browser,
 * no Meta calls). The card copy and recovery rules live in the pure module
 * `client/src/photo-room/cards.ts` (no DOM), so this check pins them here:
 *
 * - an empty wall answer carries the solid-wall retake copy, an empty
 *   floor answer the floor-in-view retake copy (exact strings);
 * - after an empty wall or floor answer there is no "Try again"
 *   (retake-only), while time-outs, network errors, caps and anything else
 *   keep the retry;
 * - the carpet fallback fires only on an empty floor answer and its text
 *   decodes as floor instances;
 * - "Next wall" is primary only when every check passes; any ✕ makes
 *   "Retake" primary and "Next wall" secondary.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global process */
import {
  EDGE_AT_DOOR_COPY,
  FALLBACK_DECODE_CONCEPT,
  FLOOR_FALLBACK_CONCEPT,
  NO_FLOOR_MESSAGE,
  NO_WALL_MESSAGE,
  TWO_WALLS_COPY,
  bothCornersOk,
  errorRecovery,
  isEmptyAnswerText,
  nextIsPrimary,
} from "../src/photo-room/cards.js";

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

// Empty answers say what to do (exact shopper copy).
check(
  "empty wall says to photograph a solid wall",
  NO_WALL_MESSAGE ===
    "We couldn't find a solid wall. Photograph a wall that isn't all window or curtain, then retake.",
  NO_WALL_MESSAGE,
);
check(
  "empty floor says to get the floor in view",
  NO_FLOOR_MESSAGE ===
    "We couldn't find the floor. Get the floor in front of the wall in view and well lit, then retake.",
  NO_FLOOR_MESSAGE,
);

// Empty means null, missing or whitespace-only text.
check("null text is empty", isEmptyAnswerText(null));
check("blank text is empty", isEmptyAnswerText("   \n "));
check("mask text is not empty", !isEmptyAnswerText("<0f>0<|box;x1=1|>"));

// After an empty wall or floor answer there is no "Try again".
check("empty wall is retake-only", errorRecovery(NO_WALL_MESSAGE) === "retake");
check("empty floor is retake-only", errorRecovery(NO_FLOOR_MESSAGE) === "retake");
// Time-outs, network errors, caps and anything else keep the retry.
check("a time-out keeps its retry", errorRecovery("The request timed out. Try again.") === "retry");
check(
  "an unreachable backend keeps its retry",
  errorRecovery("The AI service is unreachable.") === "retry",
);
check(
  "a cap keeps its retry",
  errorRecovery("The live AI is resting; try the demo room.") === "retry",
);
check("anything else keeps its retry", errorRecovery("Something else broke.") === "retry");

// The carpet fallback fires only on an empty floor and decodes as floor.
check("the fallback asks the carpet concept", FLOOR_FALLBACK_CONCEPT === "carpet");
check("the fallback decodes as floor", FALLBACK_DECODE_CONCEPT === "floor");

// "Next wall" is primary only when every check passes.
check(
  "next wall is primary when every check passes",
  nextIsPrimary({ bothCornersFound: true, floorLineFound: true }),
);
check(
  "a missing corner makes retake primary",
  !nextIsPrimary({ bothCornersFound: false, floorLineFound: true }),
);
check(
  "a hidden floor line makes retake primary",
  !nextIsPrimary({ bothCornersFound: true, floorLineFound: false }),
);
check(
  "two failures make retake primary",
  !nextIsPrimary({ bothCornersFound: false, floorLineFound: false }),
);

// Two walls in view replaces the both-corners row; an edge-at-door is an
// amber note. A ✕ always makes "Retake" primary.
check(
  "two walls copy tells the shopper to face one wall",
  TWO_WALLS_COPY === "Two walls in view: stand square to one wall",
  TWO_WALLS_COPY,
);
check(
  "edge at door copy asks to check the corner next",
  EDGE_AT_DOOR_COPY === "A door is at the wall's edge: check that corner in the next step",
  EDGE_AT_DOOR_COPY,
);
check("two walls block both corners", !bothCornersOk(true, true));
check("clean corners stay ok", bothCornersOk(true, false));
check("missing corners stay missing", !bothCornersOk(false, false));
check(
  "two walls make retake primary",
  !nextIsPrimary({ bothCornersFound: bothCornersOk(true, true), floorLineFound: true }),
);

console.log(
  failures === 0
    ? "check:photo-cards: all checks passed"
    : `check:photo-cards: ${String(failures)} check(s) failed`,
);
process.exitCode = failures === 0 ? 0 : 1;
