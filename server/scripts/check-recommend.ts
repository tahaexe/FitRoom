/**
 * `npm run check:recommend` — headless recommend check for the demo room.
 *
 * For the demo room and every demo request (coffee tables in front of the
 * sofa, shelves, "What fits here?" on every free run the demo room lists,
 * "Find a replacement" for the Chester Leather Sofa) it builds each request
 * with the shared code, answers it from the demo store through the gateway
 * pipeline in demo mode, places every recommended item at its spot and runs
 * the fit engine (0 errors expected; seat accessories and the replacement
 * leave the same instances out of the check as the builder), and checks
 * that every "N cm" in a reason equals a number in the request within 1 cm
 * and that no reason mentions a `wall-` id. It also checks the nothing-fits
 * path for the demo room: a sofa request has no candidates, so the panel
 * answers locally with sizes (longest free wall run and depth, smallest sofa
 * footprint, the 45 cm a seat needs in front) plus the "Replace the Chester
 * Leather Sofa" offer — with no model call.
 * Prints PASS or FAIL per item and exits non-zero on any FAIL. Demo mode
 * only: no live Meta calls.
 */

/* global console, process */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeFreeSpace,
  buildRecommendRequest,
  checkFit,
  isRecommendAnswer,
  longestRun,
  nothingFitsMessage,
  recommendIgnoreIds,
  replacementOfferFor,
  smallestOfCategory,
  vacatedSlot,
  wallDisplayName,
  type CandidateQuery,
  type CatalogItem,
  type FitProducts,
  type RecommendRequest,
  type RoomLayout,
  type SceneState,
} from "@fitroom/shared";
import { META_MODELS } from "../src/config.js";
import { DEMO_REQUESTS } from "../src/demo-requests.js";
import { gatewayKey } from "../src/meta/keys.js";
import {
  buildExampleRecommendDemoRequests,
  buildRecommendDemoRequests,
} from "../src/recommend-demo.js";
import { emptyExampleScene, readExampleRoom } from "../src/assistant-demo.js";

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

