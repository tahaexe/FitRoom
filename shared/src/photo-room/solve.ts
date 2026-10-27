/** Deterministic photo-to-room solver. Pure TypeScript, no DOM. */

import { createRectangleRoom } from "../rectangle.js";
import type { RoomLayout } from "../types.js";
import { validateRoomLayout } from "../validate.js";
import type { SamInstance } from "../sam.js";
import {
  applyHomography,
  fitLineRansac,
  focalPxOf,
  intersect,
  wallHomography,
  type LineFit,
} from "./geometry.js";
import {
  blendCeilingHeight,
  cornersOutOfFrame,
  estimateWallHeightFromCorners,
  tapeForLetter,
} from "./steps.js";
import {
  LETTER_TO_WALL_ID,
  type DraftFlag,
  type FittedLine,
  type PhotoInput,
  type PhotoSolution,
  type RoomDraft,
  type SolverInput,
  type Uncertain,
  type WallLetter,
} from "./types.js";

/**
 * Signed glass-to-opening margin per side, measured on the truth renders:
 * SAM's window raster overshoots the opening by ~5 cm per side (frame plus
 * bleed), so the margin recentres the raster on the opening. The generator
 * insets the glass by the same constant, keeping synthetic masks faithful.
 */
export const WINDOW_FRAME_CM = -5;
/** Ragged gap edges sit just off the jamb. */
export const GAP_MARGIN_CM = 3;
/** Frame pieces sit inside the jambs (measured on the truth renders). */
export const FRAME_MARGIN_CM = 8;

/**
 * Pixel-size rule for the whole opening section below: every absolute pixel
 * threshold is stated at the 1280 px reference width (the segmentation
 * frame) and scaled by `scalePx` to the photo at hand, so the same doorway
 * measures the same centimetres at 800, 1066 or 1280 px and a resample never
 * moves a jamb. Sampling strides (the `+= 2` / `+= 4` loop steps) are not
 * thresholds and stay fixed; fractions and centimetre margins never scale.
 */
const REF_SEG_WIDTH = 1280;
/** Scale an absolute pixel tolerance from the 1280 px reference to this photo. */
function scalePx(n: number, photoW: number): number {
  return Math.max(1, Math.round((n * Math.max(1, photoW)) / REF_SEG_WIDTH));
}
const DEFAULT_FOCAL_35MM = 26;

function tapeFor(letter: WallLetter, tapeA: number, tapeB: number): number {
  return tapeForLetter(letter, tapeA, tapeB);
}

function maskAt(inst: SamInstance, x: number, y: number): boolean {
  const [x1, y1, x2, y2] = inst.box;
  if (x < x1 || x > x2 || y < y1 || y > y2) return false;
  const w = inst.mask.width;
  const h = inst.mask.height;
  const bw = x2 - x1 + 1;
  const bh = y2 - y1 + 1;
  // Masks are box-sized rasters; tolerate resampled sizes via nearest.
  const ix = Math.min(w - 1, Math.max(0, Math.round(((x - x1) / Math.max(1, bw)) * w)));
  const iy = Math.min(h - 1, Math.max(0, Math.round(((y - y1) / Math.max(1, bh)) * h)));
  return (inst.mask.data[iy * w + ix] ?? 0) !== 0;
}

function unionAt(instances: SamInstance[], x: number, y: number): boolean {
  for (const inst of instances) if (maskAt(inst, x, y)) return true;
  return false;
}

function byConcept(instances: SamInstance[], concept: string): SamInstance[] {
  return instances.filter((i) => i.concept === concept);
}

interface WallPick {
  pieces: SamInstance[];
  /** Wall instances left out of the merge (side-wall fragments). */
  side: SamInstance[];
  colMin: number;
  colMax: number;
  centreCovered: boolean;
  /** Full-height occluder (wardrobe) abutting the range on a side. */
  occluder: { side: "left" | "right"; inst: SamInstance } | null;
}

/**
 * A full-height occluder standing against the facing wall at a corner:
 * a non-wall instance abutting (not covering) the facing pieces. Side
 * walls abut too, but they read as wall; anything else is furniture.
 */
function findOccluder(
  photo: PhotoInput,
  pieces: SamInstance[],
  colMin: number,
  colMax: number,
): { side: "left" | "right"; inst: SamInstance } | null {
  const span = Math.max(1, colMax - colMin + 1);
  const mid = (colMin + colMax) / 2;
  // Full height means full wall height (the wall need not fill the frame).
  const wallTop = Math.min(...pieces.map((p) => p.box[1]));
  const wallBot = Math.max(...pieces.map((p) => p.box[3]));
  const wallH = Math.max(
    1,
    (Number.isFinite(wallBot) ? wallBot : 0) - (Number.isFinite(wallTop) ? wallTop : 0) + 1,
  );
  for (const inst of photo.instances) {
    if (inst.concept === "wall" || inst.concept === "floor" || inst.concept === "ceiling") {
      continue;
    }
    if (inst.box[3] - inst.box[1] + 1 < 0.85 * wallH) continue;
    if (!pieces.some((p) => boxesTouch(inst, p, 12))) continue;
    const overlap = Math.max(0, Math.min(inst.box[2], colMax) - Math.max(inst.box[0], colMin) + 1);
    if (overlap >= 0.05 * span) continue;
    const cx = (inst.box[0] + inst.box[2]) / 2;
    return { side: cx < mid ? "left" : "right", inst };
  }
  return null;
}

function verticalOverlap(a: SamInstance, b: SamInstance): number {
  const top = Math.max(a.box[1], b.box[1]);
  const bot = Math.min(a.box[3], b.box[3]);
  const ha = a.box[3] - a.box[1] + 1;
  const hb = b.box[3] - b.box[1] + 1;
  return Math.max(0, bot - top + 1) / Math.max(1, Math.min(ha, hb));
}

/** Bottom-edge points of one wall instance (its floor line candidates). */
function bottomEdgePoints(inst: SamInstance): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let x = inst.box[0]; x <= inst.box[2]; x += 3) {
    for (let y = inst.box[3]; y >= inst.box[1]; y -= 1) {
      if (maskAt(inst, x, y)) {
        pts.push([x, y]);
        break;
      }
    }
  }
  return pts;
}

/**
 * Slope/intercept of an instance's floor line (y = m x + b), or null.
 * RANSAC: the doorway (or a split) corrupts the plain least-squares line,
 * while the flat bottom majority still wins the consensus.
 */
function floorLineOf(inst: SamInstance): { m: number; b: number } | null {
  const pts = bottomEdgePoints(inst);
  if (pts.length < 6) return null;
  const fit = fitLineRansac(pts, "horizontal", 3, 160);
  if (Math.abs(fit.b) < 1e-9) return null;
  const m = -fit.a / fit.b;
  const b = -fit.c / fit.b;
  return { m, b };
}

/** Fraction of [colMin, colMax] covered by wall pieces on one image row. */
function rowOccupancy(
  wallPieces: SamInstance[],
  y: number,
  colMin: number,
  colMax: number,
): number {
  let fill = 0;
  let total = 0;
  for (let x = colMin; x <= colMax; x += 2) {
    total += 1;
    if (unionAt(wallPieces, x, y)) fill += 1;
  }
  return total === 0 ? 0 : fill / total;
}

/** Least-squares y = m x + b residual sum over points. */
function lsSqErr(pts: Array<{ x: number; y: number }>): number {
  const n = pts.length;
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const denom = n * sxx - sx * sx;
  const m = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;
  let se = 0;
  for (const p of pts) {
    const e = p.y - (m * p.x + b);
    se += e * e;
  }
  return se;
}

/**
 * Best single breakpoint fit over ordered points: returns the split column
 * and the two-segment residual over the one-segment residual. Each side
 * must hold at least a quarter of the points.
 */
function bestBreakpoint(pts: Array<{ x: number; y: number }>): { at: number; ratio: number } {
  const one = lsSqErr(pts);
  let best = { at: pts[Math.floor(pts.length / 2)]?.x ?? 0, ratio: 1 };
  if (!(one > 0) || pts.length < 24) return best;
  const lo = Math.floor(pts.length * 0.25);
  const hi = Math.ceil(pts.length * 0.75);
  for (let i = lo; i <= hi; i += 4) {
    const left = pts.slice(0, i);
    const right = pts.slice(i);
    if (left.length < 6 || right.length < 6) continue;
    const two = lsSqErr(left) + lsSqErr(right);
    if (two / one < best.ratio) best = { at: pts[i]?.x ?? best.at, ratio: two / one };
  }
  return best;
}

/** Least-squares slope y(x) over points. */
function lsSlope(pts: Array<{ x: number; y: number }>): number | null {
  if (pts.length < 6) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const denom = pts.length * sxx - sx * sx;
  if (denom === 0) return null;
  return (pts.length * sxy - sx * sy) / denom;
}

