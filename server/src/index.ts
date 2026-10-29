import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { isHealthResponse, type HealthResponse } from "@fitroom/shared";
import { Hono } from "hono";
import type { CatalogItem } from "@fitroom/shared";
import { loadGatewayConfig } from "./config.js";
import { writeRecorded } from "./meta/demo.js";
import type { PipelineDeps } from "./meta/pipeline.js";
import { createNodeStore } from "./meta/store.js";
import { assistantRoutes, setAssistantCatalog } from "./routes/assistant.js";
import { recommendRoutes } from "./routes/recommend.js";
import { renderRoutes } from "./routes/render.js";
import { roomLabelRoutes } from "./routes/room-label.js";
import { roomSegmentRoutes } from "./routes/room-segment.js";

function loadCatalog(): CatalogItem[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // `src/index.ts` and the built `dist/index.js` both sit two levels below
  // the repo root, next to `shared/`.
  const root = resolve(here, "..", "..", "shared");
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(root, "catalog", "catalog.json"), "utf8"),
  );
  if (!Array.isArray(parsed)) throw new Error("Catalog is not an array.");
  return parsed as CatalogItem[];
}

function readServerVersion(): string {
  const fromNpm = process.env["npm_package_version"];
  if (typeof fromNpm === "string" && fromNpm.length > 0) {
    return fromNpm;
  }
  try {
    const packageUrl = new URL("../package.json", import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(packageUrl, "utf-8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Fall through to the default below.
  }
  return "0.0.0";
}

function readPort(): number {
  const raw = process.env["PORT"];
  const parsed = raw === undefined ? 8787 : Number(raw);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return parsed;
  }
  return 8787;
}

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json; charset=utf-8",
  ".hdr": "application/octet-stream",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const app = new Hono();

app.get("/api/health", (c) => {
  const payload: HealthResponse = { ok: true, version: readServerVersion() };
  if (!isHealthResponse(payload)) {
    return c.json({ ok: false, version: "unknown" }, 500);
  }
  return c.json(payload);
});

// Small, safe Meta-model gateway: demo store, cache, caps, upstream, metering.
const gatewayConfig = loadGatewayConfig();
setAssistantCatalog(loadCatalog());
const gatewayDeps: PipelineDeps = {
  config: gatewayConfig,
  store: createNodeStore({ dataDir: gatewayConfig.dataDir, logsDir: gatewayConfig.logsDir }),
  recordUpstream: (route, model, key, keyInput, data) => {
    writeRecorded(gatewayConfig.dataDir, route, model, key, keyInput, data);
  },
};
app.route("/api", recommendRoutes(gatewayDeps));
app.route("/api", assistantRoutes(gatewayDeps));
app.route("/api", renderRoutes(gatewayDeps));
app.route("/api", roomSegmentRoutes(gatewayDeps));
app.route("/api", roomLabelRoutes(gatewayDeps));

/**
 * Choose the file to serve for a static path inside the built client.
 *
 * - A path with an extension serves that file when it exists inside the
 *   dist folder.
 * - A path without one serves `<path>.html` when that file exists (so
 *   `/store` and `/store?id=sofa_02` serve `store.html`).
 * - Everything else falls back to `index.html`.
 * - Nothing outside the dist folder is ever served (`/../x`, encoded dots).
 */
export function resolveStaticFile(urlPath: string, distDir: string): string {
  const indexFile = resolve(distDir, "index.html");
  const hashAt = urlPath.indexOf("#");
  const queryAt = urlPath.indexOf("?");
  let end = urlPath.length;
  if (queryAt >= 0) end = Math.min(end, queryAt);
  if (hashAt >= 0) end = Math.min(end, hashAt);
  let pathPart = urlPath.slice(0, end);
  if (pathPart === "") pathPart = "/";
  if (!pathPart.startsWith("/")) pathPart = `/${pathPart}`;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return indexFile;
  }
  if (decoded.includes("\0")) return indexFile;
  let normalized = decoded;
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") return indexFile;
  const candidate = resolve(distDir, `.${normalized}`);
  const relToDist = relative(distDir, candidate);
  const isInside = relToDist !== "" && relToDist !== ".." && !relToDist.startsWith(`..${sep}`);
  if (!isInside) return indexFile;
  if (extname(candidate) !== "") {
    if (existsSync(candidate)) return candidate;
    return indexFile;
  }
  const htmlCandidate = resolve(distDir, `.${normalized}.html`);
  const htmlRel = relative(distDir, htmlCandidate);
  const htmlInside = htmlRel !== "" && htmlRel !== ".." && !htmlRel.startsWith(`..${sep}`);
  if (htmlInside && existsSync(htmlCandidate)) return htmlCandidate;
  return indexFile;
}

const clientDistDir = fileURLToPath(new URL("../../client/dist/", import.meta.url));
const clientIndexFile = resolve(clientDistDir, "index.html");

if (existsSync(clientIndexFile)) {
  app.get("/*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const filePath = resolveStaticFile(pathname, clientDistDir);
    try {
      const data = await readFile(filePath);
      const contentType = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
      return c.body(new Uint8Array(data), 200, { "Content-Type": contentType });
    } catch {
      return c.text("Not found", 404);
    }
  });
}

const port = readPort();
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`FitRoom server listening on http://localhost:${info.port}`);
});
