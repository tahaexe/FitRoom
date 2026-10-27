/**
 * `npm run check:orbit-resolution` — headless orbit-resolution check (no
 * browser, no Meta calls).
 *
 * Drives the real `OrbitResolutionController` plus a fake renderer through
 * a 2-second orbit, a damping tail where "moved" alternates every frame,
 * a pan, a wheel zoom and a window resize, applying every scale/size
 * change before the frame's draw the way `frame()` does. It fails when:
 * - any frame resizes after its draw;
 * - the scale changes on two consecutive frames (or within 250 ms);
 * - the view is not back at full resolution 300 ms after the last motion.
 *
 * It also guards the real `frame()` ordering in `client/src/main.ts`:
 * the resolution decision and every resize must come before
 * `renderer.render`, and `resize()` must defer to the next frame.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORBIT_MAX_SCALE,
  ORBIT_MIN_INTERVAL_MS,
  ORBIT_MIN_SCALE,
  ORBIT_START_SCALE,
  OrbitResolutionController,
} from "../src/orbit-resolution.js";

const here = dirname(fileURLToPath(import.meta.url));
const tmpDir = resolve(here, "..", "..", ".tmp", "orbit-resolution");

const FRAME_DT_MS = 1000 / 60;
const SETTLE_MS = 200;
const FULL_RES_AFTER_MS = 300;

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

/** Fake renderer: resizes are only legal before the frame's draw. */
class FakeRenderer {
  pixelRatio = 1;
  width = 0;
  height = 0;
  draws = 0;
  resizesAfterDraw = 0;
  private drawn = false;

  frameBegin(): void {
    this.drawn = false;
  }

  setPixelRatio(ratio: number): void {
    if (this.drawn) this.resizesAfterDraw += 1;
    this.pixelRatio = ratio;
  }

  setSize(width: number, height: number): void {
    if (this.drawn) this.resizesAfterDraw += 1;
    this.width = width;
    this.height = height;
  }

  render(): void {
    this.drawn = true;
    this.draws += 1;
  }
}

interface FrameRecord {
  index: number;
  nowMs: number;
  moved: boolean;
  scale: number;
}

