/**
 * Segment one wall photo: `postSegment` for `wall`, `floor`, `ceiling`,
 * `door` and `window` in parallel (with progress), decoded with the shared
 * SAM decoder, then solved for the instant check. When the `floor` answer
 * is empty the client asks once more with the concept `carpet` and uses
 * its instances as the floor, stopping only when both answers are empty.
 *
 * Demo mode answers `demo-miss` for the segment route, which is reported
 * plainly (never a silent failure) with a way to switch Live AI on.
 */

import {
  solveRoomFromPhotos,
  type DoorTap,
  type PhotoInput,
  type PhotoSolution,
  type RoomDraft,
  type SamInstance,
  type WallLetter,
} from "@fitroom/shared";
import { postSegment } from "../api";
import { segmentInstances } from "../capture/sam";
import {
  FALLBACK_DECODE_CONCEPT,
  FLOOR_FALLBACK_CONCEPT,
  NO_FLOOR_MESSAGE,
  NO_WALL_MESSAGE,
  isEmptyAnswerText,
} from "./cards";
import { computeSurfaceColors } from "./surfaces";

export const SEGMENT_CONCEPTS = ["wall", "floor", "ceiling", "door", "window"] as const;

/** Time limit for each segment request (60 s). */
export const SEGMENT_TIMEOUT_MS = 60000;

/** Time limit for the label request (30 s). */
export const LABEL_TIMEOUT_MS = 30000;

export type SegmentProgress = (done: number, total: number) => void;

export interface WallAnalysis {
  instances: SamInstance[];
  draft: RoomDraft;
  solution: PhotoSolution;
  /** Median wall colour of this photo (`#RRGGBB`), null when unavailable. */
  wallTint: string | null;
  /** Median floor colour of this photo (`#RRGGBB`), null when unavailable. */
  floorColor: string | null;
}

/** Mean side-edge deviation from vertical, in degrees: the phone-tilt readout. */
export function tiltDeg(solution: PhotoSolution): number {
  const angles = [solution.lines.left, solution.lines.right].map((line) => {
    if (Math.abs(line.a) < 1e-9) return 0;
    return (Math.atan(Math.abs(line.b / line.a)) * 180) / Math.PI;
  });
  return (Number(angles[0]) + Number(angles[1])) / 2;
}

/** Amber "Hold the phone level" threshold, in degrees of side-edge tilt. */
export const TILT_AMBER_DEG = 3;

/** True when every fitted corner sits inside the photo frame. */
export function cornersFound(solution: PhotoSolution, width: number, height: number): boolean {
  const margin = 3;
  return [solution.corners.m1, solution.corners.m2, solution.corners.m3, solution.corners.m4].every(
    ([x, y]) =>
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= margin &&
      x <= width - margin &&
      y >= margin &&
      y <= height - margin,
  );
}

/** True when the floor line stands on contact columns (not a hidden fallback). */
export function floorLineFound(solution: PhotoSolution): boolean {
  return solution.lines.floor.points >= 10 && solution.lines.floor.hiddenFraction <= 0.6;
}

function textOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const text = (data as Record<string, unknown>)["text"];
  return typeof text === "string" ? text : null;
}

/**
 * The one-shot floor fallback: a single `carpet` request, decoded as floor
 * instances so they join the floor mask. Resolves null when both answers
 * are empty. The extra call happens only on an empty floor answer.
 */
