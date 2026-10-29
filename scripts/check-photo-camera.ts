/* global console, process */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { segmentInstances } from "../shared/src/sam.js";
import {
  projectWallPhotoCamera,
  recoverWallPhotoCamera,
  type WallLetter,
} from "../shared/src/photo-room/index.js";
import { solveRoomFromPhotos, type PhotoInput } from "../shared/src/photo-room/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const fixtureDir = join(repoRoot, "shared", "fixtures", "photo-room");

const VIEW_LETTER: Record<string, WallLetter> = { n: "C", s: "A", e: "D", w: "B" };

let failures = 0;
function check(name: string, pass: boolean, detail?: string): void {
  if (pass) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

interface Truth {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  position_m: { x: number; y: number; z: number };
  yawDeg: number;
  pitchDeg: number;
  vfovDeg: number;
}

function truthProject(
  truth: Truth,
  pCm: { x: number; y: number; z: number },
): [number, number, number] {
  const yaw = (truth.yawDeg * Math.PI) / 180;
  const pitch = (truth.pitchDeg * Math.PI) / 180;
  const f = norm([
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  ]);
  const r = norm(cross([0, 1, 0], [-f[0], -f[1], -f[2]]));
  const u = cross([-f[0], -f[1], -f[2]], r);
  const px = pCm.x / 100;
  const py = pCm.y / 100;
  const pz = pCm.z / 100;
  const vx = px - truth.position_m.x;
  const vy = py - truth.position_m.y;
  const vz = pz - truth.position_m.z;
  const xc = vx * r[0] + vy * r[1] + vz * r[2];
  const yc = vx * u[0] + vy * u[1] + vz * u[2];
  const zc = vx * f[0] + vy * f[1] + vz * f[2];
  return [truth.cx + (truth.fx * xc) / zc, truth.cy - (truth.fy * yc) / zc, zc];
}

function boxForWall(letter: WallLetter): Array<{ x: number; y: number; z: number }> {
  const cx = letter === "A" || letter === "C" ? 210 : null;
  if (letter === "A" || letter === "C") {
    const zBack = letter === "A" ? 0 : 360;
    const zFront = letter === "A" ? 80 : 280;
    const xs = [(cx as number) - 100, (cx as number) + 100];
    const out = [];
    for (const x of xs)
      for (const y of [0, 90]) for (const z of [zBack, zFront]) out.push({ x, y, z });
    return out;
  }
  const xBack = letter === "B" ? 0 : 420;
  const xFront = letter === "B" ? 80 : 340;
  const out = [];
  for (const z of [80, 280])
    for (const y of [0, 90]) for (const x of [xBack, xFront]) out.push({ x, y, z });
  return out;
}

function frontBottom(
  letter: WallLetter,
): [{ x: number; y: number; z: number }, { x: number; y: number; z: number }] {
  if (letter === "A")
    return [
      { x: 110, y: 0, z: 80 },
      { x: 310, y: 0, z: 80 },
    ];
  if (letter === "C")
    return [
      { x: 310, y: 0, z: 280 },
      { x: 110, y: 0, z: 280 },
    ];
  if (letter === "B")
    return [
      { x: 80, y: 0, z: 280 },
      { x: 80, y: 0, z: 80 },
    ];
  return [
    { x: 340, y: 0, z: 80 },
    { x: 340, y: 0, z: 280 },
  ];
}

function wallLenOf(
  layout: {
    walls: Array<{ id: string; start: { x: number; z: number }; end: { x: number; z: number } }>;
  },
  id: string,
): number {
  const w = layout.walls.find((e) => e.id === id);
  if (w === undefined) return 0;
  return Math.hypot(w.end.x - w.start.x, w.end.z - w.start.z);
}

const LETTER_TO_WALL_ID: Record<WallLetter, string> = {
  A: "wall-1",
  B: "wall-4",
  C: "wall-3",
  D: "wall-2",
};

async function main(): Promise<void> {
  const files = readdirSync(fixtureDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    console.log("SKIP check:photo-camera: no fixtures");
    return;
  }
  const photos: PhotoInput[] = [];
  const truths = new Map<WallLetter, { file: string; truth: Truth }>();
  for (const t of files) {
    const view = basename(t, ".json").slice(-1);
    const letter = VIEW_LETTER[view];
    if (letter === undefined) continue;
    const raw = JSON.parse(readFileSync(join(fixtureDir, t), "utf8")) as Truth & { room?: unknown };
    truths.set(letter, { file: t, truth: raw });
    const prefix = basename(t, ".json");
    const instances = [];
    for (const f of readdirSync(fixtureDir)
      .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".txt"))
      .sort()) {
      const concept = basename(f, ".txt").slice(prefix.length + 1);
      const text = readFileSync(join(fixtureDir, f), "utf8");
      if (text.trim().length === 0) continue;
      instances.push(...(await segmentInstances(concept, text)));
    }
    const focal35mm = (((raw.fx + raw.fy) / 2) * 43.27) / Math.hypot(raw.width, raw.height);
    photos.push({ wall: letter, width: raw.width, height: raw.height, focal35mm, instances });
  }
  const draft = solveRoomFromPhotos({ photos, tapeA: 420, tapeB: 360 });
  const letters: WallLetter[] = ["A", "B", "C", "D"];
  for (const letter of letters) {
    const sol = draft.photos.find((p) => p.wall === letter);
    const entry = truths.get(letter);
    if (sol === undefined || entry === undefined) {
      check(`photo-camera ${letter}: solved and truth present`, false);
      continue;
    }
    const wallId = LETTER_TO_WALL_ID[letter];
    const wallLen =
      wallLenOf(
        draft.layout as unknown as {
          walls: Array<{
            id: string;
            start: { x: number; z: number };
            end: { x: number; z: number };
          }>;
        },
        wallId,
      ) || (letter === "A" || letter === "C" ? 420 : 360);
    const ceil = draft.layout.walls[0]?.height ?? 260;
    const cam = recoverWallPhotoCamera({
      corners: sol.corners,
      wall: letter,
      wallLenCm: wallLen,
      wallHeightCm: ceil,
      roomWidthCm: 420,
      roomDepthCm: 360,
      focalPx: sol.focalPx,
      imageWidth: entry.truth.width,
      imageHeight: entry.truth.height,
    });
    check(`photo-camera ${letter}: camera recovered`, cam !== null);
    if (cam === null) continue;
    // Position and angle errors (reported, no bar).
    const truthPosCm = {
      x: entry.truth.position_m.x * 100,
      y: entry.truth.position_m.y * 100,
      z: entry.truth.position_m.z * 100,
    };
    const posErr = Math.hypot(
      cam.positionCm.x - truthPosCm.x,
      cam.positionCm.y - truthPosCm.y,
      cam.positionCm.z - truthPosCm.z,
    );
    const fRec: [number, number, number] = [cam.rotation[6], cam.rotation[7], cam.rotation[8]];
    const yaw = (entry.truth.yawDeg * Math.PI) / 180;
    const pitch = (entry.truth.pitchDeg * Math.PI) / 180;
    const fTrue = norm([
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch),
    ]);
    const cosA = Math.max(
      -1,
      Math.min(
        1,
        (fRec[0] * fTrue[0] + fRec[1] * fTrue[1] + fRec[2] * fTrue[2]) /
          ((Math.hypot(fRec[0], fRec[1], fRec[2]) || 1) * 1),
      ),
    );
    const angErr = (Math.acos(cosA) * 180) / Math.PI;
    console.log(
      `photo-camera ${letter}: posErr ${posErr.toFixed(1)} cm, angleErr ${angErr.toFixed(2)} deg (pos rec ${cam.positionCm.x.toFixed(1)},${cam.positionCm.y.toFixed(1)},${cam.positionCm.z.toFixed(1)} vs truth ${truthPosCm.x.toFixed(1)},${truthPosCm.y.toFixed(1)},${truthPosCm.z.toFixed(1)})`,
    );
    const box = boxForWall(letter);
    const perCorner = box.map((p) => {
      const t = truthProject(entry.truth, p);
      const r = projectWallPhotoCamera(cam, p);
      return { t, r };
    });
    const finite =
      perCorner.every((p) => Number.isFinite(p.t[0]) && Number.isFinite(p.t[1])) &&
      perCorner.every((p) => Number.isFinite(p.r.x) && Number.isFinite(p.r.y));
    check(`photo-camera ${letter}: projections finite`, finite);
    if (!finite) continue;
    const errs = perCorner.map((p) => Math.hypot(p.r.x - p.t[0], p.r.y - p.t[1]));
    const maxErr = Math.max(...errs);
    const [fb1, fb2] = frontBottom(letter);
    const t1 = truthProject(entry.truth, fb1);
    const t2 = truthProject(entry.truth, fb2);
    const r1 = projectWallPhotoCamera(cam, fb1);
    const r2 = projectWallPhotoCamera(cam, fb2);
    const truthW = Math.hypot(t2[0] - t1[0], t2[1] - t1[1]);
    const recW = Math.hypot(r2.x - r1.x, r2.y - r1.y);
    const relW = Math.abs(recW - truthW) / Math.max(1, truthW);
    const e1 = Math.hypot(r1.x - t1[0], r1.y - t1[1]);
    const e2 = Math.hypot(r2.x - t2[0], r2.y - t2[1]);
    const edge = Math.max(e1, e2);
    const edgePct = (edge / entry.truth.height) * 100;
    console.log(
      `photo-camera ${letter}: box lands max ${maxErr.toFixed(1)} px (${((maxErr / Math.max(1, truthW)) * 100).toFixed(2)}% of truth width ${truthW.toFixed(1)}), scale rel ${(relW * 100).toFixed(2)}%, edge ${edge.toFixed(1)} px (${edgePct.toFixed(2)}% H)`,
    );
    check(
      `photo-camera ${letter}: box lands within 2% of its truth width`,
      maxErr <= truthW * 0.02,
      `${maxErr.toFixed(1)} px vs ${(truthW * 0.02).toFixed(1)} px`,
    );
    check(
      `photo-camera ${letter}: front bottom edge within 1% H`,
      edge <= entry.truth.height * 0.01,
      `${edge.toFixed(1)} px`,
    );
  }
}

await main();
if (failures > 0) process.exit(1);
console.log("photo-camera ok");
