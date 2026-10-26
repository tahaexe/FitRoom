import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { isHealthResponse, type HealthResponse } from "@fitroom/shared";
import { Hono } from "hono";

const metaApiKey = process.env["META_API_KEY"] ?? "";
// Reserved for later AI features. Never log or expose this value.
void metaApiKey;

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
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
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

const clientDistDir = fileURLToPath(new URL("../../client/dist/", import.meta.url));
const clientIndexFile = resolve(clientDistDir, "index.html");

if (existsSync(clientIndexFile)) {
  app.get("/*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    const candidate = resolve(clientDistDir, relative);
    const isInside = candidate === clientDistDir || candidate.startsWith(clientDistDir + sep);
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
