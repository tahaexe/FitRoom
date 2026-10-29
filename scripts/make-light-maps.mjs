/* Make the light surface maps + half-size HDRI once (run, then commit the files).
 *
 * - Colour / roughness: WebP at quality 80, full size unless over 300 KB,
 *   then 512 px wide (the tiling hides it on carpets).
 * - Normals: 512 px wide JPEGs, overwritten in place (re-running is stable).
 * - Environment: the same lebombo HDRI box-filtered 2x2 to 512x256 with
 *   plain node (sharp cannot read HDR), RLE-encoded like the source.
 *
 * Reads `*_Color.jpg` / `*_Roughness.jpg` / `*_NormalGL.jpg` under
 * `client/public/assets/textures/ambientcg/<id>/` for every finish the
 * swatches offer (see `FLOOR_FINISHES` / `WALL_FINISHES` in
 * `shared/src/photo-room/surfaces.ts`). Adds no dependency.
 */
/* global console, setTimeout, Buffer */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const texRoot = join(repoRoot, "client", "public", "assets", "textures", "ambientcg");
const hdriDir = join(repoRoot, "client", "public", "assets", "hdri", "polyhaven");

const FINISHES = [
  "WoodFloor070",
  "WoodFloor051",
  "WoodFloor064",
  "WoodFloor071",
  "WoodFloor039",
  "Tiles107",
  "Tiles139",
  "Carpet012",
  "Carpet015",
  "Carpet016",
  "Concrete034",
  "PaintedPlaster017",
  "Wallpaper002A",
];

const MAX_BYTES = 300 * 1024;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function safeWrite(path, buf) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      writeFileSync(path, buf);
      return;
    } catch (error) {
      if (attempt === 10) throw error;
      await delay(100 * attempt);
    }
  }
}

async function toWebp(input, output, fullWidth) {
  const source = readFileSync(input);
  let width = fullWidth;
  for (const quality of [80, 80, 70]) {
    const attempt =
      width === 0
        ? sharp(source).webp({ quality })
        : sharp(source).resize({ width }).webp({ quality });
    const buf = await attempt.toBuffer();
    if (buf.length <= MAX_BYTES || (width === 512 && quality === 70)) {
      await safeWrite(output, buf);
      console.log(
        `${output.split("\\").pop()} ${buf.length} bytes (w=${width === 0 ? fullWidth : width} q=${quality})`,
      );
      return buf.length;
    }
    width = 512;
  }
  throw new Error(`cannot fit ${output} under 300 KB`);
}

async function lightMaps() {
  for (const id of FINISHES) {
    const dir = join(texRoot, id);
    const stem = `${id}_1K-JPG`;
    await toWebp(join(dir, `${stem}_Color.jpg`), join(dir, `${stem}_Color.webp`), 0);
    await toWebp(join(dir, `${stem}_Roughness.jpg`), join(dir, `${stem}_Roughness.webp`), 0);
    const normal = await sharp(readFileSync(join(dir, `${stem}_NormalGL.jpg`)))
      .resize({ width: 512 })
      .jpeg({ quality: 90 })
      .toBuffer();
    await safeWrite(join(dir, `${stem}_NormalGL.jpg`), normal);
    console.log(`${id}_1K-JPG_NormalGL.jpg ${normal.length} bytes (512px)`);
  }
}

// ---- minimal RGBE (.hdr) half-size ----

function decodeRgbe(bytes, dataStart, width, height) {
  const out = new Float32Array(width * height * 3);
  let pos = dataStart;
  const readByte = () => {
    if (pos >= bytes.length) throw new Error("truncated hdr");
    return bytes[pos++];
  };
  for (let y = 0; y < height; y += 1) {
    const b0 = readByte();
    const b1 = readByte();
    const b2 = readByte();
    const b3 = readByte();
    const scan = new Uint8Array(width * 4);
    if (b0 === 2 && b1 === 2 && (b2 << 8) + b3 === width) {
      for (let c = 0; c < 4; c += 1) {
        let x = 0;
        while (x < width) {
          const count = readByte();
          if (count > 128) {
            const run = count - 128;
            const val = readByte();
            for (let k = 0; k < run; k += 1) scan[c * width + x + k] = val;
            x += run;
          } else {
            for (let k = 0; k < count; k += 1) scan[c * width + x + k] = readByte();
            x += count;
          }
        }
      }
    } else {
      scan[0] = b0;
      scan[width] = b1;
      scan[width * 2] = b2;
      scan[width * 3] = b3;
      for (let i = 4; i < width * 4; i += 1) scan[i] = readByte();
      void b0;
    }
    for (let x = 0; x < width; x += 1) {
      const r = scan[x];
      const g = scan[width + x];
      const b = scan[width * 2 + x];
      const e = scan[width * 3 + x];
      const o = (y * width + x) * 3;
      if (e === 0) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
      } else {
        const f = Math.pow(2, e - 128 - 8);
        out[o] = r * f;
        out[o + 1] = g * f;
        out[o + 2] = b * f;
      }
    }
  }
  return out;
}

