/**
 * Generate FitRoom Studio's own code-built models: three flat rugs and four
 * simple furniture pieces at real sizes, using only the CC0 textures already
 * in `client/public/assets/textures/ambientcg/`.
 *
 * Every part is a rounded box, a cylinder with rounded rim rings, or a
 * rounded shade: cushions, arms, frames, door edges and the lamp shade all
 * carry a small fillet radius, so nothing reads as a hard box edge. Fabrics
 * use the ambientCG weaves on disk (Fabric075 on the sofa, Fabric061 on the
 * bed, Carpet012/015/016 on the rugs, Fabric040 on the lamp shade), wardrobe
 * and bed frame use WoodFloor051/WoodFloor070 grain, and the lamp stem stays
 * dark metal. UVs are authored in metres (the glTF sampler already repeats),
 * so the grain reads at a real-world scale in the app.
 *
 * Each model's `thumb.png` is software-rendered from its own triangles in a
 * shared 3/4-view rig (key + fill, soft contact shadow, transparent
 * background), 256 px on the long side — the same framing and light for all
 * seven pieces. Sizes are exact: rounded forms keep the authored outer
 * dimensions, and rim rings tuck inside the cylinder extents.
 *
 * Run: `node client/scripts/generate-fitroom-models.mjs` (Node + sharp from
 * the repo's node_modules).
 * Output: `client/public/assets/models/fitroom/<id>/<id>_1k.gltf` +
 * `<id>.bin` + `thumb.png`. The app's normalisation (centred XZ, base at
 * y=0) then applies unchanged, and `check:footprints` measures the authored
 * POSITION min/max against the catalog within ±1 cm (±0.5 cm for these
 * seven).
 */

/* global Buffer, console, process */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const outRoot = join(repoRoot, "client", "public", "assets", "models", "fitroom");

const texUri = (id, kind) => `../../../textures/ambientcg/${id}/${id}_1K-JPG_${kind}.jpg`;
const texFile = (id) =>
  join(
    repoRoot,
    "client",
    "public",
    "assets",
    "textures",
    "ambientcg",
    id,
    `${id}_1K-JPG_Color.jpg`,
  );

/* -------------------------------------------- PNG (RGBA thumbs) -- */

/** Minimal RGBA PNG writer (8-bit, non-interlace) for catalog thumbnails. */
function writePngRGBA(width, height, rgba) {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0;
    rgba.subarray(y * width * 4, (y + 1) * width * 4).copy(raw, y * (1 + width * 4) + 1);
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  parts.push(chunk("IHDR", ihdr));
  parts.push(chunk("IDAT", deflateSync(raw)));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/* --------------------------------------- texture sampling (thumbs) -- */

/** Resized raw RGB copies of the on-disk colour textures, keyed by texture id. */
const texRawCache = new Map();
async function texRaw(id) {
  const hit = texRawCache.get(id);
  if (hit !== undefined) return hit;
  const { data, info } = await sharp(texFile(id))
    .resize(256, 256, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const entry = { data, w: info.width, h: info.height, channels: info.channels };
  texRawCache.set(id, entry);
  return entry;
}

function texIdFromUri(uri) {
  const m = /ambientcg\/([^/]+)\//.exec(uri);
  return m === null ? undefined : m[1];
}

/** Repeat-wrapped nearest sample of a raw texture entry. Returns [r, g, b]. */
function sampleTex(entry, u, v) {
  const x = (((u % 1) + 1) % 1) * entry.w;
  const y = (((v % 1) + 1) % 1) * entry.h;
  const ix = Math.min(entry.w - 1, Math.floor(x));
  const iy = Math.min(entry.h - 1, Math.floor(y));
  const o = (iy * entry.w + ix) * entry.channels;
  return [entry.data[o] ?? 128, entry.data[o + 1] ?? 128, entry.data[o + 2] ?? 128];
}

/* ------------------------------------------------------------ math -- */

function vdot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vnorm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function vcross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/* ------------------------------------------------------------ buffers -- */

function pushFloat(arrays, values) {
  for (const v of values) arrays.push(v);
}

/**
 * Flip any triangle whose geometric normal points at the part centre, so
 * every face winds outward (glTF front faces are counter-clockwise).
 */
function orientOutward(part, cx, cy, cz) {
  const { positions, indices } = part;
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] * 3;
    const ib = indices[t + 1] * 3;
    const ic = indices[t + 2] * 3;
    const ax = positions[ia];
    const ay = positions[ia + 1];
    const az = positions[ia + 2];
    const abx = positions[ib] - ax;
    const aby = positions[ib + 1] - ay;
    const abz = positions[ib + 2] - az;
    const acx = positions[ic] - ax;
    const acy = positions[ic + 1] - ay;
    const acz = positions[ic + 2] - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const gx = (positions[ia] + positions[ib] + positions[ic]) / 3 - cx;
    const gy = (positions[ia + 1] + positions[ib + 1] + positions[ic + 1]) / 3 - cy;
    const gz = (positions[ia + 2] + positions[ib + 2] + positions[ic + 2]) / 3 - cz;
    if (nx * gx + ny * gy + nz * gz < 0) {
      indices[t + 1] = ic / 3;
      indices[t + 2] = ib / 3;
    }
  }
}

