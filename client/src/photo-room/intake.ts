/**
 * Photo intake: EXIF orientation + focal length first, then downscale.
 *
 * One photo at a time: the focal length (35 mm equivalent) and the
 * orientation are read from EXIF with `exifr` before any resize, the
 * orientation is applied, and the photo is downscaled to 1280 px on the
 * long side for segmentation and 640 px for labelling. The full-size
 * image is released at once (the source is closed right after the single
 * downscale draw, so only downscaled pixels are ever kept).
 *
 * The orchestration (`runDownscalePipeline`) works on injected
 * source/canvas factories so `check:photo-intake` exercises the real order
 * of operations headlessly; the browser adapters below wrap
 * `ImageBitmap` and `HTMLCanvasElement`.
 */

import * as exifrNs from "exifr";

export const SEG_LONG_SIDE = 1280;
export const LABEL_LONG_SIDE = 640;

type ExifrParse = (
  data: ArrayBuffer | Uint8Array | Blob,
  options?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * `exifr` ships an ESM bundle (named `parse`, used by the Vite build)
 * and a UMD bundle (default export, used by Node): accept both shapes.
 */
function exifrParseFn(): ExifrParse {
  const holder: unknown = exifrNs;
  const ns = holder as Record<string, unknown>;
  const direct = ns["parse"];
  if (typeof direct === "function") return direct as ExifrParse;
  const def = ns["default"];
  if (typeof def === "object" && def !== null) {
    const inner: unknown = def;
    const fallback = (inner as Record<string, unknown>)["parse"];
    if (typeof fallback === "function") return fallback as ExifrParse;
  }
  throw new Error("The photo intake needs the exifr library.");
}

/** EXIF orientation, 1 when the file names none. */
export function normalizeOrientation(value: unknown): number {
  return value === 2 ||
    value === 3 ||
    value === 4 ||
    value === 5 ||
    value === 6 ||
    value === 7 ||
    value === 8
    ? value
    : 1;
}

/** Focal length the solver sees: EXIF 35 mm equivalent, else undefined (the solver defaults). */
export function normalizeFocal35mm(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 300) {
    return undefined;
  }
  return Math.round(value * 10) / 10;
}

export interface PhotoExif {
  orientation: number;
  focal35mm: number | undefined;
}

/**
 * Read the orientation and the focal length (35 mm equivalent) from raw
 * file bytes, before any resize. Never throws: missing tags fall back to
 * upright with no focal length.
 */
export async function readPhotoExif(data: ArrayBuffer | Uint8Array | Blob): Promise<PhotoExif> {
  try {
    const tags: unknown = await exifrParseFn()(data, {
      pick: ["Orientation", "FocalLengthIn35mmFilm", "FocalLengthIn35mmFormat"],
      translateValues: false,
    });
    if (typeof tags !== "object" || tags === null) return { orientation: 1, focal35mm: undefined };
    const record = tags as Record<string, unknown>;
    return {
      orientation: normalizeOrientation(record["Orientation"]),
      focal35mm: normalizeFocal35mm(
        record["FocalLengthIn35mmFilm"] ?? record["FocalLengthIn35mmFormat"],
      ),
    };
  } catch {
    return { orientation: 1, focal35mm: undefined };
  }
}

export interface OrientTransform {
  /** Clockwise rotation in degrees. */
  rotateDeg: 0 | 90 | 180 | 270;
  /** Horizontal flip applied after the rotation. */
  flipH: boolean;
  /** The rotation swaps width and height. */
  swapDims: boolean;
}

/** Canvas-equivalent transform for an EXIF orientation (the single source of truth). */
export function orientTransform(orientation: number): OrientTransform {
  switch (normalizeOrientation(orientation)) {
    case 2:
      return { rotateDeg: 0, flipH: true, swapDims: false };
    case 3:
      return { rotateDeg: 180, flipH: false, swapDims: false };
    case 4:
      return { rotateDeg: 180, flipH: true, swapDims: false };
    case 5:
      return { rotateDeg: 90, flipH: true, swapDims: true };
    case 6:
      return { rotateDeg: 90, flipH: false, swapDims: true };
    case 7:
      return { rotateDeg: 270, flipH: true, swapDims: true };
    case 8:
      return { rotateDeg: 270, flipH: false, swapDims: true };
    default:
      return { rotateDeg: 0, flipH: false, swapDims: false };
  }
}

