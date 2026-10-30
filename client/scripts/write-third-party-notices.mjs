/**
 * Write the browser bundle's third-party licence notices.
 *
 * Run before `vite build` (the client's `build` script runs this first, so
 * `npm run build` and `npm run deploy` both get it). It writes
 * `client/public/licenses/THIRD-PARTY-NOTICES.txt` (git-ignored; the build
 * copies `public/` to `dist/`, so it ships as `/licenses/...`).
 *
 * The bundled set is the closure of `client/package.json`'s `dependencies`
 * through each entry's `dependencies` in `package-lock.json`, following the
 * `@fitroom/shared` workspace link, without devDependencies, `dev` entries
 * or our own workspaces. Each name resolves as npm does from its importer:
 * `ajv` is `shared/node_modules/ajv`, and `json-schema-traverse` is the
 * 1.0.0 copy under `shared/node_modules`, not the root 0.4.1 copy.
 *
 * For each package, in name order: name, version, licence, npm page and the
 * full text of its own licence file (`require-from-string`'s is the
 * lower-case `license`). Known licences: MIT, BSD-3-Clause, OFL-1.1 and the
 * SAM License (`@meta-sam/parser`'s entry reads `SEE LICENSE IN LICENSE`;
 * its `LICENSE` opens `SAM License`) and Apache-2.0 (`@google/model-viewer`
 * and its worker helper). `@lit-labs/ssr-dom-shim` ships no licence file:
 * its entry takes the licence text from `lit` (same repository) and says
 * so. Exits non-zero on a package with no licence text or a licence
 * outside that list, so the build fails.
 */

/* global console, process */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, "..");
const repoRoot = resolve(clientRoot, "..");

const ALLOWED = new Set(["MIT", "BSD-3-Clause", "OFL-1.1", "SEE LICENSE IN LICENSE", "Apache-2.0"]);

// `@lit-labs/ssr-dom-shim` ships no licence file; it comes from the same
// repository and licence (BSD-3-Clause) as `lit`, which ships `LICENSE`.
const LICENCE_TEXT_FALLBACK = { "@lit-labs/ssr-dom-shim": "lit" };

function fail(message) {
  console.error(`write-third-party-notices: ${message}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function bundledPackages() {
  const clientPkg = readJson(join(clientRoot, "package.json"));
  const lock = readJson(join(repoRoot, "package-lock.json"));
  const entries = lock.packages ?? {};
  const sharedPkg = readJson(join(repoRoot, "shared", "package.json"));
  const sharedDeps = sharedPkg.dependencies ?? {};
  const seen = new Set();
  const ordered = [];
  const queue = Object.keys(clientPkg.dependencies ?? {}).map((name) => ({
    name,
    fromDir: null,
  }));
  const dirFor = (name, fromDir) => {
    const candidates =
      fromDir !== null && fromDir.startsWith("shared/")
        ? [`shared/node_modules/${name}`, `node_modules/${name}`]
        : [`node_modules/${name}`];
    for (const candidate of candidates) {
      if (Object.hasOwn(entries, candidate)) return candidate;
    }
    return null;
  };
  while (queue.length > 0) {
    const { name, fromDir } = queue.shift();
    if (name.startsWith("@fitroom/")) {
      if (name === "@fitroom/shared") {
        for (const dep of Object.keys(sharedDeps)) {
          queue.push({ name: dep, fromDir: "shared/node_modules/@fitroom/shared" });
        }
      }
      continue;
    }
    if (seen.has(name)) continue;
    const dir = dirFor(name, fromDir);
    if (dir === null) fail(`no package-lock entry resolves ${name}`);
    const entry = entries[dir];
    if (entry === undefined) fail(`no package-lock entry at ${dir}`);
    if (entry.link === true) continue;
    if (entry.dev === true) continue;
    seen.add(name);
    ordered.push({ name, dir, entry });
    for (const dep of Object.keys(entry.dependencies ?? {})) {
      queue.push({ name: dep, fromDir: dir });
    }
  }
  ordered.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ordered, lock };
}

function licenceFileFor(packageDir) {
  let names;
  try {
    names = readdirSync(packageDir);
  } catch {
    return null;
  }
  const hits = names.filter((file) => /^licen[sc]e(\..*)?$/i.test(file));
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    const rank = (file) => (file === "LICENSE" ? 0 : file === "license" ? 1 : 2);
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return hits[0] ?? null;
}

const { ordered } = bundledPackages();
const parts = [];
parts.push("Third-party notices for the FitRoom browser bundle.");
parts.push("");
parts.push(
  "The browser bundle carries the packages below, each under its own licence. " +
    "Only the licence texts owed by the bundle ship here; the Worker's server " +
    "packages stay as CREDITS.md lists them.",
);
parts.push("");
for (const { name, dir, entry } of ordered) {
  const licence = entry.license ?? entry.licenses;
  if (typeof licence !== "string" || licence === "") {
    fail(`${name} has no licence field in package-lock.json`);
  }
  if (!ALLOWED.has(licence)) {
    fail(`${name} has licence ${licence}, outside the known list`);
  }
  const packageDir = join(repoRoot, dir);
  let licenceDir = packageDir;
  let fallbackNote = null;
  let file = licenceFileFor(packageDir);
  if (file === null) {
    const mapped = LICENCE_TEXT_FALLBACK[name];
    if (mapped === undefined) fail(`${name} has no licence file in ${dir}`);
    licenceDir = join(repoRoot, "node_modules", mapped);
    file = licenceFileFor(licenceDir);
    if (file === null) fail(`${name} has no licence file in ${dir}`);
    fallbackNote = `licence text from ${mapped} (same repository)`;
  }
  const text = readFileSync(join(licenceDir, file), "utf8");
  if (text.trim() === "") fail(`${name}'s licence text is empty`);
  if (name === "@meta-sam/parser" && !text.startsWith("SAM License")) {
    fail("@meta-sam/parser's LICENSE does not open with SAM License");
  }
  parts.push("================================================================================");
  parts.push(`Package: ${name}`);
  parts.push(`Version: ${entry.version}`);
  parts.push(`License: ${licence}`);
  parts.push(`Source: https://www.npmjs.com/package/${name}`);
  if (name === "@fontsource/nunito") {
    parts.push("OFL-1.1 text: /licenses/OFL-1.1-Nunito.txt");
  }
  if (fallbackNote !== null) {
    parts.push(fallbackNote);
  }
  parts.push("--------------------------------------------------------------------------------");
  parts.push(text.trimEnd());
  parts.push("");
}
const out = `${parts.join("\n").trimEnd()}\n`;
const licensesDir = join(clientRoot, "public", "licenses");
mkdirSync(licensesDir, { recursive: true });
const outPath = join(licensesDir, "THIRD-PARTY-NOTICES.txt");
const prev = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
if (prev !== out) writeFileSync(outPath, out, "utf8");
console.log(`write-third-party-notices: wrote ${ordered.map((item) => item.name).join(", ")}`);