/**
 * One wall instance covering two planes bends where the planes meet. The
 * upper edge leads (doorways never notch it); the lower edge confirms
 * locally, since a doorway notch elsewhere must not veto the true kink.
 * Returns the corner column, else null.
 */
function twoPlaneCorner(inst: SamInstance, imageW: number, cx: number): number | null {
  const x0 = Math.max(0, inst.box[0]);
  const x1 = Math.min(imageW - 1, inst.box[2]);
  if (x1 - x0 < 0.4 * imageW) return null;
  const bots: Array<{ x: number; y: number }> = [];
  const tops: Array<{ x: number; y: number }> = [];
  for (let x = x0; x <= x1; x += 2) {
    let bot: number | null = null;
    let top: number | null = null;
    for (let y = inst.box[3]; y >= inst.box[1]; y -= 1) {
      if (maskAt(inst, x, y)) {
        bot = y;
        break;
      }
    }
    for (let y = inst.box[1]; y <= inst.box[3]; y += 1) {
      if (maskAt(inst, x, y)) {
        top = y;
        break;
      }
    }
    if (bot !== null && top !== null) {
      bots.push({ x, y: bot });
      tops.push({ x, y: top });
    }
  }
  if (bots.length < 40 || tops.length < 40) return null;
  const st = bestBreakpoint(tops);
  if (st.ratio > 0.35) return null;
  // The lower edge confirms around the candidate: its local slopes must
  // differ across it (a corner), far from any doorway notch.
  const at = st.at;
  const left = bots.filter((p) => p.x >= at - 60 && p.x <= at - 8);
  const right = bots.filter((p) => p.x >= at + 8 && p.x <= at + 60);
  const ml = lsSlope(left);
  const mr = lsSlope(right);
  if (ml === null || mr === null || Math.abs(ml - mr) < 0.02) return null;
  const corner = Math.round(at);
  const keepW = cx < corner ? corner - x0 : x1 - corner;
  if (keepW < 0.25 * (x1 - x0)) return null;
  return corner;
}

function pickFacingWall(photo: PhotoInput): WallPick {
  const W = photo.width;
  const cx = Math.floor(W / 2);
  const cy = Math.floor(photo.height / 2);
  const walls = byConcept(photo.instances, "wall");
  const covering = walls.filter(
    (w) => cx >= w.box[0] && cx <= w.box[2] && cy >= w.box[1] && cy <= w.box[3],
  );
  let seed: SamInstance | null = null;
  if (covering.length > 0) {
    seed = covering.reduce((a, b) => {
      const aa = (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]);
      const bb = (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]);
      return bb > aa ? b : a;
    });
  }
  if (seed === null) {
    const windows = byConcept(photo.instances, "window");
    if (windows.length > 0) {
      // A glazed wall has no wall instance: build its plane from the
      // window and wall pieces around it.
      const pieces = [...walls, ...windows];
      const colMin = Math.max(0, Math.min(...pieces.map((p) => p.box[0])));
      const colMax = Math.min(W - 1, Math.max(...pieces.map((p) => p.box[2])));
      return { pieces, side: [], colMin, colMax, centreCovered: false, occluder: null };
    }
    if (walls.length > 0) {
      seed = walls.reduce((a, b) => {
        const aa = (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]);
        const bb = (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]);
        return bb > aa ? b : a;
      });
    } else {
      return {
        pieces: [],
        side: [],
        colMin: 0,
        colMax: W - 1,
        centreCovered: false,
        occluder: null,
      };
    }
  }
  const picked = seed as SamInstance;
  // Merge wall instances whose floor lines are collinear (SAM splits one
  // plane at columns and doorways). Side-wall fragments fail the angle /
  // level test and stay out.
  const seedLine = floorLineOf(picked);
  const pieces: SamInstance[] = [picked];
  if (seedLine !== null) {
    const cx = (picked.box[0] + picked.box[2]) / 2;
    const yAt = (line: { m: number; b: number }, x: number): number => line.m * x + line.b;
    for (const w of walls) {
      if (w === picked) continue;
      if (verticalOverlap(w, picked) < 0.25) continue;
      const line = floorLineOf(w);
      if (line === null) continue;
      const angle = Math.abs(Math.atan(line.m) - Math.atan(seedLine.m));
      if (angle > (6 * Math.PI) / 180) continue;
      if (Math.abs(yAt(line, cx) - yAt(seedLine, cx)) > 20) continue;
      pieces.push(w);
    }
  }
  let colMin = Math.max(0, Math.min(...pieces.map((p) => p.box[0])));
  let colMax = Math.min(W - 1, Math.max(...pieces.map((p) => p.box[2])));
  // One instance may cover two planes (SAM merges across a corner): split
  // it where the floor and ceiling boundaries bend, keeping the plane that
  // holds the image centre.
  if (pieces.length === 1 && walls.length === 1 && pieces[0] !== undefined) {
    const corner = twoPlaneCorner(pieces[0], W, cx);
    if (corner !== null) {
      if (cx < corner) colMax = Math.min(colMax, corner);
      else colMin = Math.max(colMin, corner);
    }
  }
  // The range runs to the occluder's outer edge: the true corner hides
  // behind it, and its face anchors the side edge.
  const occluder = findOccluder(photo, pieces, colMin, colMax);
  if (occluder !== null) {
    if (occluder.side === "left") colMin = Math.max(0, Math.min(colMin, occluder.inst.box[0]));
    else colMax = Math.min(W - 1, Math.max(colMax, occluder.inst.box[2]));
  }
  const covered = cx >= colMin && cx <= colMax;
  const side = walls.filter((w) => !pieces.includes(w));
  return { pieces, side, colMin, colMax, centreCovered: covered, occluder };
}

function toFitted(fit: LineFit, points: number, hiddenFraction: number): FittedLine {
  return { a: fit.a, b: fit.b, c: fit.c, rmse: fit.rmse, points, hiddenFraction };
}

function yOfLine(line: FittedLine, x: number): number {
  if (Math.abs(line.b) < 1e-9) return NaN;
  return -(line.a * x + line.c) / line.b;
}

interface Boundaries {
  floor: FittedLine;
  ceiling: FittedLine;
  left: FittedLine;
  right: FittedLine;
  floorHidden: number;
  ceilHidden: number;
  floorUsable: boolean;
  ceilUsable: boolean;
  floorConfirmed: boolean;
}

/**
 * The floor (ceiling) line lives only where the wall mask touches the
 * floor (ceiling) mask within this many pixels. Furniture and cabinets
 * draw straight false edges with no opposite mask touching them, so
 * columns without contact vote nothing.
 */
const ADJ_TOL_PX = 12;
/** A boundary disagreeing this far from its expected direction is refit. */
const SLOPE_TOL_RAD = 0.3;

function dirOfHoriz(line: FittedLine): [number, number] {
  const m = Math.abs(line.b) < 1e-9 ? 0 : -line.a / line.b;
  const n = Math.hypot(1, m);
  return [1 / n, m / n];
}

function dirOfVert(line: FittedLine): [number, number] {
  const m = Math.abs(line.a) < 1e-9 ? 0 : -line.b / line.a;
  const n = Math.hypot(m, 1);
  return [m / n, 1 / n];
}

/** Directionless angle between two directions, folded to [0, 90 deg]. */
function angDiff(d1: [number, number], d2: [number, number]): number {
  const dot = Math.min(1, Math.max(-1, d1[0] * d2[0] + d1[1] * d2[1]));
  return Math.acos(Math.abs(dot));
}

