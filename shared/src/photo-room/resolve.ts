/**
 * Re-solve a photo-built room from hand-moved corners.
 *
 * Pure TypeScript, no DOM. The photos' current corners (any of m1-m4 moved
 * by hand in the 1280 px photo frame) plus the two tape values re-run the
 * solver's own steps — factored out of `solveRoomFromPhotos` without
 * changing its results — so wall lengths, the openings mapped through each
 * wall's new homography, and the same uncertainty and source rules come
 * out. A corner outside its photo is refused with a throw.
 */
import { createRectangleRoom } from "../rectangle.js";
import type { RoomLayout } from "../types.js";
import { applyHomography, wallHomography } from "./geometry.js";
import {
  applyH,
  blendCeilingHeight,
  cornersOutOfFrame,
  estimateWallHeightFromCorners,
  invertHomography3x3,
  tapeForLetter,
  type CornerSet,
} from "./steps.js";
import { draftToRoomLayout } from "./solve.js";
import {
  LETTER_TO_WALL_ID,
  type DraftFlag,
  type PhotoSolution,
  type RoomDraft,
  type Uncertain,
  type WallLetter,
} from "./types.js";

export const WALL_ORDER: WallLetter[] = ["A", "B", "C", "D"];

export type PhotoCorners = CornerSet;

export interface ResolveRoomInput {
  /** Solver output whose photos carry the current (possibly moved) corners. */
  base: RoomDraft;
  /** New corners per wall; omitted walls keep the base corners. */
  corners: Partial<Record<WallLetter, PhotoCorners>>;
  /** Photo frame per wall (the solver's PhotoSolution keeps no size). */
  sizes: Record<WallLetter, { width: number; height: number }>;
  /** Wall A (and C) length in cm (taped). */
  tapeA: number;
  /** Wall B (and D) length in cm (taped). */
  tapeB: number;
}

