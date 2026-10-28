/**
 * `npm run check:room-api` — mock-mode gateway check for the room routes.
 *
 * On the main server (mock mode) it checks:
 * - `POST /api/room/segment` answers `{ concept, text }` and
 *   `POST /api/room/label` answers a valid room label, both `mock` first
 *   and `cache` on repeat (a cache hit writes no upstream line);
 * - the `carpet` floor-fallback concept rides the same segment route,
 *   cache and metering (`mock` first, `cache` on repeat);
 * - metering lines carry images and USD (segment: `images: 1`, USD 0.0025);
 * - a label demo replay answers from the store, while a segment request in
 *   demo mode gives `demo-miss` (segment answers never enter the store);
 * - a non-JPEG or oversize image gives 400;
 * - a failed or incomplete stream gives the route's friendly error
 *   (extraction unit tests, no live call).
 * - a live label answer with word colours and an empty `uncertain`
 *   normalizes to a valid answer (normalization fixture, no live call).
 * On dedicated servers it checks:
 * - a text over 512 KB is returned but not cached (two `mock` lines);
 * - the 0.2 call weight against the session call cap (ten segments make
 *   two calls; five segments plus one render make two calls);
 * - segment USD counts in full toward the session USD cap;
 * - the 0.2 weight against the per-IP rate limit.
 *
 * Prints PASS or FAIL per check, stops every server it started itself, and
 * exits non-zero on any FAIL. Mock mode only: no live Meta calls.
 */

/* global console, process */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRoomLabelAnswer, normalizeRoomLabelAnswer } from "@fitroom/shared";
import { SAM_FRIENDLY_ERROR, extractSamOutputText } from "../src/meta/client.js";
import { UpstreamFriendlyError } from "../src/meta/errors.js";
import { DEMO_REQUESTS } from "../src/demo-requests.js";
import { SYNTHETIC_TEST_JPEG, SYNTHETIC_TEST_JPEG_UNKNOWN } from "../src/room-label-demo.js";

const BASE_PORT = 8791;

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..");
const repoRoot = resolve(serverDir, "..");
const workDir = join(repoRoot, ".tmp", "check-room-api");

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