/**
 * Small rounded rim where a lamp cylinder meets its cap (base edges, shade
 * hem): a torus of tube `t` tucked inside radius R at height y, so the outer
 * extent stays exactly R and the height stays within y ± t — callers inset y
 * by t from the cap plane to keep the authored size. Reads as a rolled edge
 * instead of a sharp corner.
 */
function rimPart(parts, R, y, t, cx, cz, material, seg = 48, tseg = 10) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const base = 0;
  for (let j = 0; j <= tseg; j += 1) {
    const b = (j / tseg) * Math.PI * 2;
    const cb = Math.cos(b);
    const sb = Math.sin(b);
    for (let i = 0; i <= seg; i += 1) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rr = R - t + cb * t;
      pushFloat(positions, [cx + rr * ca, y + sb * t, cz + rr * sa]);
      pushFloat(normals, [cb * ca, sb, cb * sa]);
      pushFloat(uvs, [(i / seg) * 2 * Math.PI * (R - t), (j / tseg) * 2 * Math.PI * t]);
    }
  }
  for (let j = 0; j < tseg; j += 1) {
    for (let i = 0; i < seg; i += 1) {
      const a = base + j * (seg + 1) + i;
      const b = a + 1;
      const c = a + seg + 1;
      const e = c + 1;
      indices.push(a, b, e, a, e, c);
    }
  }
  const ring = { positions, normals, uvs, indices, material };
  orientOutward(ring, cx, y, cz);
  parts.push(ring);
}

/** Vertical cylinder (or cone when rTop !== rBottom) centred at (cx, y0). */
function cylinderPart(parts, rTop, rBottom, h, seg, cx, y0, cz, material, capped = true) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const slope = (rBottom - rTop) / h;
  const inv = 1 / Math.hypot(1, slope);
  const avgCirc = (rTop + rBottom) * Math.PI;
  for (let i = 0; i <= seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    pushFloat(positions, [cx + ca * rBottom, y0, cz + sa * rBottom]);
    pushFloat(normals, [ca * inv, slope * inv, sa * inv]);
    pushFloat(uvs, [(i / seg) * avgCirc, 0]);
    pushFloat(positions, [cx + ca * rTop, y0 + h, cz + sa * rTop]);
    pushFloat(normals, [ca * inv, slope * inv, sa * inv]);
    pushFloat(uvs, [(i / seg) * avgCirc, h]);
  }
  for (let i = 0; i < seg; i += 1) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = i * 2 + 2;
    const d = i * 2 + 3;
    indices.push(a, b, c, b, d, c);
  }
  if (capped) {
    for (const [ry, ny, flip] of [
      [y0, -1, true],
      [y0 + h, 1, false],
    ]) {
      const base = positions.length / 3;
      const rCap = ry === y0 ? rBottom : rTop;
      pushFloat(positions, [cx, ry, cz]);
      pushFloat(normals, [0, ny, 0]);
      pushFloat(uvs, [rCap, rCap]);
      for (let i = 0; i <= seg; i += 1) {
        const a = (i / seg) * Math.PI * 2;
        const r = rCap;
        pushFloat(positions, [cx + Math.cos(a) * r, ry, cz + Math.sin(a) * r]);
        pushFloat(normals, [0, ny, 0]);
        pushFloat(uvs, [(0.5 + Math.cos(a) / 2) * 2 * r, (0.5 + Math.sin(a) / 2) * 2 * r]);
      }
      for (let i = 1; i <= seg; i += 1) {
        if (flip) indices.push(base, base + i + 1, base + i);
        else indices.push(base, base + i, base + i + 1);
      }
    }
  }
  const tube = { positions, normals, uvs, indices, material };
  orientOutward(tube, cx, y0 + h / 2, cz);
  parts.push(tube);
}