function main(): void {
  mkdirSync(tmpDir, { recursive: true });

  const controller = new OrbitResolutionController();
  const renderer = new FakeRenderer();
  const basePixelRatio = 2;
  let appliedScale = -1;
  let cssWidth = 1548;
  const cssHeight = 800;
  let pendingResize = false;
  let nowMs = 0;
  let lastCostMs = 10;

  const frames: FrameRecord[] = [];
  const changeFrames: FrameRecord[] = [];

  // Scenario: a 2 s orbit, an alternating damping tail, a pan, a wheel
  // zoom, a window resize mid-orbit, then still air to settle.
  const movedPlan: boolean[] = [];
  const costPlan: number[] = [];
  for (let i = 0; i < 120; i += 1) {
    movedPlan.push(true);
    costPlan.push(i % 2 === 0 ? 20 : 18);
  }
  for (let i = 0; i < 60; i += 1) {
    movedPlan.push(i % 2 === 0);
    costPlan.push(10);
  }
  for (let i = 0; i < 30; i += 1) {
    movedPlan.push(true);
    costPlan.push(12);
  }
  for (let i = 0; i < 12; i += 1) {
    movedPlan.push(true);
    costPlan.push(14);
  }
  for (let i = 0; i < 40; i += 1) {
    movedPlan.push(false);
    costPlan.push(8);
  }

  const resizeAtFrame = 60;
  let lastMotionNow = -1;
  renderer.setSize(cssWidth, cssHeight);

  for (let index = 0; index < movedPlan.length; index += 1) {
    const moved = movedPlan[index] ?? false;
    if (moved) lastMotionNow = nowMs;
    if (index === resizeAtFrame) pendingResize = true;

    renderer.frameBegin();
    // Window-resize path: applied at the frame start, before the draw.
    if (pendingResize) {
      pendingResize = false;
      cssWidth = 1161;
      renderer.setPixelRatio(basePixelRatio * controller.scale);
      renderer.setSize(cssWidth, cssHeight);
    }
    const scale = controller.update(moved, lastCostMs, nowMs);
    if (scale !== appliedScale) {
      renderer.setPixelRatio(basePixelRatio * scale);
      appliedScale = scale;
    }
    renderer.render();
    frames.push({ index, nowMs, moved, scale });
    const previous = changeFrames[changeFrames.length - 1];
    if (previous === undefined || previous.scale !== scale) {
      changeFrames.push({ index, nowMs, moved, scale });
    }
    lastCostMs = costPlan[index] ?? 8;
    nowMs += FRAME_DT_MS;
  }

  check("every frame drew", renderer.draws === movedPlan.length, `${String(renderer.draws)} draws`);
  check("no frame resized after its draw", renderer.resizesAfterDraw === 0);

  let consecutiveFlip = false;
  let intervalFlip = false;
  for (let i = 1; i < changeFrames.length; i += 1) {
    const prev = changeFrames[i - 1];
    const current = changeFrames[i];
    if (prev === undefined || current === undefined) continue;
    if (current.index === prev.index + 1) consecutiveFlip = true;
    if (current.nowMs - prev.nowMs < ORBIT_MIN_INTERVAL_MS - 0.5) intervalFlip = true;
  }
  check("the scale never changes on consecutive frames", !consecutiveFlip);
  check("the scale changes at most once per 250 ms", !intervalFlip);

  // The alternating damping tail must not flap: at most a handful of
  // changes across its 60 frames.
  const tailStart = 120;
  const tailEnd = 180;
  const tailChanges = changeFrames.filter((f) => f.index >= tailStart && f.index < tailEnd);
  check(
    "the damping tail does not flap the resolution",
    tailChanges.length <= 4,
    `${String(tailChanges.length)} tail change(s)`,
  );

  const settled = frames.filter((f) => f.nowMs >= lastMotionNow + FULL_RES_AFTER_MS);
  const allFull = settled.length > 0 && settled.every((f) => f.scale === ORBIT_MAX_SCALE);
  const firstSettled = settled[0];
  check(
    "the view is back at full resolution 300 ms after the last motion",
    allFull,
    firstSettled === undefined ? "no settled frames" : `scale ${String(firstSettled.scale)}`,
  );

  // Steady-cost scenarios: constant motion with a constant frame cost.
  // Cheap stays cheap so the scale climbs to 1.0 and sticks; expensive
  // stays expensive so it sinks to 0.5 and sticks. Both start at 0.75.
  interface SteadyRun {
    scales: number[];
    times: number[];
    changes: FrameRecord[];
  }

  function runSteady(costMs: number, totalFrames: number): SteadyRun {
    const ctrl = new OrbitResolutionController();
    const scales: number[] = [];
    const times: number[] = [];
    const changes: FrameRecord[] = [];
    let t = 0;
    for (let i = 0; i < totalFrames; i += 1) {
      const scale = ctrl.update(true, costMs, t);
      scales.push(scale);
      times.push(t);
      const prev = changes[changes.length - 1];
      if (prev === undefined || prev.scale !== scale) {
        changes.push({ index: i, nowMs: t, moved: true, scale });
      }
      t += FRAME_DT_MS;
    }
    return { scales, times, changes };
  }

  function directionChangeTimes(changes: FrameRecord[]): number[] {
    const times: number[] = [];
    let prevDir = 0;
    for (let i = 1; i < changes.length; i += 1) {
      const prev = changes[i - 1];
      const current = changes[i];
      if (prev === undefined || current === undefined) continue;
      const delta = current.scale - prev.scale;
      const dir = delta > 0 ? 1 : delta < 0 ? -1 : 0;
      if (dir === 0) continue;
      if (prevDir !== 0 && dir !== prevDir) times.push(current.nowMs);
      prevDir = dir;
    }
    return times;
  }

  function maxDirectionChangesPerSecond(changeTimes: number[]): number {
    let max = 0;
    for (let i = 0; i < changeTimes.length; i += 1) {
      const start = changeTimes[i];
      if (start === undefined) continue;
      let count = 0;
      for (let j = i; j < changeTimes.length; j += 1) {
        const t = changeTimes[j];
        if (t === undefined) continue;
        if (t - start < 1000 - 0.5) count += 1;
        else break;
      }
      if (count > max) max = count;
    }
    return max;
  }

  const cheap = runSteady(8, 400);
  const expensive = runSteady(20, 400);

  check(
    "steady cheap motion starts at 0.75",
    cheap.scales[0] === ORBIT_START_SCALE,
    `scale ${String(cheap.scales[0])}`,
  );
  check(
    "steady expensive motion starts at 0.75",
    expensive.scales[0] === ORBIT_START_SCALE,
    `scale ${String(expensive.scales[0])}`,
  );

  const cheapTail = cheap.scales.slice(1);
  const cheapRisesOnly = cheapTail.every((s, i) => i === 0 || s >= (cheapTail[i - 1] ?? 0) - 1e-9);
  check("steady cheap cost only raises the scale", cheapRisesOnly);
  const cheapInRange = cheap.scales.every(
    (s) => s >= ORBIT_MIN_SCALE - 1e-9 && s <= ORBIT_MAX_SCALE + 1e-9,
  );
  check("steady cheap cost stays within 0.5 and 1.0", cheapInRange);
  const cheapEndsFull = cheap.scales[cheap.scales.length - 1] === ORBIT_MAX_SCALE;
  check("steady cheap cost reaches 1.0", cheapEndsFull);
  const cheapFirstFull = cheap.scales.findIndex((s) => s === ORBIT_MAX_SCALE);
  const cheapStaysFull =
    cheapFirstFull >= 0 && cheap.scales.slice(cheapFirstFull).every((s) => s === ORBIT_MAX_SCALE);
  check("steady cheap cost stays at 1.0 once there", cheapStaysFull);

  const expensiveFallsOnly = expensive.scales.every(
    (s, i) => i === 0 || s <= (expensive.scales[i - 1] ?? 0) + 1e-9,
  );
  check("steady expensive cost only lowers the scale", expensiveFallsOnly);
  const expensiveInRange = expensive.scales.every(
    (s) => s >= ORBIT_MIN_SCALE - 1e-9 && s <= ORBIT_MAX_SCALE + 1e-9,
  );
  check("steady expensive cost stays within 0.5 and 1.0", expensiveInRange);
  const expensiveEndsMin = expensive.scales[expensive.scales.length - 1] === ORBIT_MIN_SCALE;
  check("steady expensive cost reaches 0.5", expensiveEndsMin);
  const expensiveFirstMin = expensive.scales.findIndex((s) => s === ORBIT_MIN_SCALE);
  const expensiveStaysMin =
    expensiveFirstMin >= 0 &&
    expensive.scales.slice(expensiveFirstMin).every((s) => s === ORBIT_MIN_SCALE);
  check("steady expensive cost stays at 0.5 once there", expensiveStaysMin);

  const cheapReversals = directionChangeTimes(cheap.changes);
  const expensiveReversals = directionChangeTimes(expensive.changes);
  const mainReversals = directionChangeTimes(changeFrames);
  check(
    "steady cheap cost changes direction at most once per second",
    maxDirectionChangesPerSecond(cheapReversals) <= 1,
    `${String(cheapReversals.length)} reversal(s)`,
  );
  check(
    "steady expensive cost changes direction at most once per second",
    maxDirectionChangesPerSecond(expensiveReversals) <= 1,
    `${String(expensiveReversals.length)} reversal(s)`,
  );
  check(
    "the orbit scenario changes direction at most once per second",
    maxDirectionChangesPerSecond(mainReversals) <= 1,
    `${String(mainReversals.length)} reversal(s)`,
  );

  // Static guard: the real frame() must decide and resize before drawing.
  const mainTs = readFileSync(join(here, "..", "src", "main.ts"), "utf8");
  const frameAt = mainTs.indexOf("private frame()");
  const frameBody = frameAt < 0 ? "" : mainTs.slice(frameAt, frameAt + 9000);
  const decideAt = frameBody.indexOf("orbitResolution.update");
  const renderAt = frameBody.lastIndexOf("renderer.render");
  check("frame() decides the resolution via the controller", decideAt >= 0);
  check("frame() decides the resolution before drawing", decideAt >= 0 && renderAt > decideAt);
  const afterRender = renderAt < 0 ? "" : frameBody.slice(renderAt);
  const resizeAfterDraw = afterRender.includes("setPixelRatio") || afterRender.includes("setSize");
  check("frame() never resizes after drawing", !resizeAfterDraw);

  const resizeAt = mainTs.indexOf("private resize()");
  const resizeEnd = resizeAt < 0 ? -1 : mainTs.indexOf("\n  }\n", resizeAt);
  const resizeBody = resizeAt < 0 || resizeEnd < 0 ? "" : mainTs.slice(resizeAt, resizeEnd);
  check("resize() defers to the next frame", resizeBody.includes("pendingResize = true"));
  check(
    "resize() does not resize the buffer itself",
    !resizeBody.includes("renderer.setPixelRatio") && !resizeBody.includes("renderer.setSize"),
  );
  check("the settle hysteresis is 200 ms still", SETTLE_MS === 200);

  console.log(
    failures === 0
      ? "check:orbit-resolution: all checks passed"
      : `check:orbit-resolution: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