function queryFromRequest(request: RecommendRequest): CandidateQuery {
  const wire = request.request;
  const query: CandidateQuery = { category: wire.category };
  if (wire.budget_usd !== undefined) query.budget_usd = wire.budget_usd;
  return query;
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
    catalog.map((c) => [c.id, { size: c.size, category: c.category, name: c.name }]),
  );

  // The recorded list matches what the shared code builds today.
  const rebuilt = buildRecommendDemoRequests();
  const exampleRebuilt = buildExampleRecommendDemoRequests();
  const listed = DEMO_REQUESTS["recommend"];
  check(
    "demo list holds every recommend request",
    listed.length === rebuilt.length + exampleRebuilt.length,
  );
  const spotWalls = rebuilt
    .map((r) => (r as RecommendRequest).request.spot?.wall)
    .filter((w): w is string => typeof w === "string");
  for (const wall of ["Door wall", "Back wall (window)", "Right wall (window)", "Left wall"]) {
    check(`demo list covers ${wall}`, spotWalls.includes(wall), spotWalls.join(" | "));
  }
  const keysMatch =
    listed.length === rebuilt.length + exampleRebuilt.length &&
    listed.every((entry, index) => {
      const want =
        index < rebuilt.length
          ? (rebuilt[index] as RecommendRequest | undefined)
          : (exampleRebuilt[index - rebuilt.length] as RecommendRequest | undefined);
      if (want === undefined) return false;
      return (
        gatewayKey("recommend", META_MODELS.spark, entry) ===
        gatewayKey("recommend", META_MODELS.spark, want)
      );
    });
  check("demo list matches the shared-code requests", keysMatch);
  check("example room records its four recommend requests", exampleRebuilt.length === 4);
  if (!keysMatch) {
    process.exitCode = 1;
    return;
  }

  // The replacement demo request names Chester and keeps a same-spot candidate.
  const replacement = rebuilt.find((r) => r.request.replace !== undefined);
  check("demo list holds the Chester replacement request", replacement !== undefined);
  check(
    "replacement request targets the Chester Leather Sofa",
    replacement?.request.replace?.productId === "sofa_02",
  );
  check(
    "replacement request keeps at least one fitting sofa",
    (replacement?.candidates.length ?? 0) >= 1,
    `candidates=${String(replacement?.candidates.length ?? 0)}`,
  );
  if (replacement !== undefined) {
    const oldEntry = catalog.find((c) => c.id === replacement.request.replace?.productId);
    const chester = scene.items.find((i) => i.productId === "sofa_02");
    const slot =
      oldEntry === undefined || chester === undefined
        ? null
        : vacatedSlot(room, oldEntry, {
            position: { ...chester.position },
            rotationY: chester.rotationY,
          });
    check("replacement vacated slot resolves", slot !== null);
    if (slot !== null && oldEntry !== undefined) {
      const wantWall = wallDisplayName(room, slot.wallId);
      const seenWalls = new Set(
        replacement.candidates.map((c) => (c.spot.kind === "run" ? String(c.spot.wall) : "")),
      );
      check(
        "replacement candidates anchor to the old wall",
        replacement.candidates.length > 0 &&
          replacement.candidates.every((c) => c.spot.kind === "run" && c.spot.wall === wantWall),
        [...seenWalls].join(" | "),
      );
      check(
        "replacement never suggests the slot's current product",
        replacement.candidates.every((c) => c.productId !== oldEntry.id),
        replacement.candidates.map((c) => c.productId).join(","),
      );
      let slotOk = true;
      let spareOk = true;
      let backOk = true;
      const wall = room.walls.find((w) => w.id === slot.wallId);
      for (const c of replacement.candidates) {
        if (c.spot.kind !== "run") {
          slotOk = false;
          continue;
        }
        if (
          Math.abs(c.spot.run_cm[0] - slot.start_cm) > 0.06 ||
          Math.abs(c.spot.run_cm[1] - slot.end_cm) > 0.06 ||
          Math.abs(c.spot.runLength_cm - slot.length_cm) > 0.06
        ) {
          slotOk = false;
        }
        // Same orientation as the old piece, so the along-wall extent is
        // the catalog width; spare is the vacated slot minus that width.
        const wantSpare = Math.round((slot.length_cm - c.size_cm[0]) * 10) / 10;
        if (Math.abs(c.spot.spare_cm - wantSpare) > 0.06) spareOk = false;
      }
      check(
        "replacement spots report the vacated slot",
        slotOk,
        JSON.stringify(replacement.candidates.map((c) => c.spot)),
      );
      check(
        "replacement spare equals slot length minus candidate width",
        spareOk,
        JSON.stringify(
          replacement.candidates.map((c) => ({
            id: c.productId,
            spare: c.spot.kind === "run" ? c.spot.spare_cm : null,
            size: c.size_cm,
          })),
        ),
      );
      // Back-edge anchor: every candidate centre sits one across-extent
      // inward from the old back edge on the old wall.
      if (wall !== undefined) {
        const centroid = {
          x:
            room.walls.reduce((x, w) => x + w.start.x + w.end.x, 0) /
            Math.max(1, room.walls.length * 2),
          z:
            room.walls.reduce((z, w) => z + w.start.z + w.end.z, 0) /
            Math.max(1, room.walls.length * 2),
        };
        const mid = {
          x: (wall.start.x + wall.end.x) / 2,
          z: (wall.start.z + wall.end.z) / 2,
        };
        let ox = mid.x - centroid.x;
        let oz = mid.z - centroid.z;
        const olen = Math.hypot(ox, oz) || 1;
        ox /= olen;
        oz /= olen;
        const inx = -ox;
        const inz = -oz;
        for (const c of replacement.candidates) {
          if (c.spot.kind !== "run") {
            backOk = false;
            continue;
          }
          const [px, pz] = c.spot.centre_cm;
          const inward = (px - wall.start.x) * inx + (pz - wall.start.z) * inz;
          const rad = (c.spot.rotationY * Math.PI) / 180;
          const cos = Math.abs(Math.cos(rad)) < 1e-9 ? 0 : Math.cos(rad);
          const sin = Math.abs(Math.sin(rad)) < 1e-9 ? 0 : Math.sin(rad);
          const hx = (c.size_cm[0] / 2) * Math.abs(cos) + (c.size_cm[1] / 2) * Math.abs(sin);
          const hz = (c.size_cm[0] / 2) * Math.abs(sin) + (c.size_cm[1] / 2) * Math.abs(cos);
          const across = hx * Math.abs(inx) + hz * Math.abs(inz);
          if (Math.abs(inward - across - slot.backEdge_cm) > 0.15) backOk = false;
        }
        check("replacement spots anchor to the old back edge", backOk);
      }
    }
  }

  // Nothing fits: a sofa request for the demo room has no candidates, so the
  // panel answers locally with sizes plus the replacement offer — no model
  // call. The check builds the same message and offer the panel shows.
  const sofaQuery: CandidateQuery = { category: "sofa" };
  const sofaCandidates = buildRecommendRequest(
    room,
    scene,
    catalog,
    sofaQuery,
    (productId, position, rotationY) => {
      const ignore = new Set(recommendIgnoreIds(scene, catalog, sofaQuery));
      const items = scene.items.filter((i) => !ignore.has(i.instanceId));
      const probe: SceneState = {
        ...scene,
        items: [
          ...items,
          {
            instanceId: "check-probe",
            productId,
            position,
            rotationY,
            variant: "default",
          },
        ],
      };
      return checkFit(room, probe, products).filter((i) => i.severity === "error").length === 0;
    },
  );
  check("demo room sofa request has no candidates", sofaCandidates.candidates.length === 0);
  check(
    "demo room sofa request needs no model call",
    sofaCandidates.candidates.length === 0,
    "the panel answers locally when candidates is empty",
  );
  const free = analyzeFreeSpace(room, scene, new Map(catalog.map((c) => [c.id, c])));
  const message = nothingFitsMessage("sofa", room, free, catalog);
  const run = longestRun(free);
  const smallest = smallestOfCategory(catalog, "sofa");
  check(
    "nothing-fits message names the longest free wall run and depth",
    run !== null &&
      message.includes(String(Math.round(run.length_cm))) &&
      message.includes(String(Math.round(run.depth_cm))),
  );
  check(
    "nothing-fits message names the smallest sofa footprint",
    smallest !== null &&
      message.includes(smallest.name) &&
      message.includes(String(Math.round(smallest.size.w))) &&
      message.includes(String(Math.round(smallest.size.d))),
  );
  check("nothing-fits message names the 45 cm a seat needs", message.includes("45 cm"));
  check("nothing-fits message hides wall ids", !message.includes("wall-"));
  const offer = replacementOfferFor("sofa", scene, catalog);
  check(
    "nothing-fits sofa request offers Replace the Chester Leather Sofa",
    offer?.name === "Chester Leather Sofa",
    offer === null ? "no offer" : `Replace the ${offer.name}`,
  );

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
      if (request.request.replace !== undefined) {
        check(
          `replacement answer ${String(i)} ranks at least one sofa`,
          data.recommendations.length >= 1,
        );
      }
      const numbers: number[] = [];
      collectNumbers(request, numbers);
      const query = queryFromRequest(request);
      const wireReplace = request.request.replace;
      const ignore = new Set(
        recommendIgnoreIds(
          scene,
          catalog,
          wireReplace === undefined
            ? query
            : { category: query.category, replace: { productId: wireReplace.productId } },
        ),
      );
      const items = scene.items.filter((item) => !ignore.has(item.instanceId));
      for (const rec of data.recommendations) {
        const candidate = request.candidates.find((c) => c.productId === rec.productId);
        check(
          `answer ${String(i)} ranks a known candidate ${rec.productId}`,
          candidate !== undefined,
        );
        if (candidate === undefined) continue;
        check(
          `answer ${String(i)} reason hides wall ids`,
          !rec.reason.includes("wall-"),
          rec.reason.slice(0, 80),
        );
        const [x, z] = candidate.spot.centre_cm;
        const probe: SceneState = {
          ...scene,
          items: [
            ...items,
            {
              instanceId: `check-${rec.productId}`,
              productId: rec.productId,
              position: { x: x ?? 0, z: z ?? 0 },
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

    // The example room, built exactly as the client builds it after "Try
    // the example room" (photo-solved with tape A 420 and wall B estimated,
    // the `shared/samples/example-room.json` fixture, empty start scene):
    // every Recommend request key equals its recorded file's key and answers
    // from the store with zero upstream calls.
    const exampleRoom = readExampleRoom();
    const exampleScene = emptyExampleScene();
    check(
      "example room tapes wall A at 420 with wall B estimated",
      exampleRoom.id === "photos-room" &&
        Math.hypot(
          (exampleRoom.walls[0]?.end.x ?? 0) - (exampleRoom.walls[0]?.start.x ?? 0),
          (exampleRoom.walls[0]?.end.z ?? 0) - (exampleRoom.walls[0]?.start.z ?? 0),
        ) === 420 &&
        Math.hypot(
          (exampleRoom.walls[1]?.end.x ?? 0) - (exampleRoom.walls[1]?.start.x ?? 0),
          (exampleRoom.walls[1]?.end.z ?? 0) - (exampleRoom.walls[1]?.start.z ?? 0),
        ) === 362,
    );
    const exampleProducts: FitProducts = new Map(
      catalog.map((c) => [c.id, { size: c.size, category: c.category, name: c.name }]),
    );
    for (let i = 0; i < exampleRebuilt.length; i += 1) {
      const request = exampleRebuilt[i] as RecommendRequest;
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
      check(`example demo answers request ${String(i)} ${tag} from the store`, ok);
      if (!ok) continue;
      const data = (payload as Record<string, unknown>)["data"];
      check(`example answer ${String(i)} matches the schema`, isRecommendAnswer(data));
      if (!isRecommendAnswer(data)) continue;
      check(
        `example answer ${String(i)} ranks at most 3`,
        data.recommendations.length <= 3,
        String(data.recommendations.length),
      );
      const numbers: number[] = [];
      collectNumbers(request, numbers);
      for (const rec of data.recommendations) {
        const candidate = request.candidates.find((c) => c.productId === rec.productId);
        check(
          `example answer ${String(i)} ranks a known candidate ${rec.productId}`,
          candidate !== undefined,
        );
        if (candidate === undefined) continue;
        check(
          `example answer ${String(i)} reason hides wall ids`,
          !rec.reason.includes("wall-"),
          rec.reason.slice(0, 80),
        );
        const [x, z] = candidate.spot.centre_cm;
        const probe: SceneState = {
          ...exampleScene,
          items: [
            {
              instanceId: `check-${rec.productId}`,
              productId: rec.productId,
              position: { x: x ?? 0, z: z ?? 0 },
              rotationY: candidate.spot.rotationY,
              variant: "default",
            },
          ],
        };
        const errors = checkFit(exampleRoom, probe, exampleProducts).filter(
          (iss) => iss.severity === "error",
        );
        check(
          `example ${rec.productId} placed at its spot fits`,
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
        check(`example ${rec.productId} reason cites request numbers`, cites, detail);
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
