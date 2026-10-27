/**
 * `npm run check:render` — headless render check for the demo room plus two
 * other fit-test scenes.
 *
 * For each scene it builds the shared prompt (every product named with its
 * variant; the room size present) and the key input twice from the same
 * scene (equal) and once after moving one item by 5 cm (different); then it
 * sends one request through the gateway pipeline in mock mode and checks
 * the returned image decodes as WebP. Prints PASS or FAIL per check and
 * exits non-zero on any FAIL. Mock mode only: no live Meta calls.
 */

/* global console, process */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRenderKeyInput,
  buildRenderPrompt,
  type CatalogItem,
  type RoomLayout,
  type SceneState,
} from "@fitroom/shared";
import { META_MODELS } from "../src/config.js";
import { gatewayKey } from "../src/meta/keys.js";

const PORT = 8790;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const SCENES = ["valid", "overlap", "outside"] as const;

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..");
const repoRoot = resolve(serverDir, "..");
const workDir = join(repoRoot, ".tmp", "check-render");
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

/** Minimal WebP probe: RIFF/WEBP header plus VP8/VP8L/VP8X dimensions. */
function webpDims(base64: string): { width: number; height: number } | null {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(base64, "base64"));
  } catch {
    return null;
  }
  if (bytes.length < 30) return null;
  const ascii = (at: number, len: number): string => {
    let out = "";
    for (let i = 0; i < len; i += 1) out += String.fromCharCode(bytes[at + i] ?? 0);
    return out;
  };
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
  const u16 = (at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
  const u24 = (at: number): number =>
    (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
  const chunk = ascii(12, 4);
  if (chunk === "VP8 ") {
    const w = u16(26) & 0x3fff;
    const h = u16(28) & 0x3fff;
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  if (chunk === "VP8L") {
    if ((bytes[21] ?? 0) !== 0x2f) return null;
    const bits = (bytes[22] ?? 0) | ((bytes[23] ?? 0) << 8) | ((bytes[24] ?? 0) << 16);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: u24(24) + 1, height: u24(27) + 1 };
  }
  return null;
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
  const catalog = JSON.parse(
    readFileSync(join(repoRoot, "shared", "catalog", "catalog.json"), "utf8"),
  ) as CatalogItem[];
  const byId = new Map(catalog.map((c) => [c.id, c]));

  for (const name of SCENES) {
    const scene = JSON.parse(
      readFileSync(join(repoRoot, "shared", "samples", "fit-tests", `${name}.json`), "utf8"),
    ) as SceneState;
    const prompt = buildRenderPrompt(scene, room, catalog);
    check(`${name}: prompt is non-empty`, prompt.length > 0);
    check(`${name}: prompt names the room size`, prompt.includes("420") && prompt.includes("360"));
    check(`${name}: prompt asks for photoreal`, /photoreal/i.test(prompt), prompt.slice(0, 80));
    check(
      `${name}: prompt keeps camera, room, products and places`,
      /keep/i.test(prompt) && /placement|place/i.test(prompt),
    );
    let allNamed = true;
    for (const item of scene.items) {
      const entry = byId.get(item.productId);
      const label = entry?.name ?? item.productId;
      if (!prompt.includes(label)) {
        allNamed = false;
        break;
      }
    }
    check(
      `${name}: prompt names every product (${String(scene.items.length)} items)`,
      allNamed,
      `items=${scene.items.map((i) => i.productId).join(",")}`,
    );
    let allVariants = true;
    for (const item of scene.items) {
      const variant = item.variant === "" ? "default" : item.variant;
      if (!prompt.toLowerCase().includes(variant.toLowerCase())) {
        allVariants = false;
        break;
      }
    }
    check(`${name}: prompt names every variant`, allVariants);
    check(
      `${name}: prompt names floor and wall materials`,
      prompt.includes(room.surfaces.floor) && prompt.includes(room.surfaces.wall),
    );
    check(
      `${name}: prompt names every opening with kind and place`,
      room.openings.every(
        (o) =>
          prompt.includes(o.id) &&
          prompt.includes(o.type === "door" ? "closed solid door" : "window"),
      ) &&
        prompt.includes("Door wall") &&
        prompt.includes("Back wall (window)") &&
        prompt.includes("Right wall (window)") &&
        prompt.includes("Left wall"),
      prompt.slice(0, 200),
    );
    check(
      `${name}: prompt keeps the door a closed solid door`,
      prompt.includes("the door stays a closed solid door where it is") &&
        prompt.includes("do not turn the door into a window or a glass door"),
    );
    check(
      `${name}: prompt allows windows only where the room has them`,
      prompt.includes("windows only where the room has them") &&
        prompt.includes("do not add windows or doors"),
    );

    const keyA = gatewayKey(
      "render",
      META_MODELS.image,
      buildRenderKeyInput(scene, prompt, "dollhouse"),
    );
    const keyB = gatewayKey(
      "render",
      META_MODELS.image,
      buildRenderKeyInput(scene, prompt, "dollhouse"),
    );
    check(`${name}: same scene gives the same key input`, keyA === keyB);
    const moved: SceneState = JSON.parse(JSON.stringify(scene)) as SceneState;
    const first = moved.items[0];
    if (first !== undefined) first.position = { x: first.position.x + 5, z: first.position.z };
    const keyC = gatewayKey(
      "render",
      META_MODELS.image,
      buildRenderKeyInput(moved, prompt, "dollhouse"),
    );
    check(`${name}: moving one item by 5 cm changes the key`, keyC !== keyA);
    const keyJson = JSON.stringify(buildRenderKeyInput(scene, prompt, "dollhouse"));
    check(`${name}: key input holds no image bytes`, !/base64|data:image/i.test(keyJson));
  }

  // One request through the gateway pipeline in mock mode.
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  cpSync(join(serverDir, "data", "mock"), join(dataDir, "mock"), { recursive: true });
  cpSync(join(serverDir, "data", "demo"), join(dataDir, "demo"), { recursive: true });

  const child = spawn("node", [builtServer], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      META_MOCK: "1",
      META_RECORD: "",
      META_API_KEY: "",
      FITROOM_DATA_DIR: dataDir,
      FITROOM_LOGS_DIR: logsDir,
    },
    stdio: "ignore",
  });
  try {
    check("mock server starts", await waitForHealth(child), "no /api/health on 8790");
    if (child.exitCode !== null) {
      process.exitCode = 1;
      return;
    }
    const scene = JSON.parse(
      readFileSync(join(repoRoot, "shared", "samples", "fit-tests", "valid.json"), "utf8"),
    ) as SceneState;
    const prompt = buildRenderPrompt(scene, room, catalog);
    const capture = Buffer.alloc(64, 7).toString("base64");
    let payload: unknown = null;
    let status = 0;
    try {
      const res = await fetch(`${BASE}/api/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-fitroom-live": "1" },
        body: JSON.stringify({ prompt, scene, referenceImage: capture, cameraPreset: "dollhouse" }),
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
      payload = (await res.json()) as unknown;
    } catch {
      // Falls through to the FAIL below.
    }
    const ok =
      status === 200 && isRecord(payload) && payload["status"] === "ok" && "data" in payload;
    check("mock pipeline answers the render request", ok, JSON.stringify(payload)?.slice(0, 200));
    if (ok && isRecord(payload)) {
      const data = payload["data"];
      const record = isRecord(data) ? data : {};
      const imageBase64 = typeof record["imageBase64"] === "string" ? record["imageBase64"] : null;
      const dims = imageBase64 === null ? null : webpDims(imageBase64);
      check("mock image decodes as WebP", dims !== null);
      if (dims !== null) {
        check(
          "mock image size matches its WebP header",
          record["width"] === dims.width && record["height"] === dims.height,
          `reported=${String(record["width"])}x${String(record["height"])} header=${String(dims.width)}x${String(dims.height)}`,
        );
      }
    }
  } finally {
    await stopServer(child);
  }

  console.log(
    failures === 0
      ? "check:render: all checks passed"
      : `check:render: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`check:render: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
