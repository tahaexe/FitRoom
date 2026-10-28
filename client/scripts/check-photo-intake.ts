/**
 * `npm run check:photo-intake` — headless photo-intake check (no browser,
 * no Meta calls). The test images are built inside this check.
 *
 * - EXIF orientations 3, 6 and 8 come out upright (TIFFs with those
 *   orientations read with the real `exifr`, applied with the real
 *   `pixelsUpright` core of the canvas transform, against hardcoded
 *   upright grids — not the code under test);
 * - the focal length (35 mm equivalent) is read, and a missing tag falls
 *   back to undefined (the solver defaults);
 * - a 48-megapixel photo (8000 x 6000) is downscaled to 1280 and 640 px on
 *   the long side through the real `runDownscalePipeline`: no canvas
 *   bigger than 1280 px is ever made (the full image is never kept) and
 *   the source is closed before the URLs resolve;
 * - the photo store round-trips (in-memory fallback under Node).
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computePhotoPlan,
  pixelsUpright,
  processPhotoFile,
  readPhotoExif,
  runDownscalePipeline,
  type PhotoCanvas,
  type PhotoSource,
} from "../src/photo-room/intake.js";
import { clearPhoto, loadPhoto, savePhoto } from "../src/photo-room/photo-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const tmpDir = resolve(here, "..", "..", ".tmp", "photo-intake");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function same<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Minimal little-endian TIFF with an Orientation tag and, unless `focal`
 * is null, an Exif IFD holding FocalLengthIn35mmFilm.
 */
function tiffWithExif(orientation: number, focal: number | null): Uint8Array {
  const exifEntries = focal === null ? 0 : 1;
  const ifd0Count = focal === null ? 1 : 2;
  const ifd0Size = 2 + 12 * ifd0Count + 4;
  const exifOffset = 8 + ifd0Size;
  const total = exifOffset + (focal === null ? 0 : 2 + 12 * exifEntries + 4);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  let at = 8;
  view.setUint16(at, ifd0Count, true);
  at += 2;
  view.setUint16(at, 274, true);
  view.setUint16(at + 2, 3, true);
  view.setUint32(at + 4, 1, true);
  view.setUint16(at + 8, orientation, true);
  view.setUint16(at + 10, 0, true);
  at += 12;
  if (focal !== null) {
    view.setUint16(at, 34665, true);
    view.setUint16(at + 2, 4, true);
    view.setUint32(at + 4, 1, true);
    view.setUint32(at + 8, exifOffset, true);
    at += 12;
  }
  view.setUint32(at, 0, true);
  at += 4;
  if (focal !== null) {
    view.setUint16(at, exifEntries, true);
    at += 2;
    view.setUint16(at, 41989, true);
    view.setUint16(at + 2, 3, true);
    view.setUint32(at + 4, 1, true);
    view.setUint16(at + 8, focal, true);
    view.setUint16(at + 10, 0, true);
    at += 12;
    view.setUint32(at, 0, true);
  }
  return bytes;
}

const events: string[] = [];

class FakeSource implements PhotoSource {
  public image: CanvasImageSource;
  constructor(
    public width: number,
    public height: number,
  ) {
    const holder: unknown = { fakeSource: `${String(width)}x${String(height)}` };
    this.image = holder as CanvasImageSource;
  }
  close(): void {
    events.push("close");
  }
}

class FakeCanvas implements PhotoCanvas {
  public image: CanvasImageSource;
  constructor(
    public width: number,
    public height: number,
  ) {
    const holder: unknown = { fakeCanvas: `${String(width)}x${String(height)}` };
    this.image = holder as CanvasImageSource;
  }
  drawOriented(source: PhotoSource, orientation: number): void {
    events.push(`draw ${String(source.width)}x${String(source.height)} o${String(orientation)}`);
  }
  drawSmaller(source: PhotoCanvas): void {
    events.push(`small ${String(source.width)}x${String(source.height)}`);
  }
  async toDataUrl(): Promise<string> {
    events.push(`url ${String(this.width)}x${String(this.height)}`);
    return `data:image/jpeg;base64,fake-${String(this.width)}x${String(this.height)}`;
  }
}

