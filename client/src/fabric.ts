import * as THREE from "three";
import type { CatalogItem } from "@fitroom/shared";

/**
 * Mask-recipe fabric switch for the Provence pair (Sofa_01, ArmChair_01).
 *
 * Recipe per shared/catalog fabricSwitch:
 * - mask rule "luma" (lumaMin) or "saturation" (lumaMin + saturationMax)
 *   selects fabric pixels on the model's own albedo canvas;
 * - blurPx controls the box-blur radius applied to the binary mask.
 * Wood (materials named wood/leg/frame/dark) is never touched.
 *
 * Orientation contract: glTF base-colour textures use `flipY = false`, so the
 * mask is built from the original image's pixels top-row-first and the
 * composed CanvasTexture copies `flipY`, `colorSpace` (sRGB), `wrapS`/`wrapT`,
 * `channel`, the mag/min filters and the uv transform from the original map.
 * "Stone" is the model's original material and is left byte-identical.
 */

const WOOD_HINT = /(wood|leg|frame|metal|dark|black)/i;

/** The default fabric: the model's own material, never recomposed. */
const ORIGINAL_VARIANT = "Stone";

function isWood(name: string): boolean {
  return WOOD_HINT.test(name);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v = parseInt(
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h,
    16,
  );
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) return src;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let acc = 0;
      let n = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        acc += src[y * w + xx] ?? 0;
        n += 1;
      }
      tmp[y * w + x] = acc / n;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let acc = 0;
      let n = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        acc += tmp[yy * w + x] ?? 0;
        n += 1;
      }
      out[y * w + x] = acc / n;
    }
  }
  return out;
}

const weaveCache = new Map<string, THREE.CanvasTexture>();
const composedCache = new Map<string, THREE.CanvasTexture>();
/** Pristine base-colour map per material, for Stone restore + recompose. */
const originalMaps = new WeakMap<THREE.Material, THREE.Texture | null>();

/** Full-resolution pixel canvas of the original map image (same orientation). */
function albedoCanvas(map: THREE.Texture): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  const img = map.image as { width?: number; height?: number; complete?: boolean } | undefined;
  if (img === undefined || img === null) return null;
  const w = img.width ?? 0;
  const h = img.height ?? 0;
  if (w === 0 || h === 0) return null;
  if (img.complete === false) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  // No vertical flip: canvas row 0 is the image top row, which is exactly how
  // the GPU reads it with flipY = false.
  ctx.drawImage(map.image as CanvasImageSource, 0, 0, w, h);
  return { canvas, ctx };
}

/**
 * Build (or fetch from cache) the composed fabric texture for a variant.
 * Falls back to a flat swatch + weave when the model albedo is unavailable.
 */
export function fabricTextureFor(item: CatalogItem, variantName: string): THREE.CanvasTexture {
  const key = `${item.id}::${variantName}`;
  const hit = weaveCache.get(key);
  if (hit !== undefined) return hit;

  const variant = item.variants.find((v) => v.name === variantName);
  const swatch = variant?.swatch ?? "#b9b2a6";
  const [sr, sg, sb] = hexToRgb(swatch);
  const median = item.fabricSwitch?.fabricLumaMedian ?? 0.55;

  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    const tex = new THREE.CanvasTexture(canvas);
    weaveCache.set(key, tex);
    return tex;
  }
  // Deterministic weave from the median + uv density.
  const img = ctx.createImageData(S, S);
  let seed = 7;
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const weave = ((x + y) % 2 === 0 ? 1 : -1) * 10 * median + (rand() - 0.5) * 14;
      const i = (y * S + x) * 4;
      img.data[i] = Math.min(255, Math.max(0, sr + weave));
      img.data[i + 1] = Math.min(255, Math.max(0, sg + weave));
      img.data[i + 2] = Math.min(255, Math.max(0, sb + weave));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  weaveCache.set(key, tex);
  return tex;
}