function fitBoundaries(photo: PhotoInput, pick: WallPick): Boundaries {
  const W = photo.width;
  const H = photo.height;
  const floors = byConcept(photo.instances, "floor");
  const ceilings = byConcept(photo.instances, "ceiling");
  const colMin = pick.colMin;
  const colMax = pick.colMax;
  const wallPieces = pick.pieces.filter((p) => p.concept === "wall");
  const hasWall = wallPieces.length > 0;
  // A glazed wall proxies its plane on the window pieces.
  const proxy = hasWall ? wallPieces : pick.pieces;
  // An occluder's outer face anchors the side edge on its side.
  const proxySide = pick.occluder === null ? proxy : [...proxy, pick.occluder.inst];

  // Floor-wall: only columns where the wall mask meets the floor mask
  // vote. Sofa backs, headboards, radiators and wardrobes draw straight
  // false edges with no floor mask touching them, so they vote nothing.
  const floorPts: Array<[number, number]> = [];
  let floorSkip = 0;
  let floorTotal = 0;
  for (let x = colMin; x <= colMax; x += 1) {
    floorTotal += 1;
    let top: number | null = null;
    for (let y = 0; y < H; y += 1) {
      if (floors.length > 0 ? unionAt(floors, x, y) : false) {
        top = y;
        break;
      }
    }
    if (!hasWall) {
      if (top !== null) floorPts.push([x, top]);
      else floorSkip += 1;
      continue;
    }
    let bot: number | null = null;
    for (let y = H - 1; y >= 0; y -= 1) {
      if (unionAt(wallPieces, x, y)) {
        bot = y;
        break;
      }
    }
    if (top !== null && bot !== null && Math.abs(top - bot) <= ADJ_TOL_PX) {
      floorPts.push([x, Math.min(top, bot)]);
    } else {
      floorSkip += 1;
    }
  }
  const floorHidden = floorTotal === 0 ? 1 : floorSkip / floorTotal;
  // Points must cover the range: a count below a quarter of the columns
  // (or a narrow span) cannot anchor a line, so the wall mask's own lower
  // edge stands in and the height leans on the ceiling line.
  const spanOf = (pts: Array<[number, number]>): number => {
    if (pts.length === 0) return 0;
    return Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
  };
  const colSpan = Math.max(1, colMax - colMin);
  const floorUsable =
    floorPts.length >= 10 &&
    spanOf(floorPts) >= 0.3 * colSpan &&
    floorPts.length >= 0.25 * (colMax - colMin + 1);
  let floorPtsFinal = floorPts;
  if (!floorUsable) {
    // Furniture hides the floor line: fall back to the wall pieces'
    // lower edge, flagged as hidden.
    const fb: Array<[number, number]> = [];
    for (let x = colMin; x <= colMax; x += 1) {
      let bot: number | null = null;
      for (let y = H - 1; y >= 0; y -= 1) {
        if (unionAt(wallPieces, x, y)) {
          bot = y;
          break;
        }
      }
      if (bot !== null) fb.push([x, bot]);
    }
    if (fb.length >= 2) floorPtsFinal = fb;
  }
  // Ceiling-wall: only columns where the ceiling mask meets the wall
  // mask vote. Rails and top cabinets draw straight false edges with no
  // ceiling mask touching them, so they vote nothing.
  const ceilPts: Array<[number, number]> = [];
  let ceilSkip = 0;
  let ceilTotal = 0;
  for (let x = colMin; x <= colMax; x += 1) {
    ceilTotal += 1;
    let low: number | null = null;
    for (let y = H - 1; y >= 0; y -= 1) {
      if (ceilings.length > 0 ? unionAt(ceilings, x, y) : false) {
        low = y;
        break;
      }
    }
    if (!hasWall) {
      if (low !== null) ceilPts.push([x, low]);
      else ceilSkip += 1;
      continue;
    }
    let up: number | null = null;
    for (let y = 0; y < H; y += 1) {
      if (unionAt(wallPieces, x, y)) {
        up = y;
        break;
      }
    }
    if (low !== null && up !== null && Math.abs(low - up) <= ADJ_TOL_PX) {
      ceilPts.push([x, Math.max(low, up)]);
    } else {
      ceilSkip += 1;
    }
  }
  const ceilHidden = ceilTotal === 0 ? 1 : ceilSkip / ceilTotal;
  const ceilUsable =
    ceilPts.length >= 10 &&
    spanOf(ceilPts) >= 0.3 * colSpan &&
    ceilPts.length >= 0.25 * (colMax - colMin + 1);
  let ceilPtsFinal = ceilPts;
  if (!ceilUsable) {
    const cb: Array<[number, number]> = [];
    for (let x = colMin; x <= colMax; x += 1) {
      let top: number | null = null;
      for (let y = 0; y < H; y += 1) {
        if (unionAt(wallPieces, x, y)) {
          top = y;
          break;
        }
      }
      if (top !== null) cb.push([x, top]);
    }
    if (cb.length >= 2) ceilPtsFinal = cb;
  }
  // Side edges: facing-plane mask left/right boundaries, fitted on clean
  // rows only (a doorway splits the boundary; the lintel and below-sill
  // bands still show the true corners). Falls back to all rows. A glazed
  // wall proxies on its window pieces.
  const yMin = Math.max(0, Math.min(...proxySide.map((p) => p.box[1])));
  const yMax = Math.min(H - 1, Math.max(...proxySide.map((p) => p.box[3])));
  const top = Number.isFinite(yMin) ? (yMin as number) : 0;
  const bot = Number.isFinite(yMax) ? (yMax as number) : H - 1;
  const cleanRows: number[] = [];
  for (let y = top; y <= bot; y += 1) {
    if (proxySide.length > 0 && rowOccupancy(proxySide, y, colMin, colMax) > 0.9) {
      cleanRows.push(y);
    }
  }
  const rows =
    cleanRows.length >= 8
      ? cleanRows
      : (() => {
          const all: number[] = [];
          for (let y = top; y <= bot; y += 1) all.push(y);
          return all;
        })();
  const leftPts: Array<[number, number]> = [];
  const rightPts: Array<[number, number]> = [];
  for (const y of rows) {
    let l: number | null = null;
    let r: number | null = null;
    for (let x = colMin; x <= colMax; x += 1) {
      if (unionAt(proxySide, x, y)) {
        if (l === null) l = x;
        r = x;
      }
    }
    if (l !== null) leftPts.push([l as number, y]);
    if (r !== null) rightPts.push([r as number, y]);
  }
  const floorFit = fitLineRansac(
    floorPtsFinal.length > 0 ? floorPtsFinal : [[colMin, H - 1]],
    "horizontal",
  );
  const ceilFit = fitLineRansac(
    ceilPtsFinal.length > 0 ? ceilPtsFinal : [[colMin, 0]],
    "horizontal",
  );
  const leftFit = fitLineRansac(leftPts.length > 0 ? leftPts : [[colMin, 0]], "vertical");
  const rightFit = fitLineRansac(rightPts.length > 0 ? rightPts : [[colMax, 0]], "vertical");
  // Reject a candidate that disagrees with the vertical vanishing point
  // (the side edges) and with the other boundary's slope, then refit
  // without its inliers: a sofa back or cabinet edge can still win a
  // consensus when most contact columns are hidden.
  const checked = checkBoundaries(
    floorFit,
    ceilFit,
    leftFit,
    rightFit,
    floorPtsFinal,
    ceilPtsFinal,
  );
  const floor = toFitted(checked.floor, floorPtsFinal.length, floorHidden);
  const ceiling = toFitted(checked.ceiling, ceilPtsFinal.length, ceilHidden);
  let left = toFitted(checked.left, leftPts.length, 0);
  let right = toFitted(checked.right, rightPts.length, 0);
  // Anchor each side edge at the crease where the facing wall meets the
  // side walls: a rejected side fragment abutting the column range marks
  // the crease, while the facing mask edge is eroded by a few pixels.
  // The slope stays fitted; only the intercept moves to the crease.
  const midRow = rows.length > 0 ? (rows[Math.floor(rows.length / 2)] as number) : H / 2;
  const anchor = (line: FittedLine, side: "left" | "right"): FittedLine => {
    let crease: number | null = null;
    for (const s of pick.side) {
      const overlap = Math.min(s.box[3], bot) - Math.max(s.box[1], top);
      if (overlap < 0.3 * (bot - top)) continue;
      if (side === "left" && s.box[2] <= colMin + 12 && s.box[2] >= colMin - 40) {
        const x = s.box[2] + 1;
        if (crease === null || Math.abs(x - colMin) < Math.abs(crease - colMin)) crease = x;
      }
      if (side === "right" && s.box[0] >= colMax - 12 && s.box[0] <= colMax + 40) {
        const x = s.box[0] - 1;
        if (crease === null || Math.abs(x - colMax) < Math.abs(crease - colMax)) crease = x;
      }
    }
    if (crease === null) return line;
    return { ...line, c: -line.a * crease - line.b * midRow };
  };
  void W;
  left = anchor(left, "left");
  right = anchor(right, "right");
  // A wall-edge fallback stands in for a hidden floor line: trust it only
  // when the surviving contact columns confirm it (they sit on the fitted
  // line). A sofa-top edge fails this; an intact wall base passes it.
  let floorConfirmed = floorUsable;
  if (!floorUsable && floorPts.length >= 8) {
    // Contact points sit up to ADJ_TOL_PX off the wall-edge line (they
    // mark the wall's true extent); a sofa-top edge sits further off.
    let near = 0;
    for (const p of floorPts) {
      if (horizResid(checked.floor, p) <= ADJ_TOL_PX + 2) near += 1;
    }
    floorConfirmed = near / floorPts.length >= 0.5;
  }
  return {
    floor,
    ceiling,
    left,
    right,
    floorHidden,
    ceilHidden,
    floorUsable,
    ceilUsable,
    floorConfirmed,
  };
}

/**
 * Residual of a point to a horizontal line fit (ax + by + c = 0).
 */
function horizResid(fit: LineFit, p: [number, number]): number {
  return Math.abs(fit.a * p[0] + fit.b * p[1] + fit.c) / Math.max(1e-9, Math.hypot(fit.a, fit.b));
}

/**
 * A boundary candidate must agree with the vertical vanishing point
 * (run across the side edges, i.e. perpendicular to them) and with the
 * other boundary's slope (both image parallel 3D lines). A candidate
 * failing either is refit without its inliers; the refit wins only when
 * it passes the same checks.
 */
