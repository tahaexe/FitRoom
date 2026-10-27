/**
 * `npm run check:worker` — end-to-end Worker check on Cloudflare's free plan
 * shape, all local (no Meta call, no Cloudflare account, no login).
 *
 * Builds the client and the Worker, applies the D1 migrations to a local D1
 * (state under `.tmp/check-worker/`), starts `wrangler dev` in-process on a
 * free port with `META_MOCK=1`, then checks:
 * - `/` serves the app and a deep link falls back to it;
 * - `/api/health`;
 * - demo mode answers a stored request of each route from the bundle, and
 *   an unknown request of each route gets `demo-miss`;
 * - the same mock request twice writes one `mock` row then one `cache` row
 *   in D1;
 * - a session over its call cap gets 429 with the friendly text;
 * - the budget sum counts `upstream` rows only (mock SUM ignored, an
 *   inserted `upstream` row trips the global budget for live requests while
 *   mock requests still pass);
 * - after restarting `wrangler dev` the D1 rows are still there;
 * - `X-Forwarded-For` is never trusted (shared IP bucket across sessions);
 * - the dry-run Worker bundle gzips under 3 MB;
 * - neither the Worker bundle nor `client/dist` holds the `META_API_KEY`
 *   value (a sentinel stands in for the secret; it is never printed).
 *
 * Prints PASS or FAIL per check, stops every Worker it started itself, and
 * exits non-zero on any FAIL.
 */

/* global console, process */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const workDir = join(repoRoot, ".tmp", "check-worker");
const stateDir = join(workDir, "state");
const xffStateDir = join(workDir, "xff-state");
const distDir = join(workDir, "worker-dist");
const formFile = join(distDir, "upload.bin");

const THREE_MB = 3 * 1024 * 1024;

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.once("error", () => resolvePromise({ exit: null, stdout, stderr }));
    child.once("exit", (code) => resolvePromise({ exit: code, stdout, stderr }));
  });
}

const WRANGLER_BIN = join("node_modules", "wrangler", "bin", "wrangler.js");

async function wrangler(args: string[]): Promise<{ exit: number | null; stdout: string }> {
  const res = await run("node", [WRANGLER_BIN, ...args]);
  return { exit: res.exit, stdout: `${res.stdout}\n${res.stderr}` };
}

/** A free local port (discovered by binding port 0, then released). */
function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

/** Minimal cookie jar: the gateway identifies a session by cookie. */
class Jar {
  cookie = "";
  constructor(readonly base: string) {}
  async get(path: string): Promise<{ status: number; text: string; contentType: string }> {
    const headers: Record<string, string> = {};
    if (this.cookie !== "") headers["cookie"] = this.cookie;
    const res = await fetch(`${this.base}${path}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    this.storeCookie(res);
    return {
      status: res.status,
      text: await res.text(),
      contentType: res.headers.get("content-type") ?? "",
    };
  }
  async post(
    route: string,
    body: unknown,
    options: { live?: boolean; ip?: string } = {},
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.live === true) headers["x-fitroom-live"] = "1";
    if (options.ip !== undefined) headers["x-forwarded-for"] = options.ip;
    if (this.cookie !== "") headers["cookie"] = this.cookie;
    const res = await fetch(`${this.base}/api/${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    this.storeCookie(res);
    let json: unknown;
    try {
      json = (await res.json()) as unknown;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }
  private storeCookie(res: Response): void {
    const setCookies =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of setCookies) {
      const pair = line.split(";")[0]?.trim();
      if (pair !== undefined && pair.startsWith("fitroom_sid=")) this.cookie = pair;
    }
  }
}

async function waitForHealth(base: string): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return false;
}

async function startWorker(
  port: number,
  persistTo: string,
  vars: Record<string, string>,
): Promise<Unstable_DevWorker> {
  return unstable_dev("server/src/worker.ts", {
    config: "wrangler.jsonc",
    ip: "127.0.0.1",
    port,
    local: true,
    persistTo,
    vars,
    logLevel: "error",
    experimental: { disableExperimentalWarning: true },
  });
}

async function stopWorker(worker: Unstable_DevWorker | null): Promise<void> {
  if (worker === null) return;
  try {
    await worker.stop();
  } catch {
    // Already gone.
  }
}

/** Run one SQL statement against the local D1 and return its result rows. */
async function d1Rows(
  persistTo: string,
  sql: string,
): Promise<{ ok: boolean; rows: Array<Record<string, unknown>> }> {
  const res = await wrangler([
    "d1",
    "execute",
    "fitroom",
    "--local",
    "--persist-to",
    persistTo,
    "--command",
    sql,
    "--json",
  ]);
  if (res.exit !== 0) return { ok: false, rows: [] };
  try {
    const start = res.stdout.indexOf("[");
    const end = res.stdout.lastIndexOf("]");
    if (start < 0 || end < 0 || end <= start) return { ok: false, rows: [] };
    const parsed: unknown = JSON.parse(res.stdout.slice(start, end + 1));
    if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false, rows: [] };
    const first = parsed[0] as { results?: Array<Record<string, unknown>> };
    if (!Array.isArray(first.results)) return { ok: false, rows: [] };
    return { ok: true, rows: first.results as Array<Record<string, unknown>> };
  } catch {
    return { ok: false, rows: [] };
  }
}

