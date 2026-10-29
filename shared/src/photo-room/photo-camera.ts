/** Recover a wall photo's camera in the room frame (cm). Pure, no DOM. */

import { invertHomography3x3, type CornerSet } from "./steps.js";
import { wallHomography } from "./geometry.js";
import type { WallLetter } from "./types.js";

export interface RoomPointCm {
  x: number;
  y: number;
  z: number;
}

export interface RecoverWallCameraInput {
  corners: CornerSet;
  wall: WallLetter;
  wallLenCm: number;
  wallHeightCm: number;
  roomWidthCm: number;
  roomDepthCm: number;
  focalPx: number;
  imageWidth: number;
  imageHeight: number;
}

export interface WallPhotoCamera {
  wall: WallLetter;
  positionCm: RoomPointCm;
  /** World-to-camera rotation, rows [right; up; forward]. */
  rotation: [number, number, number, number, number, number, number, number, number];
  translation: [number, number, number];
  focalPx: number;
  cx: number;
  cy: number;
  imageWidth: number;
  imageHeight: number;
  vfovDeg: number;
  aspect: number;
}

function norm3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function wallEndpoints(
  wall: WallLetter,
  roomW: number,
  roomD: number,
): { start: [number, number]; end: [number, number] } {
  if (wall === "A") return { start: [0, 0], end: [roomW, 0] };
  if (wall === "C") return { start: [roomW, roomD], end: [0, roomD] };
  if (wall === "B") return { start: [0, roomD], end: [0, 0] };
  return { start: [roomW, 0], end: [roomW, roomD] };
}

/**
 * Recover the photo's camera in the room frame (cm) from one wall quad.
 *
 * The wall homography (image px -> wall cm, u from the wall start, v up)
 * inverts to wall-cm -> image px. With centred intrinsics that plane
 * homography factors as K^-1 H^-1 ~ [r1 r2 t] (r1 along the wall, r2 up),
 * made orthonormal, then rotated into the room frame by the wall's own
 * direction. Also gives the three.js form (position metres, vfov, aspect).
 */
