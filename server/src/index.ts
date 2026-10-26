import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { isHealthResponse, type HealthResponse } from "@fitroom/shared";
import { Hono } from "hono";
import { loadGatewayConfig } from "./config.js";
import { createCapsState } from "./meta/caps.js";
import type { PipelineDeps } from "./meta/pipeline.js";
import { assistantRoutes } from "./routes/assistant.js";
import { recommendRoutes } from "./routes/recommend.js";
import { renderRoutes } from "./routes/render.js";

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
const gatewayDeps: PipelineDeps = {
  config: loadGatewayConfig(),
  caps: createCapsState(),
};
app.route("/api", recommendRoutes(gatewayDeps));
app.route("/api", assistantRoutes(gatewayDeps));
app.route("/api", renderRoutes(gatewayDeps));

const clientDistDir = fileURLToPath(new URL("../../client/dist/", import.meta.url));
const clientIndexFile = resolve(clientDistDir, "index.html");

if (existsSync(clientIndexFile)) {
  app.get("/*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
    const candidate = resolve(clientDistDir, relativePath);
    const relToDist = relative(clientDistDir, candidate);
    const isInside = relToDist !== "" && relToDist !== ".." && !relToDist.startsWith(`..${sep}`);
    const hasExtension = extname(candidate) !== "";
    let filePath: string | null = null;
    if (isInside && hasExtension && existsSync(candidate)) {
      filePath = candidate;
    } else if (!hasExtension) {
      filePath = clientIndexFile;
    }
    if (filePath === null) {
      return c.text("Not found", 404);
    }
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