function checkBoundaries(
  floorFit: LineFit,
  ceilFit: LineFit,
  leftFit: LineFit,
  rightFit: LineFit,
  floorPts: Array<[number, number]>,
  ceilPts: Array<[number, number]>,
): { floor: LineFit; ceiling: LineFit; left: LineFit; right: LineFit } {
  const sideDir = dirOfVert(toFitted(leftFit, 0, 0));
  const sideDir2 = dirOfVert(toFitted(rightFit, 0, 0));
  let sx = sideDir[0] + sideDir2[0];
  let sy = sideDir[1] + sideDir2[1];
  const sn = Math.hypot(sx, sy) || 1;
  sx /= sn;
  sy /= sn;
  const across: [number, number] = [-sy, sx];
  const refit = (fit: LineFit, other: LineFit, pts: Array<[number, number]>): LineFit => {
    const dir = dirOfHoriz(toFitted(fit, 0, 0));
    const otherDir = dirOfHoriz(toFitted(other, 0, 0));
    if (angDiff(dir, across) <= SLOPE_TOL_RAD && angDiff(dir, otherDir) <= SLOPE_TOL_RAD) {
      return fit;
    }
    const rest = pts.filter((p) => horizResid(fit, p) > 3);
    if (rest.length < 12) return fit;
    const xs = rest.map((p) => p[0]);
    if (
      Math.max(...xs) - Math.min(...xs) <
      0.3 * (Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]))) + 1
    ) {
      return fit;
    }
    const again = fitLineRansac(rest, "horizontal");
    const againDir = dirOfHoriz(toFitted(again, 0, 0));
    if (
      angDiff(againDir, across) <= SLOPE_TOL_RAD &&
      angDiff(againDir, otherDir) <= SLOPE_TOL_RAD
    ) {
      return again;
    }
    return fit;
  };
  // Check the worse fit first so the better line anchors the comparison.
  if (floorFit.rmse >= ceilFit.rmse) {
    const floor = refit(floorFit, ceilFit, floorPts);
    return { floor, ceiling: refit(ceilFit, floor, ceilPts), left: leftFit, right: rightFit };
  }
  const ceiling = refit(ceilFit, floorFit, ceilPts);
  return { floor: refit(floorFit, ceiling, floorPts), ceiling, left: leftFit, right: rightFit };
}

function unc(value: number, plusMinus: number, source: Uncertain["source"]): Uncertain {
  return { value: Math.round(value * 10) / 10, plusMinus: Math.round(plusMinus * 10) / 10, source };
}

/**
 * Wall occupancy per x over a horizontal band stated as fractions of the
 * wall height up from the fitted floor line: `fromUp`/`toUp` are 0 at the
 * floor and 1 at the ceiling (0 to 0.15 is the bottom band near the floor;
 * doorways reach the floor while window sills stay well above it, so a
 * mid-wall window hole never reads as a doorway).
 */
function bandOccupancy(
  wallPieces: SamInstance[],
  floor: FittedLine,
  ceiling: FittedLine,
  colMin: number,
  colMax: number,
  fromUp: number,
  toUp: number,
): Array<{ x: number; occ: number }> {
  const out: Array<{ x: number; occ: number }> = [];
  for (let x = colMin; x <= colMax; x += 2) {
    const yf = yOfLine(floor, x);
    const yc = yOfLine(ceiling, x);
    if (!Number.isFinite(yf) || !Number.isFinite(yc)) {
      out.push({ x, occ: 1 });
      continue;
    }
    const top = Math.min(yf, yc);
    const bot = Math.max(yf, yc);
    const band = Math.max(1, bot - top);
    const yLo = Math.ceil(bot - toUp * band);
    const yHi = Math.floor(bot - fromUp * band);
    let fill = 0;
    let total = 0;
    for (let y = yLo; y <= yHi; y += 2) {
      total += 1;
      if (unionAt(wallPieces, x, y)) fill += 1;
    }
    out.push({ x, occ: total === 0 ? 1 : fill / total });
  }
  return out;
}

/**
 * Wall occupancy per x over the bottom band near the floor (doorways reach
 * the floor; window sills stay well above it, so a mid-wall window hole
 * never reads as a doorway).
 */
function wallOccupancy(
  wallPieces: SamInstance[],
  floor: FittedLine,
  ceiling: FittedLine,
  colMin: number,
  colMax: number,
): Array<{ x: number; occ: number }> {
  return bandOccupancy(wallPieces, floor, ceiling, colMin, colMax, 0, 0.15);
}

/** Widest low-occupancy run of one occupancy profile (ragged borders stay narrow). */
function widestRun(
  occ: Array<{ x: number; occ: number }>,
  minRunPx: number,
): { x0: number; x1: number } | null {
  const consider = (
    x0: number,
    x1: number,
    best: { x0: number; x1: number } | null,
  ): { x0: number; x1: number } | null => {
    // No edge rejection here: a real doorway can sit near the facing
    // wall's corner (its leaf spills past the jamb), while ragged mask
    // borders are narrow. Edge proximity is decided by the leaf check at
    // the call site, not by geometry.
    if (x1 - x0 <= minRunPx) return best;
    if (best === null || x1 - x0 > best.x1 - best.x0) return { x0, x1 };
    return best;
  };
  let best: { x0: number; x1: number } | null = null;
  let cur0: number | null = null;
  let cur1 = 0;
  for (const { x, occ: o } of occ) {
    if (o < 0.4) {
      if (cur0 === null) cur0 = x;
      cur1 = x;
    } else {
      if (cur0 !== null) best = consider(cur0, cur1, best);
      cur0 = null;
    }
  }
  if (cur0 !== null) best = consider(cur0, cur1, best);
  return best;
}

function findDoorGap(
  wallPieces: SamInstance[],
  floor: FittedLine,
  ceiling: FittedLine,
  colMin: number,
  colMax: number,
  photoW: number,
): { x0: number; x1: number } | null {
  if (wallPieces.length === 0) return null;
  const occ = wallOccupancy(wallPieces, floor, ceiling, colMin, colMax);
  return widestRun(occ, scalePx(25, photoW));
}

/**
 * Lintel cross-check: the wall-free span in a mid-door band (0.38 to 0.62
 * of the wall height up from the floor — inside every standard doorway,
 * above skirting, clutter and the ragged floor edge, below the lintel).
 * Near the floor an ajar leaf, its shadow and the casing splay the raw gap
 * past the jambs; up here the hole is the doorway itself. The caller
 * intersects this span with the bottom-band gap, so the lintel can only
 * narrow the opening, never widen it.
 */
function findLintelGap(
  wallPieces: SamInstance[],
  floor: FittedLine,
  ceiling: FittedLine,
  colMin: number,
  colMax: number,
  photoW: number,
): { x0: number; x1: number } | null {
  if (wallPieces.length === 0) return null;
  const occ = bandOccupancy(wallPieces, floor, ceiling, colMin, colMax, 0.38, 0.62);
  return widestRun(occ, scalePx(25, photoW));
}

/**
 * Shave an ajar leaf off the raw gap. A leaf beside its doorway reads as a
 * narrow door-concept box touching one gap edge (it spills past its jamb,
 * so the box starts at or just inside the edge) while the open void fills
 * the rest of the gap; a closed leaf instead fills the whole gap and is far
 * too wide to qualify. Returns the trimmed span and which sides moved, or
 * null when nothing qualified. Widths are fractions of the gap, tolerances
 * scale with the photo (see `scalePx`).
 */
function trimLeafSpill(
  gap: { x0: number; x1: number },
  doors: SamInstance[],
  photoW: number,
): { gap: { x0: number; x1: number }; west: boolean; east: boolean } | null {
  const gapW = Math.max(1, gap.x1 - gap.x0 + 1);
  const edgeTol = scalePx(12, photoW);
  let x0 = gap.x0;
  let x1 = gap.x1;
  let west = false;
  let east = false;
  for (const d of doors) {
    const w = d.box[2] - d.box[0] + 1;
    if (w >= 0.6 * gapW) continue;
    if (d.box[2] < gap.x0 || d.box[0] > gap.x1) continue;
    if (d.box[0] <= gap.x0 + edgeTol && d.box[2] > x0 && d.box[2] < gap.x0 + gapW / 2) {
      x0 = d.box[2] + 1;
      west = true;
    } else if (d.box[2] >= gap.x1 - edgeTol && d.box[0] < x1 && d.box[0] > gap.x1 - gapW / 2) {
      x1 = d.box[0] - 1;
      east = true;
    }
  }
  if (!west && !east) return null;
  if (x1 - x0 <= scalePx(25, photoW)) return null;
  return { gap: { x0, x1 }, west, east };
}

/**
 * Snap a leaf-trimmed edge to the open void's own edge. The leaf hides the
 * jamb and the casing behind it, so the trimmed edge still sits on casing;
 * the void mask starts where the casing ends. The snap only ever applies to
 * a side the leaf trim just moved, only to a door box fully inside the gap,
 * and by at most a casing-scale distance — so a half-open leaf standing
 * inside the doorway can never collapse the opening.
 */