/**
 * Softly rounded box: a subdivided cube surface pulled toward the inner box
 * (half extents minus r) plus r along the clamped normal. Corners, edges and
 * faces share positions so shading stays smooth and round.
 */
function roundedBoxPart(parts, w, h, d, r, seg, cx, cy, cz, material) {
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const ix = hx - r;
  const iy = hy - r;
  const iz = hz - r;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const faces = [
    { fixed: 0, sign: 1, u: 2, v: 1, hu: hz, hv: hy },
    { fixed: 0, sign: -1, u: 2, v: 1, hu: hz, hv: hy },
    { fixed: 1, sign: 1, u: 0, v: 2, hu: hx, hv: hz },
    { fixed: 1, sign: -1, u: 0, v: 2, hu: hx, hv: hz },
    { fixed: 2, sign: 1, u: 0, v: 1, hu: hx, hv: hy },
    { fixed: 2, sign: -1, u: 0, v: 1, hu: hx, hv: hy },
  ];
  for (const face of faces) {
    const base = positions.length / 3;
    for (let j = 0; j <= seg; j += 1) {
      for (let i = 0; i <= seg; i += 1) {
        const p = [0, 0, 0];
        p[face.fixed] = face.sign * [hx, hy, hz][face.fixed];
        p[face.u] = (i / seg) * 2 * face.hu - face.hu;
        p[face.v] = (j / seg) * 2 * face.hv - face.hv;
        const inner = [clamp(p[0], -ix, ix), clamp(p[1], -iy, iy), clamp(p[2], -iz, iz)];
        const delta = [p[0] - inner[0], p[1] - inner[1], p[2] - inner[2]];
        const len = Math.hypot(delta[0], delta[1], delta[2]) || 1;
        const n = [delta[0] / len, delta[1] / len, delta[2] / len];
        pushFloat(positions, [
          cx + inner[0] + n[0] * r,
          cy + inner[1] + n[1] * r,
          cz + inner[2] + n[2] * r,
        ]);
        pushFloat(normals, n);
        pushFloat(uvs, [(i / seg) * 2 * face.hu, (j / seg) * 2 * face.hv]);
      }
    }
    for (let j = 0; j < seg; j += 1) {
      for (let i = 0; i < seg; i += 1) {
        const a = base + j * (seg + 1) + i;
        const b = a + 1;
        const c = a + seg + 1;
        const e = c + 1;
        if (face.sign > 0) indices.push(a, b, e, a, e, c);
        else indices.push(a, e, b, a, c, e);
      }
    }
  }
  const round = { positions, normals, uvs, indices, material };
  orientOutward(round, cx, cy, cz);
  parts.push(round);
}

/* ---------------------------------------------------------- assembler -- */

/**
 * Assemble parts into a glTF 2.0 document + binary buffer. Each part becomes
 * one mesh primitive; parts sharing a material key share one material.
 * Images point at the repo's existing ambientCG JPGs (relative URIs).
 */
