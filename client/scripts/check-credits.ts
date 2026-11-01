/**
 * `npm run check:credits` — the catalog is the one source for piece credits.
 * Headless (no browser, no Meta calls).
 *
 * - Every catalog piece has one `CREDITS.md` entry (`### <id>`) whose
 *   `Credit:` and `License:` equal its catalog `credit` and `license`.
 * - The Credits dialog holds each piece's catalog `credit` once (whitespace
 *   collapsed), linked to the entry's `Source:` URL where it has one.
 * - The dialog no longer says "All 3D and texture assets are CC0-1.0", and no
 *   line holding a built piece's credit says "CC0".
 * - Each built piece's `Source:` names exactly the ambientCG ids in its
 *   `.gltf` `images` (the wardrobe: no texture, a plain oak colour; the bed:
 *   Fabric061 only).
 * - Self-case: a copy of the catalog with one `credit` changed fails
 *   validation.
 * - `LICENSE` holds the repo licence text.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { existsSync, readFileSync } from "node:fs";
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

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

interface CatalogItem {
  id: string;
  credit: string;
  license: string;
}

const catalog = JSON.parse(
  readFileSync(join(repoRoot, "shared", "catalog", "catalog.json"), "utf8"),
) as CatalogItem[];

const creditsMd = readFileSync(join(repoRoot, "CREDITS.md"), "utf8");
const dialog = collapse(readFileSync(join(clientRoot, "index.html"), "utf8"));

const BUILT_IDS = new Set([
  "rug_160x230",
  "rug_200x300",
  "rug_240x340",
  "fitroom_floor_lamp",
  "fitroom_wardrobe",
  "fitroom_platform_bed",
  "fitroom_sofa_3seat",
]);

function creditsEntry(id: string): { credit: string; license: string; source: string } | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`### ${escaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`).exec(
    creditsMd,
  );
  if (match === null) return null;
  const body = match[1] ?? "";
  const credit = /- Credit: ([^\n]+)/.exec(body)?.[1]?.trim() ?? "";
  const license = /- License: ([^\n]+)/.exec(body)?.[1]?.trim() ?? "";
  const source = /- Source: ([^\n]+)/.exec(body)?.[1]?.trim() ?? "";
  if (credit === "" || license === "") return null;
  return { credit, license, source };
}

function validateCatalog(items: CatalogItem[]): string[] {
  const problems: string[] = [];
  for (const item of items) {
    const entry = creditsEntry(item.id);
    if (entry === null) {
      problems.push(`no CREDITS.md entry for ${item.id}`);
      continue;
    }
    if (entry.credit !== item.credit) {
      problems.push(`${item.id} Credit differs from the catalog`);
    }
    if (entry.license !== item.license) {
      problems.push(`${item.id} License differs from the catalog`);
    }
    const want = collapse(item.credit);
    const occurrences = dialog.split(want).length - 1;
    if (occurrences !== 1) {
      problems.push(`dialog holds ${item.id} credit ${occurrences} times, want once`);
    }
    const url = /(https?:\/\/[^)\s"']+)/.exec(entry.source)?.[1] ?? "";
    if (url !== "" && !dialog.includes(`href="${url}"`)) {
      problems.push(`dialog links ${item.id} to no ${url}`);
    }
  }
  return problems;
}

check("credits:piece-count", catalog.length === 41, String(catalog.length));
const catalogProblems = validateCatalog(catalog);
check(
  "credits:catalog-is-source",
  catalogProblems.length === 0,
  catalogProblems.slice(0, 5).join("; "),
);

check(
  "credits:no-blanket-cc0-line",
  !dialog.includes("All 3D and texture assets are CC0-1.0"),
  "dialog still carries the blanket line",
);
check(
  "credits:no-poly-haven-contributors-line",
  !dialog.includes("Poly Haven contributors"),
  "dialog still carries the contributors line",
);
check(
  "credits:no-new-in-this-release",
  !dialog.includes("New in this release:"),
  "dialog still carries the release list",
);

for (const item of catalog) {
  if (!BUILT_IDS.has(item.id)) continue;
  const line = dialog.split("</li>").find((chunk) => chunk.includes(collapse(item.credit)));
  check(
    `credits:built-line-no-cc0-${item.id}`,
    line !== undefined && !line.includes("CC0"),
    item.id,
  );
}

const TEXTURE_ID =
  /(Carpet\d+|Fabric\d+|WoodFloor\d+|Tiles\d+|Wallpaper\w+|PaintedPlaster\d+|Concrete\d+)/g;
for (const item of catalog) {
  if (!BUILT_IDS.has(item.id)) continue;
  const entry = creditsEntry(item.id);
  const gltfPath = join(
    clientRoot,
    "public",
    "assets",
    "models",
    "fitroom",
    item.id,
    `${item.id}_1k.gltf`,
  );
  const gltf = JSON.parse(readFileSync(gltfPath, "utf8")) as {
    images?: Array<{ uri?: string }>;
  };
  const fromGltf = new Set<string>();
  for (const image of gltf.images ?? []) {
    const hit = /ambientcg\/([^/]+)\//.exec(image.uri ?? "");
    if (hit !== null && hit[1] !== undefined) fromGltf.add(hit[1]);
  }
  const fromSource = new Set<string>(entry?.source.match(TEXTURE_ID) ?? []);
  const same = fromGltf.size === fromSource.size && [...fromGltf].every((id) => fromSource.has(id));
  check(
    `credits:built-source-textures-${item.id}`,
    same,
    `${item.id}: source names [${[...fromSource].join(", ")}], gltf uses [${[...fromGltf].join(", ")}]`,
  );
}

{
  const mutated = JSON.parse(JSON.stringify(catalog)) as CatalogItem[];
  const first = mutated[0];
  if (first !== undefined) first.credit = `${first.credit} (edited)`;
  check(
    "credits:self-changed-credit-fails",
    validateCatalog(mutated).length > 0,
    "a catalog copy with one changed credit still validates",
  );
}

const LICENCE_TEXT =
  "Copyright © 2026 MUHAMMED TAHA AKTAŞ. All rights reserved: the source is published to be read, not reused. Assets and libraries keep their own licences (see CREDITS.md).";
const licencePath = join(repoRoot, "LICENSE");
check("credits:licence-exists", existsSync(licencePath), "LICENSE");
if (existsSync(licencePath)) {
  const actual = readFileSync(licencePath, "utf8").replace(/\r\n/g, "\n").trim();
  check("credits:licence-text", actual === LICENCE_TEXT, actual.slice(0, 80));
}

if (failures > 0) process.exit(1);
console.log("credits ok");