function snapTrimmedEdgeToVoid(
  span: { x0: number; x1: number },
  doors: SamInstance[],
  trimmedWest: boolean,
  trimmedEast: boolean,
  photoW: number,
): { x0: number; x1: number } {
  const snapTol = scalePx(30, photoW);
  let { x0, x1 } = span;
  if (trimmedWest) {
    let voidWest: number | null = null;
    for (const d of doors) {
      if (d.box[0] < span.x0 || d.box[2] > span.x1) continue;
      if (d.box[0] <= span.x0 + snapTol && d.box[0] > span.x0) {
        voidWest = voidWest === null ? d.box[0] : Math.min(voidWest, d.box[0]);
      }
    }
    if (voidWest !== null) x0 = voidWest;
  }
  if (trimmedEast) {
    let voidEast: number | null = null;
    for (const d of doors) {
      if (d.box[0] < span.x0 || d.box[2] > span.x1) continue;
      if (d.box[2] >= span.x1 - snapTol && d.box[2] < span.x1) {
        voidEast = voidEast === null ? d.box[2] : Math.max(voidEast, d.box[2]);
      }
    }
    if (voidEast !== null) x1 = voidEast;
  }
  return { x0, x1 };
}

/**
 * Fraction of a doorway span's columns whose wall-free run up from the
 * fitted floor line reaches at least 60 % of the wall band. A real doorway
 * runs floor-to-lintel; a radiator under a window stacks two short voids
 * (floor gap below, window hole above) with wall between, so neither run
 * qualifies. Frame fragments sitting low only hide their own columns.
 */
function doorwayTallColumns(
  wallPieces: SamInstance[],
  floor: FittedLine,
  ceiling: FittedLine,
  x0: number,
  x1: number,
): number {
  let tall = 0;
  let total = 0;
  for (let x = Math.round(x0); x <= Math.round(x1); x += 4) {
    const yf = yOfLine(floor, x);
    const yc = yOfLine(ceiling, x);
    if (!Number.isFinite(yf) || !Number.isFinite(yc)) continue;
    const top = Math.min(yf, yc);
    const bot = Math.max(yf, yc);
    const band = Math.max(1, bot - top);
    total += 1;
    let run = 0;
    for (let y = Math.floor(bot) - 1; y >= Math.ceil(top); y -= 2) {
      if (unionAt(wallPieces, x, y)) break;
      run += 2;
    }
    if (run / band >= 0.6) tall += 1;
  }
  return total === 0 ? 1 : tall / total;
}

function boxesTouch(a: SamInstance, b: SamInstance, pad = 3): boolean {
  return !(
    a.box[2] + pad < b.box[0] ||
    b.box[2] + pad < a.box[0] ||
    a.box[3] + pad < b.box[1] ||
    b.box[3] + pad < a.box[1]
  );
}

/**
 * Window pieces overlapping one opening (panes) merge into one opening.
 * Panes touch or nearly touch with a large vertical overlap; separate
 * windows stand further apart.
 */
function xOverlap(a: SamInstance, b: SamInstance): number {
  return Math.max(0, Math.min(a.box[2], b.box[2]) - Math.max(a.box[0], b.box[0]) + 1);
}

function yGap(a: SamInstance, b: SamInstance): number {
  if (a.box[3] < b.box[1]) return b.box[1] - a.box[3];
  if (b.box[3] < a.box[1]) return a.box[1] - b.box[3];
  return 0;
}

/** Panes of one opening: touching side by side, or stacked in one column. */
function sameOpening(a: SamInstance, b: SamInstance, photoW: number): boolean {
  if (boxesTouch(a, b, scalePx(10, photoW)) && verticalOverlap(a, b) >= 0.25) return true;
  const minW = Math.min(a.box[2] - a.box[0], b.box[2] - b.box[0]) + 1;
  const minH = Math.min(a.box[3] - a.box[1], b.box[3] - b.box[1]) + 1;
  return xOverlap(a, b) >= 0.5 * minW && yGap(a, b) <= 2 * minH;
}

function groupFootprint(g: SamInstance[]): SamInstance {
  const first = g[0] as SamInstance;
  return {
    ...first,
    box: [
      Math.min(...g.map((m) => m.box[0])),
      Math.min(...g.map((m) => m.box[1])),
      Math.max(...g.map((m) => m.box[2])),
      Math.max(...g.map((m) => m.box[3])),
    ],
  };
}

function mergePanes(windows: SamInstance[], photoW: number): SamInstance[] {
  // Fixpoint: a pane joining a group grows its footprint, which can pull
  // in a further pane (a tall stack split by several mullions).
  let groups: SamInstance[][] = windows.map((w) => [w]);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const a = groupFootprint(groups[i] as SamInstance[]);
        const b = groupFootprint(groups[j] as SamInstance[]);
        if (sameOpening(a, b, photoW)) {
          (groups[i] as SamInstance[]).push(...(groups[j] as SamInstance[]));
          groups = [...groups.slice(0, j), ...groups.slice(j + 1)];
          changed = true;
          break outer;
        }
      }
    }
  }
  return groups.map((g) =>
    g.length === 1 || g[0] === undefined ? (g[0] as SamInstance) : unionInstances(g),
  );
}

/** Union of member masks over their joint box, as one instance. */
function unionInstances(members: SamInstance[]): SamInstance {
  const first = members[0] as SamInstance;
  const box: [number, number, number, number] = [
    Math.min(...members.map((m) => m.box[0])),
    Math.min(...members.map((m) => m.box[1])),
    Math.max(...members.map((m) => m.box[2])),
    Math.max(...members.map((m) => m.box[3])),
  ];
  const w = box[2] - box[0] + 1;
  const h = box[3] - box[1] + 1;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (members.some((m) => maskAt(m, box[0] + x, box[1] + y))) data[y * w + x] = 1;
    }
  }
  return {
    concept: "window",
    id: `${first.id}+${String(members.length - 1)}`,
    box,
    imageWidth: first.imageWidth,
    imageHeight: first.imageHeight,
    mask: { width: w, height: h, data },
  };
}

/** Wall occupancy per x over the top band near the ceiling. */
function topOccupancy(
  wallPieces: SamInstance[],
  floor: FittedLine,
  ceiling: FittedLine,
  colMin: number,
  colMax: number,
): Array<{ x: number; occ: number }> {
  const out: Array<{ x: number; occ: number }> = [];
  for (let x = colMin; x <= colMax; x += 2) {
    const yf = yOfLine(floor, x);
    const yc = yOfLine(ceiling, x);
    if (!Number.isFinite(yf) || !Number.isFinite(yc)) {
      out.push({ x, occ: 1 });
      continue;
    }
    const top = Math.min(yf, yc);
    const bot = Math.max(yf, yc);
    const bandBot = top + (bot - top) * 0.15;
    let fill = 0;
    let total = 0;
    for (let y = Math.ceil(top); y <= Math.floor(bandBot); y += 2) {
      total += 1;
      if (unionAt(wallPieces, x, y)) fill += 1;
    }
    out.push({ x, occ: total === 0 ? 1 : fill / total });
  }
  return out;
}

/**
 * A full-height occluder standing clear of the facing wall at an image
 * edge (a wardrobe reads as wall but never touches the facing pieces):
 * side-wall fragments do touch them, so adjacency tells them apart.
 */
function edgeOccluder(photo: PhotoInput, pick: WallPick): "left" | "right" | null {
  const W = photo.width;
  const H = photo.height;
  const band = Math.max(8, 0.02 * W);
  for (const side of ["left", "right"] as const) {
    const found = photo.instances.some((i) => {
      if (i.concept === "floor" || i.concept === "ceiling") return false;
      if (side === "left" ? i.box[0] > band : i.box[2] < W - 1 - band) return false;
      if (i.box[3] - i.box[1] + 1 < 0.85 * H) return false;
      return !pick.pieces.some((p) => boxesTouch(i, p, 12));
    });
    if (found) return side;
  }
  return null;
}

/**
 * A full-height occluder (wardrobe) at a corner: wall occupancy stays low
 * over an edge span in both the bottom and the top band.
 */
function cornerOcclusion(
  wallPieces: SamInstance[],
  floor: FittedLine,
  ceiling: FittedLine,
  colMin: number,
  colMax: number,
): "left" | "right" | null {
  if (wallPieces.length === 0) return null;
  const width = colMax - colMin + 1;
  const edge = Math.max(24, 0.08 * width);
  const bottom = wallOccupancy(wallPieces, floor, ceiling, colMin, colMax);
  const top = topOccupancy(wallPieces, floor, ceiling, colMin, colMax);
  const occOf = (rows: Array<{ x: number; occ: number }>, x: number): number => {
    let near = rows[0];
    for (const r of rows) {
      if (near === undefined || Math.abs(r.x - x) < Math.abs(near.x - x)) near = r;
    }
    return near?.occ ?? 1;
  };
  for (const side of ["left", "right"] as const) {
    const x0 = side === "left" ? colMin : colMax - edge;
    const x1 = side === "left" ? colMin + edge : colMax;
    let low = 0;
    let total = 0;
    for (let x = Math.ceil(x0); x <= Math.floor(x1); x += 2) {
      total += 1;
      if (occOf(bottom, x) < 0.4 && occOf(top, x) < 0.4) low += 1;
    }
    if (total > 0 && low / total > 0.7) return side;
  }
  return null;
}

