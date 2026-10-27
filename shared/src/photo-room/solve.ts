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
  widthHeightRatio,
  type LineFit,
} from "./geometry.js";
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
const DEFAULT_CEILING_CM = 250;
const DEFAULT_FOCAL_35MM = 26;

function tapeFor(letter: WallLetter, tapeA: number, tapeB: number): number {
  return letter === "A" || letter === "C" ? tapeA : tapeB;
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
    if (windows.length > 0 && walls.length > 0) {
      // No wall covers the centre but windows do: build the plane from
      // wall and window pieces together.
      const pieces = [...walls, ...windows];
      const colMin = Math.max(0, Math.min(...pieces.map((p) => p.box[0])));
      const colMax = Math.min(W - 1, Math.max(...pieces.map((p) => p.box[2])));
      return { pieces, side: [], colMin, colMax, centreCovered: false };
    }
    if (walls.length > 0) {
      seed = walls.reduce((a, b) => {
        const aa = (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]);
        const bb = (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]);
        return bb > aa ? b : a;
      });
    } else {
      return { pieces: [], side: [], colMin: 0, colMax: W - 1, centreCovered: false };
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
  const colMin = Math.max(0, Math.min(...pieces.map((p) => p.box[0])));
  const colMax = Math.min(W - 1, Math.max(...pieces.map((p) => p.box[2])));
  const covered = cx >= colMin && cx <= colMax;
  const side = walls.filter((w) => !pieces.includes(w));
  return { pieces, side, colMin, colMax, centreCovered: covered };
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
}

function fitBoundaries(photo: PhotoInput, pick: WallPick): Boundaries {
  const W = photo.width;
  const H = photo.height;
  const floors = byConcept(photo.instances, "floor");
  const ceilings = byConcept(photo.instances, "ceiling");
  const colMin = pick.colMin;
  const colMax = pick.colMax;
  const wallPieces = pick.pieces.filter((p) => p.concept === "wall");

  // Floor-wall: the lower of the floor mask's upper boundary and the wall
  // mask's lower edge per column (masks overlap by a few pixels; the
  // minimum is the wall's true extent), RANSACed so a doorway's lintel
  // never wins. Never the wall edge alone: furniture hides it.
  const floorPts: Array<[number, number]> = [];
  let floorMissing = 0;
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
    if (top === null) floorMissing += 1;
    let bot: number | null = null;
    for (let y = H - 1; y >= 0; y -= 1) {
      if (unionAt(wallPieces, x, y)) {
        bot = y;
        break;
      }
    }
    if (top !== null && bot !== null) floorPts.push([x, Math.min(top, bot)]);
    else if (top !== null) floorPts.push([x, top]);
    else if (bot !== null) floorPts.push([x, bot]);
  }
  const floorHidden = floorTotal === 0 ? 1 : floorMissing / floorTotal;
  // A sofa can hide the middle: points covering under 30 % of the column
  // range cannot anchor a line, so the wall mask's own lower edge stands
  // in (the hidden flag stays set above).
  const spanOf = (pts: Array<[number, number]>): number => {
    if (pts.length === 0) return 0;
    return Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
  };
  const colSpan = Math.max(1, colMax - colMin);
  const floorUsable = floorPts.length >= 10 && spanOf(floorPts) >= 0.3 * colSpan;
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
  // Ceiling-wall: the higher of the ceiling mask's lower boundary and
  // the wall mask's upper edge per column, RANSACed the same way.
  const ceilPts: Array<[number, number]> = [];
  let ceilMissing = 0;
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
    if (low === null) ceilMissing += 1;
    let up: number | null = null;
    for (let y = 0; y < H; y += 1) {
      if (unionAt(wallPieces, x, y)) {
        up = y;
        break;
      }
    }
    if (low !== null && up !== null) ceilPts.push([x, Math.max(low, up)]);
    else if (low !== null) ceilPts.push([x, low]);
    else if (up !== null) ceilPts.push([x, up]);
  }
  const ceilHidden = ceilTotal === 0 ? 1 : ceilMissing / ceilTotal;
  const ceilUsable = ceilPts.length >= 10 && spanOf(ceilPts) >= 0.3 * colSpan;
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
  // Side edges: facing-wall mask left/right boundaries, fitted on clean
  // rows only (a doorway splits the boundary; the lintel and below-sill
  // bands still show the true corners). Falls back to all rows.
  const yMin = Math.max(0, Math.min(...wallPieces.map((p) => p.box[1])));
  const yMax = Math.min(H - 1, Math.max(...wallPieces.map((p) => p.box[3])));
  const top = Number.isFinite(yMin) ? (yMin as number) : 0;
  const bot = Number.isFinite(yMax) ? (yMax as number) : H - 1;
  const cleanRows: number[] = [];
  for (let y = top; y <= bot; y += 1) {
    if (rowOccupancy(wallPieces, y, colMin, colMax) > 0.9) cleanRows.push(y);
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
      if (unionAt(wallPieces, x, y)) {
        if (l === null) l = x;
        r = x;
      }
    }
    if (l !== null) leftPts.push([l as number, y]);
    if (r !== null) rightPts.push([r as number, y]);
  }
  const floor = toFitted(
    fitLineRansac(floorPtsFinal.length > 0 ? floorPtsFinal : [[colMin, H - 1]], "horizontal"),
    floorPtsFinal.length,
    floorHidden,
  );
  const ceiling = toFitted(
    fitLineRansac(ceilPtsFinal.length > 0 ? ceilPtsFinal : [[colMin, 0]], "horizontal"),
    ceilPtsFinal.length,
    ceilHidden,
  );
  let left = toFitted(
    fitLineRansac(leftPts.length > 0 ? leftPts : [[colMin, 0]], "vertical"),
    leftPts.length,
    0,
  );
  let right = toFitted(
    fitLineRansac(rightPts.length > 0 ? rightPts : [[colMax, 0]], "vertical"),
    rightPts.length,
    0,
  );
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
  return { floor, ceiling, left, right, floorHidden, ceilHidden };
}