/**
 * Headless-testable core of the canvas transform: the upright pixel grid
 * for a row-major `src` grid (`w` x `h`) under an EXIF orientation.
 */
export function pixelsUpright<T>(
  src: readonly T[],
  w: number,
  h: number,
  orientation: number,
): T[] {
  const t = orientTransform(orientation);
  const outW = t.swapDims ? h : w;
  const put = (x: number, y: number): T => {
    let sx = x;
    const sy = y;
    if (t.flipH) sx = outW - 1 - sx;
    let rx = sx;
    let ry = sy;
    if (t.rotateDeg === 90) {
      rx = sy;
      ry = outW - 1 - sx;
    } else if (t.rotateDeg === 180) {
      rx = outW - 1 - sx;
      ry = (t.swapDims ? w : h) - 1 - sy;
    } else if (t.rotateDeg === 270) {
      rx = (t.swapDims ? w : h) - 1 - sy;
      ry = sx;
    }
    return src[ry * w + rx] as T;
  };
  const out: T[] = [];
  const outH = t.swapDims ? w : h;
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) out.push(put(x, y));
  }
  return out;
}

/** Downscaled dimensions for a `longSide` bound (never upscales). */
export function targetSize(
  w: number,
  h: number,
  longSide: number,
): { width: number; height: number } {
  const safeW = Math.max(1, Math.round(w));
  const safeH = Math.max(1, Math.round(h));
  const scale = Math.min(1, longSide / Math.max(safeW, safeH));
  return {
    width: Math.max(1, Math.round(safeW * scale)),
    height: Math.max(1, Math.round(safeH * scale)),
  };
}

export interface PhotoPlan {
  orientedWidth: number;
  orientedHeight: number;
  segWidth: number;
  segHeight: number;
  labelWidth: number;
  labelHeight: number;
}

/** Full downscale plan for a photo: orientation applied, then both sizes. */
export function computePhotoPlan(fullW: number, fullH: number, orientation: number): PhotoPlan {
  const t = orientTransform(orientation);
  const orientedWidth = t.swapDims ? fullH : fullW;
  const orientedHeight = t.swapDims ? fullW : fullH;
  const seg = targetSize(orientedWidth, orientedHeight, SEG_LONG_SIDE);
  const label = targetSize(orientedWidth, orientedHeight, LABEL_LONG_SIDE);
  return {
    orientedWidth,
    orientedHeight,
    segWidth: seg.width,
    segHeight: seg.height,
    labelWidth: label.width,
    labelHeight: label.height,
  };
}

/** A decoded full-size image: closed right after the downscale draw. */
export interface PhotoSource {
  width: number;
  height: number;
  image: CanvasImageSource;
  close(): void;
}

/** A blank downscale target: draws the source once, exports a JPEG data URL. */
export interface PhotoCanvas {
  width: number;
  height: number;
  image: CanvasImageSource;
  drawOriented(source: PhotoSource, orientation: number): void;
  drawSmaller(source: PhotoCanvas): void;
  toDataUrl(): Promise<string>;
}

export interface DownscaledPhoto {
  segUrl: string;
  segWidth: number;
  segHeight: number;
  labelUrl: string;
  labelWidth: number;
  labelHeight: number;
}

/**
 * The real order of operations: draw the source once at 1280 px, close it
 * at once, then derive 640 px from the 1280 px canvas. Resolves only after
 * the source is closed, holding no full-size pixels.
 */
