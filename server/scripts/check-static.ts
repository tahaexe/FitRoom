/**
 * `npm run check:static` — static file choice for local `/store` serving.
 *
 * Builds a temporary dist folder under `.tmp/check-static/dist` with
 * `index.html`, `store.html` and `assets/x.webp`, then calls
 * `resolveStaticFile(urlPath, distDir)` for:
 * `/`, `/store`, `/store?id=sofa_02`, `/store.html`, `/assets/x.webp`,
 * `/missing`, `/../package.json`, `/%2e%2e/package.json`.
 *
 * Prints PASS or FAIL per route and exits non-zero on any FAIL.
 */

/* global console, process */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStaticFile } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const distDir = join(repoRoot, ".tmp", "check-static", "dist");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

rmSync(join(repoRoot, ".tmp", "check-static"), { force: true, recursive: true });
mkdirSync(join(distDir, "assets"), { recursive: true });
writeFileSync(join(distDir, "index.html"), "<!doctype html><title>app</title>\n", "utf8");
writeFileSync(join(distDir, "store.html"), "<!doctype html><title>store</title>\n", "utf8");
writeFileSync(join(distDir, "assets", "x.webp"), "webp", "utf8");

const cases: Array<[string, string]> = [
  ["/", "index.html"],
  ["/store", "store.html"],
  ["/store?id=sofa_02", "store.html"],
  ["/store.html", "store.html"],
  ["/assets/x.webp", join("assets", "x.webp")],
  ["/missing", "index.html"],
  ["/../package.json", "index.html"],
  ["/%2e%2e/package.json", "index.html"],
];

for (const [route, expectedRel] of cases) {
  const expected = join(distDir, expectedRel);
  const actual = resolveStaticFile(route, distDir);
  check(`static:${route}`, actual === expected, `got ${actual}`);
}

if (failures > 0) process.exit(1);
console.log("static ok");
process.exit(0);