/** Minimal cookie jar: the server identifies a session by cookie. */
class Jar {
  cookie = "";
  constructor(readonly base: string) {}
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

function costsLines(logsDir: string): string[][] {
  const file = join(logsDir, "costs.csv");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(1)
    .map((line) => line.split(","));
}

/** A distinct tiny JPEG per number (valid SOI magic, distinct keys). */
function tinyJpeg(last: number): string {
  const bytes = Buffer.from([
    255,
    216,
    255,
    224,
    0,
    16,
    74,
    70,
    73,
    70,
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    last % 256,
  ]);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

function oversizeJpeg(byteLength: number): string {
  const bytes = Buffer.alloc(byteLength, 0);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

async function waitForHealth(child: ChildProcess, base: string): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
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

function startServer(
  port: number,
  dataDir: string,
  logsDir: string,
  extraEnv: Record<string, string>,
): ChildProcess {
  return spawn("node", [join(serverDir, "dist", "index.js")], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      META_MOCK: "1",
      META_RECORD: "",
      META_API_KEY: "",
      FITROOM_DATA_DIR: dataDir,
      FITROOM_LOGS_DIR: logsDir,
      ...extraEnv,
    },
    stdio: "ignore",
  });
}

async function main(): Promise<void> {
  const builtServer = join(serverDir, "dist", "index.js");
  if (!existsSync(builtServer)) {
    check("built server exists (run npm run build first)", false, "server/dist/index.js missing");
    process.exit(1);
  }

  rmSync(workDir, { recursive: true, force: true });
  const dataDir = join(workDir, "data");
  mkdirSync(dataDir, { recursive: true });
  cpSync(join(serverDir, "data", "mock"), join(dataDir, "mock"), { recursive: true });
  cpSync(join(serverDir, "data", "demo"), join(dataDir, "demo"), { recursive: true });

  // Main server: answer shapes, cache, metering, demo, validation.
  const logsMain = join(workDir, "logs-main");
  mkdirSync(logsMain, { recursive: true });
  const port = BASE_PORT;
  const base = `http://127.0.0.1:${String(port)}`;
  const child = startServer(port, dataDir, logsMain, {});
  try {
    check("mock server starts", await waitForHealth(child, base), `no /api/health on ${port}`);
    if (child.exitCode !== null) {
      process.exitCode = 1;
      return;
    }
    const jar = new Jar(base);
    const ip = "10.9.1.1";

    // 1. Segment: mock shape, then a cache hit with no upstream line.
    const segmentBody = { concept: "door", image: SYNTHETIC_TEST_JPEG };
    const segFirst = await jar.post("room/segment", segmentBody, { live: true, ip });
    const segSecond = await jar.post("room/segment", segmentBody, { live: true, ip });
    const segData = isRecord(segFirst.json) ? segFirst.json["data"] : null;
    check(
      "segment answers { concept, text } in mock mode",
      segFirst.status === 200 &&
        isRecord(segFirst.json) &&
        segFirst.json["status"] === "ok" &&
        segFirst.json["source"] === "mock" &&
        isRecord(segData) &&
        segData["concept"] === "door" &&
        typeof segData["text"] === "string" &&
        (segData["text"] as string).includes("<0f>"),
      JSON.stringify(segFirst.json)?.slice(0, 200),
    );
    check(
      "segment repeats from the cache",
      segSecond.status === 200 &&
        isRecord(segSecond.json) &&
        segSecond.json["source"] === "cache" &&
        isRecord(segSecond.json["data"]) &&
        (segSecond.json["data"] as Record<string, unknown>)["text"] ===
          (segData as Record<string, unknown>)?.["text"],
      JSON.stringify(segSecond.json)?.slice(0, 200),
    );

    // 2. Label: mock shape, then a cache hit.
    const labelBody = { photos: [{ wall: "A", image: SYNTHETIC_TEST_JPEG }] };
    const labFirst = await jar.post("room/label", labelBody, { live: true, ip });
    const labSecond = await jar.post("room/label", labelBody, { live: true, ip });
    const labData = isRecord(labFirst.json) ? labFirst.json["data"] : null;
    check(
      "label answers a valid room label in mock mode",
      labFirst.status === 200 &&
        isRecord(labFirst.json) &&
        labFirst.json["status"] === "ok" &&
        labFirst.json["source"] === "mock" &&
        isRoomLabelAnswer(labData, ["A"]),
      JSON.stringify(labFirst.json)?.slice(0, 300),
    );
    check(
      "label repeats from the cache",
      labSecond.status === 200 && isRecord(labSecond.json) && labSecond.json["source"] === "cache",
      JSON.stringify(labSecond.json)?.slice(0, 200),
    );

    // 3. Metering lines carry images and USD; no upstream line in mock mode.
    const lines = costsLines(logsMain);
    const sources = lines.map((l) => l[4]);
    check(
      "costs hold mock then cache lines for both routes",
      sources.join(",") === "mock,cache,mock,cache",
      sources.join(","),
    );
    const segMock = lines[0];
    check(
      "segment metering bills one image at USD 0.0025",
      segMock?.[2] === "segment" &&
        segMock?.[3] === "sam-3.1" &&
        segMock?.[8] === "1" &&
        segMock?.[9] === "0.0025",
      JSON.stringify(segMock),
    );
    const labMock = lines[2];
    const labUsd = Number(labMock?.[9]);
    check(
      "label metering carries images and USD",
      labMock?.[2] === "label" &&
        labMock?.[4] === "mock" &&
        Number(labMock?.[8]) >= 1 &&
        Number.isFinite(labUsd) &&
        labUsd > 0,
      JSON.stringify(labMock),
    );
    check("mock mode writes no upstream line", !sources.includes("upstream"), sources.join(","));

    // 3b. Carpet: the floor-fallback concept rides the same segment route,
    // cache and metering as every other concept.
    const carpetBody = { concept: "carpet", image: SYNTHETIC_TEST_JPEG };
    const carpetFirst = await jar.post("room/segment", carpetBody, { live: true, ip });
    const carpetSecond = await jar.post("room/segment", carpetBody, { live: true, ip });
    const carpetData = isRecord(carpetFirst.json) ? carpetFirst.json["data"] : null;
    check(
      "carpet answers its text in mock mode",
      carpetFirst.status === 200 &&
        isRecord(carpetFirst.json) &&
        carpetFirst.json["status"] === "ok" &&
        carpetFirst.json["source"] === "mock" &&
        isRecord(carpetData) &&
        typeof carpetData["text"] === "string" &&
        (carpetData["text"] as string).length > 0,
      JSON.stringify(carpetFirst.json)?.slice(0, 200),
    );
    check(
      "carpet repeats from the cache",
      carpetSecond.status === 200 &&
        isRecord(carpetSecond.json) &&
        carpetSecond.json["source"] === "cache" &&
        isRecord(carpetSecond.json["data"]) &&
        (carpetSecond.json["data"] as Record<string, unknown>)["text"] ===
          (carpetData as Record<string, unknown>)?.["text"],
      JSON.stringify(carpetSecond.json)?.slice(0, 200),
    );
    const carpetLines = costsLines(logsMain)
      .slice(-2)
      .map((l) => l[4]);
    check(
      "carpet metering holds a mock line then a cache line",
      carpetLines.join(",") === "mock,cache",
      carpetLines.join(","),
    );

    // 4. Label demo replay; segment demo-miss.
    const demoJar = new Jar(base);
    const demoBody = DEMO_REQUESTS["label"][0];
    const demoRes = await demoJar.post("room/label", demoBody, { ip: "10.9.1.2" });
    check(
      "label demo request replays from the store",
      demoRes.status === 200 &&
        isRecord(demoRes.json) &&
        demoRes.json["status"] === "ok" &&
        demoRes.json["source"] === "demo" &&
        isRoomLabelAnswer(demoRes.json["data"], ["A", "B"]),
      JSON.stringify(demoRes.json)?.slice(0, 300),
    );
    const missRes = await demoJar.post("room/segment", segmentBody, { ip: "10.9.1.2" });
    check(
      "segment in demo mode gives demo-miss",
      missRes.status === 200 &&
        isRecord(missRes.json) &&
        missRes.json["status"] === "demo-miss" &&
        typeof missRes.json["message"] === "string" &&
        (missRes.json["message"] as string).includes("Use the sample room"),
      JSON.stringify(missRes.json)?.slice(0, 200),
    );
    const labelMiss = await demoJar.post(
      "room/label",
      { photos: [{ wall: "A", image: SYNTHETIC_TEST_JPEG_UNKNOWN }] },
      { ip: "10.9.1.2" },
    );
    check(
      "unknown label demo request gives demo-miss",
      labelMiss.status === 200 &&
        isRecord(labelMiss.json) &&
        labelMiss.json["status"] === "demo-miss",
      JSON.stringify(labelMiss.json)?.slice(0, 200),
    );

    // 5. Validation: non-JPEG or oversize images give 400.
    const bad: Array<[string, string, unknown, { live?: boolean }]> = [
      [
        "segment rejects a non-JPEG image",
        "room/segment",
        { concept: "door", image: "data:image/png;base64,AAAA" },
        { live: true },
      ],
      [
        "segment rejects an unknown concept",
        "room/segment",
        { concept: "sofa", image: SYNTHETIC_TEST_JPEG },
        { live: true },
      ],
      ["segment rejects a missing image", "room/segment", { concept: "door" }, { live: true }],
      [
        "segment rejects an oversize image",
        "room/segment",
        { concept: "wall", image: oversizeJpeg(1024 * 1024 + 1) },
        { live: true },
      ],
      [
        "label rejects five photos",
        "room/label",
        { photos: [0, 1, 2, 3, 4].map((i) => ({ wall: "A", image: tinyJpeg(i) })) },
        { live: true },
      ],
      ["label rejects no photos", "room/label", { photos: [] }, { live: true }],
      [
        "label rejects a bad wall letter",
        "room/label",
        { photos: [{ wall: "E", image: SYNTHETIC_TEST_JPEG }] },
        { live: true },
      ],
      [
        "label rejects a repeated wall",
        "room/label",
        {
          photos: [
            { wall: "A", image: tinyJpeg(1) },
            { wall: "A", image: tinyJpeg(2) },
          ],
        },
        { live: true },
      ],
      [
        "label rejects a non-JPEG photo",
        "room/label",
        { photos: [{ wall: "A", image: "data:image/png;base64,AAAA" }] },
        { live: true },
      ],
      [
        "label rejects a body over 1 MB",
        "room/label",
        { photos: [{ wall: "A", image: oversizeJpeg(800_000) }] },
        { live: true },
      ],
    ];
    for (const [name, route, body, options] of bad) {
      const res = await jar.post(route, body, { ...options, ip: "10.9.1.3" });
      check(
        name,
        res.status === 400 && isRecord(res.json) && res.json["status"] === "error",
        `status=${String(res.status)} ${JSON.stringify(res.json)?.slice(0, 160)}`,
      );
    }
  } finally {
    await stopServer(child);
  }

  // 6. Stream failures give the friendly error (extraction only, no calls).
  {
    const friendly = (raw: string): string | null => {
      try {
        extractSamOutputText(raw);
        return null;
      } catch (error) {
        return error instanceof UpstreamFriendlyError
          ? error.message
          : `wrong error: ${String(error)}`;
      }
    };
    check(
      "a failed stream gives the friendly error",
      friendly('event: response.failed\ndata: {"type":"response.failed"}\n\n') ===
        SAM_FRIENDLY_ERROR,
    );
    check(
      "an incomplete stream gives the friendly error",
      friendly('event: response.incomplete\ndata: {"type":"response.incomplete"}\n\n') ===
        SAM_FRIENDLY_ERROR,
    );
    check(
      "an error event gives the friendly error",
      friendly('event: error\ndata: {"message":"boom"}\n\n') === SAM_FRIENDLY_ERROR,
    );
    check(
      "a stream without completion gives the friendly error",
      friendly('event: response.output_text.delta\ndata: {"delta":"<0f>"}\n\n') ===
        SAM_FRIENDLY_ERROR,
    );
    const doorRaw = readFileSync(
      join(serverDir, "data", "sam-streams", "apartment-hotel-nice-1280-door.sse"),
      "utf8",
    );
    const doorText = extractSamOutputText(doorRaw);
    check(
      "a recorded stream extracts its output text",
      doorText.startsWith("<0f>") && doorText.includes("|>"),
      doorText.slice(0, 60),
    );
  }

  // 6b. A live label answer with word colours and an empty uncertain
  // normalizes to a valid answer instead of failing the validator.
  {
    const liveAnswer = {
      floor: {
        description: "herringbone parquet hardwood floor in warm medium honey tone",
        family: "wood",
      },
      photos: [
        {
          doors: 0,
          glassDoors: 0,
          lookalikes: 1,
          openDoorways: 0,
          wall: "A",
          windows: 1,
        },
      ],
      style: {
        dominantColors: ["white", "medium wood brown", "navy blue", "green"],
        tags: ["scandinavian", "mid-century modern", "bright", "minimalist"],
      },
      uncertain: "",
      walls: {
        description: "white painted walls with simple white trim",
        family: "paint",
      },
    };
    const normalized = normalizeRoomLabelAnswer(liveAnswer, ["A"]);
    check("a live label answer normalizes instead of failing", normalized !== null);
    check(
      "the normalized live answer is a valid room label",
      normalized !== null && isRoomLabelAnswer(normalized, ["A"]),
      normalized === null ? "null" : JSON.stringify(normalized)?.slice(0, 200),
    );
    check(
      "normalizing keeps word tags, drops word colours, fills uncertain",
      normalized !== null &&
        JSON.stringify(normalized.style.tags) ===
          JSON.stringify(["scandinavian", "mid-century modern", "bright", "minimalist"]) &&
        normalized.style.dominantColors.length === 0 &&
        normalized.uncertain === "Nothing.",
      normalized === null ? "null" : JSON.stringify(normalized.style),
    );
  }

  // 7. A text over 512 KB is returned but not cached.
  {
    const bigData = join(workDir, "data-big");
    rmSync(bigData, { recursive: true, force: true });
    mkdirSync(bigData, { recursive: true });
    cpSync(join(serverDir, "data", "mock"), join(bigData, "mock"), { recursive: true });
    cpSync(join(serverDir, "data", "demo"), join(bigData, "demo"), { recursive: true });
    const bigText = `x${"y".repeat(600 * 1024)}`;
    writeFileSync(
      join(bigData, "mock", "segment.json"),
      `${JSON.stringify({ data: { concept: "wall", text: bigText }, usage: { images: 1 } })}\n`,
      "utf8",
    );
    const logsBig = join(workDir, "logs-big");
    mkdirSync(logsBig, { recursive: true });
    const bigPort = BASE_PORT + 1;
    const bigBase = `http://127.0.0.1:${String(bigPort)}`;
    const big = startServer(bigPort, bigData, logsBig, {});
    try {
      check(
        "big-text server starts",
        await waitForHealth(big, bigBase),
        `no /api/health on ${String(bigPort)}`,
      );
      if (big.exitCode !== null) {
        process.exitCode = 1;
        return;
      }
      const bigJar = new Jar(bigBase);
      const body = { concept: "wall", image: tinyJpeg(7) };
      const first = await bigJar.post("room/segment", body, { live: true, ip: "10.9.2.1" });
      const second = await bigJar.post("room/segment", body, { live: true, ip: "10.9.2.1" });
      const firstText =
        isRecord(first.json) && isRecord(first.json["data"]) ? first.json["data"]["text"] : null;
      check(
        "a text over 512 KB is returned whole",
        first.status === 200 &&
          isRecord(first.json) &&
          first.json["status"] === "ok" &&
          typeof firstText === "string" &&
          firstText.length > 512 * 1024,
        `length=${typeof firstText === "string" ? String(firstText.length) : "?"}`,
      );
      check(
        "a text over 512 KB is not cached",
        second.status === 200 &&
          isRecord(second.json) &&
          second.json["status"] === "ok" &&
          second.json["source"] === "mock",
        JSON.stringify(second.json)?.slice(0, 120),
      );
      const bigSources = costsLines(logsBig).map((l) => l[4]);
      check(
        "its metering holds two mock lines and no cache line",
        bigSources.join(",") === "mock,mock",
        bigSources.join(","),
      );
    } finally {
      await stopServer(big);
    }
  }

  // 8. The 0.2 call weight against the session call cap.
  {
    // Its own data copy: cache files are shared per directory.
    const dataCalls = join(workDir, "data-calls");
    rmSync(dataCalls, { recursive: true, force: true });
    mkdirSync(dataCalls, { recursive: true });
    cpSync(join(serverDir, "data", "mock"), join(dataCalls, "mock"), { recursive: true });
    cpSync(join(serverDir, "data", "demo"), join(dataCalls, "demo"), { recursive: true });
    const logsCalls = join(workDir, "logs-calls");
    mkdirSync(logsCalls, { recursive: true });
    const callsPort = BASE_PORT + 2;
    const callsBase = `http://127.0.0.1:${String(callsPort)}`;
    const calls = startServer(callsPort, dataCalls, logsCalls, { META_SESSION_MAX_CALLS: "2" });
    try {
      check(
        "calls-cap server starts",
        await waitForHealth(calls, callsBase),
        `no /api/health on ${String(callsPort)}`,
      );
      if (calls.exitCode !== null) {
        process.exitCode = 1;
        return;
      }
      const jar = new Jar(callsBase);
      let okCount = 0;
      let capped = 0;
      for (let i = 0; i < 11; i += 1) {
        const res = await jar.post(
          "room/segment",
          { concept: "door", image: tinyJpeg(i) },
          { live: true, ip: "10.9.3.1" },
        );
        if (res.status === 200) okCount += 1;
        else if (res.status === 429) capped += 1;
      }
      check(
        "ten segments pass, the eleventh is capped (0.2 each)",
        okCount === 10 && capped === 1,
        `ok=${String(okCount)} capped=${String(capped)}`,
      );
      const mixed = new Jar(callsBase);
      let mixedOk = 0;
      for (let i = 0; i < 5; i += 1) {
        const res = await mixed.post(
          "room/segment",
          { concept: "window", image: tinyJpeg(100 + i) },
          { live: true, ip: "10.9.3.2" },
        );
        if (res.status === 200) mixedOk += 1;
      }
      const render = await mixed.post(
        "render",
        { prompt: "weight check render" },
        { live: true, ip: "10.9.3.2" },
      );
      if (render.status === 200) mixedOk += 1;
      const extra = await mixed.post(
        "room/segment",
        { concept: "door", image: tinyJpeg(200) },
        { live: true, ip: "10.9.3.2" },
      );
      check(
        "five segments plus one render make two calls",
        mixedOk === 6 &&
          extra.status === 429 &&
          isRecord(extra.json) &&
          extra.json["status"] === "capped",
        `mixedOk=${String(mixedOk)} extra=${String(extra.status)}`,
      );
    } finally {
      await stopServer(calls);
    }
  }

  // 9. Segment USD counts in full toward the session USD cap.
  {
    const dataUsd = join(workDir, "data-usd");
    rmSync(dataUsd, { recursive: true, force: true });
    mkdirSync(dataUsd, { recursive: true });
    cpSync(join(serverDir, "data", "mock"), join(dataUsd, "mock"), { recursive: true });
    cpSync(join(serverDir, "data", "demo"), join(dataUsd, "demo"), { recursive: true });
    const logsUsd = join(workDir, "logs-usd");
    mkdirSync(logsUsd, { recursive: true });
    const usdPort = BASE_PORT + 3;
    const usdBase = `http://127.0.0.1:${String(usdPort)}`;
    const usd = startServer(usdPort, dataUsd, logsUsd, { META_SESSION_MAX_USD: "0.01" });
    try {
      check(
        "usd-cap server starts",
        await waitForHealth(usd, usdBase),
        `no /api/health on ${String(usdPort)}`,
      );
      if (usd.exitCode !== null) {
        process.exitCode = 1;
        return;
      }
      const jar = new Jar(usdBase);
      let okCount = 0;
      for (let i = 0; i < 5; i += 1) {
        const res = await jar.post(
          "room/segment",
          { concept: "floor", image: tinyJpeg(50 + i) },
          { live: true, ip: "10.9.4.1" },
        );
        if (res.status === 200) okCount += 1;
        else {
          check(
            "four segments at USD 0.0025 trip the USD 0.01 cap",
            okCount === 4 &&
              res.status === 429 &&
              isRecord(res.json) &&
              res.json["status"] === "capped",
            `ok=${String(okCount)} status=${String(res.status)}`,
          );
          break;
        }
      }
      if (okCount === 5) {
        check("four segments at USD 0.0025 trip the USD 0.01 cap", false, "never capped");
      }
      const total = costsLines(logsUsd)
        .filter((l) => l[4] === "mock")
        .reduce((sum, l) => sum + Number(l[9]), 0);
      check("segment USD sums in full", Math.abs(total - 0.01) < 1e-9, `total=${String(total)}`);
    } finally {
      await stopServer(usd);
    }
  }

  // 10. The 0.2 weight against the per-IP rate limit.
  {
    const dataRate = join(workDir, "data-rate");
    rmSync(dataRate, { recursive: true, force: true });
    mkdirSync(dataRate, { recursive: true });
    cpSync(join(serverDir, "data", "mock"), join(dataRate, "mock"), { recursive: true });
    cpSync(join(serverDir, "data", "demo"), join(dataRate, "demo"), { recursive: true });
    const logsRate = join(workDir, "logs-rate");
    mkdirSync(logsRate, { recursive: true });
    const ratePort = BASE_PORT + 4;
    const rateBase = `http://127.0.0.1:${String(ratePort)}`;
    const rate = startServer(ratePort, dataRate, logsRate, { META_RATE_PER_MIN: "2" });
    try {
      check(
        "rate server starts",
        await waitForHealth(rate, rateBase),
        `no /api/health on ${String(ratePort)}`,
      );
      if (rate.exitCode !== null) {
        process.exitCode = 1;
        return;
      }
      const jar = new Jar(rateBase);
      let okCount = 0;
      let capped = 0;
      for (let i = 0; i < 11; i += 1) {
        const res = await jar.post(
          "room/segment",
          { concept: "door", image: tinyJpeg(150 + i) },
          { live: true, ip: "10.9.5.1" },
        );
        if (res.status === 200) okCount += 1;
        else if (res.status === 429) capped += 1;
      }
      check(
        "ten segments pass, the eleventh is rate-capped (0.2 each)",
        okCount === 10 && capped === 1,
        `ok=${String(okCount)} capped=${String(capped)}`,
      );
      const mixed = new Jar(rateBase);
      let mixedOk = 0;
      for (let i = 0; i < 5; i += 1) {
        const res = await mixed.post(
          "room/segment",
          { concept: "door", image: tinyJpeg(180 + i) },
          { live: true, ip: "10.9.5.2" },
        );
        if (res.status === 200) mixedOk += 1;
      }
      const render = await mixed.post(
        "render",
        { prompt: "weight check rate render" },
        { live: true, ip: "10.9.5.2" },
      );
      if (render.status === 200) mixedOk += 1;
      const extra = await mixed.post(
        "render",
        { prompt: "weight check rate render two" },
        { live: true, ip: "10.9.5.2" },
      );
      check(
        "five segments plus one render fill a rate limit of 2",
        mixedOk === 6 && extra.status === 429,
        `mixedOk=${String(mixedOk)} extra=${String(extra.status)}`,
      );
    } finally {
      await stopServer(rate);
    }
  }

  console.log(
    failures === 0
      ? "check:room-api: all checks passed"
      : `check:room-api: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`check:room-api: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
