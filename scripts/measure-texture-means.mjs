/* Measure mean sRGB colour of each ambientCG Color texture into shared JSON. */
/* global console */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outPath = join(repoRoot, "shared", "src", "photo-room", "texture-means.json");

const IDS = [
  "WoodFloor070",
  "WoodFloor051",
  "WoodFloor064",
  "WoodFloor071",
  "Tiles107",
  "Tiles139",
  "Carpet012",
  "Carpet015",
  "Carpet016",
  "Concrete034",
  "PaintedPlaster017",
  "Wallpaper002A",
];

function toHex(r, g, b) {
  const c = (n) =>
    Math.min(255, Math.max(0, Math.round(n)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${c(r)}${c(g)}${c(b)}`;
}

const out = {};
for (const id of IDS) {
  const file = join(
    repoRoot,
    "client",
    "public",
    "assets",
    "textures",
    "ambientcg",
    id,
    `${id}_1K-JPG_Color.jpg`,
  );
  const stats = await sharp(file).stats();
  const mean = stats.channels.slice(0, 3).map((ch) => ch.mean);
  out[id] = toHex(mean[0], mean[1], mean[2]);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${outPath}`);
