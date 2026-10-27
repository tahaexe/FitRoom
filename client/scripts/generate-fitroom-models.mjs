/**
 * Generate FitRoom Studio's own code-built models: three flat rugs and four
 * simple furniture pieces at real sizes, using only the CC0 textures already
 * in `client/public/assets/textures/ambientcg/`.
 *
 * Run: `node client/scripts/generate-fitroom-models.mjs` (Node builtins only).
 * Output: `client/public/assets/models/fitroom/<id>/<id>_1k.gltf` +
 * `<id>.bin` + `thumb.png`. Every part is a box, cylinder or rounded box with
 * baked world coordinates (metres); the app's normalisation (centred XZ,
 * base at y=0) then applies unchanged, and `check:footprints` measures the
 * authored POSITION min/max against the catalog within ±1 cm.
 */

/* global Buffer, console, process */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const outRoot = join(repoRoot, "client", "public", "assets", "models", "fitroom");

const texUri = (id, kind) => `../../../textures/ambientcg/${id}/${id}_1K-JPG_${kind}.jpg`;

/* ---------------------------------------------------------------- PNG -- */

/** Minimal RGB PNG writer (8-bit, no interlace) for catalog thumbnails. */
function writePng(width, height, rgb) {
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
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = rgb(x / (width - 1), y / (height - 1));
      raw[y * (1 + width * 3) + 1 + x * 3] = p[0];
      raw[y * (1 + width * 3) + 1 + x * 3 + 1] = p[1];
      raw[y * (1 + width * 3) + 1 + x * 3 + 2] = p[2];
    }
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  parts.push(chunk("IHDR", ihdr));
  parts.push(chunk("IDAT", deflateSync(raw)));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Soft vertical-gradient thumbnail in the product's colour. */