export async function runDownscalePipeline(
  source: PhotoSource,
  orientation: number,
  makeCanvas: (w: number, h: number) => PhotoCanvas,
): Promise<DownscaledPhoto> {
  const plan = computePhotoPlan(source.width, source.height, orientation);
  const seg = makeCanvas(plan.segWidth, plan.segHeight);
  seg.drawOriented(source, orientation);
  source.close();
  const label = makeCanvas(plan.labelWidth, plan.labelHeight);
  label.drawSmaller(seg);
  const segUrl = await seg.toDataUrl();
  const labelUrl = await label.toDataUrl();
  return {
    segUrl,
    segWidth: plan.segWidth,
    segHeight: plan.segHeight,
    labelUrl,
    labelWidth: plan.labelWidth,
    labelHeight: plan.labelHeight,
  };
}

/** Browser `PhotoCanvas` over a real 2D canvas. */
export function browserCanvas(w: number, h: number): PhotoCanvas & { canvas: HTMLCanvasElement } {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("The photo intake needs a 2D canvas.");
  const drawOriented = (source: PhotoSource, orientation: number): void => {
    const t = orientTransform(orientation);
    const dw = canvas.width;
    const dh = canvas.height;
    const fullW = t.swapDims ? source.height : source.width;
    const fullH = t.swapDims ? source.width : source.height;
    const scale = Math.min(dw / fullW, dh / fullH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(dw / 2, dh / 2);
    ctx.rotate((t.rotateDeg * Math.PI) / 180);
    ctx.scale(t.flipH ? -scale : scale, scale);
    ctx.drawImage(source.image, -source.width / 2, -source.height / 2, source.width, source.height);
  };
  const drawSmaller = (source: PhotoCanvas): void => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(source.image, 0, 0, canvas.width, canvas.height);
  };
  const toDataUrl = (): Promise<string> =>
    new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob === null) {
            reject(new Error("The photo could not be encoded as JPEG."));
            return;
          }
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("The photo could not be read back."));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        0.92,
      );
    });
  return {
    width: w,
    height: h,
    image: canvas,
    drawOriented,
    drawSmaller,
    toDataUrl,
    canvas,
  };
}

export interface IntakePhoto {
  segUrl: string;
  segWidth: number;
  segHeight: number;
  labelUrl: string;
  labelWidth: number;
  labelHeight: number;
  orientation: number;
  focal35mm: number | undefined;
}

/** Time limit for reading and resizing one photo (20 s). */
export const PHOTO_READ_TIMEOUT_MS = 20000;

/** Decodes a picked file into a drawable full-size image. */
export type PhotoDecoder = (file: Blob) => Promise<ImageBitmap>;

/** Injectable wiring for `processPhotoFile` (headless checks pass fakes). */
export interface ProcessPhotoOptions {
  decode?: PhotoDecoder;
  makeCanvas?: (w: number, h: number) => PhotoCanvas;
  timeoutMs?: number;
}

/**
 * One photo at a time from a picked file: EXIF first (before any resize),
 * then the downscale pipeline, releasing the full-size image at once.
 */
export async function processPhotoFile(
  file: File,
  options: ProcessPhotoOptions = {},
): Promise<IntakePhoto> {
  const decode = options.decode ?? ((blob: Blob) => createImageBitmap(blob));
  const makeCanvas = options.makeCanvas ?? browserCanvas;
  const timeoutMs = options.timeoutMs ?? PHOTO_READ_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async (): Promise<IntakePhoto> => {
    const bytes = await file.arrayBuffer();
    const exif = await readPhotoExif(bytes);
    const bitmap = await decode(file);
    const source: PhotoSource = {
      width: bitmap.width,
      height: bitmap.height,
      image: bitmap,
      close: () => bitmap.close(),
    };
    try {
      const downscaled = await runDownscalePipeline(source, exif.orientation, makeCanvas);
      return { ...downscaled, orientation: exif.orientation, focal35mm: exif.focal35mm };
    } finally {
      try {
        bitmap.close();
      } catch {
        // Already closed by the pipeline.
      }
    }
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Reading your photo timed out after 20 seconds. Try again.")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
