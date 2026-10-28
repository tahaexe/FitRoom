/**
 * `npm run check:page-basics` — page basics check (no browser, no Meta calls).
 *
 * - `client/index.html` carries the one-line meta description;
 * - `client/public/robots.txt` is a real static file (text/plain, allow all);
 * - `client/public/llms.txt` is a short static Markdown file (an H1 plus two
 *   lines: what the app is, how to try it in Demo mode);
 * - `server/src/worker.ts` serves both as static files, not the app: every
 *   non-`/api/` path goes to the `ASSETS` binding (the built client copies
 *   `client/public/*` to the dist root, so `/robots.txt` and `/llms.txt`
 *   answer with their own content type and text, never the SPA fallback).
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const DESCRIPTION = "Try furniture in your own room at true size, in the browser.";

const html = readFileSync(join(repoRoot, "client", "index.html"), "utf8");
const metaTag = html.match(/<meta\b[^>]*\bname\s*=\s*(["'])description\1[^>]*>/s)?.[0] ?? "";
const metaContent = metaTag.match(/\bcontent\s*=\s*(["'])(.*?)\1/s)?.[2];
check(
  "HTML has the one-line meta description",
  metaContent === DESCRIPTION,
  JSON.stringify(metaTag),
);

const robotsPath = join(repoRoot, "client", "public", "robots.txt");
const llmsPath = join(repoRoot, "client", "public", "llms.txt");
check("robots.txt is a static file", existsSync(robotsPath), "client/public/robots.txt");
check("llms.txt is a static file", existsSync(llmsPath), "client/public/llms.txt");

const robots = existsSync(robotsPath) ? readFileSync(robotsPath, "utf8") : "";
check(
  "robots.txt allows all (text/plain)",
  robots.includes("User-agent: *") && robots.includes("Allow: /"),
  JSON.stringify(robots),
);

const llms = existsSync(llmsPath) ? readFileSync(llmsPath, "utf8") : "";
const llmsLines = llms.split("\n").filter((line) => line.trim() !== "");
check(
  "llms.txt opens with an H1",
  llmsLines[0]?.startsWith("# ") === true,
  JSON.stringify(llmsLines[0] ?? ""),
);
check(
  "llms.txt is an H1 plus two lines",
  llmsLines.length === 3,
  `${String(llmsLines.length)} non-empty lines`,
);
check(
  "llms.txt says what the app is",
  (llmsLines[1] ?? "").includes("true size"),
  JSON.stringify(llmsLines[1] ?? ""),
);
check(
  "llms.txt says how to try Demo mode",
  (llmsLines[1] ?? "").includes("browser") || (llmsLines[2] ?? "").includes("Demo mode"),
  JSON.stringify(llmsLines[2] ?? ""),
);

const worker = readFileSync(join(repoRoot, "server", "src", "worker.ts"), "utf8");
check(
  "worker serves non-API paths as static files, not the app",
  worker.includes('if (!url.pathname.startsWith("/api/"))') &&
    worker.includes("env.ASSETS.fetch(request)"),
  "server/src/worker.ts",
);

const wrangler = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8");
check(
  "assets directory serves the built client",
  wrangler.includes('"directory": "client/dist"'),
  "wrangler.jsonc",
);

if (failures > 0) {
  console.log(`check:page-basics: ${String(failures)} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("check:page-basics: all checks passed");
}