async function main(): Promise<void> {
  mkdirSync(tmpDir, { recursive: true });

  // Stored 4 x 2 grid; every orientation below must reproduce its upright
  // form by hand (hardcoded expectations, not the code under test).
  const stored = [0, 1, 2, 3, 4, 5, 6, 7];
  const upright1 = [0, 1, 2, 3, 4, 5, 6, 7];
  const upright3 = [7, 6, 5, 4, 3, 2, 1, 0];
  const upright6 = [4, 0, 5, 1, 6, 2, 7, 3];
  const upright8 = [3, 7, 2, 6, 1, 5, 0, 4];

  for (const [orientation, expected] of [
    [1, upright1],
    [3, upright3],
    [6, upright6],
    [8, upright8],
  ] as Array<[number, number[]]>) {
    const tiff = tiffWithExif(orientation, 26);
    writeFileSync(join(tmpDir, `orient-${String(orientation)}.tif`), tiff);
    const exif = await readPhotoExif(tiff);
    check(
      `orientation ${String(orientation)} is read from EXIF`,
      exif.orientation === orientation,
      `got ${String(exif.orientation)}`,
    );
    check(
      `orientation ${String(orientation)} comes out upright`,
      same(pixelsUpright(stored, 4, 2, exif.orientation), expected),
      pixelsUpright(stored, 4, 2, exif.orientation).join(","),
    );
    check(
      `orientation ${String(orientation)} reads the 26 mm focal length`,
      exif.focal35mm === 26,
      `got ${String(exif.focal35mm)}`,
    );
  }

  const plain = tiffWithExif(1, null);
  writeFileSync(join(tmpDir, "no-focal.tif"), plain);
  const plainExif = await readPhotoExif(plain);
  check("a missing focal tag falls back to undefined", plainExif.focal35mm === undefined);

  // A 48-megapixel JPEG (8000 x 6000) through the real pipeline.
  const plan = computePhotoPlan(8000, 6000, 1);
  check(
    "a 48 MP photo plans 1280 px for segmentation",
    plan.segWidth === 1280 && plan.segHeight === 960,
    `${String(plan.segWidth)}x${String(plan.segHeight)}`,
  );
  check(
    "a 48 MP photo plans 640 px for labelling",
    plan.labelWidth === 640 && plan.labelHeight === 480,
    `${String(plan.labelWidth)}x${String(plan.labelHeight)}`,
  );
  const rotated = computePhotoPlan(8000, 6000, 6);
  check(
    "orientation 6 swaps the downscale axes",
    rotated.segWidth === 960 && rotated.segHeight === 1280,
    `${String(rotated.segWidth)}x${String(rotated.segHeight)}`,
  );
  const small = computePhotoPlan(400, 300, 1);
  check(
    "small photos are never upscaled",
    small.segWidth === 400 && small.segHeight === 300,
    `${String(small.segWidth)}x${String(small.segHeight)}`,
  );
  check(
    "a 48 MP photo keeps a 1920 px second-try frame",
    plan.hasLarge && plan.largeWidth === 1920 && plan.largeHeight === 1440,
    `${String(plan.largeWidth)}x${String(plan.largeHeight)} hasLarge=${String(plan.hasLarge)}`,
  );
  check(
    "a 1280 px photo keeps no second-try frame",
    computePhotoPlan(1280, 857, 1).hasLarge === false,
    "hasLarge",
  );
  check(
    "a 1920 px photo keeps a second-try frame",
    computePhotoPlan(1920, 1280, 1).hasLarge === true,
    "hasLarge",
  );

  let oversized = false;
  const made: string[] = [];
  const result = await runDownscalePipeline(new FakeSource(8000, 6000), 1, (w, h) => {
    made.push(`${String(w)}x${String(h)}`);
    if (Math.max(w, h) > 1920) oversized = true;
    return new FakeCanvas(w, h);
  });
  check(
    "only downscaled canvases are made",
    !oversized && same(made, ["1280x960", "1920x1440", "640x480"]),
    made.join(","),
  );
  check(
    "the full image is closed before the URLs resolve",
    same(events, [
      "draw 8000x6000 o1",
      "draw 8000x6000 o1",
      "close",
      "small 1280x960",
      "url 1280x960",
      "url 1920x1440",
      "url 640x480",
    ]),
    events.join(" | "),
  );
  check(
    "the pipeline keeps the 1280 px size",
    result.segWidth === 1280 && result.segHeight === 960,
    `${String(result.segWidth)}x${String(result.segHeight)}`,
  );
  check(
    "the pipeline keeps the 640 px size",
    result.labelWidth === 640 && result.labelHeight === 480,
    `${String(result.labelWidth)}x${String(result.labelHeight)}`,
  );
  check(
    "the pipeline keeps the 1920 px second-try frame",
    result.largeWidth === 1920 &&
      result.largeHeight === 1440 &&
      result.largeUrl === "data:image/jpeg;base64,fake-1920x1440",
    `${String(result.largeWidth)}x${String(result.largeHeight)}`,
  );

  const wiringFile = new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" });
  let closedWiring = 0;
  const fakeImageHolder: unknown = {
    width: 800,
    height: 600,
    close: () => {
      closedWiring += 1;
    },
  };
  const fakeImage = fakeImageHolder as ImageBitmap;
  let drawSawExactImage = false;
  const wiringResult = await processPhotoFile(wiringFile, {
    decode: () => Promise.resolve(fakeImage),
    makeCanvas: (w, h) => {
      const holder: unknown = { wiringCanvas: `${String(w)}x${String(h)}` };
      const canvas: PhotoCanvas = {
        width: w,
        height: h,
        image: holder as CanvasImageSource,
        drawOriented: (source) => {
          const expected: unknown = fakeImage;
          const actual: unknown = source.image;
          if (actual !== expected) throw new Error("drawOriented did not get the decoded image");
          drawSawExactImage = true;
        },
        drawSmaller: () => {},
        toDataUrl: () => Promise.resolve(`data:image/jpeg;base64,fake-${String(w)}x${String(h)}`),
      };
      return canvas;
    },
    timeoutMs: 5000,
  });
  check(
    "processPhotoFile draws exactly the decoded image",
    drawSawExactImage && wiringResult.segWidth > 0 && closedWiring >= 1,
    `draw=${String(drawSawExactImage)} closed=${String(closedWiring)}`,
  );

  let decoderErrorSeen = false;
  try {
    await processPhotoFile(wiringFile, {
      decode: () => Promise.reject(new Error("decode boom")),
      makeCanvas: (w, h) => new FakeCanvas(w, h),
      timeoutMs: 5000,
    });
  } catch (error) {
    decoderErrorSeen = error instanceof Error && error.message.includes("decode boom");
  }
  check("a decoder failure reaches the caller", decoderErrorSeen);

  let timedOut = false;
  try {
    await processPhotoFile(wiringFile, {
      decode: () => new Promise<never>(() => {}),
      makeCanvas: (w, h) => new FakeCanvas(w, h),
      timeoutMs: 50,
    });
  } catch (error) {
    timedOut = error instanceof Error && error.message.includes("timed out");
  }
  check("a hung decoder hits the time limit", timedOut);

  await savePhoto({
    wall: "A",
    savedAt: Date.now(),
    segUrl: "data:image/jpeg;base64,/9j/test",
    segWidth: 1280,
    segHeight: 960,
    labelUrl: "data:image/jpeg;base64,/9j/test",
    labelWidth: 640,
    labelHeight: 480,
    orientation: 1,
    focal35mm: 26,
  });
  const loaded = await loadPhoto("A");
  check(
    "the photo store round-trips wall A",
    loaded !== null && loaded.segWidth === 1280 && loaded.focal35mm === 26,
  );
  await clearPhoto("A");
  check("a retake clears the wall", (await loadPhoto("A")) === null);

  console.log(
    failures === 0
      ? "check:photo-intake: all checks passed"
      : `check:photo-intake: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
