/**
 * `npm run check:ar` — packed AR `.glb` files are self-contained and true size.
 * Headless (no browser, no Meta calls).
 *
 * - Packs into two folders under `.tmp/` (via `client/scripts/pack-ar.mjs`)
 *   and reads every catalog piece's file;
 * - each file is binary glTF 2.0, one embedded buffer, no `uri` anywhere,
 *   none of the Draco / meshopt / KTX2 compression extensions, under 10 MB;
 * - its bounding box over every POSITION through the node transforms (as
 *   model-viewer measures it) is centred on x and z and based at y = 0
 *   within 0.5 cm, with w x d x h equal to the catalog size within 2 cm
 *   or 2 %;
 * - the two runs are byte-identical (so a deploy uploads each file once).
 * - Source cases: the button renders only where AR can open (a capable
 *   browser whose viewer reports ready), `@google/model-viewer` loads
 *   through one dynamic import on the first such selection (the `main` and
 *   `store` entries never import it), and the layer closes on its Back
 *   button, on a closing `ar-status`, and on return to the page.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, "..");
const repoRoot = join(clientRoot, "..");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

interface CatalogEntry {
  id: string;
  size: { w: number; d: number; h: number };
  model: string;
}

const catalog = readJson(join(repoRoot, "shared", "catalog", "catalog.json")) as CatalogEntry[];

// ---- The build packs AR files between the notices and vite build ----
const buildScript = String(
  (readJson(join(clientRoot, "package.json")) as { scripts?: Record<string, string> }).scripts?.[
    "build"
  ] ?? "",
);
check(
  "ar:build-packs-between-notices-and-vite",
  buildScript ===
    "node scripts/write-third-party-notices.mjs && node scripts/pack-ar.mjs && vite build",
  buildScript,
);

const packSource = readFileSync(join(clientRoot, "scripts", "pack-ar.mjs"), "utf8");
check(
  "ar:pack-reads-yaw-like-footprints",
  packSource.includes("MODEL_YAW_FIX_DEG") &&
    packSource.includes("matchAll(/([A-Za-z0-9_]+)") &&
    packSource.includes("NodeIO") &&
    packSource.includes("ALL_EXTENSIONS"),
  "pack-ar.mjs must read MODEL_YAW_FIX_DEG with NodeIO and all extensions",
);
check(
  "ar:pack-centres-below",
  packSource.includes('center({ pivot: "below" })'),
  'pack-ar.mjs must call center({ pivot: "below" })',
);
const packCode = packSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
check(
  "ar:pack-keeps-geometry",
  !packCode.includes("draco(") &&
    !packCode.includes("meshopt(") &&
    !packCode.includes("toktx") &&
    !packCode.includes("webp(") &&
    !packCode.includes("resize("),
  "pack-ar.mjs must not compress, swap or resize",
);

// ---- The button shows only where AR can open ----
const inspectorSource = readFileSync(join(clientRoot, "src", "inspector.ts"), "utf8");
const arSource = readFileSync(join(clientRoot, "src", "ar.ts"), "utf8");
const mainSource = readFileSync(join(clientRoot, "src", "main.ts"), "utf8");
const storeSource = readFileSync(join(clientRoot, "src", "store.ts"), "utf8");

check(
  "ar:button-renders-only-when-available",
  inspectorSource.includes('arRow.className = "inspector-ar"') &&
    inspectorSource.includes("this.opts.ar.isAvailable()"),
  "the Inspector must render its AR row only while isAvailable() holds",
);
check(
  "ar:button-needs-capable-browser-and-ready-viewer",
  mainSource.includes("if (productId === null || !isARCapableBrowser()) return;") &&
    mainSource.includes("mayOpenAR()") &&
    mainSource.includes("waitForARReady"),
  "the button must stay hidden until a capable browser and a ready viewer",
);
check(
  "ar:model-viewer-loads-only-on-first-selection",
  arSource.includes('import("@google/model-viewer")') &&
    !arSource.includes('from "@google/model-viewer"') &&
    mainSource.includes("this.refreshAR(current?.productId ?? null)"),
  "model-viewer must load through one dynamic import on selection, never statically",
);
check(
  "ar:entries-do-not-import-model-viewer",
  !mainSource.includes("@google/model-viewer") &&
    !storeSource.includes("@google/model-viewer") &&
    !storeSource.includes("./ar"),
  "the main and store entries must not import model-viewer",
);

// ---- The layer closes every way out ----
check(
  "ar:close-back-button",
  arSource.includes('back.className = "ar-layer-back"') &&
    arSource.includes('back.addEventListener("click", () => hideARLayer())'),
  "the layer Back button must close the layer",
);
check(
  "ar:close-on-ar-status",
  arSource.includes('el.addEventListener("ar-status"') &&
    arSource.includes('"not-presenting"') &&
    arSource.includes('"failed"'),
  "a not-presenting or failed ar-status must close the layer",
);
check(
  "ar:close-on-return-to-page",
  arSource.includes('document.addEventListener("visibilitychange"') &&
    arSource.includes("if (!document.hidden) hideARLayer()"),
  "returning to the page must close the layer",
);

// ---- Pack twice under .tmp/ ----
const runA = join(repoRoot, ".tmp", "check-ar-run1");
const runB = join(repoRoot, ".tmp", "check-ar-run2");
mkdirSync(runA, { recursive: true });
mkdirSync(runB, { recursive: true });
execFileSync(process.execPath, ["scripts/pack-ar.mjs", "--outDir", runA], {
  cwd: clientRoot,
  stdio: "ignore",
});
execFileSync(process.execPath, ["scripts/pack-ar.mjs", "--outDir", runB], {
  cwd: clientRoot,
  stdio: "ignore",
});

check("ar:count-is-41", catalog.length === 41, `${String(catalog.length)} pieces`);

function quatToMat(q: number[]): number[] {
  const [x, y, z, w] = q as [number, number, number, number];
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

function composeNode(node: Record<string, number[] | number[] | undefined>): number[] {
  const matrix = node["matrix"] as number[] | undefined;
  if (matrix !== undefined) return matrix;
  const t = (node["translation"] as number[] | undefined) ?? [0, 0, 0];
  const r = quatToMat((node["rotation"] as number[] | undefined) ?? [0, 0, 0, 1]);
  const s = (node["scale"] as number[] | undefined) ?? [1, 1, 1];
  return [
    (r[0] ?? 0) * (s[0] ?? 1),
    (r[1] ?? 0) * (s[1] ?? 1),
    (r[2] ?? 0) * (s[2] ?? 1),
    t[0] ?? 0,
    (r[4] ?? 0) * (s[0] ?? 1),
    (r[5] ?? 0) * (s[1] ?? 1),
    (r[6] ?? 0) * (s[2] ?? 1),
    t[1] ?? 0,
    (r[8] ?? 0) * (s[0] ?? 1),
    (r[9] ?? 0) * (s[1] ?? 1),
    (r[10] ?? 0) * (s[2] ?? 1),
    t[2] ?? 0,
    0,
    0,
    0,
    1,
  ];
}

function mul(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let acc = 0;
      for (let k = 0; k < 4; k += 1) acc += (a[row * 4 + k] ?? 0) * (b[k * 4 + col] ?? 0);
      out[row * 4 + col] = acc;
    }
  }
  return out;
}

interface GlbParsed {
  json: Record<string, unknown>;
  bin: Buffer;
}

function parseGlb(path: string): GlbParsed {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  if (magic !== 0x46546c67 || version !== 2) {
    throw new Error(`${path}: not binary glTF 2.0`);
  }
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(Buffer.from(buf.subarray(20, 20 + jsonLen)).toString("utf8")) as Record<
    string,
    unknown
  >;
  const binOffset = 20 + jsonLen;
  const binLen = view.getUint32(binOffset, true);
  const bin = Buffer.from(buf.subarray(binOffset + 8, binOffset + 8 + binLen));
  return { json, bin };
}

function readPositions(
  json: Record<string, unknown>,
  bin: Buffer,
): Array<{ accessor: number; values: Float32Array }> {
  const out: Array<{ accessor: number; values: Float32Array }> = [];
  const accessors = (json["accessors"] as Array<Record<string, unknown>>) ?? [];
  const bufferViews = (json["bufferViews"] as Array<Record<string, unknown>>) ?? [];
  const meshes = (json["meshes"] as Array<Record<string, unknown>>) ?? [];
  const wanted = new Set<number>();
  for (const mesh of meshes) {
    for (const prim of (mesh["primitives"] as Array<Record<string, unknown>>) ?? []) {
      const attrs = prim["attributes"] as Record<string, number>;
      if (attrs !== undefined && attrs["POSITION"] !== undefined) {
        wanted.add(attrs["POSITION"] as number);
      }
    }
  }
  for (const index of wanted) {
    const acc = accessors[index] as Record<string, unknown>;
    const viewIndex = acc["bufferView"] as number;
    const view = bufferViews[viewIndex] as Record<string, unknown>;
    const byteOffset =
      ((acc["byteOffset"] as number | undefined) ?? 0) +
      ((view["byteOffset"] as number | undefined) ?? 0);
    const count = acc["count"] as number;
    const stride = (view["byteStride"] as number | undefined) ?? 12;
    const values = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const at = byteOffset + i * stride;
      values[i * 3] = bin.readFloatLE(at);
      values[i * 3 + 1] = bin.readFloatLE(at + 4);
      values[i * 3 + 2] = bin.readFloatLE(at + 8);
    }
    out.push({ accessor: index, values });
  }
  return out;
}

function worldBox(
  json: Record<string, unknown>,
  bin: Buffer,
): {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
} {
  const box = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const nodes = (json["nodes"] as Array<Record<string, unknown>>) ?? [];
  const meshes = (json["meshes"] as Array<Record<string, unknown>>) ?? [];
  const accessors = (json["accessors"] as Array<Record<string, unknown>>) ?? [];
  const bufferViews = (json["bufferViews"] as Array<Record<string, unknown>>) ?? [];
  const positions = new Map<number, Float32Array>(
    readPositions(json, bin).map((entry) => [entry.accessor, entry.values]),
  );
  const primIndexOf = new Map<string, number>();
  for (const mesh of meshes) {
    for (const prim of (mesh["primitives"] as Array<Record<string, unknown>>) ?? []) {
      const attrs = prim["attributes"] as Record<string, number>;
      void attrs;
      void accessors;
      void bufferViews;
      void primIndexOf;
    }
  }
  const visit = (nodeIndex: number, parent: number[]): void => {
    const node = nodes[nodeIndex] as Record<string, unknown>;
    const world = mul(parent, composeNode(node as Record<string, number[] | undefined>));
    const meshIndex = node["mesh"] as number | undefined;
    if (meshIndex !== undefined) {
      const mesh = meshes[meshIndex] as Record<string, unknown>;
      for (const prim of (mesh["primitives"] as Array<Record<string, unknown>>) ?? []) {
        const attrs = prim["attributes"] as Record<string, number>;
        const values = positions.get(attrs["POSITION"] as number);
        if (values === undefined) continue;
        for (let i = 0; i < values.length; i += 3) {
          const x = values[i] ?? 0;
          const y = values[i + 1] ?? 0;
          const z = values[i + 2] ?? 0;
          const wx =
            (world[0] ?? 0) * x + (world[1] ?? 0) * y + (world[2] ?? 0) * z + (world[3] ?? 0);
          const wy =
            (world[4] ?? 0) * x + (world[5] ?? 0) * y + (world[6] ?? 0) * z + (world[7] ?? 0);
          const wz =
            (world[8] ?? 0) * x + (world[9] ?? 0) * y + (world[10] ?? 0) * z + (world[11] ?? 0);
          box.minX = Math.min(box.minX, wx);
          box.minY = Math.min(box.minY, wy);
          box.minZ = Math.min(box.minZ, wz);
          box.maxX = Math.max(box.maxX, wx);
          box.maxY = Math.max(box.maxY, wy);
          box.maxZ = Math.max(box.maxZ, wz);
        }
      }
    }
    for (const child of (node["children"] as number[] | undefined) ?? []) {
      visit(child, world);
    }
  };
  const scenes = (json["scenes"] as Array<Record<string, unknown>>) ?? [];
  const sceneIndex = (json["scene"] as number | undefined) ?? 0;
  const scene = scenes[sceneIndex] as Record<string, unknown>;
  for (const root of (scene?.["nodes"] as number[] | undefined) ?? []) {
    visit(root, identity);
  }
  return box;
}

const BANNED = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"];

let totalBytes = 0;
let largest = { id: "", bytes: 0 };

for (const item of catalog) {
  const fileA = join(runA, `${item.id}.glb`);
  const fileB = join(runB, `${item.id}.glb`);
  check(`ar:${item.id}-packed`, existsSync(fileA), fileA);
  if (!existsSync(fileA)) continue;
  const stat = statSync(fileA);
  totalBytes += stat.size;
  if (stat.size > largest.bytes) largest = { id: item.id, bytes: stat.size };
  check(`ar:${item.id}-under-10mb`, stat.size < 10 * 1024 * 1024, `${String(stat.size)} bytes`);

  let parsed: GlbParsed;
  try {
    parsed = parseGlb(fileA);
  } catch (error) {
    check(`ar:${item.id}-binary-gltf2`, false, (error as Error).message);
    continue;
  }
  check(`ar:${item.id}-binary-gltf2`, true);
  const raw = readFileSync(fileA, "utf8").slice(0, 0);
  void raw;
  const jsonText = JSON.stringify(parsed.json);
  check(`ar:${item.id}-no-uri`, !jsonText.includes('"uri"'), "buffer or image has a uri");
  const buffers = (parsed.json["buffers"] as Array<Record<string, unknown>>) ?? [];
  check(
    `ar:${item.id}-one-embedded-buffer`,
    buffers.length === 1 && buffers[0]?.["uri"] === undefined,
    `${String(buffers.length)} buffers`,
  );
  const used = new Set([
    ...(((parsed.json["extensionsUsed"] as string[] | undefined) ?? []) as string[]),
    ...(((parsed.json["extensionsRequired"] as string[] | undefined) ?? []) as string[]),
  ]);
  check(
    `ar:${item.id}-no-compression`,
    !BANNED.some((name) => used.has(name) || jsonText.includes(name)),
    [...used].join(", "),
  );

  const box = worldBox(parsed.json, parsed.bin);
  const finite =
    Number.isFinite(box.minX) &&
    Number.isFinite(box.minY) &&
    Number.isFinite(box.minZ) &&
    Number.isFinite(box.maxX);
  check(`ar:${item.id}-has-geometry`, finite, "empty bounding box");
  if (!finite) continue;
  const cxCm = ((box.minX + box.maxX) / 2) * 100;
  const czCm = ((box.minZ + box.maxZ) / 2) * 100;
  const baseCm = box.minY * 100;
  check(
    `ar:${item.id}-centred-based`,
    Math.abs(cxCm) <= 0.5 && Math.abs(czCm) <= 0.5 && Math.abs(baseCm) <= 0.5,
    `cx=${cxCm.toFixed(2)} cz=${czCm.toFixed(2)} base=${baseCm.toFixed(2)}cm`,
  );
  const wCm = (box.maxX - box.minX) * 100;
  const dCm = (box.maxZ - box.minZ) * 100;
  const hCm = (box.maxY - box.minY) * 100;
  const within = (measured: number, want: number): boolean =>
    Math.abs(measured - want) <= Math.max(2, 0.02 * want);
  check(
    `ar:${item.id}-matches-catalog`,
    within(wCm, item.size.w) && within(dCm, item.size.d) && within(hCm, item.size.h),
    `measured ${wCm.toFixed(1)}x${dCm.toFixed(1)}x${hCm.toFixed(1)} vs catalog ${item.size.w}x${item.size.d}x${item.size.h}`,
  );

  if (existsSync(fileB)) {
    const hashA = createHash("sha256").update(readFileSync(fileA)).digest("hex");
    const hashB = createHash("sha256").update(readFileSync(fileB)).digest("hex");
    check(`ar:${item.id}-byte-identical`, hashA === hashB, "two pack runs differ");
  } else {
    check(`ar:${item.id}-byte-identical`, false, "second run missing");
  }
}

{
  const sheen = parseGlb(join(runA, "SheenChair.glb"));
  const text = JSON.stringify(sheen.json);
  check(
    "ar:sheenchair-keeps-variants-and-sheen",
    text.includes("KHR_materials_variants") && text.includes("KHR_materials_sheen"),
    "missing variant or sheen extension",
  );
  const cabinet = parseGlb(join(runA, "vintage_cabinet_01.glb"));
  check(
    "ar:cabinet-keeps-clearcoat",
    JSON.stringify(cabinet.json).includes("KHR_materials_clearcoat"),
    "missing clearcoat extension",
  );
}

console.log(
  `ar: ${String(catalog.length)} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB total, largest ${largest.id} ${(largest.bytes / 1024 / 1024).toFixed(2)} MB`,
);
const listed = readdirSync(runA).filter((name) => name.endsWith(".glb"));
check("ar:one-file-per-piece", listed.length === catalog.length, `${String(listed.length)} files`);

if (failures > 0) {
  console.log(`check:ar: ${String(failures)} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("check:ar: all checks passed");
}
