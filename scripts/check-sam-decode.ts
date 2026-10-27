/**
 * `npm run check:sam-decode` — SAM text extraction plus client decode.
 *
 * For each recorded SAM 3.1 stream in `server/data/sam-streams/` it checks
 * that the server's text extraction (`extractSamOutputText`) followed by the
 * client's `segmentInstances` (`client/src/capture/sam.ts`) gives exactly
 * the instances `parseImageStream` gives from the raw events: count, ids,
 * boxes and rasters. It also checks that every raster is box-sized and
 * touches all four box edges, and that every box lies inside its image.
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL. No Meta
 * calls: the streams are committed fixtures.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMaskToRaster, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import { segmentInstances } from "../client/src/capture/sam.js";
import { extractSamOutputText } from "../server/src/meta/client.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const streamsDir = join(repoRoot, "server", "data", "sam-streams");

const STREAMS = [
  { file: "apartment-hotel-nice-1280-door.sse", concept: "door", instances: 1 },
  { file: "apartment-hotel-nice-1280-window.sse", concept: "window", instances: 2 },
  { file: "living-420x360-n-wall.sse", concept: "wall", instances: 3 },
] as const;

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

interface RawEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Reference events straight from the raw stream: every
 * `response.output_text.delta` in order, one `response.output_text.done`
 * lane, then `response.completed` — the same lane `sam.ts` is fed.
 */
async function* referenceEvents(raw: string): AsyncIterable<RawEvent> {
  for (const block of raw.split(/\r?\n\r?\n/)) {
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:"))
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
    if (event === "response.output_text.delta" || event === "response.output_text.done") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(dataLines.join("\n")) as unknown;
      } catch {
        continue;
      }
      if (typeof parsed === "object" && parsed !== null) {
        yield { ...(parsed as Record<string, unknown>), type: event };
      }
    }
  }
  yield { type: "response.completed" };
}

function rasterTouchesEdges(data: Uint8Array, width: number, height: number): boolean {
  const row = (y: number): boolean => {
    for (let x = 0; x < width; x += 1) {
      if ((data[y * width + x] ?? 0) !== 0) return true;
    }
    return false;
  };
  const col = (x: number): boolean => {
    for (let y = 0; y < height; y += 1) {
      if ((data[y * width + x] ?? 0) !== 0) return true;
    }
    return false;
  };
  return row(0) && row(height - 1) && col(0) && col(width - 1);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function main(): Promise<void> {
  for (const stream of STREAMS) {
    const raw = readFileSync(join(streamsDir, stream.file), "utf8");
    const text = extractSamOutputText(raw);
    check(`${stream.file}: server extraction is non-empty`, text.length > 0);

    const reference = await parseImageStream(referenceEvents(raw)).finalResult;
    check(
      `${stream.file}: reference stream completes`,
      reference.outcome.status === "completed",
      JSON.stringify(reference.outcome),
    );
    check(
      `${stream.file}: extraction equals the parsed lane`,
      reference.rawOutput === text,
      `${String(reference.rawOutput.length)} vs ${String(text.length)}`,
    );
    check(
      `${stream.file}: reference has no error diagnostics`,
      reference.diagnostics.every((d) => d.severity !== "error"),
      JSON.stringify(reference.diagnostics.slice(0, 2)),
    );

    // Reference instances from the raw events, paired by object id.
    const boxes = recordsOfKind(reference.records, "box");
    const masks = recordsOfKind(reference.records, "mask");
    const boxById = new Map(boxes.map((box) => [box.objectId, box]));
    const expected = masks.map((mask) => {
      const box = boxById.get(mask.objectId);
      if (box === undefined) throw new Error(`mask without box in ${stream.file}`);
      return {
        id: mask.objectId,
        box: [box.left, box.top, box.right - 1, box.bottom - 1] as [number, number, number, number],
        raster: decodeMaskToRaster(mask.mask),
        maskWidth: mask.mask.width,
        maskHeight: mask.mask.height,
      };
    });

    const instances = await segmentInstances(stream.concept, text);
    check(
      `${stream.file}: instance count matches (${String(stream.instances)})`,
      instances.length === stream.instances && instances.length === expected.length,
      `sam=${String(instances.length)} ref=${String(expected.length)}`,
    );
    const count = Math.min(instances.length, expected.length);
    for (let i = 0; i < count; i += 1) {
      const got = instances[i];
      const want = expected[i];
      if (got === undefined || want === undefined) continue;
      const [x1, y1, x2, y2] = got.box;
      check(
        `${stream.file}: instance ${String(i)} id matches (${want.id})`,
        got.id === want.id && got.concept === stream.concept,
        `got=${got.id}`,
      );
      check(
        `${stream.file}: instance ${String(i)} box matches`,
        got.box[0] === want.box[0] &&
          got.box[1] === want.box[1] &&
          got.box[2] === want.box[2] &&
          got.box[3] === want.box[3],
        `got=[${got.box.join(",")}] want=[${want.box.join(",")}]`,
      );
      check(
        `${stream.file}: instance ${String(i)} raster matches`,
        got.mask.width === want.maskWidth &&
          got.mask.height === want.maskHeight &&
          equalBytes(got.mask.data, want.raster),
        `${String(got.mask.width)}x${String(got.mask.height)}`,
      );
      check(
        `${stream.file}: instance ${String(i)} raster is box-sized`,
        got.mask.width === x2 - x1 + 1 && got.mask.height === y2 - y1 + 1,
        `${String(got.mask.width)}x${String(got.mask.height)} box=[${got.box.join(",")}]`,
      );
      check(
        `${stream.file}: instance ${String(i)} raster touches all four box edges`,
        rasterTouchesEdges(got.mask.data, got.mask.width, got.mask.height),
      );
      check(
        `${stream.file}: instance ${String(i)} box lies inside its image`,
        x1 >= 0 && y1 >= 0 && x2 < got.imageWidth && y2 < got.imageHeight,
        `box=[${got.box.join(",")}] image=${String(got.imageWidth)}x${String(got.imageHeight)}`,
      );
    }
  }

  console.log(
    failures === 0
      ? "check:sam-decode: all checks passed"
      : `check:sam-decode: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`check:sam-decode: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
