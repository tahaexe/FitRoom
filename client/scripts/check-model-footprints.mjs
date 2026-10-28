/**
 * Development check: every catalog model's visible bounding box must match
 * its catalog footprint within ±1 cm.
 *
 * It mirrors the app's normalisation (client/src/models.ts): the yaw fix
 * from MODEL_YAW_FIX_DEG, centred on XZ with the base at y=0 — then measures
 * the box at item rotationY 0 (W along X, D along Z, as in the catalog) and
 * at rotationY 90 (swapped footprint). Bounds come from the POSITION
 * accessor min/max transformed by the glTF node hierarchy, which is exactly
 * what three's Box3.setFromObject measures at runtime.
 *
 * FitRoom Studio originals (built in code) hold a tighter bar: their full
 * bounding box must equal the catalog W × D × H within ±0.5 cm, and their
 * catalog thumbnails must be real renders — existing RGBA PNGs, 256 px on
 * the long side, with transparent corners.
 *
 * Run: npm run check:footprints -w @fitroom/client
 */
/* global console, process */
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOLERANCE_CM = 1.0;
/** Tighter bar for the code-built FitRoom originals (bounding box W×D×H). */
const FITROOM_TOLERANCE_CM = 0.5;
const FITROOM_IDS = new Set([
  "rug_160x230",
  "rug_200x300",
  "rug_240x340",
  "fitroom_floor_lamp",
  "fitroom_wardrobe",
  "fitroom_platform_bed",
  "fitroom_sofa_3seat",
]);

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");
const repoRoot = resolve(clientDir, "..");

const catalog = JSON.parse(
  readFileSync(join(repoRoot, "shared", "catalog", "catalog.json"), "utf8"),
);

/** Yaw fixes, read from the app's own table so this check cannot drift. */
function loadYawFixes() {
  const src = readFileSync(join(clientDir, "src", "models.ts"), "utf8");
  const block = src.match(/MODEL_YAW_FIX_DEG[^=]*=\s*\{([\s\S]*?)\};/);
  if (block === null || block[1] === undefined) {
    throw new Error("MODEL_YAW_FIX_DEG block not found in client/src/models.ts");
  }
  const fixes = new Map();
  for (const m of block[1].matchAll(/([A-Za-z0-9_]+)\s*:\s*(-?\d+(?:\.\d+)?)/g)) {
    fixes.set(m[1], Number(m[2]));
  }
  return fixes;
}

function loadGltf(modelPath) {
  const dir = dirname(modelPath);
  if (modelPath.endsWith(".glb")) {
    const buf = readFileSync(modelPath);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`Bad glb magic: ${modelPath}`);
    const jsonLen = view.getUint32(12, true);
    const json = JSON.parse(Buffer.from(buf.subarray(20, 20 + jsonLen)).toString("utf8"));
    let binOffset = 20 + jsonLen;
    const binLen = view.getUint32(binOffset, true);
    const bin = buf.subarray(binOffset + 8, binOffset + 8 + binLen);
    return { json, bin, dir };
  }
  const json = JSON.parse(readFileSync(modelPath, "utf8"));
  const bin = readFileSync(join(dir, json.buffers[0].uri));
  return { json, bin, dir };
}

function quatToMat(q) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    0,
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    0,
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
    0,
    0,
    0,
    0,
    1,
  ];
}

function composeNode(node) {
  if (node.matrix !== undefined) return node.matrix;
  const t = node.translation ?? [0, 0, 0];
  const r = quatToMat(node.rotation ?? [0, 0, 0, 1]);
  const s = node.scale ?? [1, 1, 1];
  return [
    r[0] * s[0],
    r[1] * s[1],
    r[2] * s[2],
    t[0],
    r[4] * s[0],
    r[5] * s[1],
    r[6] * s[2],
    t[1],
    r[8] * s[0],
    r[9] * s[1],
    r[10] * s[2],
    t[2],
    0,
    0,
    0,
    1,
  ];
}

function mul(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let acc = 0;
      for (let k = 0; k < 4; k += 1) acc += a[row * 4 + k] * b[k * 4 + col];
      out[row * 4 + col] = acc;
    }
  }
  return out;
}

function rotY(deg) {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
}

