/**
 * Browser surface colours: wall/floor albedo from the 1280 px photo pixels
 * plus the SAM masks at hand. No model call: the pixels come from the
 * already-downloaded photo, the masks from the segment answers.
 */

import { floorAlbedoColor, wallAlbedoColor, type RgbaImage } from "@fitroom/shared";
import type { SamInstance } from "@fitroom/shared";

export interface SurfaceColors {
  wallTint: string | null;
  floorColor: string | null;
}

/** Decode a data-URL photo into RGBA pixels (natural size, never upscaled). */
export function loadPhotoPixels(url: string): Promise<RgbaImage | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        try {
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          if (!(w > 0) || !(h > 0)) {
            resolve(null);
            return;
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx === null) {
            resolve(null);
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          const pixels = ctx.getImageData(0, 0, w, h);
          resolve({ width: w, height: h, data: pixels.data });
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    } catch {
      resolve(null);
    }
  });
}

/** Albedos for one photo from its pixels + instances (pure part, testable). */
export function surfaceColorsOf(
  image: RgbaImage,
  instances: SamInstance[],
  width: number,
  height: number,
): SurfaceColors {
  return {
    wallTint: wallAlbedoColor(image, instances, width, height),
    floorColor: floorAlbedoColor(image, instances, width, height),
  };
}

/**
 * Albedos for one analysed wall photo. Resolves nulls (never throws) when
 * the pixels cannot be read or the masks are empty.
 */
export async function computeSurfaceColors(
  segUrl: string,
  segWidth: number,
  segHeight: number,
  instances: SamInstance[],
  load: (url: string) => Promise<RgbaImage | null> = loadPhotoPixels,
): Promise<SurfaceColors> {
  try {
    const image = await load(segUrl);
    if (image === null) return { wallTint: null, floorColor: null };
    const w = Math.min(image.width, Math.max(1, Math.round(segWidth)));
    const h = Math.min(image.height, Math.max(1, Math.round(segHeight)));
    return surfaceColorsOf(image, instances, w, h);
  } catch {
    return { wallTint: null, floorColor: null };
  }
}