function assemble(id, parts, materials) {
  const bin = [];
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const alloc = (bytes) => {
    const offset = bin.length;
    for (const b of bytes) bin.push(b);
    while (bin.length % 4 !== 0) bin.push(0);
    return offset;
  };
  const pushAccessor = (view, count, type, min, max, componentType = 5126) => {
    accessors.push({ bufferView: view, componentType, count, type, min, max });
    return accessors.length - 1;
  };
  const materialIndex = new Map();
  const gltfMaterials = [];
  const images = [];
  const imageIndex = new Map();
  const imageFor = (uri) => {
    if (!imageIndex.has(uri)) {
      imageIndex.set(uri, images.length);
      images.push({ mimeType: "image/jpeg", name: uri.split("/").pop().replace(".jpg", ""), uri });
    }
    return imageIndex.get(uri);
  };
  const textures = [];
  const textureFor = (uri) => {
    textures.push({ sampler: 0, source: imageFor(uri) });
    return textures.length - 1;
  };
  const matFor = (key) => {
    if (!materialIndex.has(key)) {
      const def = materials[key];
      const pbr = { metallicFactor: def.metallic ?? 0, roughnessFactor: def.roughness ?? 0.9 };
      if (def.map !== undefined) pbr.baseColorTexture = { index: textureFor(def.map) };
      else if (def.color !== undefined) pbr.baseColorFactor = def.color;
      const mat = { name: `${id}-${key}`, pbrMetallicRoughness: pbr };
      if (def.normal !== undefined) mat.normalTexture = { index: textureFor(def.normal) };
      if (def.doubleSided === true) mat.doubleSided = true;
      materialIndex.set(key, gltfMaterials.length);
      gltfMaterials.push(mat);
    }
    return materialIndex.get(key);
  };
  for (const part of parts) {
    const posView = bufferViews.length;
    const posOffset = alloc(new Uint8Array(new Float32Array(part.positions).buffer));
    bufferViews.push({ buffer: 0, byteOffset: posOffset, byteLength: part.positions.length * 4 });
    const norOffset = alloc(new Uint8Array(new Float32Array(part.normals).buffer));
    bufferViews.push({ buffer: 0, byteOffset: norOffset, byteLength: part.normals.length * 4 });
    const uvOffset = alloc(new Uint8Array(new Float32Array(part.uvs).buffer));
    bufferViews.push({ buffer: 0, byteOffset: uvOffset, byteLength: part.uvs.length * 4 });
    const use32 = part.positions.length / 3 > 65535;
    const idxArray = use32 ? new Uint32Array(part.indices) : new Uint16Array(part.indices);
    const idxOffset = alloc(new Uint8Array(idxArray.buffer));
    bufferViews.push({
      buffer: 0,
      byteOffset: idxOffset,
      byteLength: idxArray.length * (use32 ? 4 : 2),
    });
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < part.positions.length; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        if (part.positions[i + k] < min[k]) min[k] = part.positions[i + k];
        if (part.positions[i + k] > max[k]) max[k] = part.positions[i + k];
      }
    }
    const count = part.positions.length / 3;
    const posAcc = pushAccessor(posView, count, "VEC3", min, max);
    const norAcc = pushAccessor(posView + 1, count, "VEC3", undefined, undefined);
    const uvAcc = pushAccessor(posView + 2, count, "VEC2", undefined, undefined);
    const idxAcc = pushAccessor(
      posView + 3,
      part.indices.length,
      "SCALAR",
      undefined,
      undefined,
      use32 ? 5125 : 5123,
    );
    meshes.push({
      name: `${id}-part-${meshes.length}`,
      primitives: [
        {
          attributes: { POSITION: posAcc, NORMAL: norAcc, TEXCOORD_0: uvAcc },
          indices: idxAcc,
          material: matFor(part.material),
        },
      ],
    });
  }
  const nodes = meshes.map((mesh, i) => ({ mesh: i, name: `${id}-node-${i}` }));
  return {
    json: {
      asset: { generator: "FitRoom Studio generate-fitroom-models.mjs", version: "2.0" },
      scene: 0,
      scenes: [{ name: "Scene", nodes: nodes.map((_, i) => i) }],
      nodes,
      materials: gltfMaterials,
      meshes,
      textures,
      images,
      accessors,
      bufferViews,
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
      buffers: [{ byteLength: bin.length, uri: `${id}.bin` }],
    },
    bin: Buffer.from(bin),
  };
}

/* ------------------------------------------------------------- models -- */

const carpetMat = (id) => ({
  map: texUri(id, "Color"),
  normal: texUri(id, "NormalGL"),
  roughness: 0.96,
});
const fabricMat = (id) => ({
  map: texUri(id, "Color"),
  normal: texUri(id, "NormalGL"),
  roughness: 0.94,
});
const woodMat = (id) => ({
  map: texUri(id, "Color"),
  normal: texUri(id, "NormalGL"),
  roughness: 0.7,
});
/** Three low rugs, 1 cm high, with softly rounded edges, in the carpet weaves. */
function rugModel(wCm, dCm, carpet) {
  const parts = [];
  roundedBoxPart(parts, wCm / 100, 0.01, dCm / 100, 0.004, 2, 0, 0.005, 0, "carpet");
  return { parts, materials: { carpet: carpetMat(carpet) } };
}

/**
 * Floor lamp: disc base with a rolled edge, slim pole, tapered fabric shade
 * with a rolled hem; 40 x 40 x 160 cm. Rim rings tuck inside the cylinder
 * extents, so the authored size is unchanged.
 */