async function requestFloorFallback(
  segUrl: string,
  dims: { width: number; height: number },
  onProgress: SegmentProgress,
): Promise<SamInstance[] | { demoMiss: true } | null> {
  onProgress(SEGMENT_CONCEPTS.length, SEGMENT_CONCEPTS.length + 1);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEGMENT_TIMEOUT_MS);
  try {
    const result = await postSegment(
      { image: segUrl, concept: FLOOR_FALLBACK_CONCEPT },
      { signal: controller.signal },
    );
    onProgress(SEGMENT_CONCEPTS.length + 1, SEGMENT_CONCEPTS.length + 1);
    if (result.status === "demo-miss") return { demoMiss: true };
    if (result.status !== "ok") {
      throw new Error(
        result.status === "error" || result.status === "capped"
          ? result.message
          : "The AI service is unreachable.",
      );
    }
    const text = textOf(result.data);
    if (text === null || isEmptyAnswerText(text)) return null;
    return segmentInstances(FALLBACK_DECODE_CONCEPT, text, dims);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Segment one 1280 px photo and solve it for the instant check.
 * Placeholder tapes only scale the height readout (corners, lines and
 * tilt never depend on them). Throws a plain-English error, except
 * `demo-miss` which resolves to `{ demoMiss: true }`.
 */
export async function analyseWallPhoto(
  wall: WallLetter,
  segUrl: string,
  segWidth: number,
  segHeight: number,
  focal35mm: number | undefined,
  doorTap: DoorTap | null,
  onProgress: SegmentProgress,
): Promise<WallAnalysis | { demoMiss: true }> {
  const total = SEGMENT_CONCEPTS.length;
  let done = 0;
  onProgress(0, total);
  const perConcept = SEGMENT_CONCEPTS.map((concept) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEGMENT_TIMEOUT_MS);
    return postSegment({ image: segUrl, concept }, { signal: controller.signal })
      .then((result) => {
        done += 1;
        onProgress(done, total);
        return { concept, result };
      })
      .finally(() => clearTimeout(timer));
  });
  const answers = await Promise.all(perConcept);
  for (const { result } of answers) {
    if (result.status === "demo-miss") return { demoMiss: true };
  }
  const instances: SamInstance[] = [];
  for (const { concept, result } of answers) {
    if (result.status !== "ok") {
      throw new Error(
        result.status === "error" || result.status === "capped"
          ? result.message
          : "The AI service is unreachable.",
      );
    }
    const text = textOf(result.data);
    // A wall without windows, doors or a ceiling in view is normal: a
    // missing or empty answer for an optional concept holds zero instances
    // and the analysis goes on. An empty wall answer stops the instant
    // check with a retake reason; an empty floor answer first tries the
    // one-shot carpet fallback and stops only when both are empty.
    if (text === null || isEmptyAnswerText(text)) {
      if (concept === "wall") throw new Error(NO_WALL_MESSAGE);
      if (concept === "floor") {
        const fallback = await requestFloorFallback(
          segUrl,
          { width: segWidth, height: segHeight },
          onProgress,
        );
        if (fallback === null) throw new Error(NO_FLOOR_MESSAGE);
        if ("demoMiss" in fallback) return { demoMiss: true };
        instances.push(...fallback);
        continue;
      }
      continue;
    }
    instances.push(
      ...(await segmentInstances(concept, text, { width: segWidth, height: segHeight })),
    );
  }
  const photo: PhotoInput = {
    wall,
    width: segWidth,
    height: segHeight,
    focal35mm,
    instances,
  };
  const draft = solveRoomFromPhotos({
    photos: [photo],
    tapeA: 400,
    tapeB: 350,
    ...(doorTap !== null && doorTap.wall === wall ? { doorTap } : {}),
  });
  const solution = draft.photos[0];
  if (solution === undefined) throw new Error("The room scanner found no wall in that photo.");
  // The masks are at hand now: tint from the photo pixels, no extra call.
  // Pixels never block the check: a missed read keeps null colours.
  let wallTint: string | null = null;
  let floorColor: string | null = null;
  try {
    if (typeof document !== "undefined") {
      const colors = await computeSurfaceColors(segUrl, segWidth, segHeight, instances);
      wallTint = colors.wallTint;
      floorColor = colors.floorColor;
    }
  } catch {
    wallTint = null;
    floorColor = null;
  }
  // Keep the colours with the photo's own solution, for the build step.
  if (wallTint !== null) solution.wallTint = wallTint;
  if (floorColor !== null) solution.floorColor = floorColor;
  return { instances, draft, solution, wallTint, floorColor };
}
