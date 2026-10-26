import * as THREE from "three";
import type { CatalogItem } from "@fitroom/shared";

/**
 * Mask-recipe fabric switch for the Provence pair (Sofa_01, ArmChair_01).
 *
 * Recipe per shared/catalog fabricSwitch:
 * - mask rule "luma" (lumaMin) or "saturation" (lumaMin + saturationMax)
 *   selects fabric pixels on the model's own albedo canvas;
 * - blurPx controls the box-blur radius applied to the binary mask;
 * - fabricLumaMedian / uvPerMeter / tileCm drive the woven detail overlay.
 * Wood (materials named wood/leg/frame/dark) is never touched.
 * Results are cached per (productId, variant).
 */

const WOOD_HINT = /(wood|leg|frame|metal|dark|black)/i;

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

const cache = new Map<string, THREE.CanvasTexture>();

function albedoCanvas(map: THREE.Texture | null): HTMLCanvasElement | null {
  const img = map?.image as HTMLImageElement | HTMLCanvasElement | undefined;
  if (img === undefined || img === null) return null;
  const w = (img as { width?: number }).width ?? 0;
  const h = (img as { height?: number }).height ?? 0;
  if (w === 0 || h === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(256, w);
  canvas.height = Math.min(256, h);
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Build (or fetch from cache) the composed fabric texture for a variant.
 * Falls back to a flat swatch + weave when the model albedo is unavailable.
 */
export function fabricTextureFor(item: CatalogItem, variantName: string): THREE.CanvasTexture {
  const key = `${item.id}::${variantName}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const variant = item.variants.find((v) => v.name === variantName);
  const swatch = variant?.swatch ?? "#b9b2a6";
  const [sr, sg, sb] = hexToRgb(swatch);
  const mask = item.fabricSwitch?.mask;
  const rule = mask?.rule ?? "luma";
  const lumaMin = mask?.lumaMin ?? 0.3;
  const satMax = mask?.saturationMax ?? 0.15;
  const median = item.fabricSwitch?.fabricLumaMedian ?? 0.55;

  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    const tex = new THREE.CanvasTexture(canvas);
    cache.set(key, tex);
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
  void rule;
  void lumaMin;
  void satMax;
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

/** Apply a fabric variant to a model root; wood parts are left unchanged. */
export function applyFabricVariant(
  root: THREE.Object3D,
  item: CatalogItem,
  variantName: string,
): void {
  const tex = fabricTextureFor(item, variantName);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!("material" in mesh) || mesh.material === undefined) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (std === undefined || typeof std !== "object" || !("color" in std)) continue;
      const matName = (std.name ?? "") + " " + (mesh.name ?? "");
      if (isWood(matName)) continue;
      if (std.map !== undefined && std.map !== null) {
        const src = albedoCanvas(std.map as THREE.Texture);
        if (src !== null) {
          const sctx = src.getContext("2d");
          if (sctx !== null) {
            const data = sctx.getImageData(0, 0, src.width, src.height);
            const w = src.width;
            const h = src.height;
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
                const rule = item.fabricSwitch?.mask.rule ?? "luma";
                const lmin = item.fabricSwitch?.mask.lumaMin ?? 0.3;
                const smax = item.fabricSwitch?.mask.saturationMax ?? 0.15;
                raw[y * w + x] =
                  rule === "saturation"
                    ? sat <= smax && luma >= lmin
                      ? 1
                      : 0
                    : luma >= lmin
                      ? 1
                      : 0;
              }
            }
            const blurred = boxBlur(raw, w, h, item.fabricSwitch?.blurPx ?? 5);
            // Soft-mask composite: repaint fabric pixels toward the swatch.
            const [sr, sg, sb] = hexToRgb(variantNameToSwatch(item, variantName));
            for (let y = 0; y < h; y += 1) {
              for (let x = 0; x < w; x += 1) {
                const a = blurred[y * w + x] ?? 0;
                const i = (y * w + x) * 4;
                data.data[i] = Math.round((data.data[i] ?? 0) * (1 - a) + sr * a);
                data.data[i + 1] = Math.round((data.data[i + 1] ?? 0) * (1 - a) + sg * a);
                data.data[i + 2] = Math.round((data.data[i + 2] ?? 0) * (1 - a) + sb * a);
              }
            }
            sctx.putImageData(data, 0, 0);
            const composed = new THREE.CanvasTexture(src);
            composed.wrapS = THREE.RepeatWrapping;
            composed.wrapT = THREE.RepeatWrapping;
            composed.colorSpace = THREE.SRGBColorSpace;
            std.map = composed;
            std.needsUpdate = true;
            continue;
          }
        }
      }
      // No usable albedo: tint + weave overlay.
      std.map = tex;
      std.needsUpdate = true;
    }
  });
}

function variantNameToSwatch(item: CatalogItem, variantName: string): string {
  return item.variants.find((v) => v.name === variantName)?.swatch ?? "#b9b2a6";
}

/** SheenChair KHR_materials_variants: switch between Mango / Peacock velvet. */
export function applySheenVariant(root: THREE.Object3D, variantName: string): void {
  const target = variantName.toLowerCase().includes("peacock") ? "#0F5C61" : "#E25A1C";
  const [r, g, b] = hexToRgb(target);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!("material" in mesh) || mesh.material === undefined) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial & { sheenColor?: THREE.Color };
      if (std === undefined || typeof std !== "object" || !("color" in std)) continue;
      const matName =
        ((std as { name?: string }).name ?? "") + " " + ((mesh as { name?: string }).name ?? "");
      if (/(wood|metal|leg)/i.test(matName)) continue;
      (std.color as THREE.Color).setRGB(r / 255, g / 255, b / 255);
      if (std.sheenColor instanceof THREE.Color) {
        std.sheenColor.setRGB(r / 255, g / 255, b / 255);
      }
      std.needsUpdate = true;
    }
  });
}
