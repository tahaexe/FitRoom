/** Synthetic pinhole generator: known rooms -> SAM-shaped instances. */

import type { SamInstance } from "../sam.js";
import type { PhotoInput, WallLetter } from "./types.js";
import { WINDOW_FRAME_CM } from "./solve.js";

export interface SynthOpening {
  type: "door" | "window";
  wall: WallLetter;
  offset: number;
  width: number;
  height: number;
  sillHeight: number;
  hinge?: "left" | "right";
}

export interface SynthRoom {
  id: string;
  width: number;
  depth: number;
  height: number;
  tapeA: number;
  tapeB: number;
  openings: SynthOpening[];
}

export interface SynthPhotoOpts {
  yawDeg?: number;
  pitchDeg?: number;
  rollDeg?: number;
  focal35mm?: number;
  imageW?: number;
  imageH?: number;
  eyeCm?: number;
  lateralCm?: number;
  distFraction?: number;
  splitWall?: boolean;
  hideFloorMiddle?: number;
  doorLeafOnly?: boolean;
  cornerOutOfFrame?: "left" | "right" | null;
  cornerNoisePx?: number;
  raggedPx?: number;
  seed?: number;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

/** Wall plane point in cm (s = offset from wall start, y = height). */
function wallPoint(room: SynthRoom, wall: WallLetter, sFromStart: number, y: number): Vec3 {
  if (wall === "A") return { x: sFromStart, y, z: 0 };
  if (wall === "C") return { x: room.width - sFromStart, y, z: room.depth };
  if (wall === "B") return { x: 0, y, z: room.depth - sFromStart };
  return { x: room.width, y, z: sFromStart };
}

function wallLengthOf(room: SynthRoom, wall: WallLetter): number {
  return wall === "A" || wall === "C" ? room.width : room.depth;
}

interface Cam {
  pos: Vec3;
  f: Vec3;
  r: Vec3;
  u: Vec3;
  fPx: number;
  cx: number;
  cy: number;
}

function baseCamera(room: SynthRoom, wall: WallLetter, opts: SynthPhotoOpts): Cam {
  const W = opts.imageW ?? 800;
  const H = opts.imageH ?? 600;
  const focal35 = opts.focal35mm ?? 26;
  const fPx = (focal35 * Math.hypot(W, H)) / 43.27;
  const eye = opts.eyeCm ?? 160;
  const lat = opts.lateralCm ?? 0;
  const frac = opts.distFraction ?? 0.62;
  let pos: Vec3;
  let f: Vec3;
  let r: Vec3;
  // Camera-right runs from the wall start to the wall end (image left
  // to image right), matching the dev-camera truth renders.
  if (wall === "A") {
    pos = { x: room.width / 2 + lat, y: eye, z: room.depth * frac };
    f = { x: 0, y: 0, z: -1 };
    r = { x: 1, y: 0, z: 0 };
  } else if (wall === "C") {
    pos = { x: room.width / 2 + lat, y: eye, z: room.depth * (1 - frac) };
    f = { x: 0, y: 0, z: 1 };
    r = { x: -1, y: 0, z: 0 };
  } else if (wall === "B") {
    pos = { x: room.width * frac, y: eye, z: room.depth / 2 + lat };
    f = { x: -1, y: 0, z: 0 };
    r = { x: 0, y: 0, z: -1 };
  } else {
    pos = { x: room.width * (1 - frac), y: eye, z: room.depth / 2 + lat };
    f = { x: 1, y: 0, z: 0 };
    r = { x: 0, y: 0, z: 1 };
  }
  let u: Vec3 = { x: 0, y: 1, z: 0 };
  // Perturbations in camera space (consistent for every wall):
  // yaw turns f toward r, pitch lifts f toward u (positive looks up),
  // roll turns r toward u.
  const yaw = ((opts.yawDeg ?? 0) * Math.PI) / 180;
  const pitch = ((opts.pitchDeg ?? 0) * Math.PI) / 180;
  const roll = ((opts.rollDeg ?? 0) * Math.PI) / 180;
  const f1 = norm({
    x: f.x * Math.cos(yaw) + r.x * Math.sin(yaw),
    y: f.y * Math.cos(yaw) + r.y * Math.sin(yaw),
    z: f.z * Math.cos(yaw) + r.z * Math.sin(yaw),
  });
  const r1 = norm({
    x: r.x * Math.cos(yaw) - f.x * Math.sin(yaw),
    y: r.y * Math.cos(yaw) - f.y * Math.sin(yaw),
    z: r.z * Math.cos(yaw) - f.z * Math.sin(yaw),
  });
  f = norm({ x: f1.x * Math.cos(pitch) + u.x * Math.sin(pitch), y: f1.y * Math.cos(pitch) + u.y * Math.sin(pitch), z: f1.z * Math.cos(pitch) + u.z * Math.sin(pitch) });
  u = norm({ x: u.x * Math.cos(pitch) - f1.x * Math.sin(pitch), y: u.y * Math.cos(pitch) - f1.y * Math.sin(pitch), z: u.z * Math.cos(pitch) - f1.z * Math.sin(pitch) });
  let r2 = norm({ x: r1.x * Math.cos(roll) + u.x * Math.sin(roll), y: r1.y * Math.cos(roll) + u.y * Math.sin(roll), z: r1.z * Math.cos(roll) + u.z * Math.sin(roll) });
  const u2 = norm({ x: u.x * Math.cos(roll) - r1.x * Math.sin(roll), y: u.y * Math.cos(roll) - r1.y * Math.sin(roll), z: u.z * Math.cos(roll) - r1.z * Math.sin(roll) });
  // Swing the camera so one corner leaves the frame (a rotated camera,
  // not a sheared one: r turns with f, keeping the basis orthonormal).
  const swing = 0.35;
  if (opts.cornerOutOfFrame === "left") {
    const f0 = f;
    f = norm({ x: f.x + swing * r2.x, y: f.y, z: f.z + swing * r2.z });
    r2 = norm({ x: r2.x - swing * f0.x, y: r2.y - swing * f0.y, z: r2.z - swing * f0.z });
  } else if (opts.cornerOutOfFrame === "right") {
    const f0 = f;
    f = norm({ x: f.x - swing * r2.x, y: f.y, z: f.z - swing * r2.z });
    r2 = norm({ x: r2.x + swing * f0.x, y: r2.y + swing * f0.y, z: r2.z + swing * f0.z });
  }
  return { pos, f, r: norm(r2), u: norm(u2), fPx, cx: W / 2, cy: H / 2 };
}

function project(cam: Cam, p: Vec3): [number, number, number] {
  const vx = p.x - cam.pos.x;
  const vy = p.y - cam.pos.y;
  const vz = p.z - cam.pos.z;
  const xc = vx * cam.r.x + vy * cam.r.y + vz * cam.r.z;
  const yc = vx * cam.u.x + vy * cam.u.y + vz * cam.u.z;
  const zc = vx * cam.f.x + vy * cam.f.y + vz * cam.f.z;
  const x = cam.cx + (cam.fPx * xc) / Math.max(1, zc);
  const y = cam.cy - (cam.fPx * yc) / Math.max(1, zc);
  return [x, y, zc];
}

function pointInPoly(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const xi = poly[i]?.[0] as number;
    const yi = poly[i]?.[1] as number;
    const xj = poly[j]?.[0] as number;
    const yj = poly[j]?.[1] as number;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function makeInstance(
  concept: string,
  id: string,
  imageW: number,
  imageH: number,
  fill: (x: number, y: number) => boolean,
  clip?: { x0: number; x1: number },
): SamInstance | null {
  let x0 = imageW;
  let x1 = -1;
  let y0 = imageH;
  let y1 = -1;
  const xLo = Math.max(0, Math.floor(clip?.x0 ?? 0));
  const xHi = Math.min(imageW - 1, Math.ceil(clip?.x1 ?? imageW - 1));
  for (let y = 0; y < imageH; y += 2) {
    for (let x = xLo; x <= xHi; x += 2) {
      if (fill(x, y)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0 || y1 < y0) return null;
  // Pad by one pixel so the raster touches its box edges.
  x0 = Math.max(0, x0 - 1);
  y0 = Math.max(0, y0 - 1);
  x1 = Math.min(imageW - 1, x1 + 1);
  y1 = Math.min(imageH - 1, y1 + 1);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (fill(x0 + x, y0 + y)) data[y * w + x] = 1;
    }
  }
  return { concept, id, box: [x0, y0, x1, y1], imageWidth: imageW, imageHeight: imageH, mask: { width: w, height: h, data } };
}

export function synthPhoto(
  room: SynthRoom,
  wall: WallLetter,
  opts: SynthPhotoOpts = {},
): PhotoInput {
  const W = opts.imageW ?? 800;
  const H = opts.imageH ?? 600;
  const rand = lcg(opts.seed ?? 1234 + wall.charCodeAt(0) * 97);
  const cam = baseCamera(room, wall, opts);
  const L = wallLengthOf(room, wall);
  // Proper ring order (no bowtie): start-top, end-top, end-bottom,
  // start-bottom in wall terms.
  const wallCorners: Vec3[] = [
    wallPoint(room, wall, 0, room.height),
    wallPoint(room, wall, L, room.height),
    wallPoint(room, wall, L, 0),
    wallPoint(room, wall, 0, 0),
  ];
  const noise = opts.cornerNoisePx ?? 1.0;
  const jitter = (): number => (rand() - 0.5) * 2 * noise;
  const proj = (p: Vec3): [number, number] => {
    const [x, y] = project(cam, p);
    return [x + jitter(), y + jitter()];
  };
  const wallPoly = wallCorners.map(proj);
  const openings = room.openings.filter((o) => o.wall === wall);
  // Opening image polygons (doorway full, window glass inset by frame).
  const openingPolys: Array<{ poly: Array<[number, number]>; type: string }> = [];
  for (const o of openings) {
    if (opts.doorLeafOnly === true && o.type === "door") continue;
    if (o.type === "door") {
      const poly = [
        wallPoint(room, wall, o.offset, 0),
        wallPoint(room, wall, o.offset + o.width, 0),
        wallPoint(room, wall, o.offset + o.width, o.height),
        wallPoint(room, wall, o.offset, o.height),
      ].map(proj);
      openingPolys.push({ poly, type: "door" });
    } else {
      const poly = [
        wallPoint(room, wall, o.offset + WINDOW_FRAME_CM, o.sillHeight + WINDOW_FRAME_CM),
        wallPoint(room, wall, o.offset + o.width - WINDOW_FRAME_CM, o.sillHeight + WINDOW_FRAME_CM),
        wallPoint(room, wall, o.offset + o.width - WINDOW_FRAME_CM, o.sillHeight + o.height - WINDOW_FRAME_CM),
        wallPoint(room, wall, o.offset + WINDOW_FRAME_CM, o.sillHeight + o.height - WINDOW_FRAME_CM),
      ].map(proj);
      openingPolys.push({ poly, type: "window" });
    }
  }
  const ragged = opts.raggedPx ?? 1.2;
  const raggedJitter = (x: number, y: number): boolean => {
    void x;
    void y;
    return rand() < 0.02;
  };
  const inWall = (x: number, y: number): boolean => {
    if (!pointInPoly(x, y, wallPoly)) return false;
    for (const o of openingPolys) {
      if (pointInPoly(x + (rand() - 0.5) * ragged, y + (rand() - 0.5) * ragged, o.poly)) return false;
    }
    if (raggedJitter(x, y)) return false;
    return true;
  };
  // Floor polygon: facing edge along wall base + camera-side edge.
  const camSide: Vec3[] = [0, 1].map((i) => {
    void i;
    return cam.pos;
  });
  void camSide;
  // Build floor/ceiling polys from room corners projected.
  const floorCorners: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: room.width, y: 0, z: 0 },
    { x: room.width, y: 0, z: room.depth },
    { x: 0, y: 0, z: room.depth },
  ];
  const ceilCorners: Vec3[] = floorCorners.map((p) => ({ ...p, y: room.height }));
  const floorPoly = floorCorners.map(proj);
  const ceilPoly = ceilCorners.map(proj);
  const hideMid = opts.hideFloorMiddle ?? 0;
  const inFloor = (x: number, y: number): boolean => {
    if (!pointInPoly(x, y, floorPoly)) return false;
    if (pointInPoly(x, y, wallPoly)) return false;
    if (hideMid > 0) {
      const fx = x / W;
      if (fx > 0.5 - hideMid / 2 && fx < 0.5 + hideMid / 2) return false;
    }
    return true;
  };
  const inCeil = (x: number, y: number): boolean => {
    if (!pointInPoly(x, y, ceilPoly)) return false;
    if (pointInPoly(x, y, wallPoly)) return false;
    return true;
  };
  const instances: SamInstance[] = [];
  if (opts.splitWall === true) {
    const midX = (Math.min(...wallPoly.map((p) => p[0])) + Math.max(...wallPoly.map((p) => p[0]))) / 2;
    const left = makeInstance("wall", `${wall}-wall-a`, W, H, inWall, { x0: 0, x1: midX + 4 });
    const right = makeInstance("wall", `${wall}-wall-b`, W, H, inWall, { x0: midX - 4, x1: W });
    if (left !== null) instances.push(left);
    if (right !== null) instances.push(right);
  } else {
    const w = makeInstance("wall", `${wall}-wall`, W, H, inWall);
    if (w !== null) instances.push(w);
  }
  const f = makeInstance("floor", `${wall}-floor`, W, H, inFloor);
  if (f !== null) instances.push(f);
  const c = makeInstance("ceiling", `${wall}-ceiling`, W, H, inCeil);
  if (c !== null) instances.push(c);
  for (const [i, o] of openings.entries()) {
    if (o.type === "door") {
      // Open leaf beside the doorway (hinge side in room terms).
      const hingeLeft = (o.hinge ?? "left") === "left";
      const leafS = hingeLeft ? o.offset + o.width - 8 : o.offset - 70;
      const leafPoly = [
        wallPoint(room, wall, leafS, 0),
        wallPoint(room, wall, leafS + 78, 0),
        wallPoint(room, wall, leafS + 78, 200),
        wallPoint(room, wall, leafS, 200),
      ].map(proj);
      const leaf = makeInstance("door", `${wall}-door-${String(i)}`, W, H, (x, y) =>
        pointInPoly(x, y, leafPoly),
      );
      if (leaf !== null) instances.push(leaf);
    } else {
      const glass = openingPolys.find((p) => p.type === "window");
      void glass;
      const gp = [
        wallPoint(room, wall, o.offset + WINDOW_FRAME_CM, o.sillHeight + WINDOW_FRAME_CM),
        wallPoint(room, wall, o.offset + o.width - WINDOW_FRAME_CM, o.sillHeight + WINDOW_FRAME_CM),
        wallPoint(room, wall, o.offset + o.width - WINDOW_FRAME_CM, o.sillHeight + o.height - WINDOW_FRAME_CM),
        wallPoint(room, wall, o.offset + WINDOW_FRAME_CM, o.sillHeight + o.height - WINDOW_FRAME_CM),
      ].map(proj);
      const inst = makeInstance("window", `${wall}-window-${String(i)}`, W, H, (x, y) =>
        pointInPoly(x, y, gp),
      );
      if (inst !== null) instances.push(inst);
    }
  }
  return { wall, width: W, height: H, focal35mm: opts.focal35mm ?? 26, instances };
}