function floorLampModel() {
  const parts = [];
  cylinderPart(parts, 0.2, 0.2, 0.02, 48, 0, 0, 0, "metal");
  rimPart(parts, 0.2, 0.006, 0.006, 0, 0, "metal");
  rimPart(parts, 0.2, 0.014, 0.006, 0, 0, "metal");
  cylinderPart(parts, 0.02, 0.02, 1.28, 24, 0, 0.02, 0, "metal");
  cylinderPart(parts, 0.14, 0.18, 0.3, 48, 0, 1.3, 0, "shade");
  rimPart(parts, 0.18, 1.312, 0.012, 0, 0, "shade");
  rimPart(parts, 0.14, 1.588, 0.012, 0, 0, "shade");
  return {
    parts,
    materials: {
      metal: { color: [0.05, 0.05, 0.06, 1], metallic: 0.8, roughness: 0.4 },
      shade: { ...fabricMat("Fabric040"), doubleSided: true },
    },
  };
}

/** Modern two-door wardrobe: rounded carcass, rounded doors, bar handles. */
function wardrobeModel() {
  const parts = [];
  roundedBoxPart(parts, 1.0, 2.0, 0.54, 0.015, 3, 0, 1.0, -0.03, "wood");
  roundedBoxPart(parts, 0.49, 1.96, 0.04, 0.012, 3, -0.25, 1.0, 0.26, "wood");
  roundedBoxPart(parts, 0.49, 1.96, 0.04, 0.012, 3, 0.25, 1.0, 0.26, "wood");
  roundedBoxPart(parts, 0.02, 0.2, 0.02, 0.006, 2, -0.05, 1.0, 0.29, "metal");
  roundedBoxPart(parts, 0.02, 0.2, 0.02, 0.006, 2, 0.05, 1.0, 0.29, "metal");
  return {
    parts,
    materials: {
      wood: woodMat("WoodFloor051"),
      metal: { color: [0.08, 0.08, 0.09, 1], metallic: 0.8, roughness: 0.4 },
    },
  };
}

/** Low platform bed: rounded frame, mattress, two pillows, 100 cm headboard. */
function bedModel() {
  const parts = [];
  roundedBoxPart(parts, 1.6, 0.22, 1.92, 0.02, 3, 0, 0.11, -0.04, "wood");
  roundedBoxPart(parts, 1.56, 0.13, 1.84, 0.04, 4, 0, 0.285, -0.06, "linen");
  roundedBoxPart(parts, 0.6, 0.12, 0.35, 0.05, 4, -0.36, 0.41, 0.55, "linen");
  roundedBoxPart(parts, 0.6, 0.12, 0.35, 0.05, 4, 0.36, 0.41, 0.55, "linen");
  roundedBoxPart(parts, 1.6, 1.0, 0.08, 0.02, 3, 0, 0.5, 0.96, "wood");
  return {
    parts,
    materials: { wood: woodMat("WoodFloor070"), linen: fabricMat("Fabric061") },
  };
}

/**
 * Modern three-seat sofa: fully upholstered in Fabric075 (frame, arms and
 * cushions all rounded) on dark-metal feet.
 */
function sofaModel() {
  const parts = [];
  for (const fx of [-1.0, 1.0]) {
    for (const fz of [-0.36, 0.36]) {
      roundedBoxPart(parts, 0.06, 0.08, 0.06, 0.015, 2, fx, 0.04, fz, "metal");
    }
  }
  roundedBoxPart(parts, 2.2, 0.24, 0.9, 0.03, 3, 0, 0.2, 0, "fabric");
  roundedBoxPart(parts, 0.2, 0.34, 0.9, 0.05, 4, -1.0, 0.49, 0, "fabric");
  roundedBoxPart(parts, 0.2, 0.34, 0.9, 0.05, 4, 1.0, 0.49, 0, "fabric");
  for (const cx of [-0.6075, 0, 0.6075]) {
    roundedBoxPart(parts, 0.585, 0.14, 0.66, 0.05, 4, cx, 0.37, -0.09, "fabric");
  }
  roundedBoxPart(parts, 2.2, 0.48, 0.2, 0.06, 3, 0, 0.56, 0.35, "fabric");
  for (const cx of [-0.6075, 0, 0.6075]) {
    roundedBoxPart(parts, 0.585, 0.34, 0.16, 0.06, 4, cx, 0.61, 0.17, "fabric");
  }
  return {
    parts,
    materials: {
      fabric: fabricMat("Fabric075"),
      metal: { color: [0.08, 0.08, 0.09, 1], metallic: 0.8, roughness: 0.4 },
    },
  };
}