export function solveRoomFromPhotos(input: SolverInput): RoomDraft {
  const flags: DraftFlag[] = [];
  const photos: PhotoSolution[] = [];
  const perWallHeight: Array<{ wall: WallLetter; h: number; w: number; t: boolean }> = [];
  const photoWide: boolean[] = [];

  for (const photo of input.photos) {
    const focal35mm = photo.focal35mm ?? DEFAULT_FOCAL_35MM;
    const focalSource = photo.focal35mm === undefined ? "default" : "exif";
    const wide = focal35mm < 18;
    photoWide.push(wide);
    if (wide) {
      flags.push({
        code: "focal-wide",
        message: `Wall ${photo.wall}: focal length ${String(focal35mm)} mm looks like a 0.5x photo.`,
        wall: photo.wall,
      });
    }
    const fPx = focalPxOf(photo.focal35mm, photo.width, photo.height);
    const pick = pickFacingWall(photo);
    const bounds = fitBoundaries(photo, pick);
    const m1 = intersect(bounds.ceiling, bounds.left);
    const m2 = intersect(bounds.ceiling, bounds.right);
    const m3 = intersect(bounds.floor, bounds.left);
    const m4 = intersect(bounds.floor, bounds.right);
    const wallLen = tapeFor(photo.wall, input.tapeA, input.tapeB);
    // Ratio + height share one helper with the corner re-solve.
    const estimate = estimateWallHeightFromCorners({
      corners: { m1, m2, m3, m4 },
      width: photo.width,
      height: photo.height,
      focalPx: fPx,
      wallLenCm: wallLen,
      floorRmse: bounds.floor.rmse,
      ceilRmse: bounds.ceiling.rmse,
      focal35mm,
    });
    const ratio = estimate.ratio;
    const ratioUnc = estimate.ratioPlusMinus;
    const height = estimate.heightEstimate;
    const heightUnc = estimate.heightPlusMinus;
    const lineNoise = (bounds.floor.rmse + bounds.ceiling.rmse) / 2;
    // A side edge at the image border means a corner out of frame: judge
    // the fitted corners (side-wall slivers may touch the border while the
    // facing corners sit inside). A corner on the border is already cut.
    const outOfFrame = cornersOutOfFrame({ m1, m2, m3, m4 }, photo.width, photo.height);
    if (outOfFrame) {
      flags.push({
        code: "corner-out-of-frame",
        message: `Wall ${photo.wall}: a corner is out of frame.`,
        wall: photo.wall,
      });
    }
    if (bounds.floorHidden > 0.6) {
      flags.push({
        code: "floor-hidden",
        message: `Wall ${photo.wall}: the floor line is hidden over most of its width.`,
        wall: photo.wall,
      });
    }
    // Trusted while contact columns confirm the floor line (a direct fit
    // or a confirmed wall-edge fallback); otherwise the height leans on
    // the ceiling line alone.
    const trusted = bounds.floorUsable || bounds.floorConfirmed;
    if (!trusted && bounds.ceilUsable) {
      flags.push({
        code: "height-from-ceiling",
        message: `Wall ${photo.wall}: the floor line is hidden, so the height comes from the ceiling line alone.`,
        wall: photo.wall,
      });
    }
    // The range-edge rule needs structural wall pieces: a glazed wall's
    // glass floats above the floor, which is not an occlusion.
    const structuralPieces = pick.pieces.filter((p) => p.concept === "wall");
    const occluded =
      pick.occluder?.side ??
      edgeOccluder(photo, pick) ??
      cornerOcclusion(structuralPieces, bounds.floor, bounds.ceiling, pick.colMin, pick.colMax);
    if (
      occluded !== null &&
      !flags.some((f) => f.code === "corner-occluded" && f.wall === photo.wall)
    ) {
      flags.push({
        code: "corner-occluded",
        message: `Wall ${photo.wall}: a full-height occluder covers the ${occluded} corner.`,
        wall: photo.wall,
      });
    }
    const both = Number.isFinite(m1[0]) && Number.isFinite(m4[0]);
    // An untrusted height stays out of the blend when a trusted one
    // exists; a 0.5x photo weighs almost nothing either way.
    if (both && !outOfFrame && (trusted || !bounds.ceilUsable)) {
      const w = (1 / (1 + lineNoise * lineNoise)) * (trusted ? 1 : 1 / 16) * (wide ? 1 / 16 : 1);
      perWallHeight.push({ wall: photo.wall, h: estimate.heightRaw, w, t: trusted });
    }
    photos.push({
      wall: photo.wall,
      wallId: LETTER_TO_WALL_ID[photo.wall],
      focalPx: Math.round(fPx * 100) / 100,
      focalSource,
      focal35mm,
      lines: {
        floor: bounds.floor,
        ceiling: bounds.ceiling,
        left: bounds.left,
        right: bounds.right,
      },
      corners: { m1, m2, m3, m4 },
      ratio: Math.round(ratio * 1000) / 1000,
      ratioPlusMinus: Math.round(ratioUnc * 1000) / 1000,
      heightEstimate: Math.round(height * 10) / 10,
      heightPlusMinus: Math.round(heightUnc * 10) / 10,
    });
  }

  // One ceiling height: inverse-variance blend over walls showing both
  // corners and both lines. Untrusted heights (floor line hidden) stay
  // out while a trusted one exists; with none trusted the default stands.
  // The blend itself lives in steps.ts, shared with the corner re-solve.
  const blend = blendCeilingHeight(perWallHeight, photoWide);
  const ceiling = blend.ceiling;
  const ceilingUnc = blend.ceilingUnc;
  const ceilingSource: Uncertain["source"] = blend.source;
  if (blend.spread) {
    const mean = ceiling;
    const spread = Math.max(...perWallHeight.filter((e) => e.t).map((e) => Math.abs(e.h - mean)));
    flags.push({
      code: "ceiling-spread",
      message: `Ceiling heights from different walls differ by ${String(Math.round((spread / mean) * 100))}%.`,
    });
  }

  // Openings through each wall's homography.
  const openings: RoomDraft["openings"] = [];
  let doorN = 0;
  let winN = 0;
  for (let pi = 0; pi < input.photos.length; pi += 1) {
    const photo = input.photos[pi] as PhotoInput;
    const sol = photos[pi] as PhotoSolution;
    const wallLen = tapeFor(photo.wall, input.tapeA, input.tapeB);
    const H = wallHomography(
      sol.corners.m1,
      sol.corners.m2,
      sol.corners.m3,
      sol.corners.m4,
      wallLen,
      sol.heightEstimate,
    );
    const toWall = (x: number, y: number): [number, number] => applyHomography(H, x, y);
    const pick = pickFacingWall(photo);
    const wallPieces = pick.pieces.filter((p) => p.concept === "wall");
    // Only instances whose centre falls inside the facing wall's column
    // range belong to this wall: side walls bring their own openings.
    const inRange = (box: [number, number, number, number]): boolean => {
      const cx = (box[0] + box[2]) / 2;
      return cx >= pick.colMin && cx <= pick.colMax;
    };
    const doors = byConcept(photo.instances, "door").filter((d) => inRange(d.box));
    // Window pieces overlapping one opening (panes) merge into one; a
    // glass strip inside a door's leaf is the door glazing, not a window.
    const windows = mergePanes(
      byConcept(photo.instances, "window").filter((w) => inRange(w.box)),
      photo.width,
    );
    const uncMul = photoWide[pi] === true ? 2.5 : 1;
    // Shopper-tapped door point for this wall, when the solver would
    // otherwise flag `tap-the-door`: it anchors a default-width opening.
    const tap =
      input.doorTap?.wall === photo.wall &&
      Number.isFinite(input.doorTap.x) &&
      Number.isFinite(input.doorTap.y) &&
      input.doorTap.x >= 0 &&
      input.doorTap.x < photo.width &&
      input.doorTap.y >= 0 &&
      input.doorTap.y < photo.height
        ? input.doorTap
        : undefined;
    const tapDoor = (): boolean => {
      if (tap === undefined) return false;
      const TAP_DOOR_WIDTH = 90;
      const [u] = toWall(tap.x, tap.y);
      if (!Number.isFinite(u)) return false;
      const width = Math.min(TAP_DOOR_WIDTH, wallLen);
      const off = Math.max(0, Math.min(wallLen - width, u - width / 2));
      doorN += 1;
      openings.push({
        id: `door-${String(doorN)}`,
        wall: photo.wall,
        wallId: LETTER_TO_WALL_ID[photo.wall],
        type: "door",
        offset: unc(off, 12 * uncMul, "photo"),
        width: unc(width, 12 * uncMul, "photo"),
        height: unc(210, 8, "photo"),
        sillHeight: unc(0, 1, "photo"),
        hinge: "left",
        swing: "in",
      });
      return true;
    };

    // Door gap in the wall mask (the doorway); the door instance is often
    // just the open leaf beside it and never joins the span (an ajar leaf
    // spills past its jamb). Non-seed merged pieces of partial height
    // touching the gap or a leaf are the frame next to it and delimit the
    // doorway instead.
    //
    // Physical door rule: a door is a gap in the facing wall's structural
    // plane (the seed and full-height merged pieces — never a partial-height
    // frame fragment, whatever thin piece covers the gap's lowest
    // centimetres) that reaches the fitted floor line, confirmed by a door
    // instance (the leaf) beside or inside that gap. A radiator or furniture
    // leaves the structural wall above it intact, so its run stays short and
    // it is no door even when a leaf-shaped raster sits nearby.
    const seed = wallPieces.length > 0 ? wallPieces[0] : undefined;
    const seedH = seed === undefined ? 1 : seed.box[3] - seed.box[1] + 1;
    const structural = wallPieces.filter(
      (p) => p === seed || p.box[3] - p.box[1] + 1 >= 0.8 * seedH,
    );
    // The gap search skips the occluder span: its face is wall-free over
    // the full height and would read as a doorway.
    const gapLo = pick.occluder?.side === "left" ? pick.occluder.inst.box[2] + 1 : pick.colMin;
    const gapHi = pick.occluder?.side === "right" ? pick.occluder.inst.box[0] - 1 : pick.colMax;
    // A doorway is measured between its jambs, never by the widest
    // wall-free run near the floor: the raw bottom-band gap still finds the
    // hole, but an ajar leaf, its shadow and the casing splay it past the
    // jambs (the example's wall A reads 145 cm for a 90 cm door). The lintel
    // band (mid-door height, above the floor clutter) holds the hole
    // itself, so intersecting the two can only narrow to the doorway; the
    // leaf trim then shaves a narrow edge-touching leaf box off, and the
    // void snap moves that edge to the open void's own start (the casing's
    // inner edge the leaf was hiding). A closed leaf fills the whole gap
    // and is far too wide to trim, so closed doors are untouched.
    const rawGap = findDoorGap(
      structural,
      sol.lines.floor,
      sol.lines.ceiling,
      gapLo,
      gapHi,
      photo.width,
    );
    const lintelGap = findLintelGap(
      structural,
      sol.lines.floor,
      sol.lines.ceiling,
      gapLo,
      gapHi,
      photo.width,
    );
    let gap = rawGap;
    if (gap !== null && lintelGap !== null) {
      const lo = Math.max(gap.x0, lintelGap.x0);
      const hi = Math.min(gap.x1, lintelGap.x1);
      if (hi - lo > scalePx(25, photo.width) && lo <= hi) gap = { x0: lo, x1: hi };
    }
    const trimmed = gap !== null ? trimLeafSpill(gap, doors, photo.width) : null;
    if (trimmed !== null) {
      gap = snapTrimmedEdgeToVoid(trimmed.gap, doors, trimmed.west, trimmed.east, photo.width);
    }
    const touchesGapOrLeaf = (p: SamInstance): boolean => {
      const padGap = scalePx(4, photo.width);
      const nearGap = gap !== null && p.box[0] <= gap.x1 + padGap && p.box[2] >= gap.x0 - padGap;
      const nearLeaf = doors.some((d) => boxesTouch(p, d, scalePx(8, photo.width)));
      return gap !== null ? nearGap && nearLeaf : nearLeaf;
    };
    const frame = wallPieces.filter(
      (p) => p !== seed && p.box[3] - p.box[1] + 1 < 0.8 * seedH && touchesGapOrLeaf(p),
    );
    if (gap !== null || frame.length > 0) {
      const yf = (x: number): number => {
        const y = yOfLine(sol.lines.floor, x);
        return Number.isFinite(y) ? y : photo.height - 1;
      };
      const uAt = (x: number): number => {
        const [u] = toWall(x, yf(x));
        return u;
      };
      // West/east jamb candidates: the gap edges (ragged, small margin)
      // and the frame edges (measured ~8 cm inside the jambs on the truth
      // renders). A casing fragment is wall trim standing inside the
      // doorway, so each side takes its innermost evidence: an ajar leaf
      // widens the raw gap past its jamb, and a fragment jutting past the
      // gap is wall beyond the jamb, not the jamb.
      const west: number[] = [];
      const east: number[] = [];
      let imgLo = Infinity;
      let imgHi = -Infinity;
      if (gap !== null) {
        west.push(Math.min(uAt(gap.x0), uAt(gap.x1)) - GAP_MARGIN_CM);
        east.push(Math.max(uAt(gap.x0), uAt(gap.x1)) + GAP_MARGIN_CM);
        imgLo = Math.min(imgLo, gap.x0);
        imgHi = Math.max(imgHi, gap.x1);
      }
      for (const f of frame) {
        // Frame evidence must lie inside the doorway span: a fragment
        // jutting past the gap is wall beyond the jamb, not the jamb.
        const c0 = gap !== null ? Math.max(f.box[0], gap.x0) : f.box[0];
        const c1 = gap !== null ? Math.min(f.box[2], gap.x1) : f.box[2];
        if (c1 < c0) continue;
        west.push(Math.min(uAt(c0), uAt(c1)) - FRAME_MARGIN_CM);
        east.push(Math.max(uAt(c0), uAt(c1)) + FRAME_MARGIN_CM);
        imgLo = Math.min(imgLo, c0);
        imgHi = Math.max(imgHi, c1);
      }
      let lo = Math.max(...west);
      let hi = Math.min(...east);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 20) {
        lo = Math.min(...west);
        hi = Math.max(...east);
      }
      // A low occlusion (radiator, furniture) also opens the lower band
      // but never runs up the wall: without tall floor-to-lintel columns
      // in the structural plane there is no door. The run ignores
      // partial-height frame fragments, so a fragment covering the gap's
      // lowest centimetres cannot veto a real doorway. A tall gap still
      // needs its leaf beside or inside the span to confirm it.
      const tallShare = doorwayTallColumns(
        structural,
        sol.lines.floor,
        sol.lines.ceiling,
        imgLo,
        imgHi,
      );
      const leafPad = scalePx(12, photo.width);
      const leafConfirms =
        Number.isFinite(imgLo) &&
        Number.isFinite(imgHi) &&
        doors.some((d) => d.box[0] <= imgHi + leafPad && d.box[2] >= imgLo - leafPad);
      if (tallShare < 0.4 || !leafConfirms) {
        if (doors.length > 0 && !tapDoor()) {
          flags.push({
            code: "tap-the-door",
            message: `Wall ${photo.wall}: a door leaf is visible but no opening was found — tap the door.`,
            wall: photo.wall,
          });
        }
      } else {
        // Wall runs left -> right from its start: offset is measured from
        // the start (image left).
        const width = Math.max(20, hi - lo);
        const off = Math.max(0, Math.min(wallLen - width, lo));
        // Hinge in room terms from where the leaf meets the doorway's
        // jamb. A flat-open leaf lies beside the gap on its hinge side.
        // A concept filling the gap is the open void itself: it reads
        // largest away from the swung leaf, so the hinge is opposite its
        // bulk side. Room left is the wall-end side (image east on every
        // wall: the camera runs from the wall start to the wall end). A
        // leaf covering the whole gap carries no signal and keeps the
        // default.
        let hinge: "left" | "right" = "left";
        if (doors.length > 0 && Number.isFinite(imgLo) && Number.isFinite(imgHi)) {
          const leaf = doors.reduce((a, b) => (b.box[2] - b.box[0] > a.box[2] - a.box[0] ? b : a));
          const glo = imgLo as number;
          const ghi = imgHi as number;
          const covers =
            leaf.box[0] <= glo + scalePx(6, photo.width) &&
            leaf.box[2] >= ghi - scalePx(6, photo.width);
          const toRoom = (hingeEast: boolean): "left" | "right" => (hingeEast ? "left" : "right");
          if (!covers) {
            // The door concept is either the leaf beside the gap (small
            // overlap) or the open void itself (large overlap): opposite
            // readings, told apart by the cover ratio.
            const overlap =
              Math.max(0, Math.min(leaf.box[2], ghi) - Math.max(leaf.box[0], glo) + 1) /
              Math.max(1, leaf.box[2] - leaf.box[0] + 1);
            if (overlap >= 0.5) {
              // The void reads largest away from the swung leaf, so the
              // hinge is opposite its bulk side.
              const leafCx = (leaf.box[0] + leaf.box[2]) / 2;
              const gapCx = (glo + ghi) / 2;
              const hingePad = scalePx(12, photo.width);
              if (leafCx < gapCx - hingePad) hinge = toRoom(true);
              else if (leafCx > gapCx + hingePad) hinge = toRoom(false);
            } else {
              const overEast = leaf.box[2] - ghi;
              const overWest = glo - leaf.box[0];
              if (Math.max(overEast, overWest) >= scalePx(12, photo.width)) {
                // A flat-open leaf lies beside the gap on its hinge side.
                hinge = toRoom(overEast > overWest);
              }
            }
          }
        }
        doorN += 1;
        const wUnc = Math.max(3, (sol.lines.floor.rmse + 2) * (wallLen / photo.width) * 2) * uncMul;
        openings.push({
          id: `door-${String(doorN)}`,
          wall: photo.wall,
          wallId: LETTER_TO_WALL_ID[photo.wall],
          type: "door",
          offset: unc(off, wUnc, "photo"),
          width: unc(width, wUnc, "photo"),
          height: unc(210, 8, "photo"),
          sillHeight: unc(0, 1, "photo"),
          hinge,
          swing: "in",
        });
        if (width < 70 || width > 100) {
          flags.push({
            code: "door-width",
            message: `Wall ${photo.wall}: door is ${String(Math.round(width))} cm wide (70-100 cm expected).`,
            wall: photo.wall,
          });
        }
      }
    } else if (doors.length > 0 && !tapDoor()) {
      flags.push({
        code: "tap-the-door",
        message: `Wall ${photo.wall}: a door leaf is visible but no opening was found — tap the door.`,
        wall: photo.wall,
      });
    }

    for (const win of windows) {
      if (doors.length > 0 && doors.some((d) => boxesTouch(win, d, scalePx(3, photo.width))))
        continue;
      // The glass raster is precise; the box is loose. Map the mask
      // pixels through the homography and take the extents.
      let lo = Infinity;
      let hi = -Infinity;
      let bot = Infinity;
      let top = -Infinity;
      {
        const [bx0, by0, bx1, by1] = win.box;
        for (let y = by0; y <= by1; y += 2) {
          for (let x = bx0; x <= bx1; x += 2) {
            if (!maskAt(win, x, y)) continue;
            const [X, Y] = toWall(x, y);
            if (X < lo) lo = X;
            if (X > hi) hi = X;
            if (Y < bot) bot = Y;
            if (Y > top) top = Y;
          }
        }
        if (!Number.isFinite(lo)) {
          const [ua, ya] = toWall(bx0, by1);
          const [ub, yb] = toWall(bx1, by0);
          lo = Math.min(ua, ub);
          hi = Math.max(ua, ub);
          bot = Math.min(ya, yb);
          top = Math.max(ya, yb);
        }
      }
      lo -= WINDOW_FRAME_CM;
      hi += WINDOW_FRAME_CM;
      top += WINDOW_FRAME_CM;
      bot -= WINDOW_FRAME_CM;
      const width = Math.max(10, hi - lo);
      const off = Math.max(0, Math.min(wallLen - width, lo));
      const height = Math.max(10, top - bot);
      const sill = Math.max(0, bot);
      winN += 1;
      const wUnc = Math.max(3, (sol.lines.floor.rmse + 2) * (wallLen / photo.width) * 2) * uncMul;
      openings.push({
        id: `window-${String(winN)}`,
        wall: photo.wall,
        wallId: LETTER_TO_WALL_ID[photo.wall],
        type: "window",
        offset: unc(off, wUnc, "photo"),
        width: unc(width, wUnc, "photo"),
        height: unc(height, Math.max(4, height * 0.05) * uncMul, "photo"),
        sillHeight: unc(sill, Math.max(3, wUnc), "photo"),
      });
      if (sill < 0 || sill > 120) {
        flags.push({
          code: "sill-range",
          message: `Wall ${photo.wall}: sill is ${String(Math.round(sill))} cm (0-120 cm expected).`,
          wall: photo.wall,
        });
      }
    }
  }

  const wallLengths: RoomDraft["wallLengths"] = {
    A: unc(input.tapeA, 0, "taped"),
    B: unc(input.tapeB, 0, "taped"),
    C: unc(input.tapeA, 0, "taped"),
    D: unc(input.tapeB, 0, "taped"),
  };

  const layout = draftToRoomLayout(
    {
      wallLengths,
      ceilingHeight: unc(ceiling, ceilingUnc, ceilingSource),
      openings,
    },
    input,
  );
  return {
    layout,
    wallLengths,
    ceilingHeight: unc(ceiling, ceilingUnc, ceilingSource),
    openings,
    photos,
    letterToWallId: { ...LETTER_TO_WALL_ID },
    flags,
  };
}

