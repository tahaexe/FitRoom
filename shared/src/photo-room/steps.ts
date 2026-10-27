/** Shared solver steps: used by `solveRoomFromPhotos` and the corner re-solve. */
import { widthHeightRatio } from "./geometry.js";
import type { Uncertain, WallLetter } from "./types.js";

export const DEFAULT_CEILING_CM = 250;

export function tapeForLetter(letter: WallLetter, tapeA: number, tapeB: number): number {
  return letter === "A" || letter === "C" ? tapeA : tapeB;
}

export interface CornerSet {
  m1: [number, number];
  m2: [number, number];
  m3: [number, number];
  m4: [number, number];
}

export interface WallHeightEstimate {
  ratio: number;
  ratioPlusMinus: number;
  heightEstimate: number;
  heightPlusMinus: number;
  wide: boolean;
  /** Unrounded ratio/height the ceiling blend weighs (solver-identical). */
  ratioRaw: number;
  heightRaw: number;
}

/**
 * Ratio + height for one wall from its four corners. Same arithmetic as the
 * solver: Zhang & He ratio with the default-ceiling fallback, uncertainty
 * from the two horizontal line noises over the wall pixel height, wider ±
 * on a 0.5x photo. Rounded exactly like the stored solution.
 */
export function estimateWallHeightFromCorners(args: {
  corners: CornerSet;
  width: number;
  height: number;
  focalPx: number;
  wallLenCm: number;
  floorRmse: number;
  ceilRmse: number;
  focal35mm: number;
}): WallHeightEstimate {
  const wide = args.focal35mm < 18;
  let ratio = widthHeightRatio(
    args.corners.m1,
    args.corners.m2,
    args.corners.m3,
    args.corners.m4,
    args.width,
    args.height,
    args.focalPx,
  );
  if (!Number.isFinite(ratio) || ratio <= 0.2 || ratio > 8) {
    ratio = args.wallLenCm / DEFAULT_CEILING_CM;
  }
  const wallPxH = Math.max(
    1,
    Math.abs(
      (args.corners.m3[1] + args.corners.m4[1]) / 2 - (args.corners.m1[1] + args.corners.m2[1]) / 2,
    ),
  );
  const lineNoise = (args.floorRmse + args.ceilRmse) / 2;
  const wideMul = wide ? 2.5 : 1;
  const ratioUnc = ratio * Math.max(0.01, (lineNoise + 1.5) / wallPxH) * wideMul;
  const height = args.wallLenCm / ratio;
  const heightUnc = Math.max(1.5, height * (ratioUnc / ratio));
  return {
    ratio: Math.round(ratio * 1000) / 1000,
    ratioPlusMinus: Math.round(ratioUnc * 1000) / 1000,
    heightEstimate: Math.round(height * 10) / 10,
    heightPlusMinus: Math.round(heightUnc * 10) / 10,
    wide,
    ratioRaw: ratio,
    heightRaw: height,
  };
}

/** True when any corner leaves the photo frame (same 3 px margin). */
export function cornersOutOfFrame(corners: CornerSet, width: number, height: number): boolean {
  const margin = 3;
  return [corners.m1, corners.m2, corners.m3, corners.m4].some(
    ([x, y]) =>
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < margin ||
      x > width - margin ||
      y < margin ||
      y > height - margin,
  );
}

export interface CeilingBlendEntry {
  h: number;
  w: number;
  t: boolean;
}

/**
 * Inverse-variance ceiling blend over per-wall heights. Untrusted heights
 * stay out while a trusted one exists; with none trusted the default
 * stands. Same weights, spread rule and 0.5x widening as the solver.
 */
export function blendCeilingHeight(
  entries: CeilingBlendEntry[],
  photoWide: boolean[],
): { ceiling: number; ceilingUnc: number; source: Uncertain["source"]; spread: boolean } {
  const trusted = entries.filter((e) => e.t);
  const contributors = trusted.length > 0 ? trusted : [];
  if (contributors.length === 0) {
    return { ceiling: DEFAULT_CEILING_CM, ceilingUnc: 15, source: "default", spread: false };
  }
  let sw = 0;
  let sh = 0;
  for (const e of contributors) {
    sw += e.w;
    sh += e.h * e.w;
  }
  const ceiling = sh / sw;
  const mean = ceiling;
  let spread = 0;
  for (const e of contributors) spread = Math.max(spread, Math.abs(e.h - mean));
  let ceilingUnc = Math.max(2, spread / 2 + 2);
  if (photoWide.some(Boolean)) ceilingUnc = Math.max(ceilingUnc * 1.5, 6);
  return {
    ceiling,
    ceilingUnc,
    source: "photo",
    spread: spread > 0.03 * mean && contributors.length > 1,
  };
}

/** Inverse of a 3x3 row-major homography. */
export function invertHomography3x3(h: number[]): number[] {
  const [a, b, c, d, e, f, g, hh, i] = h as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const A = e * i - f * hh;
  const B = -(d * i - f * g);
  const C = d * hh - e * g;
  const det = a * A + b * B + c * C;
  const inv = det === 0 ? 0 : 1 / det;
  return [
    A * inv,
    (c * hh - b * i) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    (c * d - a * f) * inv,
    C * inv,
    (b * g - a * hh) * inv,
    (a * e - b * d) * inv,
  ];
}

/** Apply a 3x3 row-major homography with perspective divide. */
export function applyH(h: number[], x: number, y: number): [number, number] {
  const w = (h[6] as number) * x + (h[7] as number) * y + (h[8] as number);
  return [
    ((h[0] as number) * x + (h[1] as number) * y + (h[2] as number)) / w,
    ((h[3] as number) * x + (h[4] as number) * y + (h[5] as number)) / w,
  ];
}