export const SAMPLE_SYNTH_ROOM: SynthRoom = {
  id: "living-420x360",
  width: 420,
  depth: 360,
  height: 260,
  tapeA: 420,
  tapeB: 360,
  openings: [
    { type: "door", wall: "A", offset: 30, width: 90, height: 210, sillHeight: 0, hinge: "left" },
    { type: "window", wall: "C", offset: 80, width: 160, height: 140, sillHeight: 90 },
    { type: "window", wall: "D", offset: 120, width: 120, height: 140, sillHeight: 90 },
  ],
};

export const VARIANT_ROOM_1: SynthRoom = {
  id: "variant-380x300",
  width: 380,
  depth: 300,
  height: 250,
  tapeA: 380,
  tapeB: 300,
  openings: [
    // Narrow door (fault) + high sill (fault), asymmetric so flips fail.
    // The B window top (125 + 120 = 245) stays under the 250 cm ceiling.
    { type: "door", wall: "A", offset: 250, width: 64, height: 210, sillHeight: 0, hinge: "right" },
    { type: "window", wall: "B", offset: 40, width: 150, height: 120, sillHeight: 125 },
    { type: "window", wall: "C", offset: 170, width: 110, height: 120, sillHeight: 85 },
  ],
};

export const VARIANT_ROOM_2: SynthRoom = {
  id: "variant-450x330",
  width: 450,
  depth: 330,
  height: 265,
  tapeA: 450,
  tapeB: 330,
  openings: [
    { type: "door", wall: "A", offset: 60, width: 92, height: 210, sillHeight: 0, hinge: "right" },
    { type: "window", wall: "B", offset: 190, width: 130, height: 140, sillHeight: 80 },
    { type: "window", wall: "D", offset: 30, width: 100, height: 120, sillHeight: 95 },
  ],
};