export function recoverWallPhotoCamera(input: RecoverWallCameraInput): WallPhotoCamera | null {
  const { corners, wall, wallLenCm, wallHeightCm, roomWidthCm, roomDepthCm } = input;
  const { focalPx, imageWidth, imageHeight } = input;
  if (!(wallLenCm > 0) || !(wallHeightCm > 0)) return null;
  if (!(focalPx > 0) || !(imageWidth > 0) || !(imageHeight > 0)) return null;
  for (const p of [corners.m1, corners.m2, corners.m3, corners.m4]) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
  }
  const hImgToWall = wallHomography(
    corners.m1,
    corners.m2,
    corners.m3,
    corners.m4,
    wallLenCm,
    wallHeightCm,
  );
  const h00 = hImgToWall[0] as number;
  const h01 = hImgToWall[1] as number;
  const h02 = hImgToWall[2] as number;
  const h10 = hImgToWall[3] as number;
  const h11 = hImgToWall[4] as number;
  const h12 = hImgToWall[5] as number;
  const h20 = hImgToWall[6] as number;
  const h21 = hImgToWall[7] as number;
  const h22 = hImgToWall[8] as number;
  const det =
    h00 * (h11 * h22 - h12 * h21) - h01 * (h10 * h22 - h12 * h20) + h02 * (h10 * h21 - h11 * h20);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const hWallToImg = invertHomography3x3(hImgToWall);
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;
  const iw = (i: number): number => hWallToImg[i] as number;
  // M = K^-1 H (wall-cm -> normalized ray), columns [m1 m2 m3].
  const m: number[] = [
    (iw(0) - cx * iw(6)) / focalPx,
    (iw(1) - cx * iw(7)) / focalPx,
    (iw(2) - cx * iw(8)) / focalPx,
    (iw(3) - cy * iw(6)) / -focalPx,
    (iw(4) - cy * iw(7)) / -focalPx,
    (iw(5) - cy * iw(8)) / -focalPx,
    iw(6),
    iw(7),
    iw(8),
  ];
  const m1: [number, number, number] = [m[0] as number, m[3] as number, m[6] as number];
  const m2: [number, number, number] = [m[1] as number, m[4] as number, m[7] as number];
  const m3: [number, number, number] = [m[2] as number, m[5] as number, m[8] as number];
  const lambda = (Math.hypot(m1[0], m1[1], m1[2]) + Math.hypot(m2[0], m2[1], m2[2])) / 2;
  if (!(lambda > 1e-12)) return null;

  const { start, end } = wallEndpoints(wall, roomWidthCm, roomDepthCm);
  const len = Math.hypot(end[0] - start[0], end[1] - start[1]) || 1;
  const dir: [number, number, number] = [(end[0] - start[0]) / len, 0, (end[1] - start[1]) / len];
  const up: [number, number, number] = [0, 1, 0];
  const inward = norm3(cross3(dir, up));
  // World basis columns [D Y N]; rotation R = Q W^T with Q columns [r1 r2 r3].
  const wT: number[][] = [
    [dir[0], dir[1], dir[2]],
    [up[0], up[1], up[2]],
    [inward[0], inward[1], inward[2]],
  ];
  const start3: [number, number, number] = [start[0], 0, start[1]];

  const candidates: Array<{
    rotation: [number, number, number, number, number, number, number, number, number];
    translation: [number, number, number];
    positionCm: RoomPointCm;
    depth: number;
  }> = [];
  for (const s of [1, -1] as const) {
    const r1 = norm3([s * m1[0], s * m1[1], s * m1[2]]);
    const r2raw: [number, number, number] = [s * m2[0], s * m2[1], s * m2[2]];
    const along = dot3(r2raw, r1);
    const r2o: [number, number, number] = [
      r2raw[0] - along * r1[0],
      r2raw[1] - along * r1[1],
      r2raw[2] - along * r1[2],
    ];
    if (Math.hypot(r2o[0], r2o[1], r2o[2]) < 1e-9) continue;
    const r2 = norm3(r2o);
    // Camera space here is (right, up, forward-depth): a reflection, so the
    // plane normal maps to minus the cross product (right x up = -forward).
    const r3 = norm3(cross3(r1, r2).map((v) => -v) as [number, number, number]);
    // Q = [r1 r2 r3] columns; R = Q W^T.
    const q: number[][] = [
      [r1[0], r2[0], r3[0]],
      [r1[1], r2[1], r3[1]],
      [r1[2], r2[2], r3[2]],
    ];
    // R = Q W^T with W's columns [D Y N]: ww is the col-th row of W^T,
    // i.e. the col-th components of (D, Y, N) — not the col-th basis vector.
    const r: number[][] = [0, 1, 2].map((row) =>
      [0, 1, 2].map((col) => {
        const qq = q[row] as number[];
        return (
          (qq[0] as number) * ((wT[0] as number[])[col] as number) +
          (qq[1] as number) * ((wT[1] as number[])[col] as number) +
          (qq[2] as number) * ((wT[2] as number[])[col] as number)
        );
      }),
    );
    const t0: [number, number, number] = [
      (s * m3[0]) / lambda,
      (s * m3[1]) / lambda,
      (s * m3[2]) / lambda,
    ];
    const rs: [number, number, number] = [
      (r[0]?.[0] as number) * start3[0] +
        (r[0]?.[1] as number) * start3[1] +
        (r[0]?.[2] as number) * start3[2],
      (r[1]?.[0] as number) * start3[0] +
        (r[1]?.[1] as number) * start3[1] +
        (r[1]?.[2] as number) * start3[2],
      (r[2]?.[0] as number) * start3[0] +
        (r[2]?.[1] as number) * start3[1] +
        (r[2]?.[2] as number) * start3[2],
    ];
    const t: [number, number, number] = [t0[0] - rs[0], t0[1] - rs[1], t0[2] - rs[2]];
    // Camera centre and wall-centre depth pick the sign.
    const rt: number[][] = [
      [r[0]?.[0] as number, r[1]?.[0] as number, r[2]?.[0] as number],
      [r[0]?.[1] as number, r[1]?.[1] as number, r[2]?.[1] as number],
      [r[0]?.[2] as number, r[1]?.[2] as number, r[2]?.[2] as number],
    ];
    const centre: [number, number, number] = [
      start3[0] + dir[0] * (wallLenCm / 2),
      wallHeightCm / 2,
      start3[2] + dir[2] * (wallLenCm / 2),
    ];
    const camPos: [number, number, number] = [
      -(
        (rt[0]?.[0] as number) * t[0] +
        (rt[0]?.[1] as number) * t[1] +
        (rt[0]?.[2] as number) * t[2]
      ),
      -(
        (rt[1]?.[0] as number) * t[0] +
        (rt[1]?.[1] as number) * t[1] +
        (rt[1]?.[2] as number) * t[2]
      ),
      -(
        (rt[2]?.[0] as number) * t[0] +
        (rt[2]?.[1] as number) * t[1] +
        (rt[2]?.[2] as number) * t[2]
      ),
    ];
    const depth =
      (r[2]?.[0] as number) * centre[0] +
      (r[2]?.[1] as number) * centre[1] +
      (r[2]?.[2] as number) * centre[2] +
      t[2];
    if (!(depth > 0)) continue;
    const rotation: [number, number, number, number, number, number, number, number, number] = [
      r[0]?.[0] as number,
      r[0]?.[1] as number,
      r[0]?.[2] as number,
      r[1]?.[0] as number,
      r[1]?.[1] as number,
      r[1]?.[2] as number,
      r[2]?.[0] as number,
      r[2]?.[1] as number,
      r[2]?.[2] as number,
    ];
    candidates.push({
      rotation,
      translation: t,
      positionCm: { x: camPos[0], y: camPos[1], z: camPos[2] },
      depth,
    });
  }
  // Two plane solutions differ by a mirror: the photo was taken from inside
  // the room, on the wall's inward side with the wall centre ahead. Prefer a
  // candidate inside the room; fall back to the inward side, then depth.
  const inside = (p: RoomPointCm): boolean =>
    p.x >= -1 &&
    p.x <= roomWidthCm + 1 &&
    p.z >= -1 &&
    p.z <= roomDepthCm + 1 &&
    p.y > 0 &&
    p.y < wallHeightCm + 60;
  const scored = candidates
    .map((c) => {
      const alongInward =
        (c.positionCm.x - start3[0]) * inward[0] + (c.positionCm.z - start3[2]) * inward[2];
      return { c, alongInward, inRoom: inside(c.positionCm) };
    })
    .filter((e) => Number.isFinite(e.alongInward));
  const picked =
    scored.find((e) => e.inRoom && e.alongInward > 0)?.c ??
    scored.find((e) => e.alongInward > 0)?.c ??
    candidates[0];
  if (picked === undefined) return null;
  const vfovDeg = (2 * Math.atan(imageHeight / 2 / focalPx) * 180) / Math.PI;
  return {
    wall,
    positionCm: picked.positionCm,
    rotation: picked.rotation,
    translation: picked.translation,
    focalPx,
    cx,
    cy,
    imageWidth,
    imageHeight,
    vfovDeg,
    aspect: imageWidth / imageHeight,
  };
}