export function draftToRoomLayout(
  draft: Pick<RoomDraft, "wallLengths" | "ceilingHeight" | "openings">,
  input: SolverInput,
): RoomLayout {
  const room = createRectangleRoom({
    widthCm: Math.round(draft.wallLengths.A.value),
    depthCm: Math.round(draft.wallLengths.B.value),
    heightCm: Math.round(draft.ceilingHeight.value),
    id: "photos-room",
    name: "Room from photos",
  });
  room.source = "photos";
  const tapeAvg = (input.tapeA + input.tapeB) / 2;
  room.confidence = draft.ceilingHeight.source === "photo" ? 0.7 : 0.4;
  void tapeAvg;
  // Clamp every opening inside its wall so the built layout validates; the
  // draft keeps the raw photo estimates with their uncertainties.
  const wallLenOf = (wallId: string): number => {
    const wall = room.walls.find((w) => w.id === wallId);
    if (wall === undefined) return 0;
    return Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z);
  };
  const ceilCm = Math.round(draft.ceilingHeight.value);
  room.openings = draft.openings.map((o) => {
    const len = wallLenOf(o.wallId);
    const width = Math.min(Math.max(1, Math.round(o.width.value)), Math.max(1, Math.round(len)));
    const offset = Math.min(
      Math.max(0, Math.round(o.offset.value)),
      Math.max(0, Math.round(len) - width),
    );
    if (o.type === "door") {
      return {
        id: o.id,
        wallId: o.wallId,
        type: "door" as const,
        offset,
        width,
        height: Math.min(Math.max(1, Math.round(o.height.value)), ceilCm),
        sillHeight: 0,
        hinge: o.hinge ?? "left",
        swing: o.swing ?? "in",
      };
    }
    const height = Math.min(Math.max(1, Math.round(o.height.value)), ceilCm);
    const sillHeight = Math.min(
      Math.max(0, Math.round(o.sillHeight.value)),
      Math.max(0, ceilCm - height),
    );
    return {
      id: o.id,
      wallId: o.wallId,
      type: "window" as const,
      offset,
      width,
      height,
      sillHeight,
    };
  });
  return room;
}

