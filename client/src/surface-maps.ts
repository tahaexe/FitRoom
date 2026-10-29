/**
 * Surface map file names, built in one place.
 *
 * Both surface loaders (`pbrSet` in `stage.ts` for floors, `dressWalls` in
 * `main.ts` for walls) name their files through `surfaceMapFiles`, so a
 * format change touches this module only. Colour and roughness maps are
 * WebP (quality ~80); normal maps are 512 px JPEGs; the environment map is
 * the same lebombo HDRI at half size (512x256).
 */

export const HDRI_URL = "assets/hdri/polyhaven/lebombo_512.hdr";

export interface SurfaceMapFiles {
  colorUrl: string;
  normalUrl: string;
  roughnessUrl: string;
}

/** Map URLs for one ambientCG finish id (floor or wall). */
export function surfaceMapFiles(finishId: string): SurfaceMapFiles {
  const base = `assets/textures/ambientcg/${finishId}/${finishId}_1K-JPG`;
  return {
    colorUrl: `${base}_Color.webp`,
    normalUrl: `${base}_NormalGL.jpg`,
    roughnessUrl: `${base}_Roughness.webp`,
  };
}