/** Project a room-cm point to image px; z is the camera-space depth. */
export function projectWallPhotoCamera(
  cam: WallPhotoCamera,
  p: RoomPointCm,
): { x: number; y: number; z: number } {
  const r = cam.rotation;
  const x =
    (r[0] as number) * p.x + (r[1] as number) * p.y + (r[2] as number) * p.z + cam.translation[0];
  const y =
    (r[3] as number) * p.x + (r[4] as number) * p.y + (r[5] as number) * p.z + cam.translation[1];
  const z =
    (r[6] as number) * p.x + (r[7] as number) * p.y + (r[8] as number) * p.z + cam.translation[2];
  if (!(z > 1e-9)) return { x: NaN, y: NaN, z };
  return { x: cam.cx + (cam.focalPx * x) / z, y: cam.cy - (cam.focalPx * y) / z, z };
}

/** three.js form: position metres, quaternion, vertical fov and aspect. */
export function wallPhotoCameraThree(cam: WallPhotoCamera): {
  positionM: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  vfovDeg: number;
  aspect: number;
} {
  const r = cam.rotation;
  // Camera rows: right, up, forward. three.js looks down -Z: basis [r u -f].
  const m = [
    [r[0], r[3], -(r[6] as number)],
    [r[1], r[4], -(r[7] as number)],
    [r[2], r[5], -(r[8] as number)],
  ];
  const trace = (m[0]?.[0] as number) + (m[1]?.[1] as number) + (m[2]?.[2] as number);
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = ((m[2]?.[1] as number) - (m[1]?.[2] as number)) / s;
    y = ((m[0]?.[2] as number) - (m[2]?.[0] as number)) / s;
    z = ((m[1]?.[0] as number) - (m[0]?.[1] as number)) / s;
  } else if (
    (m[0]?.[0] as number) > (m[1]?.[1] as number) &&
    (m[0]?.[0] as number) > (m[2]?.[2] as number)
  ) {
    const s =
      Math.sqrt(1 + (m[0]?.[0] as number) - (m[1]?.[1] as number) - (m[2]?.[2] as number)) * 2;
    w = ((m[2]?.[1] as number) - (m[1]?.[2] as number)) / s;
    x = 0.25 * s;
    y = ((m[0]?.[1] as number) + (m[1]?.[0] as number)) / s;
    z = ((m[0]?.[2] as number) + (m[2]?.[0] as number)) / s;
  } else if ((m[1]?.[1] as number) > (m[2]?.[2] as number)) {
    const s =
      Math.sqrt(1 + (m[1]?.[1] as number) - (m[0]?.[0] as number) - (m[2]?.[2] as number)) * 2;
    w = ((m[0]?.[2] as number) - (m[2]?.[0] as number)) / s;
    x = ((m[0]?.[1] as number) + (m[1]?.[0] as number)) / s;
    y = 0.25 * s;
    z = ((m[1]?.[2] as number) + (m[2]?.[1] as number)) / s;
  } else {
    const s =
      Math.sqrt(1 + (m[2]?.[2] as number) - (m[0]?.[0] as number) - (m[1]?.[1] as number)) * 2;
    w = ((m[1]?.[0] as number) - (m[0]?.[1] as number)) / s;
    x = ((m[0]?.[2] as number) + (m[2]?.[0] as number)) / s;
    y = ((m[1]?.[2] as number) + (m[2]?.[1] as number)) / s;
    z = 0.25 * s;
  }
  return {
    positionM: {
      x: cam.positionCm.x / 100,
      y: cam.positionCm.y / 100,
      z: cam.positionCm.z / 100,
    },
    quaternion: { x, y, z, w },
    vfovDeg: cam.vfovDeg,
    aspect: cam.aspect,
  };
}
