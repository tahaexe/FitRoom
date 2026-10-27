/**
 * Segment one wall photo: `postSegment` for `wall`, `floor`, `ceiling`,
 * `door` and `window` in parallel (with progress), decoded with the shared
 * SAM decoder, then solved for the instant check.
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
    // and the analysis goes on. Only a missing or empty wall or floor
    // answer stops the instant check, with a plain reason.
    if (text === null || text.trim().length === 0) {
      if (concept === "wall" || concept === "floor") {
        throw new Error(
          concept === "wall"
            ? "The room scanner found no wall in that photo."
            : "The room scanner found no floor in that photo.",
        );
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
  return { instances, draft, solution };
}