function floatToRgbe(r, g, b) {
  const m = Math.max(r, g, b);
  if (m < 1e-32) return [0, 0, 0, 0];
  const exp = Math.floor(Math.log2(m)) + 1;
  const f = m / Math.pow(2, exp);
  const k = (f * 256) / m;
  return [
    Math.min(255, Math.round(r * k)),
    Math.min(255, Math.round(g * k)),
    Math.min(255, Math.round(b * k)),
    exp + 128,
  ];
}

function encodeChannelRle(values) {
  const out = [];
  let i = 0;
  const n = values.length;
  while (i < n) {
    let run = 1;
    while (i + run < n && values[i + run] === values[i] && run < 127) run += 1;
    if (run >= 4) {
      out.push(128 + run, values[i]);
      i += run;
    } else {
      let j = i;
      while (j < n) {
        let look = 1;
        while (j + look < n && values[j + look] === values[j] && look < 127) look += 1;
        if (look >= 4) break;
        j += 1;
        if (j - i >= 128) break;
      }
      out.push(j - i, ...values.slice(i, j));
      i = j;
    }
  }
  return out;
}

async function halfHdri() {
  const src = join(hdriDir, "lebombo_1k.hdr");
  const bytes = readFileSync(src);
  const headerEnd = bytes.indexOf("\n\n");
  const resLine = bytes.subarray(headerEnd + 2, headerEnd + 42).toString("latin1");
  const res = resLine.match(/-Y (\d+) \+X (\d+)/);
  if (res === null) throw new Error(`unreadable hdr resolution: ${resLine}`);
  const height = Number(res[1]);
  const width = Number(res[2]);
  const dataStart = bytes.indexOf("\n", headerEnd + 2) + 1;
  const pixels = decodeRgbe(bytes, dataStart, width, height);
  const w2 = Math.floor(width / 2);
  const h2 = Math.floor(height / 2);
  const small = new Float32Array(w2 * h2 * 3);
  for (let y = 0; y < h2; y += 1) {
    for (let x = 0; x < w2; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        const a = pixels[(y * 2 * width + x * 2) * 3 + c];
        const b = pixels[(y * 2 * width + x * 2 + 1) * 3 + c];
        const cc = pixels[((y * 2 + 1) * width + x * 2) * 3 + c];
        const d = pixels[((y * 2 + 1) * width + x * 2 + 1) * 3 + c];
        small[(y * w2 + x) * 3 + c] = (a + b + cc + d) / 4;
      }
    }
  }
  const body = [];
  for (let y = 0; y < h2; y += 1) {
    const chans = [[], [], [], []];
    for (let x = 0; x < w2; x += 1) {
      const o = (y * w2 + x) * 3;
      const [r, g, b, e] = floatToRgbe(small[o], small[o + 1], small[o + 2]);
      chans[0].push(r);
      chans[1].push(g);
      chans[2].push(b);
      chans[3].push(e);
    }
    body.push(2, 2, (w2 >> 8) & 255, w2 & 255);
    for (const ch of chans) body.push(...encodeChannelRle(ch));
  }
  const outHeader = `#?RADIANCE\n# Made with Adobe Photoshop\nGAMMA=1\nPRIMARIES=0 0 0 0 0 0 0 0\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h2} +X ${w2}\n`;
  const dest = join(hdriDir, "lebombo_512.hdr");
  await safeWrite(dest, Buffer.concat([Buffer.from(outHeader, "latin1"), Buffer.from(body)]));
  console.log(`lebombo_512.hdr ${w2}x${h2}`);
}

await lightMaps();
await halfHdri();
