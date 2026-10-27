/**
 * `npm run check:example-room` — headless example-room check (no browser,
 * no Meta calls).
 *
 * - the example tapes are 420 and 360 with the example note, the built room
 *   is named "Example room (generated photos)", and every example badge is
 *   "Generated example";
 * - the example urls are local assets (no upstream fetch) and `tryExample`
 *   replays every analysis from the demo store (its block holds no `/api/`
 *   call and never forces Live);
 * - the confirm view names the truth with the app's own numbers
 *   (`Measured 4xx × 3xx cm · the example room is 420 × 360 cm`);
 * - the demo store holds segment and label answers for the replay, and the
 *   taped 420 × 360 cm room sits within 5 % of 420 × 360 cm.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXAMPLE_LABEL_SIZE,
  EXAMPLE_ROOM_NAME,
  EXAMPLE_SEG_SIZE,
  EXAMPLE_TAPE_A,
  EXAMPLE_TAPE_B,
  EXAMPLE_TAPE_NOTE,
  EXAMPLE_TRUE_SIZE_LINE,
  EXAMPLE_WALLS,
  exampleBadge,
  exampleLabelUrl,
  exampleMeasuredLine,
  exampleSegUrl,
  exampleWebpUrl,
  isExampleRoom,
  type WallLetter,
} from "../src/photo-room/example.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");
const repoRoot = resolve(clientDir, "..");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const LETTERS = ["A", "B", "C", "D"] as const;

function withinFivePercent(measured: number, truth: number): boolean {
  return Math.abs(measured - truth) <= truth * 0.05;
}

function main(): void {
  check("example tape A is 420", EXAMPLE_TAPE_A === "420", EXAMPLE_TAPE_A);
  check("example tape B is 360", EXAMPLE_TAPE_B === "360", EXAMPLE_TAPE_B);
  check(
    "example tape note names the measurements",
    EXAMPLE_TAPE_NOTE.includes("420") && EXAMPLE_TAPE_NOTE.includes("360"),
    EXAMPLE_TAPE_NOTE,
  );
  check(
    "example room name is the generated-photos room",
    EXAMPLE_ROOM_NAME === "Example room (generated photos)",
    EXAMPLE_ROOM_NAME,
  );
  check(
    "the truth line names the 420 × 360 cm room",
    EXAMPLE_TRUE_SIZE_LINE === "the example room is 420 × 360 cm",
    EXAMPLE_TRUE_SIZE_LINE,
  );
  check("isExampleRoom matches the built room", isExampleRoom(EXAMPLE_ROOM_NAME));
  check("other rooms are not the example", !isExampleRoom("Sample living room"));

  let badgesOk = true;
  for (const letter of LETTERS) {
    const wall = (EXAMPLE_WALLS as Record<string, { badge: string }>)[letter];
    if (
      wall?.badge !== "Generated example" ||
      exampleBadge(letter as WallLetter) !== "Generated example"
    ) {
      badgesOk = false;
    }
  }
  check("every example photo badge is Generated example", badgesOk);

  let urlsOk = true;
  for (const letter of LETTERS) {
    const l = letter as WallLetter;
    const webp = exampleWebpUrl(l);
    const seg = exampleSegUrl(l);
    const label = exampleLabelUrl(l);
    if (
      !webp.startsWith("assets/example-room/") ||
      !webp.endsWith(".webp") ||
      !seg.startsWith("assets/example-room/") ||
      !seg.endsWith("-seg.jpg") ||
      !label.startsWith("assets/example-room/") ||
      !label.endsWith("-label.jpg") ||
      webp.includes("http") ||
      seg.includes("/api/") ||
      label.includes("/api/")
    ) {
      urlsOk = false;
    }
  }
  check("example photos are local assets (no upstream urls)", urlsOk);

  check(
    "example frames are the downscaled sizes",
    EXAMPLE_SEG_SIZE.width === 1280 &&
      EXAMPLE_SEG_SIZE.height === 951 &&
      EXAMPLE_LABEL_SIZE.width === 640 &&
      EXAMPLE_LABEL_SIZE.height === 476,
    `${String(EXAMPLE_SEG_SIZE.width)}x${String(EXAMPLE_SEG_SIZE.height)} / ${String(EXAMPLE_LABEL_SIZE.width)}x${String(EXAMPLE_LABEL_SIZE.height)}`,
  );

  check(
    "measured line at truth uses the app's own numbers",
    exampleMeasuredLine(420, 360) === "Measured 420 × 360 cm · the example room is 420 × 360 cm",
    exampleMeasuredLine(420, 360),
  );
  const offTruth = exampleMeasuredLine(415, 355);
  const offMatch = /^Measured (\d+) × (\d+) cm · the example room is 420 × 360 cm$/.exec(offTruth);
  check("measured line keeps the one-line truth shape off truth", offMatch !== null, offTruth);
  if (offMatch !== null) {
    const measuredA = Number(offMatch[1]);
    const measuredB = Number(offMatch[2]);
    check(
      "off-truth example numbers sit within 5 % of 420 × 360 cm",
      withinFivePercent(measuredA, 420) && withinFivePercent(measuredB, 360),
      offTruth,
    );
  }
  const tapeA = Number(EXAMPLE_TAPE_A);
  const tapeB = Number(EXAMPLE_TAPE_B);
  check(
    "the taped 420 × 360 cm room is within 5 % of 420 × 360 cm",
    withinFivePercent(tapeA, 420) && withinFivePercent(tapeB, 360),
    `${EXAMPLE_TAPE_A} × ${EXAMPLE_TAPE_B}`,
  );

  const flowSource = readFileSync(join(clientDir, "src", "photo-room", "flow.ts"), "utf8");
  const tryAt = flowSource.indexOf("async tryExample");
  const tryEnd = flowSource.indexOf("private currentLetter");
  const tryBlock = tryAt >= 0 && tryEnd > tryAt ? flowSource.slice(tryAt, tryEnd) : "";
  check("the flow offers Try the example room", flowSource.includes("Try the example room"));
  check(
    "tryExample prefills the example tapes",
    tryBlock.includes("EXAMPLE_TAPE_A") && tryBlock.includes("EXAMPLE_TAPE_B"),
  );
  check(
    "the example build names the example room",
    flowSource.includes("EXAMPLE_ROOM_NAME") && flowSource.includes("exampleMode"),
  );
  check(
    "tryExample replays from the demo store without an upstream call",
    tryBlock.includes("exampleSegUrl") &&
      tryBlock.includes("exampleLabelUrl") &&
      tryBlock.includes("analyse(") &&
      !tryBlock.includes("/api/") &&
      !tryBlock.includes("x-fitroom-live"),
    tryBlock.slice(0, 120),
  );

  const confirmSource = readFileSync(join(clientDir, "src", "editor", "photo-confirm.ts"), "utf8");
  check(
    "the confirm view lines the example up against its truth",
    confirmSource.includes("exampleMeasuredLine") && confirmSource.includes("isExampleRoom"),
    "missing example helpers",
  );
  check(
    "the confirm view badges every example photo",
    confirmSource.includes("exampleBadge") && confirmSource.includes("photo-example-badge"),
  );

  let segmentFiles: string[] = [];
  let labelFiles: string[] = [];
  try {
    segmentFiles = readdirSync(join(repoRoot, "server", "data", "demo", "segment")).filter((n) =>
      n.endsWith(".json"),
    );
  } catch {
    // Keep the empty list: the check below reports the missing store.
  }
  try {
    labelFiles = readdirSync(join(repoRoot, "server", "data", "demo", "label")).filter((n) =>
      n.endsWith(".json"),
    );
  } catch {
    // Keep the empty list: the check below reports the missing store.
  }
  check(
    "the demo store holds segment answers for the replay",
    segmentFiles.length >= 4,
    `${String(segmentFiles.length)} segment file(s)`,
  );
  check(
    "the demo store holds label answers for the replay",
    labelFiles.length >= 1,
    `${String(labelFiles.length)} label file(s)`,
  );

  console.log(
    failures === 0
      ? "check:example-room: all checks passed"
      : `check:example-room: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