/** Copy the original map's sampling settings onto the composed texture. */
function inheritSampling(composed: THREE.CanvasTexture, src: THREE.Texture): void {
  composed.flipY = src.flipY;
  composed.colorSpace = src.colorSpace;
  composed.wrapS = src.wrapS;
  composed.wrapT = src.wrapT;
  composed.magFilter = src.magFilter;
  composed.minFilter = src.minFilter;
  composed.generateMipmaps = src.generateMipmaps;
  composed.anisotropy = src.anisotropy;
  composed.repeat.copy(src.repeat);
  composed.offset.copy(src.offset);
  composed.rotation = src.rotation;
  composed.center.copy(src.center);
  const srcChannel = (src as { channel?: unknown }).channel;
  if (typeof srcChannel === "number") {
    (composed as { channel?: number }).channel = srcChannel;
  }
}

/**
 * Compose the variant's base-colour map from the ORIGINAL map's pixels:
 * only masked fabric texels move toward the swatch; everything else
 * (carved wood, piping shadows) keeps its original colour.
 */
function composedTextureFor(
  item: CatalogItem,
  variantName: string,
  src: THREE.Texture,
): THREE.CanvasTexture | null {
  const key = `${item.id}::${variantName}::${src.uuid}`;
  const hit = composedCache.get(key);
  if (hit !== undefined) return hit;

  const albedo = albedoCanvas(src);
  if (albedo === null) return null;
  const { canvas, ctx } = albedo;
  const w = canvas.width;
  const h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h);

  const rule = item.fabricSwitch?.mask.rule ?? "luma";
  const lumaMin = item.fabricSwitch?.mask.lumaMin ?? 0.3;
  const satMax = item.fabricSwitch?.mask.saturationMax ?? 0.15;
  const blurPx = item.fabricSwitch?.blurPx ?? 5;

  const raw = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const r = (data.data[i] ?? 0) / 255;
      const g = (data.data[i + 1] ?? 0) / 255;
      const b = (data.data[i + 2] ?? 0) / 255;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      raw[y * w + x] =
        rule === "saturation"
          ? sat <= satMax && luma >= lumaMin
            ? 1
            : 0
          : luma >= lumaMin
            ? 1
            : 0;
    }
  }
  const mask = boxBlur(raw, w, h, blurPx);

  const swatch = item.variants.find((v) => v.name === variantName)?.swatch ?? "#b9b2a6";
  const [sr, sg, sb] = hexToRgb(swatch);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const a = mask[y * w + x] ?? 0;
      const i = (y * w + x) * 4;
      data.data[i] = Math.round((data.data[i] ?? 0) * (1 - a) + sr * a);
      data.data[i + 1] = Math.round((data.data[i + 1] ?? 0) * (1 - a) + sg * a);
      data.data[i + 2] = Math.round((data.data[i + 2] ?? 0) * (1 - a) + sb * a);
    }
  }
  ctx.putImageData(data, 0, 0);

  const composed = new THREE.CanvasTexture(canvas);
  inheritSampling(composed, src);
  composed.needsUpdate = true;
  composedCache.set(key, composed);
  return composed;
}

/** Apply a fabric variant to a model root; wood parts are left unchanged. */
export function applyFabricVariant(
  root: THREE.Object3D,
  item: CatalogItem,
  variantName: string,
): void {
  const isOriginal = variantName === ORIGINAL_VARIANT;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!("material" in mesh) || mesh.material === undefined) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (std === undefined || typeof std !== "object" || !("color" in std)) continue;
      const matName = (std.name ?? "") + " " + ((mesh as { name?: string }).name ?? "");
      if (isWood(matName)) continue;
      if (!originalMaps.has(std)) {
        const current = std.map instanceof THREE.Texture ? (std.map as THREE.Texture) : null;
        originalMaps.set(std, current);
      }
      if (isOriginal) {
        // Stone: restore the model's own material, unchanged.
        const original = originalMaps.get(std) ?? null;
        if (std.map !== original) {
          std.map = original;
          std.needsUpdate = true;
        }
        continue;
      }
      const src = originalMaps.get(std) ?? null;
      if (src !== null) {
        const composed = composedTextureFor(item, variantName, src);
        if (composed !== null) {
          std.map = composed;
          std.needsUpdate = true;
          continue;
        }
      }
      // No usable albedo: tint + weave overlay.
      std.map = fabricTextureFor(item, variantName);
      std.needsUpdate = true;
    }
  });
}
