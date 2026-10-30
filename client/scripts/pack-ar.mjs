/**
 * Pack one self-contained `.glb` per catalog piece for AR.
 *
 * Run after the notices and before `vite build` (the client's `build`
 * script runs notices, then this, then vite). For every catalog piece it
 * reads `model` with `NodeIO` and all extensions registered, gives it the
 * app's pose (a root node with the piece's yaw from `MODEL_YAW_FIX_DEG`,
 * read from `models.ts` the way `check-model-footprints.mjs` reads it,
 * then `center({ pivot: "below" })`: centred on x and z, base at y = 0)
 * and writes `client/public/assets/ar/<catalog id>.glb`.
 *
 * Geometry and textures stay as they are: no Draco, meshopt, KTX2, no WebP
 * swap, no resizing. Output is deterministic: the same inputs produce
 * byte-identical files, so a deploy uploads each file once.
 *
 * Usage: `node scripts/pack-ar.mjs [--outDir <dir>]`
 */
/* global console, process */
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { center } from "@gltf-transform/functions";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");
const repoRoot = resolve(clientDir, "..");

function outDirFromArgs() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--outDir");
  if (at >= 0 && args[at + 1] !== undefined) return resolve(repoRoot, args[at + 1]);
  const positional = args.find((arg) => !arg.startsWith("--"));
  if (positional !== undefined) return resolve(repoRoot, positional);
  return join(clientDir, "public", "assets", "ar");
}

/** Yaw fixes, read from the app's own table so this script cannot drift. */
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

const catalog = JSON.parse(
  readFileSync(join(repoRoot, "shared", "catalog", "catalog.json"), "utf8"),
);
const yawFixes = loadYawFixes();
const outDir = outDirFromArgs();
mkdirSync(outDir, { recursive: true });

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

for (const item of catalog) {
  const modelPath = join(clientDir, "public", item.model);
  const document = await io.read(modelPath);
  const yawDeg = yawFixes.get(item.id) ?? 0;
  if (yawDeg !== 0) {
    const half = (yawDeg * Math.PI) / 180 / 2;
    for (const scene of document.getRoot().listScenes()) {
      const wrapper = document.createNode("fitroom-ar-yaw");
      wrapper.setRotation([0, Math.sin(half), 0, Math.cos(half)]);
      for (const child of [...scene.listChildren()]) {
        wrapper.addChild(child);
      }
      scene.addChild(wrapper);
    }
  }
  await document.transform(center({ pivot: "below" }));
  const binary = await io.writeBinary(document);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(outDir, `${item.id}.glb`), Buffer.from(binary));
  console.log(`pack-ar: wrote ${item.id}.glb`);
}