/** Authored AABB of the parts (metres) for the size report. */
function authoredBox(parts) {
  const box = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
  for (const part of parts) {
    for (let i = 0; i < part.positions.length; i += 3) {
      const x = part.positions[i];
      const y = part.positions[i + 1];
      const z = part.positions[i + 2];
      if (x < box.minX) box.minX = x;
      if (y < box.minY) box.minY = y;
      if (z < box.minZ) box.minZ = z;
      if (x > box.maxX) box.maxX = x;
      if (y > box.maxY) box.maxY = y;
      if (z > box.maxZ) box.maxZ = z;
    }
  }
  return box;
}

/* ---------------------------------------------------------------- main -- */

/* --------------------------------------------------- thumbnail rig -- */

/**
 * Software-render a catalog thumbnail from the model's own triangles: a
 * shared 3/4-view orthographic rig (camera azimuth 33°, elevation 24°), a
 * warm key plus a cool fill, and a soft contact shadow on the ground plane.
 * Textured parts sample the same on-disk colour textures the glTF points at
 * (UVs are in metres, wrapping), so the weave and grain show in the thumb.
 * Rendered at 2x and downsampled for smooth edges; the canvas fits the
 * piece with margin so the long side lands on exactly 256 px, background
 * stays transparent, and corners stay clear.
 */
