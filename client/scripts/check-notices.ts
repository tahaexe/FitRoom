/**
 * `npm run check:notices` — the browser bundle's licence notices are complete.
 * Headless (no browser, no Meta calls).
 *
 * - Recomputes the bundled set from `package-lock.json` on its own (the
 *   closure of the client's `dependencies` through each entry's
 *   `dependencies`, following the `@fitroom/shared` workspace link, without
 *   devDependencies, `dev` entries or our own workspaces, each name resolved
 *   as npm does) and compares it with what
 *   `client/scripts/write-third-party-notices.mjs` writes to
 *   `client/public/licenses/THIRD-PARTY-NOTICES.txt`.
 * - Fails when a package has no entry, an entry's version differs from
 *   `package-lock.json`, a licence is outside the known list (MIT,
 *   BSD-3-Clause, OFL-1.1, `SEE LICENSE IN LICENSE`) or a licence text is
 *   empty, and when an entry's text differs from its package's own licence
 *   file.
 * - Self-cases: a notices text missing a package and an entry whose licence
 *   is `GPL-3.0` must each fail validation.
 * - Asserts the Credits dialog links `/licenses/THIRD-PARTY-NOTICES.txt`,
 *   the Nunito entry names `/licenses/OFL-1.1-Nunito.txt` and the dialog's
 *   font line links it, `client/public/licenses/OFL-1.1-Nunito.txt` equals
 *   the package's `LICENSE` (line endings aside), and
 *   `client/public/licenses/SAM-LICENSE.txt` still equals
 *   `@meta-sam/parser`'s `LICENSE` (line endings aside).
 * - Asserts `CREDITS.md`'s code section says the full list ships there.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

const ALLOWED = new Set(["MIT", "BSD-3-Clause", "OFL-1.1", "SEE LICENSE IN LICENSE"]);

interface LockEntry {
  version?: unknown;
  license?: unknown;
  licenses?: unknown;
  dependencies?: unknown;
  dev?: unknown;
  link?: unknown;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

interface BundledEntry {
  name: string;
  dir: string;
  version: string;
  licence: string;
}

function bundledFromLock(): BundledEntry[] {
  const clientPkg = readJson(join(clientRoot, "package.json")) as {
    dependencies?: Record<string, string>;
  };
  const lock = readJson(join(repoRoot, "package-lock.json")) as {
    packages?: Record<string, LockEntry>;
  };
  const entries: Record<string, LockEntry> = lock.packages ?? {};
  const sharedPkg = readJson(join(repoRoot, "shared", "package.json")) as {
    dependencies?: Record<string, string>;
  };
  const sharedDeps = (sharedPkg.dependencies ?? {}) as Record<string, string>;
  const seen = new Set<string>();
  const ordered: BundledEntry[] = [];
  const queue: Array<{ name: string; fromDir: string | null }> = Object.keys(
    (clientPkg.dependencies ?? {}) as Record<string, string>,
  ).map((name) => ({ name, fromDir: null }));
  const dirFor = (name: string, fromDir: string | null): string | null => {
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
    const next = queue.shift();
    if (next === undefined) break;
    const { name, fromDir } = next;
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
    if (dir === null) continue;
    const entry: LockEntry | undefined = entries[dir];
    if (entry === undefined || entry.link === true || entry.dev === true) continue;
    seen.add(name);
    ordered.push({
      name,
      dir,
      version: String(entry.version ?? ""),
      licence: String(entry.license ?? entry.licenses ?? ""),
    });
    const deps = (entry.dependencies ?? {}) as Record<string, string>;
    for (const dep of Object.keys(deps)) {
      queue.push({ name: dep, fromDir: dir });
    }
  }
  ordered.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return ordered;
}

function licenceFileFor(packageDir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(packageDir);
  } catch {
    return null;
  }
  const hits = names.filter((file) => /^licen[sc]e(\..*)?$/i.test(file));
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    const rank = (file: string): number => (file === "LICENSE" ? 0 : file === "license" ? 1 : 2);
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return hits[0] ?? null;
}

function normalise(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

interface NoticeEntry {
  name: string;
  version: string;
  licence: string;
  text: string;
  raw: string;
}

function parseNotices(text: string): NoticeEntry[] {
  const out: NoticeEntry[] = [];
  const blocks = text.split(
    "================================================================================",
  );
  for (const block of blocks.slice(1)) {
    const name = /Package: (.+)/.exec(block)?.[1]?.trim() ?? "";
    const version = /Version: (.+)/.exec(block)?.[1]?.trim() ?? "";
    const licence = /License: (.+)/.exec(block)?.[1]?.trim() ?? "";
    const marker =
      "--------------------------------------------------------------------------------";
    const at = block.indexOf(marker);
    const body = at >= 0 ? block.slice(at + marker.length) : "";
    out.push({ name, version, licence, text: body.trim(), raw: block });
  }
  return out;
}

function validateNotices(noticesText: string, expected: BundledEntry[]): string[] {
  const problems: string[] = [];
  const entries = parseNotices(noticesText);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const want of expected) {
    const got = byName.get(want.name);
    if (got === undefined) {
      problems.push(`missing entry for ${want.name}`);
      continue;
    }
    if (got.version !== want.version) {
      problems.push(`${want.name} version ${got.version} differs from ${want.version}`);
    }
    if (!ALLOWED.has(got.licence)) {
      problems.push(`${want.name} licence ${got.licence} outside the known list`);
    }
    if (got.text.trim() === "") {
      problems.push(`${want.name} licence text is empty`);
    }
  }
  for (const entry of entries) {
    if (!expected.some((want) => want.name === entry.name)) {
      problems.push(`unexpected entry for ${entry.name}`);
    }
  }
  return problems;
}

const expected = bundledFromLock();
check(
  "notices:bundled-set-is-nine-known-packages",
  expected.map((item) => `${item.name}@${item.version}`).join(", ") ===
    "@fontsource/nunito@5.3.0, @meta-sam/parser@0.1.0, ajv@8.20.0, exifr@7.1.3, fast-deep-equal@3.1.3, fast-uri@3.1.9, json-schema-traverse@1.0.0, require-from-string@2.0.2, three@0.186.1",
  expected.map((item) => `${item.name}@${item.version}`).join(", "),
);
check(
  "notices:ajv-resolves-under-shared",
  expected.some((item) => item.name === "ajv" && item.dir === "shared/node_modules/ajv"),
  expected.find((item) => item.name === "ajv")?.dir ?? "missing",
);
check(
  "notices:traverse-resolves-under-shared",
  expected.some(
    (item) =>
      item.name === "json-schema-traverse" &&
      item.dir === "shared/node_modules/json-schema-traverse",
  ),
  expected.find((item) => item.name === "json-schema-traverse")?.dir ?? "missing",
);

const noticesPath = join(clientRoot, "public", "licenses", "THIRD-PARTY-NOTICES.txt");
check("notices:file-exists", existsSync(noticesPath), noticesPath);
const noticesText = existsSync(noticesPath) ? readFileSync(noticesPath, "utf8") : "";
if (existsSync(noticesPath)) {
  const problems = validateNotices(noticesText, expected);
  check("notices:entries-match-lock", problems.length === 0, problems.join("; "));
  const parsed = parseNotices(noticesText);
  for (const want of expected) {
    const got = parsed.find((entry) => entry.name === want.name);
    const file = licenceFileFor(join(repoRoot, want.dir));
    const actual =
      file === null ? null : normalise(readFileSync(join(repoRoot, want.dir, file), "utf8")).trim();
    check(
      `notices:text-equals-file-${want.name}`,
      got !== undefined && actual !== null && normalise(got.text).trim() === actual,
      want.name,
    );
  }
  const nunito = parsed.find((entry) => entry.name === "@fontsource/nunito");
  check(
    "notices:nunito-names-ofl-file",
    nunito !== undefined && nunito.raw.includes("/licenses/OFL-1.1-Nunito.txt"),
    nunito?.raw.slice(0, 200) ?? "missing",
  );
  const dropped = noticesText.replace("Package: three\n", "Package: three-removed\n");
  check(
    "notices:self-missing-package-fails",
    validateNotices(dropped, expected).length > 0,
    "a notices text without three still validates",
  );
  const gpl = noticesText.replace("License: MIT", "License: GPL-3.0");
  check(
    "notices:self-gpl-licence-fails",
    validateNotices(gpl, expected).length > 0,
    "a notices entry with GPL-3.0 still validates",
  );
}

const dialog = readFileSync(join(clientRoot, "index.html"), "utf8");
check(
  "notices:dialog-links-notices",
  dialog.includes('href="/licenses/THIRD-PARTY-NOTICES.txt"'),
  "dialog has no /licenses/THIRD-PARTY-NOTICES.txt link",
);
check(
  "notices:dialog-font-links-ofl",
  dialog.includes('href="/licenses/OFL-1.1-Nunito.txt"'),
  "dialog font line has no OFL link",
);

const samShipped = normalise(
  readFileSync(join(clientRoot, "public", "licenses", "SAM-LICENSE.txt"), "utf8"),
);
const samPackage = normalise(
  readFileSync(join(repoRoot, "node_modules", "@meta-sam", "parser", "LICENSE"), "utf8"),
);
check("notices:sam-copy-equals-package", samShipped === samPackage, "SAM-LICENSE.txt differs");

const oflPath = join(clientRoot, "public", "licenses", "OFL-1.1-Nunito.txt");
check("notices:ofl-file-exists", existsSync(oflPath), oflPath);
if (existsSync(oflPath)) {
  const oflShipped = normalise(readFileSync(oflPath, "utf8"));
  const oflPackage = normalise(
    readFileSync(join(repoRoot, "node_modules", "@fontsource", "nunito", "LICENSE"), "utf8"),
  );
  check("notices:ofl-copy-equals-package", oflShipped === oflPackage, "OFL copy differs");
}

const credits = readFileSync(join(repoRoot, "CREDITS.md"), "utf8");
check(
  "notices:credits-names-notices-file",
  credits.includes("THIRD-PARTY-NOTICES.txt") &&
    credits.includes("/licenses/THIRD-PARTY-NOTICES.txt"),
  "CREDITS.md code section names no notices file",
);

if (failures > 0) process.exit(1);
console.log("notices ok");