/** Validate a RoomDraft: structure, tape exactness, extents, lines, flags. */
export function validateRoomDraft(draft: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const d = draft as Partial<RoomDraft>;
  if (typeof d !== "object" || d === null) return { ok: false, errors: ["draft is not an object"] };
  for (const letter of ["A", "B", "C", "D"] as const) {
    const v = d.wallLengths?.[letter];
    if (v === undefined || !Number.isFinite(v.value) || v.value <= 0) {
      errors.push(`wallLengths.${letter} is not a positive number`);
    }
  }
  if (d.wallLengths !== undefined) {
    if (d.wallLengths.A?.value !== d.wallLengths.C?.value) {
      errors.push("opposite walls A and C differ (tape is exact)");
    }
    if (d.wallLengths.B?.value !== d.wallLengths.D?.value) {
      errors.push("opposite walls B and D differ (tape is exact)");
    }
  }
  if (d.ceilingHeight === undefined || !Number.isFinite(d.ceilingHeight.value)) {
    errors.push("ceilingHeight is missing");
  }
  if (!Array.isArray(d.photos) || d.photos.length === 0 || d.photos.length > 4) {
    errors.push("photos has 1-4 entries");
  }
  for (const [i, p] of (d.photos ?? []).entries()) {
    for (const key of ["floor", "ceiling", "left", "right"] as const) {
      const line = p?.lines?.[key];
      if (
        line === undefined ||
        !Number.isFinite(line.a) ||
        !Number.isFinite(line.b) ||
        !Number.isFinite(line.c)
      ) {
        errors.push(`photos[${String(i)}].lines.${key} is not a fitted line`);
      }
    }
    for (const key of ["m1", "m2", "m3", "m4"] as const) {
      const c = p?.corners?.[key];
      if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
        errors.push(`photos[${String(i)}].corners.${key} is not a point`);
      }
    }
  }
  if (d.layout !== undefined) {
    const res = validateRoomLayout(d.layout);
    if (!res.ok) {
      for (const e of res.errors) errors.push(`layout.${e.path}: ${e.message}`);
    }
    if ((d.layout as RoomLayout).source !== "photos") errors.push("layout.source is not photos");
  }
  return { ok: errors.length === 0, errors };
}