async function renderThumbnail(parts, materials) {
  const samplers = new Map();
  for (const [key, def] of Object.entries(materials)) {
    if (def.map !== undefined) {
      const id = texIdFromUri(def.map);
      if (id === undefined) throw new Error(`Cannot resolve texture id from ${def.map}`);
      samplers.set(key, { tex: await texRaw(id) });
    } else {
      const c = def.color ?? [0.5, 0.5, 0.5, 1];
      samplers.set(key, { rgb: [c[0] * 255, c[1] * 255, c[2] * 255] });
    }
  }
  const doubleSided = new Set(
    Object.entries(materials)
      .filter(([, def]) => def.doubleSided === true)
      .map(([key]) => key),
  );

  const az = (33 * Math.PI) / 180;
  const el = (24 * Math.PI) / 180;
  const d = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  const f = vnorm([-d[0], -d[1], -d[2]]);
  const r = vnorm(vcross(f, [0, 1, 0]));
  const u = vcross(r, f);
  const key = vnorm([-0.45, 0.78, 0.5]);
  const fill = vnorm([0.6, 0.25, -0.4]);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const part of parts) {
    for (let i = 0; i < part.positions.length; i += 3) {
      const x = part.positions[i];
      const y = part.positions[i + 1];
      const z = part.positions[i + 2];
      const sx = x * r[0] + y * r[1] + z * r[2];
      const sy = x * u[0] + y * u[1] + z * u[2];
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
  }
  const MARGIN = 1.14;
  const spanX = Math.max(1e-6, (maxX - minX) * MARGIN);
  const spanY = Math.max(1e-6, (maxY - minY) * MARGIN);
  const SS = 2;
  const W = Math.max(1, Math.round((256 * spanX) / Math.max(spanX, spanY)));
  const H = Math.max(1, Math.round((256 * spanY) / Math.max(spanX, spanY)));
  const RW = W * SS;
  const RH = H * SS;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rgba = Buffer.alloc(RW * RH * 4, 0);
  const zbuf = new Float32Array(RW * RH).fill(-Infinity);
  const toPx = (sx, sy) => [
    ((sx - cx) / spanX) * (RW - 1) + (RW - 1) / 2,
    ((cy - sy) / spanY) * (RH - 1) + (RH - 1) / 2,
  ];

  // Soft contact shadow on the ground plane, drawn first (triangles overdraw).
  // The world-space XZ footprint corners projected at y=0 set the ellipse.
  {
    let fx0 = Infinity;
    let fx1 = -Infinity;
    let fz0 = Infinity;
    let fz1 = -Infinity;
    for (const part of parts) {
      for (let i = 0; i < part.positions.length; i += 3) {
        const x = part.positions[i];
        const z = part.positions[i + 2];
        if (x < fx0) fx0 = x;
        if (x > fx1) fx1 = x;
        if (z < fz0) fz0 = z;
        if (z > fz1) fz1 = z;
      }
    }
    const foot = [];
    for (const [wx, wz] of [
      [fx0, fz0],
      [fx0, fz1],
      [fx1, fz0],
      [fx1, fz1],
    ]) {
      const sx = wx * r[0] + wz * r[2];
      const sy = wx * u[0] + wz * u[2];
      foot.push(toPx(sx, sy));
    }
    let ex0 = Infinity;
    let ex1 = -Infinity;
    let ey0 = Infinity;
    let ey1 = -Infinity;
    for (const [px, py] of foot) {
      if (px < ex0) ex0 = px;
      if (px > ex1) ex1 = px;
      if (py < ey0) ey0 = py;
      if (py > ey1) ey1 = py;
    }
    const ecx = (ex0 + ex1) / 2;
    const ecy = (ey0 + ey1) / 2;
    const erx = Math.max(1, ((ex1 - ex0) / 2) * 1.1 + RW * 0.01);
    const ery = Math.max(1, ((ey1 - ey0) / 2) * 1.1 + RH * 0.01);
    for (let y = 0; y < RH; y += 1) {
      for (let x = 0; x < RW; x += 1) {
        const qx = (x + 0.5 - ecx) / erx;
        const qy = (y + 0.5 - ecy) / ery;
        const q = qx * qx + qy * qy;
        if (q >= 1) continue;
        const a = Math.round(72 * (1 - q) * (1 - q));
        const o = (y * RW + x) * 4;
        rgba[o] = 30;
        rgba[o + 1] = 28;
        rgba[o + 2] = 30;
        rgba[o + 3] = a;
      }
    }
  }

  // Triangles, front-to-back-agnostic via a z-buffer (painter-safe).
  for (const part of parts) {
    const sampler = samplers.get(part.material);
    if (sampler === undefined) throw new Error(`No sampler for material ${part.material}`);
    const sided = doubleSided.has(part.material);
    const { positions, normals, uvs, indices } = part;
    for (let t = 0; t < indices.length; t += 3) {
      const vi = [indices[t], indices[t + 1], indices[t + 2]];
      const P = vi.map((k) => [positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]]);
      const e1 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]];
      const e2 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
      const gn = vnorm(vcross(e1, e2));
      if (!sided && vdot(gn, f) <= 1e-9) continue;
      const S = P.map((p) => {
        const sx = p[0] * r[0] + p[1] * r[1] + p[2] * r[2];
        const sy = p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
        return toPx(sx, sy);
      });
      const dep = P.map((p) => p[0] * f[0] + p[1] * f[1] + p[2] * f[2]);
      const N = vi.map((k) => [normals[k * 3], normals[k * 3 + 1], normals[k * 3 + 2]]);
      const T = vi.map((k) => [uvs[k * 2], uvs[k * 2 + 1]]);
      const x0 = Math.max(0, Math.floor(Math.min(S[0][0], S[1][0], S[2][0])));
      const x1 = Math.min(RW - 1, Math.ceil(Math.max(S[0][0], S[1][0], S[2][0])));
      const y0 = Math.max(0, Math.floor(Math.min(S[0][1], S[1][1], S[2][1])));
      const y1 = Math.min(RH - 1, Math.ceil(Math.max(S[0][1], S[1][1], S[2][1])));
      const denom =
        (S[1][1] - S[2][1]) * (S[0][0] - S[2][0]) + (S[2][0] - S[1][0]) * (S[0][1] - S[2][1]);
      if (Math.abs(denom) < 1e-12) continue;
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 =
            ((S[1][1] - S[2][1]) * (px - S[2][0]) + (S[2][0] - S[1][0]) * (py - S[2][1])) / denom;
          const w1 =
            ((S[2][1] - S[0][1]) * (px - S[2][0]) + (S[0][0] - S[2][0]) * (py - S[2][1])) / denom;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
          const depth = w0 * dep[0] + w1 * dep[1] + w2 * dep[2];
          const zi = y * RW + x;
          if (depth <= zbuf[zi]) continue;
          let nx = w0 * N[0][0] + w1 * N[1][0] + w2 * N[2][0];
          let ny = w0 * N[0][1] + w1 * N[1][1] + w2 * N[2][1];
          let nz = w0 * N[0][2] + w1 * N[1][2] + w2 * N[2][2];
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl;
          ny /= nl;
          nz /= nl;
          const tu = w0 * T[0][0] + w1 * T[1][0] + w2 * T[2][0];
          const tv = w0 * T[0][1] + w1 * T[1][1] + w2 * T[2][1];
          const baseCol = sampler.tex !== undefined ? sampleTex(sampler.tex, tu, tv) : sampler.rgb;
          const li = Math.max(0, nx * key[0] + ny * key[1] + nz * key[2]);
          const fi = Math.max(0, nx * fill[0] + ny * fill[1] + nz * fill[2]);
          const k = Math.min(1.04, 0.46 + 0.58 * li + 0.12 * fi);
          const o = zi * 4;
          rgba[o] = Math.min(255, Math.round(baseCol[0] * k));
          rgba[o + 1] = Math.min(255, Math.round(baseCol[1] * k));
          rgba[o + 2] = Math.min(255, Math.round(baseCol[2] * k));
          rgba[o + 3] = 255;
          zbuf[zi] = depth;
        }
      }
    }
  }

  // Box downsample to the 256-px-long-side canvas (premultiplied).
  const out = Buffer.alloc(W * H * 4, 0);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let j = 0; j < SS; j += 1) {
        for (let i = 0; i < SS; i += 1) {
          const o = ((y * SS + j) * RW + (x * SS + i)) * 4;
          const a = rgba[o + 3] / 255;
          pa += a;
          pr += rgba[o] * a;
          pg += rgba[o + 1] * a;
          pb += rgba[o + 2] * a;
        }
      }
      pa /= SS * SS;
      const o = (y * W + x) * 4;
      if (pa > 1e-6) {
        out[o] = Math.round(pr / (SS * SS) / pa);
        out[o + 1] = Math.round(pg / (SS * SS) / pa);
        out[o + 2] = Math.round(pb / (SS * SS) / pa);
      }
      out[o + 3] = Math.round(pa * 255);
    }
  }
  return { w: W, h: H, rgba: out };
}