function thumbnail(top, bottom) {
  const mix = (t) => [
    Math.round(top[0] + (bottom[0] - top[0]) * t),
    Math.round(top[1] + (bottom[1] - top[1]) * t),
    Math.round(top[2] + (bottom[2] - top[2]) * t),
  ];
  return writePng(256, 160, (u, v) => {
    const edge = Math.min(u, 1 - u) * 256 < 10 || Math.min(v, 1 - v) * 160 < 10;
    if (edge) return [226, 224, 220];
    return mix(v);
  });
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

/** Axis-aligned box centred at (cx, cy, cz), 24 verts, outward normals. */
function boxPart(parts, w, h, d, cx, cy, cz, material) {
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const faces = [
    {
      n: [1, 0, 0],
      corners: [
        [1, -1, -1],
        [1, -1, 1],
        [1, 1, 1],
        [1, 1, -1],
      ],
    },
    {
      n: [-1, 0, 0],
      corners: [
        [-1, -1, 1],
        [-1, -1, -1],
        [-1, 1, -1],
        [-1, 1, 1],
      ],
    },
    {
      n: [0, 1, 0],
      corners: [
        [-1, 1, -1],
        [1, 1, -1],
        [1, 1, 1],
        [-1, 1, 1],
      ],
    },
    {
      n: [0, -1, 0],
      corners: [
        [-1, -1, 1],
        [1, -1, 1],
        [1, -1, -1],
        [-1, -1, -1],
      ],
    },
    {
      n: [0, 0, 1],
      corners: [
        [-1, -1, 1],
        [-1, 1, 1],
        [1, 1, 1],
        [1, -1, 1],
      ],
    },
    {
      n: [0, 0, -1],
      corners: [
        [1, -1, -1],
        [1, 1, -1],
        [-1, 1, -1],
        [-1, -1, -1],
      ],
    },
  ];
  const faceUv = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  for (const face of faces) {
    const base = positions.length / 3;
    for (let i = 0; i < 4; i += 1) {
      const c = face.corners[i];
      pushFloat(positions, [cx + c[0] * hx, cy + c[1] * hy, cz + c[2] * hz]);
      pushFloat(normals, face.n);
      pushFloat(uvs, faceUv[i]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const box = { positions, normals, uvs, indices, material };
  orientOutward(box, cx, cy, cz);
  parts.push(box);
}

/** Vertical cylinder (or cone when rTop !== rBottom) centred at (cx, y0). */
function cylinderPart(parts, rTop, rBottom, h, seg, cx, y0, cz, material, capped = true) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const slope = (rBottom - rTop) / h;
  const inv = 1 / Math.hypot(1, slope);
  for (let i = 0; i <= seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    pushFloat(positions, [cx + ca * rBottom, y0, cz + sa * rBottom]);
    pushFloat(normals, [ca * inv, slope * inv, sa * inv]);
    pushFloat(uvs, [i / seg, 0]);
    pushFloat(positions, [cx + ca * rTop, y0 + h, cz + sa * rTop]);
    pushFloat(normals, [ca * inv, slope * inv, sa * inv]);
    pushFloat(uvs, [i / seg, 1]);
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
      pushFloat(positions, [cx, ry, cz]);
      pushFloat(normals, [0, ny, 0]);
      pushFloat(uvs, [0.5, 0.5]);
      for (let i = 0; i <= seg; i += 1) {
        const a = (i / seg) * Math.PI * 2;
        const r = ry === y0 ? rBottom : rTop;
        pushFloat(positions, [cx + Math.cos(a) * r, ry, cz + Math.sin(a) * r]);
        pushFloat(normals, [0, ny, 0]);
        pushFloat(uvs, [0.5 + Math.cos(a) / 2, 0.5 + Math.sin(a) / 2]);
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
        pushFloat(uvs, [i / seg, j / seg]);
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
const plasterMat = {
  map: texUri("PaintedPlaster017", "Color"),
  normal: texUri("PaintedPlaster017", "NormalGL"),
  roughness: 0.94,
};

/** Three flat rugs, 1 cm high, in the carpet textures already on disk. */
function rugModel(wCm, dCm, carpet) {
  const parts = [];
  boxPart(parts, wCm / 100, 0.01, dCm / 100, 0, 0.005, 0, "carpet");
  return { parts, materials: { carpet: carpetMat(carpet) } };
}

/** Floor lamp: disc base, slim pole, cone fabric shade; 40 x 40 x 160 cm. */
function floorLampModel() {
  const parts = [];
  cylinderPart(parts, 0.2, 0.2, 0.02, 40, 0, 0, 0, "metal");
  cylinderPart(parts, 0.02, 0.02, 1.28, 20, 0, 0.02, 0, "metal");
  cylinderPart(parts, 0.14, 0.18, 0.3, 40, 0, 1.3, 0, "shade");
  return {
    parts,
    materials: {
      metal: { color: [0.05, 0.05, 0.06, 1], metallic: 0.8, roughness: 0.4 },
      shade: { ...fabricMat("Fabric040"), doubleSided: true },
    },
  };
}

/** Modern two-door wardrobe: carcass, two flush doors, bar handles. */
function wardrobeModel() {
  const parts = [];
  boxPart(parts, 1.0, 2.0, 0.54, 0, 1.0, -0.03, "wood");
  boxPart(parts, 0.49, 1.96, 0.04, -0.25, 1.0, 0.26, "wood");
  boxPart(parts, 0.49, 1.96, 0.04, 0.25, 1.0, 0.26, "wood");
  boxPart(parts, 0.02, 0.2, 0.02, -0.05, 1.0, 0.29, "metal");
  boxPart(parts, 0.02, 0.2, 0.02, 0.05, 1.0, 0.29, "metal");
  return {
    parts,
    materials: {
      wood: woodMat("WoodFloor051"),
      metal: { color: [0.08, 0.08, 0.09, 1], metallic: 0.8, roughness: 0.4 },
    },
  };
}

/** Low platform bed: frame, mattress, two pillows, 100 cm headboard. */
function bedModel() {
  const parts = [];
  boxPart(parts, 1.6, 0.22, 1.92, 0, 0.11, -0.04, "wood");
  roundedBoxPart(parts, 1.56, 0.13, 1.84, 0.04, 4, 0, 0.285, -0.06, "linen");
  roundedBoxPart(parts, 0.6, 0.12, 0.35, 0.05, 4, -0.36, 0.41, 0.55, "linen");
  roundedBoxPart(parts, 0.6, 0.12, 0.35, 0.05, 4, 0.36, 0.41, 0.55, "linen");
  boxPart(parts, 1.6, 1.0, 0.08, 0, 0.5, 0.96, "wood");
  return {
    parts,
    materials: { wood: woodMat("WoodFloor070"), linen: plasterMat },
  };
}

/** Modern three-seat sofa: base, arms, three seat + three back cushions. */
function sofaModel() {
  const parts = [];
  for (const fx of [-1.0, 1.0]) {
    for (const fz of [-0.36, 0.36]) boxPart(parts, 0.06, 0.08, 0.06, fx, 0.04, fz, "base");
  }
  boxPart(parts, 2.2, 0.24, 0.9, 0, 0.2, 0, "base");
  roundedBoxPart(parts, 0.2, 0.34, 0.9, 0.05, 4, -1.0, 0.49, 0, "base");
  roundedBoxPart(parts, 0.2, 0.34, 0.9, 0.05, 4, 1.0, 0.49, 0, "base");
  for (const cx of [-0.6075, 0, 0.6075]) {
    roundedBoxPart(parts, 0.585, 0.14, 0.66, 0.05, 4, cx, 0.37, -0.09, "cushion");
  }
  boxPart(parts, 2.2, 0.48, 0.2, 0, 0.56, 0.35, "base");
  for (const cx of [-0.6075, 0, 0.6075]) {
    roundedBoxPart(parts, 0.585, 0.34, 0.16, 0.06, 4, cx, 0.61, 0.17, "cushion");
  }
  return {
    parts,
    materials: {
      base: { color: [0.32, 0.31, 0.3, 1], roughness: 0.9 },
      cushion: fabricMat("Fabric075"),
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

const MODELS = [
  {
    id: "rug_160x230",
    sizeCm: [160, 1, 230],
    thumb: [
      [214, 200, 182],
      [172, 158, 140],
    ],
    build: () => rugModel(160, 230, "Carpet012"),
  },
  {
    id: "rug_200x300",
    sizeCm: [200, 1, 300],
    thumb: [
      [198, 196, 190],
      [150, 148, 142],
    ],
    build: () => rugModel(200, 300, "Carpet015"),
  },
  {
    id: "rug_240x340",
    sizeCm: [240, 1, 340],
    thumb: [
      [188, 182, 176],
      [140, 134, 128],
    ],
    build: () => rugModel(240, 340, "Carpet016"),
  },
  {
    id: "fitroom_floor_lamp",
    sizeCm: [40, 160, 40],
    thumb: [
      [90, 88, 86],
      [40, 38, 36],
    ],
    build: floorLampModel,
  },
  {
    id: "fitroom_wardrobe",
    sizeCm: [100, 200, 60],
    thumb: [
      [172, 140, 108],
      [120, 92, 64],
    ],
    build: wardrobeModel,
  },
  {
    id: "fitroom_platform_bed",
    sizeCm: [160, 100, 200],
    thumb: [
      [170, 138, 106],
      [118, 90, 62],
    ],
    build: bedModel,
  },
  {
    id: "fitroom_sofa_3seat",
    sizeCm: [220, 80, 90],
    thumb: [
      [120, 116, 150],
      [70, 66, 100],
    ],
    build: sofaModel,
  },
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
  writeFileSync(join(dir, "thumb.png"), thumbnail(spec.thumb[0], spec.thumb[1]));
}
if (failed > 0) process.exit(1);
console.log(`Wrote ${MODELS.length} models under ${outRoot}.`);
