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
 * - the guide's B/D sides match the wall table through rule 4 (B on the
 *   left as you face wall A, D on the right), and rule 2 reads the same in
 *   `types.ts` and the README.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LETTER_TO_WALL_ID } from "@fitroom/shared";
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

// The guide's B/D sides match the wall table through rule 4: facing wall A
// (wall-1, the south wall) from inside means facing -z, and rule 4 (facing
// +z, +x is on the left) puts -x on the left there — the west wall (wall-4).
// The guide must put B on the left (wall-4) and D on the right (wall-2).
const RULE_2 =
  "Letters run counter-clockwise seen from inside: A = wall-1 (the entrance door), B = wall-4 (on the left as you face A), C = wall-3 (opposite A), D = wall-2 (on the right as you face A)";
{
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..");
  const flowSource = readFileSync(join(repoRoot, "client", "src", "photo-room", "flow.ts"), "utf8");
  const typesSource = readFileSync(
    join(repoRoot, "shared", "src", "photo-room", "types.ts"),
    "utf8",
  );
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const sideOf = (letter: "B" | "D"): string | null => {
    const match = flowSource.match(
      new RegExp(`${letter}:\\s*"Wall ${letter}[^"]*on the (left|right) as you face wall A"`),
    );
    return match?.[1] ?? null;
  };
  const bSide = sideOf("B");
  const dSide = sideOf("D");
  check("guide puts wall B on a side", bSide === "left" || bSide === "right", `B: ${bSide ?? "?"}`);
  check("guide puts wall D on a side", dSide === "left" || dSide === "right", `D: ${dSide ?? "?"}`);
  // Rule 4: facing +z, +x is on the left, so left(fx, fz) = (fz, -fx).
  // Facing wall-1 from inside is facing -z (0, -1): left is (-1, 0), west.
  const left: [number, number] = [-1, 0];
  const expectedLeftId = left[0] < 0 ? "wall-4" : "wall-2";
  const expectedRightId = left[0] < 0 ? "wall-2" : "wall-4";
  const leftLetter = bSide === "left" ? "B" : dSide === "left" ? "D" : null;
  const rightLetter = bSide === "right" ? "B" : dSide === "right" ? "D" : null;
  check(
    "guide left letter maps to the wall on the left of wall-1",
    leftLetter !== null && LETTER_TO_WALL_ID[leftLetter] === expectedLeftId,
    `left: ${leftLetter ?? "?"} -> ${leftLetter === null ? "?" : LETTER_TO_WALL_ID[leftLetter]} (want ${expectedLeftId})`,
  );
  check(
    "guide right letter maps to the wall on the right of wall-1",
    rightLetter !== null && LETTER_TO_WALL_ID[rightLetter] === expectedRightId,
    `right: ${rightLetter ?? "?"} -> ${rightLetter === null ? "?" : LETTER_TO_WALL_ID[rightLetter]} (want ${expectedRightId})`,
  );
  check("types.ts rule 2 names the counter-clockwise letters", typesSource.includes(RULE_2));
  check("README rule 2 names the counter-clockwise letters", readme.includes(RULE_2));
}

console.log(
  failures === 0
    ? "check:photo-cards: all checks passed"
    : `check:photo-cards: ${String(failures)} check(s) failed`,
);
process.exitCode = failures === 0 ? 0 : 1;