function unc(value: number, plusMinus: number, source: Uncertain["source"]): Uncertain {
  return { value: Math.round(value * 10) / 10, plusMinus: Math.round(plusMinus * 10) / 10, source };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Map one wall-cm point through the old homography back to the photo, then forward. */
function remapPoint(oldH: number[], newH: number[], x: number, y: number): [number, number] {
  const inv = invertHomography3x3(oldH);
  const img = applyH(inv, x, y);
  return applyHomography(newH, img[0], img[1]);
}

export function resolveRoomFromCorners(input: ResolveRoomInput): RoomDraft {
  const { base, corners, sizes, tapeA, tapeB } = input;
  // Every moved corner must land inside its photo; the solver never reads
  // outside the frame.
  for (const letter of WALL_ORDER) {
    const next = corners[letter];
    if (next === undefined) continue;
    const size = sizes[letter];
    for (const [x, y] of [next.m1, next.m2, next.m3, next.m4]) {
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        x >= size.width ||
        y < 0 ||
        y >= size.height
      ) {
        throw new Error(`Wall ${letter}: a moved corner is outside its photo.`);
      }
    }
  }

  const photos: PhotoSolution[] = [];
  const perWallHeight: Array<{ wall: WallLetter; h: number; w: number; t: boolean }> = [];
  const photoWide: boolean[] = [];
  const newCorners = new Map<WallLetter, PhotoCorners>();
  const newHeights = new Map<WallLetter, number>();

  for (const sol of base.photos) {
    const letter = sol.wall;
    const size = sizes[letter];
    const next: PhotoCorners = corners[letter] ?? sol.corners;
    newCorners.set(letter, next);
    const wallLen = tapeForLetter(letter, tapeA, tapeB);
    const estimate = estimateWallHeightFromCorners({
      corners: next,
      width: size.width,
      height: size.height,
      focalPx: sol.focalPx,
      wallLenCm: wallLen,
      floorRmse: sol.lines.floor.rmse,
      ceilRmse: sol.lines.ceiling.rmse,
      focal35mm: sol.focal35mm,
    });
    photoWide.push(estimate.wide);
    newHeights.set(letter, estimate.heightEstimate);
    const both = Number.isFinite(next.m1[0]) && Number.isFinite(next.m4[0]);
    const outOfFrame = cornersOutOfFrame(next, size.width, size.height);
    if (both && !outOfFrame) {
      const lineNoise = (sol.lines.floor.rmse + sol.lines.ceiling.rmse) / 2;
      // Trusted weight, like a confirmed contact line: the re-solve keeps
      // no per-wall trust record, so every framed wall contributes.
      const w = (1 / (1 + lineNoise * lineNoise)) * (estimate.wide ? 1 / 16 : 1);
      perWallHeight.push({ wall: letter, h: estimate.heightRaw, w, t: true });
    }
    photos.push({
      ...sol,
      lines: { ...sol.lines },
      corners: { m1: [...next.m1] as [number, number], m2: [...next.m2] as [number, number], m3: [...next.m3] as [number, number], m4: [...next.m4] as [number, number] },
      ratio: estimate.ratio,
      ratioPlusMinus: estimate.ratioPlusMinus,
      heightEstimate: estimate.heightEstimate,
      heightPlusMinus: estimate.heightPlusMinus,
    });
  }

  const blend = blendCeilingHeight(perWallHeight, photoWide);
  const ceilingHeight = unc(blend.ceiling, blend.ceilingUnc, blend.source);

  const wallLengths: RoomDraft["wallLengths"] = {
    A: unc(tapeA, 0, "taped"),
    B: unc(tapeB, 0, "taped"),
    C: unc(tapeA, 0, "taped"),
    D: unc(tapeB, 0, "taped"),
  };

  // Openings ride their wall's new homography: each opening's wall-cm
  // rectangle returns to the photo through the old homography, then lands
  // again through the new one. Untouched walls map to themselves exactly.
  const openings: RoomDraft["openings"] = base.openings.map((o) => ({ ...o }));
  for (const letter of WALL_ORDER) {
    const baseSol = base.photos.find((p) => p.wall === letter);
    const next = newCorners.get(letter);
    if (baseSol === undefined || next === undefined) continue;
    const wallLen = tapeForLetter(letter, tapeA, tapeB);
    const oldH = wallHomography(
      baseSol.corners.m1,
      baseSol.corners.m2,
      baseSol.corners.m3,
      baseSol.corners.m4,
      wallLen,
      baseSol.heightEstimate,
    );
    const newH = wallHomography(
      next.m1,
      next.m2,
      next.m3,
      next.m4,
      wallLen,
      newHeights.get(letter) ?? baseSol.heightEstimate,
    );
    for (const o of openings) {
      if (o.wall !== letter) continue;
      if (o.type === "door") {
        const [xa] = remapPoint(oldH, newH, o.offset.value, 0);
        const [xb] = remapPoint(oldH, newH, o.offset.value + o.width.value, 0);
        const width = Math.max(20, round1(Math.abs(xb - xa)));
        const off = round1(Math.max(0, Math.min(wallLen - width, Math.min(xa, xb))));
        o.offset = { ...o.offset, value: off };
        o.width = { ...o.width, value: width };
      } else {
        const pts = [
          remapPoint(oldH, newH, o.offset.value, o.sillHeight.value),
          remapPoint(oldH, newH, o.offset.value + o.width.value, o.sillHeight.value),
          remapPoint(
            oldH,
            newH,
            o.offset.value,
            o.sillHeight.value + o.height.value,
          ),
          remapPoint(
            oldH,
            newH,
            o.offset.value + o.width.value,
            o.sillHeight.value + o.height.value,
          ),
        ];
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const lo = Math.min(...xs);
        const hi = Math.max(...xs);
        const bot = Math.min(...ys);
        const top = Math.max(...ys);
        const width = Math.max(10, round1(hi - lo));
        const off = round1(Math.max(0, Math.min(wallLen - width, lo)));
        o.offset = { ...o.offset, value: off };
        o.width = { ...o.width, value: width };
        o.height = { ...o.height, value: Math.max(10, round1(top - bot)) };
        o.sillHeight = { ...o.sillHeight, value: Math.max(0, round1(bot)) };
      }
    }
  }

  const flags: DraftFlag[] = base.flags
    .filter((f) => f.code !== "ceiling-spread")
    .map((f) => ({ ...f }));
  if (blend.spread) {
    const mean = blend.ceiling;
    const spread = Math.max(...perWallHeight.map((e) => Math.abs(e.h - mean)));
    flags.push({
      code: "ceiling-spread",
      message: `Ceiling heights from different walls differ by ${String(Math.round((spread / mean) * 100))}%.`,
    });
  }

  const room = createRectangleRoom({
    widthCm: Math.round(wallLengths.A.value),
    depthCm: Math.round(wallLengths.B.value),
    heightCm: Math.round(ceilingHeight.value),
    id: "photos-room",
    name: "Room from photos",
  });
  room.source = "photos";
  room.confidence = ceilingHeight.source === "photo" ? 0.7 : 0.4;
  const layout: RoomLayout = draftToRoomLayout(
    { wallLengths, ceilingHeight, openings },
    { photos: [], tapeA, tapeB },
  );
  void room;

  return {
    layout,
    wallLengths,
    ceilingHeight,
    openings,
    photos,
    letterToWallId: { ...LETTER_TO_WALL_ID },
    flags,
  };
}
