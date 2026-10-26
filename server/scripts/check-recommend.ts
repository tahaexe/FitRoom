/**
 * `npm run check:recommend` — headless recommend check for the demo room.
 *
 * For the demo room and the four demo requests (sofas, coffee tables,
 * shelves, "What fits here?") it builds each request with the shared code,
 * answers it from the demo store through the gateway pipeline in demo mode,
 * places every recommended item at its spot and runs the fit engine
 * (0 errors expected), and checks that every "N cm" in a reason equals a
 * number in the request within 1 cm. Prints PASS or FAIL per item and exits
 * non-zero on any FAIL. Demo mode only: no live Meta calls.
 */

/* global console, process */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkFit,
  isRecommendAnswer,
  type CatalogItem,
  type FitProducts,
  type RecommendRequest,
  type RoomLayout,
  type SceneState,
} from "@fitroom/shared";
import { META_MODELS } from "../src/config.js";
import { DEMO_REQUESTS } from "../src/demo-requests.js";
import { gatewayKey } from "../src/meta/keys.js";
import { buildRecommendDemoRequests } from "../src/recommend-demo.js";

const PORT = 8789;
const BASE = `http://127.0.0.1:${String(PORT)}`;

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..");
const repoRoot = resolve(serverDir, "..");
const workDir = join(repoRoot, ".tmp", "check-recommend");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectNumbers(value: unknown, out: number[]): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectNumbers(entry, out);
    return;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) collectNumbers(value[key], out);
  }
}

function cmFigures(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*cm/gi)) {
    const figure = Number(match[1]);
    if (Number.isFinite(figure)) out.push(figure);
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

  const room = JSON.parse(
    readFileSync(join(repoRoot, "shared", "samples", "living-420x360.json"), "utf8"),
  ) as RoomLayout;
  const scene = JSON.parse(
    readFileSync(join(repoRoot, "shared", "samples", "fit-tests", "valid.json"), "utf8"),
  ) as SceneState;
  const catalog = JSON.parse(
    readFileSync(join(repoRoot, "shared", "catalog", "catalog.json"), "utf8"),
  ) as CatalogItem[];
  const products: FitProducts = new Map(
    catalog.map((c) => [c.id, { size: c.size, category: c.category }]),
  );

  // The recorded list matches what the shared code builds today.
  const rebuilt = buildRecommendDemoRequests();
  const listed = DEMO_REQUESTS["recommend"];
  check("demo list holds the four recommend requests", listed.length === 4);
  const keysMatch =
    listed.length === rebuilt.length &&
    listed.every((entry, index) => {
      const want = rebuilt[index] as RecommendRequest | undefined;
      if (want === undefined) return false;
      return (
        gatewayKey("recommend", META_MODELS.spark, entry) ===
        gatewayKey("recommend", META_MODELS.spark, want)
      );
    });
  check("demo list matches the shared-code requests", keysMatch);
  if (!keysMatch) {
    process.exitCode = 1;
    return;
  }

  const baseErrors = checkFit(room, scene, products).filter((i) => i.severity === "error");
  check("demo room scene has no fit errors", baseErrors.length === 0);

  // Isolated data (a copy of the committed store) + logs.
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  cpSync(join(serverDir, "data"), dataDir, { recursive: true });

  const child = spawn("node", [builtServer], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      META_MOCK: "",
      META_RECORD: "",
      META_API_KEY: "",
      FITROOM_DATA_DIR: dataDir,
      FITROOM_LOGS_DIR: logsDir,
    },
    stdio: "ignore",
  });
  try {
    check("demo server starts", await waitForHealth(child), "no /api/health on 8789");
    if (child.exitCode !== null) {
      process.exitCode = 1;
      return;
    }

    for (let i = 0; i < rebuilt.length; i += 1) {
      const request = rebuilt[i] as RecommendRequest;
      const tag = JSON.stringify(request.request);
      let payload: unknown = null;
      let status = 0;
      try {
        const res = await fetch(`${BASE}/api/recommend`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(15_000),
        });
        status = res.status;
        payload = (await res.json()) as unknown;
      } catch {
        // Falls through to the FAIL below.
      }
      const ok =
        status === 200 &&
        isRecord(payload) &&
        payload["status"] === "ok" &&
        payload["source"] === "demo";
      check(`demo answers request ${String(i)} ${tag} from the store`, ok);
      if (!ok) continue;
      const data = (payload as Record<string, unknown>)["data"];
      check(`answer ${String(i)} matches the schema`, isRecommendAnswer(data));
      if (!isRecommendAnswer(data)) continue;
      check(
        `answer ${String(i)} ranks at most 3`,
        data.recommendations.length <= 3,
        String(data.recommendations.length),
      );
      const numbers: number[] = [];
      collectNumbers(request, numbers);
      for (const rec of data.recommendations) {
        const candidate = request.candidates.find((c) => c.productId === rec.productId);
        check(
          `answer ${String(i)} ranks a known candidate ${rec.productId}`,
          candidate !== undefined,
        );
        if (candidate === undefined) continue;
        const [x, z] = candidate.spot.centre_cm;
        const probe: SceneState = {
          ...scene,
          items: [
            ...scene.items,
            {
              instanceId: `check-${rec.productId}`,
              productId: rec.productId,
              position: { x, z },
              rotationY: candidate.spot.rotationY,
              variant: "default",
            },
          ],
        };
        const errors = checkFit(room, probe, products).filter((iss) => iss.severity === "error");
        check(
          `${rec.productId} placed at its spot fits`,
          errors.length === 0,
          errors.map((e) => e.type).join(","),
        );
        let cites = true;
        let detail: string | undefined;
        for (const figure of cmFigures(rec.reason)) {
          const near = numbers.some((n) => Math.abs(n - figure) <= 1 + 1e-9);
          if (!near) {
            cites = false;
            detail = `${String(figure)} cm is not in the request within 1 cm`;
            break;
          }
        }
        check(`${rec.productId} reason cites request numbers`, cites, detail);
      }
    }

    const costsFile = join(logsDir, "costs.csv");
    const lines = existsSync(costsFile)
      ? readFileSync(costsFile, "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .slice(1)
      : [];
    const upstream = lines.filter((line) => line.split(",")[4] === "upstream").length;
    check("demo mode makes zero upstream calls", upstream === 0, `upstream=${String(upstream)}`);
  } finally {
    await stopServer(child);
  }

  console.log(
    failures === 0
      ? "check:recommend: all checks passed"
      : `check:recommend: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`check:recommend: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