function unc(value: number, plusMinus: number, source: Uncertain["source"]): Uncertain {
  return { value: Math.round(value * 10) / 10, plusMinus: Math.round(plusMinus * 10) / 10, source };
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
    const bandTop = bot - (bot - top) * 0.15;
    let fill = 0;
    let total = 0;
    for (let y = Math.ceil(bandTop); y <= Math.floor(bot); y += 2) {
      total += 1;
      if (unionAt(wallPieces, x, y)) fill += 1;
    }
    out.push({ x, occ: total === 0 ? 1 : fill / total });
  }
  return out;
}

function findDoorGap(
  wallPieces: SamInstance[],
  floor: FittedLine,
  ceiling: FittedLine,
  colMin: number,
  colMax: number,
): { x0: number; x1: number } | null {
  if (wallPieces.length === 0) return null;
  const occ = wallOccupancy(wallPieces, floor, ceiling, colMin, colMax);
  const consider = (
    x0: number,
    x1: number,
    best: { x0: number; x1: number } | null,
  ): { x0: number; x1: number } | null => {
    // No edge rejection here: a real doorway can sit near the facing
    // wall's corner (its leaf spills past the jamb), while ragged mask
    // borders are narrow. Edge proximity is decided by the leaf check at
    // the call site, not by geometry.
    if (x1 - x0 <= 25) return best;
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

export function solveRoomFromPhotos(input: SolverInput): RoomDraft {
  const flags: DraftFlag[] = [];
  const photos: PhotoSolution[] = [];
  const perWallHeight: Array<{ wall: WallLetter; h: number; w: number }> = [];

  for (const photo of input.photos) {
    const focal35mm = photo.focal35mm ?? DEFAULT_FOCAL_35MM;
    const focalSource = photo.focal35mm === undefined ? "default" : "exif";
    if (focal35mm < 18) {
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
    let ratio = widthHeightRatio(m1, m2, m3, m4, photo.width, photo.height, fPx);
    if (!Number.isFinite(ratio) || ratio <= 0.2 || ratio > 8) {
      ratio = wallLen / DEFAULT_CEILING_CM;
    }
    const wallPxH = Math.max(1, Math.abs((m3[1] + m4[1]) / 2 - (m1[1] + m2[1]) / 2));
    const lineNoise = (bounds.floor.rmse + bounds.ceiling.rmse) / 2;
    const ratioUnc = ratio * Math.max(0.01, (lineNoise + 1.5) / wallPxH);
    const height = wallLen / ratio;
    const heightUnc = Math.max(1.5, height * (ratioUnc / ratio));
    // A side edge at the image border means a corner out of frame: judge
    // the fitted corners (side-wall slivers may touch the border while the
    // facing corners sit inside). A corner on the border is already cut.
    const margin = 3;
    const outOfFrame = [m1, m2, m3, m4].some(
      ([x, y]) =>
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < margin ||
        x > photo.width - margin ||
        y < margin ||
        y > photo.height - margin,
    );
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
    const both = Number.isFinite(m1[0]) && Number.isFinite(m4[0]);
    if (both && !outOfFrame) {
      const w = 1 / (1 + lineNoise * lineNoise);
      perWallHeight.push({ wall: photo.wall, h: height, w });
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
  // corners and both lines.
  let ceiling = DEFAULT_CEILING_CM;
  let ceilingUnc = 15;
  let ceilingSource: Uncertain["source"] = "default";
  if (perWallHeight.length > 0) {
    let sw = 0;
    let sh = 0;
    for (const e of perWallHeight) {
      sw += e.w;
      sh += e.h * e.w;
    }
    ceiling = sh / sw;
    const mean = ceiling;
    let spread = 0;
    for (const e of perWallHeight) spread = Math.max(spread, Math.abs(e.h - mean));
    ceilingUnc = Math.max(2, spread / 2 + 2);
    ceilingSource = "photo";
    if (spread > 0.03 * mean && perWallHeight.length > 1) {
      flags.push({
        code: "ceiling-spread",
        message: `Ceiling heights from different walls differ by ${String(Math.round((spread / mean) * 100))}%.`,
      });
    }
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
    const windows = byConcept(photo.instances, "window").filter((w) => inRange(w.box));

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
    const gap = findDoorGap(
      structural,
      sol.lines.floor,
      sol.lines.ceiling,
      pick.colMin,
      pick.colMax,
    );
    const touchesGapOrLeaf = (p: SamInstance): boolean => {
      const nearGap = gap !== null && p.box[0] <= gap.x1 + 4 && p.box[2] >= gap.x0 - 4;
      const nearLeaf = doors.some((d) => boxesTouch(p, d, 8));
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
      // renders). The doorway starts at the innermost west evidence: an
      // ajar leaf widens the raw gap past its jamb.
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
      let hi = Math.max(...east);
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
      const leafConfirms =
        Number.isFinite(imgLo) &&
        Number.isFinite(imgHi) &&
        doors.some((d) => d.box[0] <= imgHi + 12 && d.box[2] >= imgLo - 12);
      if (tallShare < 0.4 || !leafConfirms) {
        if (doors.length > 0) {
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
        // Hinge in room terms from the leaf beside the gap: room left is
        // the wall-end side (image right), so a leaf east of the gap means
        // a left hinge.
        let hinge: "left" | "right" = "left";
        if (doors.length > 0 && (gap !== null || frame.length > 0)) {
          const leaf = doors.reduce((a, b) => (b.box[2] - b.box[0] > a.box[2] - a.box[0] ? b : a));
          const leafCx = (leaf.box[0] + leaf.box[2]) / 2;
          const refCx = gap !== null ? (gap.x0 + gap.x1) / 2 : (lo + hi) / 2;
          hinge = leafCx > refCx ? "left" : "right";
        } else if (photo.wall === "A") {
          hinge = "left";
        }
        doorN += 1;
        const wUnc = Math.max(3, (sol.lines.floor.rmse + 2) * (wallLen / photo.width) * 2);
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
    } else if (doors.length > 0) {
      flags.push({
        code: "tap-the-door",
        message: `Wall ${photo.wall}: a door leaf is visible but no opening was found — tap the door.`,
        wall: photo.wall,
      });
    }

    for (const win of windows) {
      if (doors.length > 0 && doors.some((d) => boxesTouch(win, d))) continue;
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
      const wUnc = Math.max(3, (sol.lines.floor.rmse + 2) * (wallLen / photo.width) * 2);
      openings.push({
        id: `window-${String(winN)}`,
        wall: photo.wall,
        wallId: LETTER_TO_WALL_ID[photo.wall],
        type: "window",
        offset: unc(off, wUnc, "photo"),
        width: unc(width, wUnc, "photo"),
        height: unc(height, Math.max(4, height * 0.05), "photo"),
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
