/**
 * `npm run check:gateway` — end-to-end gateway check in mock mode.
 *
 * Starts the built server (META_MOCK=1) on port 8788 with its data and logs
 * under `.tmp/check-gateway/`, then checks:
 * - the same render request twice: a cache hit the second time (one `mock`
 *   line, then one `cache` line in costs.csv);
 * - a session over its call cap gets 429 with the friendly text;
 * - demo mode answers all three routes from the store, an unknown request
 *   gets `demo-miss`, and no `mock` or `upstream` line is written;
 * - `client/dist` holds no `META_API_KEY` value.
 *
 * Prints PASS or FAIL per check, stops the server it started itself, and
 * exits non-zero on any FAIL. Mock mode only: no live Meta calls.
 */

/* global console, process */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8788;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const ROUTES = ["recommend", "assistant", "render"] as const;

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..");
const repoRoot = resolve(serverDir, "..");
const workDir = join(repoRoot, ".tmp", "check-gateway");
const dataDir = join(workDir, "data");
const logsDir = join(workDir, "logs");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

/** Minimal cookie jar: the server identifies a session by cookie. */
class Jar {
  cookie = "";
  async post(
    route: string,
    body: unknown,
    options: { live?: boolean; ip?: string } = {},
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.live === true) headers["x-fitroom-live"] = "1";
    if (options.ip !== undefined) headers["x-forwarded-for"] = options.ip;
    if (this.cookie !== "") headers["cookie"] = this.cookie;
    const res = await fetch(`${BASE}/api/${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const setCookies =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of setCookies) {
      const pair = line.split(";")[0]?.trim();
      if (pair !== undefined && pair.startsWith("fitroom_sid=")) this.cookie = pair;
    }
    let json: unknown;
    try {
      json = (await res.json()) as unknown;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function costsLines(): string[][] {
  const file = join(logsDir, "costs.csv");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(1)
    .map((line) => line.split(","));
}

function demoInputs(route: string): unknown[] {
  const dir = join(dataDir, "demo", route);
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

async function waitForHealth(child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => resolve();
    child.once("exit", done);
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      setTimeout(done, 1000);
    }, 5000);
  });
}

async function main(): Promise<void> {
  const builtServer = join(serverDir, "dist", "index.js");
  if (!existsSync(builtServer)) {
    check("built server exists (run npm run build first)", false, "server/dist/index.js missing");
    process.exit(1);
  }

  // Fresh isolated data + logs; seed the committed fixtures.
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  cpSync(join(serverDir, "data", "mock"), join(dataDir, "mock"), { recursive: true });
  cpSync(join(serverDir, "data", "demo"), join(dataDir, "demo"), { recursive: true });

  // A sentinel key proves the built client leaks nothing: it must never
  // appear in client/dist. The key itself is never printed.
  const sentinel = `cg-sentinel-${randomBytes(8).toString("hex")}`;
  const child = spawn("node", [builtServer], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      META_MOCK: "1",
      META_RECORD: "",
      META_API_KEY: sentinel,
      FITROOM_DATA_DIR: dataDir,
      FITROOM_LOGS_DIR: logsDir,
    },
    stdio: "ignore",
  });
  try {
    check("mock server starts", await waitForHealth(child), "no /api/health on 8788");
    if (child.exitCode !== null) {
      process.exitCode = 1;
      return;
    }

    // 1. Same render request twice: mock, then a cache hit.
    {
      const jar = new Jar();
      const body = { prompt: "gateway check render" };
      const first = await jar.post("render", body, { live: true, ip: "10.8.8.1" });
      const second = await jar.post("render", body, { live: true, ip: "10.8.8.1" });
      check(
        "render answers twice in mock mode",
        first.status === 200 &&
          isRecord(first.json) &&
          first.json["status"] === "ok" &&
          first.json["source"] === "mock" &&
          second.status === 200 &&
          isRecord(second.json) &&
          second.json["status"] === "ok" &&
          second.json["source"] === "cache",
        JSON.stringify({ first: first.json, second: second.json }).slice(0, 300),
      );
      const lines = costsLines();
      check(
        "costs.csv holds one mock line then one cache line",
        lines.length === 2 && lines[0]?.[4] === "mock" && lines[1]?.[4] === "cache",
        JSON.stringify(lines.map((l) => l[4])),
      );
      const usd = Number(lines[0]?.[9]);
      check(
        "mock render line carries its USD",
        Number.isFinite(usd) && usd > 0,
        String(lines[0]?.[9]),
      );
    }

    // 2. A session over its call cap gets 429 with the friendly text.
    {
      const jar = new Jar();
      let capped = 0;
      let okCount = 0;
      let last: unknown = null;
      for (let i = 0; i < 21; i += 1) {
        const res = await jar.post(
          "render",
          { prompt: `gateway check cap ${String(i)}` },
          {
            live: true,
            ip: "10.8.8.2",
          },
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
          last["message"].includes("Use the sample room"),
        JSON.stringify(last)?.slice(0, 200),
      );
    }

    // 3. Demo mode: stored answers for all routes, demo-miss otherwise.
    {
      const jar = new Jar();
      const before = costsLines().filter((l) => l[4] === "mock" || l[4] === "upstream").length;
      let demoOk = 0;
      for (const route of ROUTES) {
        const inputs = demoInputs(route);
        if (inputs.length === 0) continue;
        const res = await jar.post(route, inputs[0], { ip: "10.8.8.3" });
        if (
          res.status === 200 &&
          isRecord(res.json) &&
          res.json["status"] === "ok" &&
          res.json["source"] === "demo"
        ) {
          demoOk += 1;
        } else {
          check(
            `demo mode answers ${route} from the store`,
            false,
            JSON.stringify(res.json)?.slice(0, 200),
          );
        }
      }
      check(
        "demo mode answers all three routes from the store",
        demoOk === 3,
        `demo=${String(demoOk)}`,
      );
      const missBody = (route: string): unknown =>
        route === "recommend"
          ? {
              room: {
                name: "No such room",
                size_cm: [1, 1],
                style: { tags: [], colors: [] },
              },
              placed: [],
              request: { category: "no such demo answer 000000" },
              freeSpace: { runs: [], openAreas: [] },
              candidates: [],
            }
          : route === "assistant"
            ? {
                request: "no such demo answer 000000",
                messages: [{ role: "user", content: "no such demo answer 000000" }],
                room: JSON.parse(
                  readFileSync(join(repoRoot, "shared", "samples", "living-420x360.json"), "utf8"),
                ),
                scene: JSON.parse(
                  readFileSync(
                    join(repoRoot, "shared", "samples", "fit-tests", "valid.json"),
                    "utf8",
                  ),
                ),
              }
            : { prompt: "no such demo answer 000000" };
      let missOk = 0;
      for (const route of ROUTES) {
        const res = await jar.post(route, missBody(route), { ip: "10.8.8.3" });
        if (
          res.status === 200 &&
          isRecord(res.json) &&
          res.json["status"] === "demo-miss" &&
          typeof res.json["message"] === "string" &&
          res.json["message"].includes("Use the sample room")
        ) {
          missOk += 1;
        }
      }
      check("unknown demo requests get demo-miss", missOk === 3, `miss=${String(missOk)}`);
      const after = costsLines().filter((l) => l[4] === "mock" || l[4] === "upstream").length;
      check(
        "demo mode writes no mock or upstream line",
        after === before,
        `before=${String(before)} after=${String(after)}`,
      );
    }

    // 3b. A refused or spent credit rests like a reached cap: a mocked
    // upstream answering 401, 402 or 429, or an error body naming a quota,
    // credit or billing limit, answers 429 `capped` with the resting line
    // and writes no cost line (the call was not billed).
    {
      const { Hono } = await import("hono");
      const { serveGatewayRequest } = await import("../src/meta/pipeline.js");
      const { createNodeStore } = await import("../src/meta/store.js");
      const { UpstreamQuotaError } = await import("../src/meta/errors.js");
      const { callSpark } = await import("../src/meta/client.js");
      const { GATEWAY_CAPPED_MESSAGE } = await import("@fitroom/shared");
      const realFetch = globalThis.fetch;
      const quotaCases = [
        { name: "401", status: 401, body: "" },
        { name: "402", status: 402, body: "" },
        { name: "429", status: 429, body: "" },
        {
          name: "quota body",
          status: 500,
          body: JSON.stringify({ error: { message: "You exceeded your billing credit quota" } }),
        },
      ];
      for (const qc of quotaCases) {
        globalThis.fetch = (async () => ({
          ok: false,
          status: qc.status,
          text: async () => qc.body,
          json: async () => JSON.parse(qc.body === "" ? "null" : qc.body),
        })) as unknown as typeof fetch;
        let threw = false;
        try {
          await callSpark("quota-key", { messages: [{ role: "user", content: "hi" }] });
        } catch (error) {
          threw = error instanceof UpstreamQuotaError;
        }
        check(`upstream ${qc.name} throws the quota error`, threw);
      }
      globalThis.fetch = realFetch;

      const quotaDataDir = join(workDir, "quota-data");
      const quotaLogsDir = join(workDir, "quota-logs");
      rmSync(quotaDataDir, { recursive: true, force: true });
      rmSync(quotaLogsDir, { recursive: true, force: true });
      mkdirSync(quotaDataDir, { recursive: true });
      mkdirSync(quotaLogsDir, { recursive: true });
      const quotaConfig = {
        apiKey: "quota-test-key",
        mock: false,
        record: false,
        sessionMaxCalls: 20,
        sessionMaxUsd: 0.5,
        globalBudgetUsd: 10,
        globalBudgetFromIso: null,
        ratePerMinutePerIp: 1000,
        dataDir: quotaDataDir,
        logsDir: quotaLogsDir,
      };
      const quotaStore = createNodeStore({ dataDir: quotaDataDir, logsDir: quotaLogsDir });
      const quotaCostsFile = join(quotaLogsDir, "costs.csv");
      const quotaCostsCount = (): number => {
        if (!existsSync(quotaCostsFile)) return 0;
        return readFileSync(quotaCostsFile, "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "").length;
      };
      for (const qc of quotaCases) {
        const app = new Hono();
        app.post("/render", (c) =>
          serveGatewayRequest(
            c,
            { config: quotaConfig, store: quotaStore },
            {
              route: "render",
              model: "muse-image-1.0",
              liveReady: true,
              parseBody: () => ({ input: { prompt: qc.name } }),
              keyInput: () => ({ prompt: `quota ${qc.name}` }),
              upstream: async () => {
                throw new UpstreamQuotaError();
              },
            },
          ),
        );
        const before = quotaCostsCount();
        const res = await app.request("/render", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-fitroom-live": "1" },
          body: JSON.stringify({ prompt: `quota ${qc.name}`, live: true }),
        });
        let payload: unknown = null;
        try {
          payload = (await res.json()) as unknown;
        } catch {
          payload = null;
        }
        const capped =
          res.status === 429 &&
          isRecord(payload) &&
          payload["status"] === "capped" &&
          typeof payload["message"] === "string" &&
          payload["message"] === GATEWAY_CAPPED_MESSAGE &&
          payload["message"].includes("Use the sample room");
        check(`quota ${qc.name} answers 429 capped`, capped, `status=${String(res.status)}`);
        check(`quota ${qc.name} writes no cost line`, quotaCostsCount() === before, qc.name);
        const setCookie = res.headers.get("set-cookie") ?? "";
        const sidMatch = /fitroom_sid=([0-9a-f]{32})/.exec(setCookie);
        if (sidMatch !== null) {
          const verdict = await quotaStore.checkGenerationCap(
            sidMatch[1] as string,
            false,
            20,
            0.5,
            10,
            null,
            1,
          );
          check(`quota ${qc.name} leaves the session counters alone`, verdict.ok, qc.name);
        } else {
          check(`quota ${qc.name} leaves the session counters alone`, false, "no session cookie");
        }
      }
    }

    // 3c. Every billed try reaches the costs table: a retried recommend
    // or assistant round carries both tries' usage on its one `upstream`
    // line (summed), so the judging-window cap adds up the first billed
    // try too. Invalid JSON on both tries writes both tries' usage and
    // answers today's friendly error. Mocked upstream only: no live calls.
    {
      const { Hono } = await import("hono");
      const { serveGatewayRequest } = await import("../src/meta/pipeline.js");
      const { createNodeStore } = await import("../src/meta/store.js");
      const { recommendDef, RECOMMEND_FRIENDLY_ERROR } = await import("../src/routes/recommend.js");
      const { assistantDef, ASSISTANT_FRIENDLY_ERROR } = await import("../src/routes/assistant.js");
      const { costUsd } = await import("../src/meta/pricing.js");
      const { META_MODELS } = await import("../src/config.js");
      const realFetch = globalThis.fetch;
      type UsageShape = {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        images: number;
      };
      const sparkBody = (text: string, usage: UsageShape, finishReason = "stop"): unknown => ({
        choices: [{ message: { content: text }, finish_reason: finishReason }],
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          prompt_tokens_details: { cached_tokens: usage.cachedInputTokens },
        },
      });
      const stubUpstream = (replies: Array<{ text: string; usage: UsageShape }>): void => {
        let index = 0;
        globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          json: async () => {
            const reply = replies[Math.min(index, replies.length - 1)] as {
              text: string;
              usage: UsageShape;
            };
            index += 1;
            return sparkBody(reply.text, reply.usage);
          },
        })) as unknown as typeof fetch;
      };
      const costsRows = (logsDir: string): string[][] => {
        const file = join(logsDir, "costs.csv");
        if (!existsSync(file)) return [];
        return readFileSync(file, "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .slice(1)
          .map((line) => line.split(","));
      };
      const recommendBody = {
        room: { name: "Cost room", size_cm: [420, 360], style: { tags: [], colors: [] } },
        placed: [],
        request: { category: "sofa" },
        freeSpace: { runs: [], openAreas: [] },
        candidates: [],
      };
      const assistantBody = (tag: string): unknown => ({
        request: `cost check ${tag}`,
        messages: [{ role: "user", content: `cost check ${tag}` }],
        room: JSON.parse(
          readFileSync(join(repoRoot, "shared", "samples", "living-420x360.json"), "utf8"),
        ),
        scene: JSON.parse(
          readFileSync(join(repoRoot, "shared", "samples", "fit-tests", "valid.json"), "utf8"),
        ),
      });
      const runRoute = async (
        tag: string,
        route: "recommend" | "assistant",
        body: unknown,
        replies: Array<{ text: string; usage: UsageShape }>,
      ): Promise<{ status: number; payload: unknown; rows: string[][] }> => {
        const caseDataDir = join(workDir, `costs-${tag}-data`);
        const caseLogsDir = join(workDir, `costs-${tag}-logs`);
        rmSync(caseDataDir, { recursive: true, force: true });
        rmSync(caseLogsDir, { recursive: true, force: true });
        mkdirSync(caseDataDir, { recursive: true });
        mkdirSync(caseLogsDir, { recursive: true });
        const store = createNodeStore({ dataDir: caseDataDir, logsDir: caseLogsDir });
        const config = {
          apiKey: "cost-test-key",
          mock: false,
          record: false,
          sessionMaxCalls: 20,
          sessionMaxUsd: 0.5,
          globalBudgetUsd: 10,
          globalBudgetFromIso: null,
          ratePerMinutePerIp: 1000,
          dataDir: caseDataDir,
          logsDir: caseLogsDir,
        };
        stubUpstream(replies);
        const app = new Hono();
        const def = route === "recommend" ? recommendDef : assistantDef;
        app.post(`/${route}`, (c) => serveGatewayRequest(c, { config, store }, def));
        const res = await app.request(`/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-fitroom-live": "1" },
          body: JSON.stringify(body),
        });
        let payload: unknown;
        try {
          payload = (await res.json()) as unknown;
        } catch {
          payload = null;
        }
        return { status: res.status, payload, rows: costsRows(caseLogsDir) };
      };
      const first: UsageShape = {
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 100,
        images: 0,
      };
      const second: UsageShape = {
        inputTokens: 2000,
        cachedInputTokens: 0,
        outputTokens: 200,
        images: 0,
      };
      const summed: UsageShape = {
        inputTokens: 3000,
        cachedInputTokens: 0,
        outputTokens: 300,
        images: 0,
      };
      const expectedUsd = costUsd(META_MODELS.spark, summed);
      const secondUsd = costUsd(META_MODELS.spark, second);
      try {
        // Recommend: invalid JSON then a valid answer.
        {
          const { status, payload, rows } = await runRoute(
            "recommend-retry",
            "recommend",
            recommendBody,
            [
              { text: "not json at all", usage: first },
              { text: '{"recommendations":[]}', usage: second },
            ],
          );
          const data = isRecord(payload) ? (payload["data"] as unknown) : null;
          check(
            "recommend retry answers ok",
            status === 200 && isRecord(payload) && payload["status"] === "ok" && isRecord(data),
            `status=${String(status)}`,
          );
          const upstream = rows.filter((r) => r[4] === "upstream");
          check(
            "recommend retry writes one upstream line",
            upstream.length === 1,
            String(rows.length),
          );
          const line = upstream[0];
          check(
            "recommend retry line carries both tries' tokens",
            line?.[5] === "3000" && line?.[7] === "300",
            (line ?? []).slice(5, 9).join(","),
          );
          check(
            "recommend retry USD covers both tries",
            Number(line?.[9]) === expectedUsd && Number(line?.[9]) > secondUsd,
            String(line?.[9]),
          );
        }
        // Assistant: an empty round then the final answer.
        {
          const { status, payload, rows } = await runRoute(
            "assistant-retry",
            "assistant",
            assistantBody("retry"),
            [
              { text: "", usage: first },
              { text: "All done", usage: second },
            ],
          );
          const data = isRecord(payload) ? (payload["data"] as unknown) : null;
          check(
            "assistant retry answers ok",
            status === 200 &&
              isRecord(payload) &&
              payload["status"] === "ok" &&
              isRecord(data) &&
              (data as Record<string, unknown>)["text"] === "All done",
            `status=${String(status)}`,
          );
          const upstream = rows.filter((r) => r[4] === "upstream");
          check(
            "assistant retry writes one upstream line",
            upstream.length === 1,
            String(rows.length),
          );
          const line = upstream[0];
          check(
            "assistant retry line carries both tries' tokens",
            line?.[5] === "3000" && line?.[7] === "300",
            (line ?? []).slice(5, 9).join(","),
          );
          check(
            "assistant retry USD covers both tries",
            Number(line?.[9]) === expectedUsd && Number(line?.[9]) > secondUsd,
            String(line?.[9]),
          );
        }
        // Recommend: invalid JSON on both tries writes both tries' usage.
        {
          const { status, payload, rows } = await runRoute(
            "recommend-fail",
            "recommend",
            recommendBody,
            [
              { text: "not json at all", usage: first },
              { text: "still not json", usage: second },
            ],
          );
          check(
            "recommend double-invalid answers today's friendly error",
            status === 200 &&
              isRecord(payload) &&
              payload["status"] === "error" &&
              payload["message"] === RECOMMEND_FRIENDLY_ERROR,
            JSON.stringify(payload)?.slice(0, 200),
          );
          const upstream = rows.filter((r) => r[4] === "upstream");
          const line = upstream[0];
          check(
            "recommend double-invalid writes both tries' usage",
            upstream.length === 1 && line?.[5] === "3000" && Number(line?.[9]) === expectedUsd,
            (line ?? []).slice(5, 10).join(","),
          );
        }
        // Assistant: empty rounds on both tries write both tries' usage.
        {
          const { status, payload, rows } = await runRoute(
            "assistant-fail",
            "assistant",
            assistantBody("fail"),
            [
              { text: "", usage: first },
              { text: "", usage: second },
            ],
          );
          check(
            "assistant double-empty answers today's friendly error",
            status === 200 &&
              isRecord(payload) &&
              payload["status"] === "error" &&
              payload["message"] === ASSISTANT_FRIENDLY_ERROR,
            JSON.stringify(payload)?.slice(0, 200),
          );
          const upstream = rows.filter((r) => r[4] === "upstream");
          const line = upstream[0];
          check(
            "assistant double-empty writes both tries' usage",
            upstream.length === 1 && line?.[5] === "3000" && Number(line?.[9]) === expectedUsd,
            (line ?? []).slice(5, 10).join(","),
          );
        }
      } finally {
        globalThis.fetch = realFetch;
      }
    }

    // 4. The built client holds no key material.
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
          void basename(file);
        }
      }
      check("client/dist holds no META_API_KEY value", !foundKeyName && !foundSentinel);
    }
  } finally {
    await stopServer(child);
  }

  console.log(
    failures === 0
      ? "check:gateway: all checks passed"
      : `check:gateway: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`check:gateway: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
