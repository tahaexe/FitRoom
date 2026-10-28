/**
 * `npm run check:example-room` — headless example-room check (no browser,
 * no Meta calls).
 *
 * - the example truth is 420 and 360 with the example note (only wall A is
 *   prefilled; wall B stays empty so the solver estimates it from the
 *   photos), the built room is named "Example room (generated photos)", and
 *   every example badge is "Generated example";
 * - the example urls are local assets (no upstream fetch) and `tryExample`
 *   replays every analysis from the demo store (its block holds no `/api/`
 *   call and never forces Live);
 * - the confirm view names the truth with the app's own numbers
 *   (`Measured 4xx × 3xx cm · the example room is 420 × 360 cm`), shows
 *   each wall's source and ± with the truth beside it in the example, and
 *   shows each opening's width ±;
 * - the demo store holds segment and label answers for the replay, and the
 *   taped 420 cm wall sits within 5 % of 420 cm.
 * - Demo mode in the example room's built layout: Arrange replays its own
 *   recorded chips in place and Recommend asks in place (never the sample
 *   room, never Live AI — demo mode sends no live header, so the answers
 *   come from the demo store with zero upstream calls); Furnish and
 *   Visualise, which have no recording yet, show one miss card each with
 *   "Use the sample room" and "Turn on Live AI" (the same words in the
 *   assistant, Recommend and Visualise);
 * - the sample room's orbit case: Visualise moves the camera back to the
 *   recorded view before capturing and the answer names it with "Showing
 *   the recorded view".
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
import {
  exampleTruthFor,
  openingBoxText,
  openingBoxTextWithPm,
  wallPillText,
} from "../src/editor/photo-confirm.js";

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
  check("example truth B is 360", EXAMPLE_TAPE_B === "360", EXAMPLE_TAPE_B);
  check(
    "example tape note names the taped wall and the estimate",
    EXAMPLE_TAPE_NOTE.includes("420") && EXAMPLE_TAPE_NOTE.toLowerCase().includes("estimate"),
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
    "the example truth sits within 5 % of 420 × 360 cm",
    withinFivePercent(tapeA, 420) && withinFivePercent(tapeB, 360),
    `${EXAMPLE_TAPE_A} × ${EXAMPLE_TAPE_B}`,
  );
  // The confirm view renders these strings from the same view code the
  // shopper sees (`photo-confirm.ts`): each wall with its source and ± and
  // the truth beside it in the example, each opening with its width ±.
  check(
    "confirm pill shows a measured wall",
    wallPillText("A", 420, "measured", undefined, 420) ===
      "Wall A · measured 420 cm · truth 420 cm",
    wallPillText("A", 420, "measured", undefined, 420),
  );
  check(
    "confirm pill shows an estimated wall with its ± and truth",
    wallPillText("B", 362, "estimated", 9, 360) === "Wall B · estimated 362 ± 9 cm · truth 360 cm",
    wallPillText("B", 362, "estimated", 9, 360),
  );
  check(
    "confirm pill shows the source away from the example",
    wallPillText("B", 362, "estimated", 9) === "Wall B · estimated 362 ± 9 cm",
    wallPillText("B", 362, "estimated", 9),
  );
  check(
    "example truth is 420 on A/C and 360 on B/D",
    exampleTruthFor("A") === 420 &&
      exampleTruthFor("C") === 420 &&
      exampleTruthFor("B") === 360 &&
      exampleTruthFor("D") === 360,
    `A ${String(exampleTruthFor("A"))} B ${String(exampleTruthFor("B"))}`,
  );
  check(
    "confirm opening tag shows its width ±",
    openingBoxTextWithPm("door", 100, 210, 3) === "Door 100 ± 3 × 210",
    openingBoxTextWithPm("door", 100, 210, 3),
  );
  check(
    "a measured opening tag keeps the plain shape",
    openingBoxTextWithPm("window", 120, 140) === openingBoxText("window", 120, 140),
    openingBoxTextWithPm("window", 120, 140),
  );

  const flowSource = readFileSync(join(clientDir, "src", "photo-room", "flow.ts"), "utf8");
  const tryAt = flowSource.indexOf("async tryExample");
  const tryEnd = flowSource.indexOf("private currentLetter");
  const tryBlock = tryAt >= 0 && tryEnd > tryAt ? flowSource.slice(tryAt, tryEnd) : "";
  check("the flow offers Try the example room", flowSource.includes("Try the example room"));
  check(
    "tryExample prefills only wall A and leaves B empty to estimate",
    tryBlock.includes("EXAMPLE_TAPE_A") &&
      tryBlock.includes("this.tapeB = ") &&
      !tryBlock.includes("EXAMPLE_TAPE_B"),
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

  // ---- Item 3: example-room demo replay, miss cards, orbit recorded view ----
  const assistantSource = readFileSync(join(clientDir, "src", "assistant", "panel.ts"), "utf8");
  const recommendSource = readFileSync(join(clientDir, "src", "recommend", "panel.ts"), "utf8");
  const viewerSource = readFileSync(join(clientDir, "src", "render", "viewer.ts"), "utf8");
  const appSource = readFileSync(join(clientDir, "src", "main.ts"), "utf8");
  const apiSource = readFileSync(join(clientDir, "src", "api.ts"), "utf8");

  const region = (source: string, start: string, end: string): string => {
    const at = source.indexOf(start);
    if (at < 0) return "";
    const stop = source.indexOf(end, at + start.length);
    return stop < 0 ? "" : source.slice(at, stop);
  };

  // Arrange replays its own recordings in place in the example room.
  check(
    "the example room has its own two arrange chips",
    assistantSource.includes("EXAMPLE_ASSISTANT_DEMO_CHIPS") &&
      assistantSource.includes("ASSISTANT_DEMO_CHIPS[0]") &&
      assistantSource.includes("ASSISTANT_DEMO_CHIPS[5]"),
  );
  const sendDemo = region(assistantSource, "private async sendDemo", "private addSampleConfirm");
  check(
    "arrange replays in place in the example room",
    sendDemo.includes("isExampleRoom()") && sendDemo.includes("await this.send(text)"),
    sendDemo.slice(0, 120),
  );
  check(
    "arrange in the example room never resets or asks for the sample room",
    sendDemo.includes(
      "if (this.isExampleRoom()) {\n      this.pendingDemo = null;\n      await this.send(text);",
    ),
  );
  const sendFurnishDemo = region(
    assistantSource,
    "private async sendFurnishDemo",
    "private addFurnishUserLine",
  );
  check(
    "furnish runs in place in the example room",
    sendFurnishDemo.includes("isExampleRoom()") &&
      sendFurnishDemo.includes("await this.furnishTurn("),
  );
  check(
    "furnish in the example room never resets or asks for the sample room",
    sendFurnishDemo.includes(
      "if (this.isExampleRoom()) {\n      this.pendingDemo = null;\n      await this.furnishTurn(brief, buildBriefRequest(brief, note));",
    ),
  );
  check(
    "demo mode sends no live header (the store answers, zero upstream calls)",
    apiSource.includes("X-FitRoom-Live") && apiSource.includes("isLive()"),
  );

  // Recommend asks in place: the only reset is the miss card's way out.
  const resetUses = recommendSource.split("resetDemoRoom").length - 1;
  check(
    "recommend asks in place (reset only on the miss card)",
    resetUses === 2,
    `${String(resetUses)} resetDemoRoom use(s)`,
  );

  // One miss card each for Furnish and Visualise, same words everywhere.
  const arrangeMiss = region(assistantSource, "private addDemoMiss", "private addAnswer");
  const furnishMiss = region(assistantSource, "private addFurnishDemoMiss", "private logEl");
  const recommendMiss = recommendSource.slice(
    recommendSource.indexOf("private showNotice(message"),
  );
  const visualiseMiss = region(viewerSource, "private showDemoMiss", "private showNotice");
  for (const [name, card] of [
    ["assistant arrange", arrangeMiss],
    ["assistant furnish", furnishMiss],
    ["recommend", recommendMiss],
    ["visualise", visualiseMiss],
  ] as const) {
    check(
      `the ${name} miss card offers the sample room and live AI`,
      card.includes("Use the sample room") && card.includes("Turn on Live AI"),
    );
  }
  check(
    "no assistant/recommend/visualise card still says reset demo room",
    !assistantSource.includes("Reset demo room") &&
      !recommendSource.includes("Reset demo room") &&
      !viewerSource.includes("Reset demo room"),
  );

  // Sample-room orbit case: back to the recorded view, then render it.
  const recordedLine = /RECORDED_VIEW_LINE = "(.*)"/.exec(viewerSource)?.[1];
  check(
    "the recorded view line names the recorded view",
    recordedLine === "Showing the recorded view",
    recordedLine ?? "missing",
  );
  check(
    "visualise resets to the recorded view before capturing",
    viewerSource.includes("resetToRecordedView") &&
      viewerSource.indexOf("resetToRecordedView") < viewerSource.indexOf("getCapture()"),
  );
  const showAnswer = viewerSource.slice(viewerSource.indexOf("private showAnswer("));
  check("the answer names the recorded view it renders", showAnswer.includes("RECORDED_VIEW_LINE"));
  check(
    "the app hands visualise its recorded-view reset",
    appSource.includes("resetToRecordedView: () => this.resetToRecordedView()"),
  );
  const recordedReset = region(
    appSource,
    "private resetToRecordedView",
    "Follow the selected piece",
  );
  check(
    "the recorded-view reset is demo-only, sample-room-only, dollhouse-only",
    recordedReset.includes("isLive()") &&
      recordedReset.includes("SAMPLE_ROOM") &&
      recordedReset.includes("dollhouse") &&
      recordedReset.includes("frameDollhouse"),
  );

  // "Use the sample room" returns to Orbit and the first view, like the
  // first visit, so Visualise replays the recorded view.
  const resetDemo = region(appSource, "private resetDemoRoom", "True when live in the sample room");
  check(
    "the sample-room reset returns to Orbit",
    resetDemo.includes('this.mode !== "orbit"') && resetDemo.includes("this.setMode("),
    "resetDemoRoom must set Orbit mode",
  );
  check(
    "the sample-room reset reframes the first view",
    resetDemo.includes("this.resetView()"),
    "resetDemoRoom must call resetView (the first-view framing)",
  );

  // The demo store holds assistant, recommend and render answers.
  const storeCount = (route: string): number => {
    try {
      return readdirSync(join(repoRoot, "server", "data", "demo", route)).filter((n) =>
        n.endsWith(".json"),
      ).length;
    } catch {
      return 0;
    }
  };
  const assistantFiles = storeCount("assistant");
  const recommendFiles = storeCount("recommend");
  const renderFiles = storeCount("render");
  check(
    "the demo store holds assistant answers for the replay",
    assistantFiles >= 9,
    `${String(assistantFiles)} assistant file(s)`,
  );
  check(
    "the demo store holds recommend answers for the replay",
    recommendFiles >= 3,
    `${String(recommendFiles)} recommend file(s)`,
  );
  check(
    "the demo store holds the recorded visualisation",
    renderFiles >= 1,
    `${String(renderFiles)} render file(s)`,
  );

  console.log(
    failures === 0
      ? "check:example-room: all checks passed"
      : `check:example-room: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
