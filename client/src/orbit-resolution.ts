/**
 * Adaptive orbit resolution with settle hysteresis.
 *
 * Pure (no DOM, no WebGL): per frame the caller passes whether the camera
 * moved, the previous frame's cost and the current time, and gets back the
 * pixel-ratio scale to apply *before* drawing that frame. All buffer-size
 * changes therefore land before `renderer.render`, never between a draw
 * and the browser showing it.
 *
 * - Enters reduced-resolution motion mode only on real camera motion.
 * - Leaves it only after the camera has been still for ORBIT_STILL_MS, by
 *   returning ORBIT_MAX_SCALE so the exit frame itself draws full-res.
 * - Changes the scale at most once per ORBIT_MIN_INTERVAL_MS, so it never
 *   flips back and forth on consecutive frames (e.g. the damping-glide
 *   tail where `controls.update()` alternates moved/not-moved).
 * - While moving, nudges the scale so frame cost stays under budget.
 */

export const ORBIT_START_SCALE = 0.75;
export const ORBIT_MIN_SCALE = 0.5;
export const ORBIT_MAX_SCALE = 1.0;
export const ORBIT_FRAME_BUDGET_MS = 16;
export const ORBIT_STILL_MS = 200;
export const ORBIT_MIN_INTERVAL_MS = 250;

const ORBIT_DOWN_STEP = 0.1;
const ORBIT_UP_STEP = 0.05;

export class OrbitResolutionController {
  private scaleValue = ORBIT_MAX_SCALE;
  private motion = false;
  private emaMs = 0;
  private lastMotionMs = Number.NEGATIVE_INFINITY;
  private lastChangeMs = Number.NEGATIVE_INFINITY;

  /** Current scale to apply (basePixelRatio * scale). */
  get scale(): number {
    return this.scaleValue;
  }

  /** True while the camera is moving or still settling. */
  get inMotion(): boolean {
    return this.motion;
  }

  /**
   * Decide this frame's scale. Call at the start of the frame, apply the
   * returned scale before rendering.
   */
  update(moved: boolean, frameCostMs: number, nowMs: number): number {
    const cost = Number.isFinite(frameCostMs) && frameCostMs >= 0 ? frameCostMs : 0;
    if (moved) {
      if (!this.motion) {
        this.motion = true;
        this.emaMs = cost;
        this.lastMotionMs = nowMs;
        return this.apply(ORBIT_START_SCALE, nowMs);
      }
      this.lastMotionMs = nowMs;
      this.emaMs = this.emaMs === 0 ? cost : this.emaMs * 0.8 + cost * 0.2;
      if (nowMs - this.lastChangeMs < ORBIT_MIN_INTERVAL_MS) return this.scaleValue;
      if (this.scaleValue > ORBIT_START_SCALE) return this.apply(ORBIT_START_SCALE, nowMs);
      if (this.emaMs > ORBIT_FRAME_BUDGET_MS + 0.5) {
        return this.apply(this.scaleValue - ORBIT_DOWN_STEP, nowMs);
      }
      if (this.emaMs < ORBIT_FRAME_BUDGET_MS - 4) {
        return this.apply(this.scaleValue + ORBIT_UP_STEP, nowMs);
      }
      return this.scaleValue;
    }
    if (!this.motion) {
      if (this.scaleValue !== ORBIT_MAX_SCALE) return this.apply(ORBIT_MAX_SCALE, nowMs);
      return this.scaleValue;
    }
    if (nowMs - this.lastMotionMs < ORBIT_STILL_MS) return this.scaleValue;
    if (nowMs - this.lastChangeMs < ORBIT_MIN_INTERVAL_MS) return this.scaleValue;
    this.motion = false;
    this.emaMs = 0;
    return this.apply(ORBIT_MAX_SCALE, nowMs);
  }

  private apply(next: number, nowMs: number): number {
    const clamped = Math.min(ORBIT_MAX_SCALE, Math.max(ORBIT_MIN_SCALE, next));
    if (clamped === this.scaleValue) return this.scaleValue;
    this.scaleValue = clamped;
    this.lastChangeMs = nowMs;
    return this.scaleValue;
  }
}