async function d1Exec(persistTo: string, sql: string): Promise<boolean> {
  const res = await wrangler([
    "d1",
    "execute",
    "fitroom",
    "--local",
    "--persist-to",
    persistTo,
    "--command",
    sql,
  ]);
  return res.exit === 0;
}

function demoInputs(route: string): unknown[] {
  const dir = join(repoRoot, "server", "data", "demo", route);
  if (!existsSync(dir)) return [];
  const out: unknown[] = [];
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (isRecord(parsed) && "input" in parsed) out.push(parsed["input"]);
  }
  return out;
}

function distFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...distFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Extract the Worker's script part (`main_module`) from the dry-run upload
 * form `--outfile` writes, as raw bytes.
 */
function extractWorkerScript(form: Buffer, boundaryFirstLine: string): Buffer | null {
  const boundary = Buffer.from(boundaryFirstLine, "latin1");
  const headerEnd = Buffer.from("\r\n\r\n", "latin1");
  const trailer = Buffer.from("\r\n", "latin1");
  const splitBody = (part: Buffer): Buffer | null => {
    const bodyStart = part.indexOf(headerEnd);
    if (bodyStart < 0) return null;
    let body = part.subarray(bodyStart + headerEnd.length);
    if (body.length >= 2 && body.subarray(body.length - 2).equals(trailer)) {
      body = body.subarray(0, body.length - 2);
    }
    return Buffer.from(body);
  };
  const bodies = new Map<string, Buffer>();
  let at = 0;
  for (;;) {
    const next = form.indexOf(boundary, at);
    if (next < 0) break;
    const part = form.subarray(at, next);
    at = next + boundary.length;
    const headEnd = part.indexOf(headerEnd);
    if (headEnd < 0) continue;
    const head = part.subarray(0, headEnd).toString("latin1");
    const nameMatch = /name="([^"]+)"/.exec(head);
    if (nameMatch === null) continue;
    const body = splitBody(part);
    if (body !== null) bodies.set(nameMatch[1] ?? "", body);
  }
  // The upload form names the Worker's script in its metadata part.
  const metadata = bodies.get("metadata");
  if (metadata !== undefined) {
    try {
      const parsed: unknown = JSON.parse(metadata.toString("latin1"));
      if (isRecord(parsed) && typeof parsed["main_module"] === "string") {
        const main = bodies.get(parsed["main_module"]);
        if (main !== undefined) return main;
      }
    } catch {
      // Fall through to the filename fallback below.
    }
  }
  return bodies.get("worker.js") ?? null;
}