const MODELS = [
  { id: "rug_160x230", sizeCm: [160, 1, 230], build: () => rugModel(160, 230, "Carpet012") },
  { id: "rug_200x300", sizeCm: [200, 1, 300], build: () => rugModel(200, 300, "Carpet015") },
  { id: "rug_240x340", sizeCm: [240, 1, 340], build: () => rugModel(240, 340, "Carpet016") },
  { id: "fitroom_floor_lamp", sizeCm: [40, 160, 40], build: floorLampModel },
  { id: "fitroom_wardrobe", sizeCm: [100, 200, 60], build: wardrobeModel },
  { id: "fitroom_platform_bed", sizeCm: [160, 100, 200], build: bedModel },
  { id: "fitroom_sofa_3seat", sizeCm: [220, 80, 90], build: sofaModel },
];

let failed = 0;
for (const spec of MODELS) {
  const { parts, materials } = spec.build();
  const { json, bin } = assemble(spec.id, parts, materials);
  const box = authoredBox(parts);
  const sx = (box.maxX - box.minX) * 100;
  const sy = (box.maxY - box.minY) * 100;
  const sz = (box.maxZ - box.minZ) * 100;
  const [w, h, d] = spec.sizeCm;
  const ok = Math.abs(sx - w) <= 0.01 && Math.abs(sy - h) <= 0.01 && Math.abs(sz - d) <= 0.01;
  console.log(
    `${spec.id}: authored ${sx.toFixed(2)}x${sy.toFixed(2)}x${sz.toFixed(2)}cm` +
      ` vs catalog ${w}x${h}x${d}cm  ${ok ? "OK" : "MISMATCH"}`,
  );
  if (!ok) failed += 1;
  const dir = join(outRoot, spec.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${spec.id}_1k.gltf`), `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(join(dir, `${spec.id}.bin`), bin);
  const view = await renderThumbnail(parts, materials);
  console.log(`${spec.id}: thumbnail ${view.w}x${view.h} RGBA`);
  writeFileSync(join(dir, "thumb.png"), writePngRGBA(view.w, view.h, view.rgba));
}
if (failed > 0) process.exit(1);
console.log(`Wrote ${MODELS.length} models under ${outRoot}.`);