function xformPoint(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

/** World-space AABB of the model file as authored (metres). */
function authoredBox(gltf) {
  const { json } = gltf;
  const box = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const visit = (nodeIndex, parent) => {
    const node = json.nodes[nodeIndex];
    const world = mul(parent, composeNode(node));
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        const acc = json.accessors[prim.attributes.POSITION];
        if (acc.min === undefined || acc.max === undefined) {
          throw new Error(`POSITION accessor without min/max in ${json.nodes[nodeIndex].name}`);
        }
        for (let i = 0; i < 8; i += 1) {
          const p = xformPoint(world, [
            i & 1 ? acc.max[0] : acc.min[0],
            i & 2 ? acc.max[1] : acc.min[1],
            i & 4 ? acc.max[2] : acc.min[2],
          ]);
          box.minX = Math.min(box.minX, p[0]);
          box.minY = Math.min(box.minY, p[1]);
          box.minZ = Math.min(box.minZ, p[2]);
          box.maxX = Math.max(box.maxX, p[0]);
          box.maxY = Math.max(box.maxY, p[1]);
          box.maxZ = Math.max(box.maxZ, p[2]);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  const scene = json.scenes[json.scene ?? 0];
  for (const root of scene.nodes) visit(root, identity);
  return box;
}

function boxSizeCm(box, extraDeg) {
  const corners = [];
  for (let i = 0; i < 8; i += 1) {
    corners.push([
      i & 1 ? box.maxX : box.minX,
      i & 2 ? box.maxY : box.minY,
      i & 4 ? box.maxZ : box.minZ,
    ]);
  }
  const m = rotY(extraDeg);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const c of corners) {
    const p = xformPoint(m, c);
    minX = Math.min(minX, p[0]);
    minZ = Math.min(minZ, p[2]);
    maxX = Math.max(maxX, p[0]);
    maxZ = Math.max(maxZ, p[2]);
  }
  return { sx: (maxX - minX) * 100, sz: (maxZ - minZ) * 100 };
}

const yawFixes = loadYawFixes();
let failures = 0;
for (const item of catalog) {
  const modelPath = join(clientDir, "public", item.model);
  const yaw = yawFixes.get(item.id) ?? 0;
  const box = authoredBox(loadGltf(modelPath));
  if (!Number.isFinite(box.minX)) {
    console.log(`${item.id}: no geometry found  FAIL`);
    failures += 1;
    continue;
  }
  const at0 = boxSizeCm(box, yaw);
  const at90 = boxSizeCm(box, yaw + 90);
  const dw0 = at0.sx - item.size.w;
  const dd0 = at0.sz - item.size.d;
  // Item rotationY 90 swaps the footprint: extentX = d, extentZ = w.
  const dw90 = at90.sx - item.size.d;
  const dd90 = at90.sz - item.size.w;
  const ok =
    Math.abs(dw0) <= TOLERANCE_CM + 1e-9 &&
    Math.abs(dd0) <= TOLERANCE_CM + 1e-9 &&
    Math.abs(dw90) <= TOLERANCE_CM + 1e-9 &&
    Math.abs(dd90) <= TOLERANCE_CM + 1e-9;
  if (!ok) failures += 1;
  const fmt = (v) => (v >= 0 ? "+" : "") + v.toFixed(1);
  console.log(
    `${item.id}: visible ${at0.sx.toFixed(1)}x${at0.sz.toFixed(1)}cm` +
      ` vs catalog ${item.size.w.toFixed(1)}x${item.size.d.toFixed(1)}cm` +
      ` (rot0 dw=${fmt(dw0)} dd=${fmt(dd0)}; rot90 dw=${fmt(dw90)} dd=${fmt(dd90)}; yaw=${yaw})` +
      `  ${ok ? "PASS" : "FAIL"}`,
  );
  // Tighter bar for the code-built originals: the full bounding box
  // (W × H × D, base at y=0 so height is maxY − minY) equals the catalog.
  if (FITROOM_IDS.has(item.id)) {
    const wCm = (box.maxX - box.minX) * 100;
    const hCm = (box.maxY - box.minY) * 100;
    const dCm = (box.maxZ - box.minZ) * 100;
    const dw = wCm - item.size.w;
    const dh = hCm - item.size.h;
    const dd = dCm - item.size.d;
    const tight =
      Math.abs(dw) <= FITROOM_TOLERANCE_CM + 1e-9 &&
      Math.abs(dh) <= FITROOM_TOLERANCE_CM + 1e-9 &&
      Math.abs(dd) <= FITROOM_TOLERANCE_CM + 1e-9;
    if (!tight) failures += 1;
    console.log(
      `${item.id}: bbox ${wCm.toFixed(2)}x${hCm.toFixed(2)}x${dCm.toFixed(2)}cm` +
        ` vs catalog ${item.size.w.toFixed(1)}x${item.size.h.toFixed(1)}x${item.size.d.toFixed(1)}cm` +
        ` (dw=${fmt(dw)} dh=${fmt(dh)} dd=${fmt(dd)})  ${tight ? "PASS" : "FAIL"}`,
    );
  }
}

/** Read an RGBA PNG's corners: width, height, color type, corner alphas. */
function readPngCorners(thumbPath) {
  const bytes = readFileSync(thumbPath);
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG file");
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  const colorType = bytes[25];
  if (colorType !== 6) return { w, h, colorType, corners: [] };
  const idat = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(pos);
    const type = bytes.subarray(pos + 4, pos + 8).toString("ascii");
    if (type === "IDAT") idat.push(bytes.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
    if (type === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = 1 + w * 4;
  const alphaAt = (x, y) => raw[y * stride + 1 + x * 4 + 3];
  return {
    w,
    h,
    colorType,
    corners: [alphaAt(0, 0), alphaAt(w - 1, 0), alphaAt(0, h - 1), alphaAt(w - 1, h - 1)],
  };
}

// Every code-built original's catalog thumbnail is a real render: an
// existing RGBA PNG, 256 px on the long side, with transparent corners.
for (const item of catalog) {
  if (!FITROOM_IDS.has(item.id)) continue;
  const label = `${item.id}: thumbnail ${item.thumbnail}`;
  let detail;
  try {
    detail = readPngCorners(join(clientDir, "public", item.thumbnail));
  } catch (error) {
    console.log(`${label}  FAIL — ${error.message}`);
    failures += 1;
    continue;
  }
  const longSide = Math.max(detail.w, detail.h);
  const clear = detail.corners.length === 4 && detail.corners.every((a) => a === 0);
  const okThumb =
    detail.colorType === 6 && longSide === 256 && detail.w >= 1 && detail.h >= 1 && clear;
  if (!okThumb) failures += 1;
  console.log(
    `${label}: ${detail.w}x${detail.h} ctype=${detail.colorType}` +
      ` long=${longSide} corners=[${detail.corners.join(",")}]  ${okThumb ? "PASS" : "FAIL"}`,
  );
}

// Every code-built thumbnail camera sits on the piece's front side (+Z,
// the side each original faces) and above its top, looking down 25-35 deg
// at three-quarters. The shared rig lives in generate-fitroom-models.mjs
// as azimuth/elevation constants; this check reads those same constants so
// it cannot drift from the renderer.
{
  const src = readFileSync(join(clientDir, "scripts", "generate-fitroom-models.mjs"), "utf8");
  const azMatch = src.match(/const az = \(([\d.]+) \* Math\.PI\)/);
  const elMatch = src.match(/const el = \(([\d.]+) \* Math\.PI\)/);
  const azDeg = azMatch === null ? NaN : Number(azMatch[1]);
  const elDeg = elMatch === null ? NaN : Number(elMatch[1]);
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  const dir = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  const elevOk = elDeg >= 25 && elDeg <= 35;
  const frontOk = dir[2] > 0.2 && dir[0] > 0.2;
  const aboveOk = dir[1] > Math.sin((25 * Math.PI) / 180) - 1e-9;
  for (const item of catalog) {
    if (!FITROOM_IDS.has(item.id)) continue;
    const box = authoredBox(loadGltf(join(clientDir, "public", item.model)));
    const top = box.maxY;
    const cameraAboveTop = dir[1] > 0 && top > 0;
    const okCam = elevOk && frontOk && aboveOk && cameraAboveTop;
    if (!okCam) failures += 1;
    console.log(
      `${item.id}: camera az=${Number.isFinite(azDeg) ? azDeg.toFixed(1) : "?"}deg` +
        ` el=${Number.isFinite(elDeg) ? elDeg.toFixed(1) : "?"}deg` +
        ` dir=[${dir.map((v) => (Number.isFinite(v) ? v.toFixed(3) : "?")).join(",")}]` +
        ` top=${Number.isFinite(top) ? (top * 100).toFixed(1) : "?"}cm` +
        ` frontSide=${dir[2] > 0 ? "+Z" : "NOT-+Z"}` +
        ` above=${dir[1] > 0 ? "yes" : "no"}` +
        `  ${okCam ? "PASS" : "FAIL"}`,
    );
  }
}
console.log(
  failures === 0
    ? `All ${catalog.length} models within ±${TOLERANCE_CM.toFixed(0)} cm.`
    : `${failures} model(s) outside ±${TOLERANCE_CM.toFixed(0)} cm.`,
);
process.exit(failures === 0 ? 0 : 1);
