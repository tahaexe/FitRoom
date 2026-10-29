/**
 * One heavy boot step per task.
 *
 * The setup screen's buttons must answer at once while the room builds
 * behind it, so `startStageLoads` never runs two heavy steps (wall/floor
 * maps, the room build, the stage, each model's parse and variant, the
 * shader precompile) back to back: every step runs, then the main thread
 * yields before the next begins. Pure TypeScript, no DOM at import time.
 */

/** Yield the main thread: idle time when available, else a zero time-out. */
export function yieldToUI(): Promise<void> {
  return new Promise((resolve) => {
    const scope = globalThis as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    };
    if (typeof scope.requestIdleCallback === "function") {
      scope.requestIdleCallback(() => resolve(), { timeout: 50 });
      return;
    }
    setTimeout(() => resolve(), 0);
  });
}

/**
 * Run each step, yielding between steps so no two heavy steps share a
 * task. Steps run in order; a rejection stops the queue. The room still
 * finishes on its own: every yield has a time-out, so progress never waits
 * on user input.
 */
export async function runOnePerTask(
  steps: ReadonlyArray<() => void | Promise<void>>,
  yieldTask: () => Promise<void> = yieldToUI,
): Promise<void> {
  for (let index = 0; index < steps.length; index += 1) {
    await steps[index]?.();
    if (index < steps.length - 1) await yieldTask();
  }
}