async function gzipSize(bytes: Buffer): Promise<number> {
  return gzipSync(bytes).length;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function missBody(route: string): unknown {
  if (route === "recommend") {
    return {
      room: { name: "No such room", size_cm: [1, 1], style: { tags: [], colors: [] } },
      placed: [],
      request: { category: "no such demo answer 000000" },
      freeSpace: { runs: [], openAreas: [] },
      candidates: [],
    };
  }
  if (route === "assistant") {
    return {
      request: "no such demo answer 000000",
      messages: [{ role: "user", content: "no such demo answer 000000" }],
      room: JSON.parse(
        readFileSync(join(repoRoot, "shared", "samples", "living-420x360.json"), "utf8"),
      ),
      scene: JSON.parse(
        readFileSync(join(repoRoot, "shared", "samples", "fit-tests", "valid.json"), "utf8"),
      ),
    };
  }
  return { prompt: "no such demo answer 000000" };
}

async function main(): Promise<void> {
  // A sentinel stands in for the Meta secret everywhere a key would travel;
  // it is passed to the Worker as a var and must never appear in a bundle,
  // in client/dist, a log or this output.
  const sentinel = `wk-sentinel-${randomBytes(8).toString("hex")}`;
  const runTag = randomBytes(4).toString("hex");
  let worker: Unstable_DevWorker | null = null;
  let lastBase: string | null;
  try {
    // 0. Builds: shared, server (regenerates the Worker bundle data), client.
    for (const workspace of ["@fitroom/shared", "@fitroom/server", "@fitroom/client"]) {
      const built = await run(process.platform === "win32" ? "npm.cmd" : "npm", [
        "run",
        "build",
        "-w",
        workspace,
      ]);
      if (built.exit !== 0) {
        check(`build ${workspace}`, false, built.stderr.slice(-300).trim());
        process.exitCode = 1;
        return;
      }
    }
    check("shared, server and client build", true);

    // 1. Dry-run Worker bundle (no account needed) and its gzip size.
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });
    const dry = await wrangler(["deploy", "--dry-run", "--outdir", distDir, "--outfile", formFile]);
    check("dry-run Worker builds (no account)", dry.exit === 0, dry.stdout.slice(-400).trim());
    if (dry.exit !== 0 || !existsSync(formFile)) {
      process.exitCode = 1;
      return;
    }
    const form = readFileSync(formFile);
    const firstLine = form.subarray(0, form.indexOf("\n")).toString("latin1").trim();
    const script = extractWorkerScript(form, firstLine);
    check("Worker script extracted from the dry-run form", script !== null);
    if (script === null) {
      process.exitCode = 1;
      return;
    }
    const gzipped = await gzipSize(script);
    console.log(`worker gzip size: ${(gzipped / 1024 / 1024).toFixed(2)} MB`);
    check("Worker gzip size is under 3 MB", gzipped < THREE_MB, `${String(gzipped)} bytes`);
    check("Worker bundle holds no META_API_KEY value", !script.includes(sentinel));

    // 2. The built client holds no key material either.
    {
      const dist = join(repoRoot, "client", "dist");
      let foundKeyName = false;
      let foundSentinel = false;
      if (existsSync(dist)) {
        for (const file of distFiles(dist)) {
          let text: string;
          try {
            text = readFileSync(file, "utf8");
          } catch {
            continue;
          }
          if (text.includes("META_API_KEY")) foundKeyName = true;
          if (text.includes(sentinel)) foundSentinel = true;
        }
      }
      check("client/dist holds no META_API_KEY value", !foundKeyName && !foundSentinel);
      const indexHtml = existsSync(join(dist, "index.html"))
        ? readFileSync(join(dist, "index.html"), "utf8")
        : "";
      check("client/dist has a built app", indexHtml.includes("<div"));
    }

    // 3. Fresh local D1 state plus migrations, for the main and XFF workers.
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(xffStateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(xffStateDir, { recursive: true });
    for (const dir of [stateDir, xffStateDir]) {
      const applied = await wrangler([
        "d1",
        "migrations",
        "apply",
        "fitroom",
        "--local",
        "--persist-to",
        dir,
      ]);
      check(
        `migrations apply to local D1 (${dir === stateDir ? "main" : "xff"})`,
        applied.exit === 0,
        applied.stdout.slice(-300).trim(),
      );
    }
    if (failures > 0) {
      process.exitCode = 1;
      return;
    }

    // 4. Main worker: mock mode, generous rate limit, sentinel as the key.
    const port = await freePort();
    worker = await startWorker(port, stateDir, {
      META_MOCK: "1",
      META_API_KEY: sentinel,
      META_RATE_PER_MIN: "1000",
    });
    const base = `http://127.0.0.1:${String(port)}`;
    const up = await waitForHealth(base);
    check("mock worker starts", up, `no /api/health on ${String(port)}`);
    if (!up) {
      process.exitCode = 1;
      return;
    }
    const jar = new Jar(base);

    // 4a. Static app plus single-page fallback.
    {
      const home = await jar.get("/");
      const deep = await jar.get("/room/demo-chair-1");
      check(
        "/ serves the app",
        home.status === 200 && home.contentType.includes("text/html") && home.text.length > 500,
        `status=${String(home.status)}`,
      );
      check(
        "a deep link falls back to the app",
        deep.status === 200 && deep.text === home.text,
        `status=${String(deep.status)}`,
      );
    }

    // 4b. Health.
    {
      const health = await jar.get("/api/health");
      let ok = false;
      try {
        const payload: unknown = JSON.parse(health.text);
        ok = health.status === 200 && isRecord(payload) && payload["ok"] === true;
      } catch {
        ok = false;
      }
      check("/api/health", ok, health.text.slice(0, 120));
    }

    // 4c. Demo mode answers every route from the bundle; unknown is a miss.
    {
      const routes = ["recommend", "assistant", "render"] as const;
      let demoOk = 0;
      for (const route of routes) {
        const inputs = demoInputs(route);
        if (inputs.length === 0) {
          check(`demo mode answers ${route} from the bundle`, false, "no stored inputs");
          continue;
        }
        const res = await jar.post(route, inputs[0]);
        if (
          res.status === 200 &&
          isRecord(res.json) &&
          res.json["status"] === "ok" &&
          res.json["source"] === "demo"
        ) {
          demoOk += 1;
        } else {
          check(
            `demo mode answers ${route} from the bundle`,
            false,
            JSON.stringify(res.json)?.slice(0, 200),
          );
        }
      }
      check("demo mode answers all three routes from the bundle", demoOk === 3);
      let missOk = 0;
      for (const route of routes) {
        const res = await jar.post(route, missBody(route));
        if (
          res.status === 200 &&
          isRecord(res.json) &&
          res.json["status"] === "demo-miss" &&
          typeof res.json["message"] === "string" &&
          res.json["message"].includes("demo room")
        ) {
          missOk += 1;
        }
      }
      check("unknown demo requests get demo-miss", missOk === 3, `miss=${String(missOk)}`);
    }

    // 4d. Same mock request twice: mock, then cache.
    const mockJar = new Jar(base);
    const mockPrompt = `worker check render ${runTag}`;
    {
      const first = await mockJar.post("render", { prompt: mockPrompt }, { live: true });
      const second = await mockJar.post("render", { prompt: mockPrompt }, { live: true });
      check(
        "same mock request gives mock then cache",
        first.status === 200 &&
          isRecord(first.json) &&
          first.json["source"] === "mock" &&
          second.status === 200 &&
          isRecord(second.json) &&
          second.json["source"] === "cache",
        JSON.stringify({ first: first.json, second: second.json }).slice(0, 200),
      );
    }
    const mockSession = (mockJar.cookie.split(";")[0] ?? "").replace("fitroom_sid=", "");

    // 4e. A session over its call cap gets 429.
    {
      const capJar = new Jar(base);
      let okCount = 0;
      let capped = 0;
      let last: unknown = null;
      for (let i = 0; i < 21; i += 1) {
        const res = await capJar.post(
          "render",
          { prompt: `worker check cap ${runTag} ${String(i)}` },
          { live: true },
        );
        last = res.json;
        if (res.status === 429) capped += 1;
        else if (res.status === 200) okCount += 1;
      }
      check(
        "20 calls pass, the 21st is capped",
        okCount === 20 && capped === 1,
        `ok=${String(okCount)} capped=${String(capped)}`,
      );
      check(
        "cap answer is friendly",
        isRecord(last) &&
          last["status"] === "capped" &&
          typeof last["message"] === "string" &&
          last["message"].includes("demo room"),
        JSON.stringify(last)?.slice(0, 200),
      );
    }

    // Stop the main worker before touching its D1 from the CLI.
    await stopWorker(worker);
    worker = null;

    // 5. D1 rows: one mock row then one cache row for the mock session.
    {
      const rows = await d1Rows(
        stateDir,
        `SELECT source FROM costs WHERE session = ${sqlQuote(mockSession)} ORDER BY id`,
      );
      check(
        "D1 holds one mock row then one cache row",
        rows.ok &&
          rows.rows.length === 2 &&
          rows.rows[0]?.["source"] === "mock" &&
          rows.rows[1]?.["source"] === "cache",
        JSON.stringify(rows.rows),
      );
    }

    // 6. The budget sum counts upstream rows only (no upstream row exists yet).
    {
      const sums = await d1Rows(
        stateDir,
        "SELECT source, COALESCE(SUM(usd), 0) AS total FROM costs GROUP BY source",
      );
      const bySource = new Map<string, number>();
      for (const row of sums.rows) {
        if (typeof row["source"] === "string" && typeof row["total"] === "number") {
          bySource.set(row["source"], row["total"]);
        }
      }
      check(
        "budget sum counts upstream rows only",
        sums.ok && (bySource.get("upstream") ?? 0) === 0 && (bySource.get("mock") ?? 0) > 0,
        JSON.stringify(sums.rows),
      );
    }

    // 7. An upstream probe row trips the global budget for live requests.
    check(
      "budget probe row inserted",
      await d1Exec(
        stateDir,
        "INSERT INTO costs (time, session, route, model, source, input_tokens, " +
          "cached_input_tokens, output_tokens, images, usd) VALUES " +
          `('2026-10-27T00:00:00.000Z', 'budget-probe', 'render', 'muse-image-1.0', ` +
          `'upstream', 100, 0, 50, 1, 999)`,
      ),
    );

    // 8. Restarted worker in live mode (no key): the tripped budget caps
    // live requests while demo-miss still bypasses it.
    const port2 = await freePort();
    worker = await startWorker(port2, stateDir, { META_RATE_PER_MIN: "1000" });
    const base2 = `http://127.0.0.1:${String(port2)}`;
    check("worker restarts", await waitForHealth(base2), `no /api/health on ${String(port2)}`);
    {
      const liveJar = new Jar(base2);
      const tripped = await liveJar.post(
        "render",
        { prompt: `worker check budget ${runTag}` },
        { live: true },
      );
      check(
        "tripped upstream budget caps live requests",
        tripped.status === 429 && isRecord(tripped.json) && tripped.json["status"] === "capped",
        JSON.stringify(tripped.json)?.slice(0, 200),
      );
      const miss = await liveJar.post("render", missBody("render"));
      check(
        "demo-miss bypasses the tripped budget",
        miss.status === 200 && isRecord(miss.json) && miss.json["status"] === "demo-miss",
        JSON.stringify(miss.json)?.slice(0, 200),
      );
    }
    await stopWorker(worker);
    worker = null;

    // 9. The D1 rows survived the restart.
    {
      const still = await d1Rows(
        stateDir,
        `SELECT COUNT(*) AS n FROM costs WHERE session = ${sqlQuote(mockSession)}`,
      );
      check(
        "D1 rows are still there after the restart",
        still.ok && still.rows[0]?.["n"] === 2,
        JSON.stringify(still.rows),
      );
      const total = await d1Rows(
        stateDir,
        "SELECT COALESCE(SUM(usd), 0) AS total FROM costs WHERE source = 'upstream'",
      );
      check(
        "upstream sum holds the probe row only",
        total.ok && total.rows[0]?.["total"] === 999,
        JSON.stringify(total.rows),
      );
    }

    // 10. X-Forwarded-For is never trusted: two sessions with a distinct
    // spoofed IP per request share one 30/min bucket (30 ok, then capped).
    const port3 = await freePort();
    worker = await startWorker(port3, xffStateDir, {
      META_MOCK: "1",
      META_API_KEY: sentinel,
    });
    const base3 = `http://127.0.0.1:${String(port3)}`;
    lastBase = base3;
    check("xff worker starts", await waitForHealth(base3), `no /api/health on ${String(port3)}`);
    {
      let okCount = 0;
      for (let s = 0; s < 2; s += 1) {
        const sessionJar = new Jar(base3);
        for (let i = 0; i < 16; i += 1) {
          const res = await sessionJar.post(
            "render",
            { prompt: `worker xff ${runTag} ${String(s)} ${String(i)}` },
            { live: true, ip: `10.${String(s)}.${String(i)}.1` },
          );
          if (res.status === 200) okCount += 1;
        }
      }
      check(
        "X-Forwarded-For is ignored (one shared IP bucket)",
        okCount === 30,
        `ok=${String(okCount)}`,
      );
    }
    await stopWorker(worker);
    worker = null;

    // 11. Nothing is left running.
    {
      let stopped = false;
      try {
        await fetch(`${lastBase}/api/health`, { signal: AbortSignal.timeout(3000) });
      } catch {
        stopped = true;
      }
      check("the started worker is stopped", stopped);
    }
  } finally {
    await stopWorker(worker);
  }

  console.log(
    failures === 0
      ? "check:worker: all checks passed"
      : `check:worker: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`check:worker: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
