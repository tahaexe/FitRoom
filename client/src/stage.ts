import * as THREE from "three";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { HDRI_URL, surfaceMapFiles } from "./surface-maps";

export interface StageRig {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  contactPlane: THREE.Mesh;
  contactNeedsRefresh: { value: boolean };
}

function pbrSet(
  finish: string,
  repeatX: number,
  repeatY: number,
  onLoad: () => void,
): { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture } {
  const loader = new THREE.TextureLoader();
  const load = (url: string, srgb: boolean): THREE.Texture => {
    const tex = loader.load(url, onLoad);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    tex.anisotropy = 8;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  // File names come from the one place (`surface-maps.ts`): the finish
  // id maps to its colour/normal/roughness URLs there, never here.
  const files = surfaceMapFiles(finish);
  return {
    map: load(files.colorUrl, true),
    normalMap: load(files.normalUrl, false),
    roughnessMap: load(files.roughnessUrl, false),
  };
}

/** Known on-disk ambientCG floor finishes (plus legacy sample ids). */
export const FLOOR_TEXTURE_IDS = [
  "WoodFloor070",
  "WoodFloor051",
  "WoodFloor064",
  "WoodFloor071",
  "WoodFloor039",
  "Tiles107",
  "Tiles139",
  "Carpet012",
  "Carpet015",
  "Carpet016",
  "Concrete034",
] as const;

/** Real tile size in metres per on-disk finish (WoodFloor039 is 190 cm). */
export const FLOOR_TILE_M: Readonly<Record<string, number>> = {
  WoodFloor039: 1.9,
};

/** Resolve a layout floor id to an on-disk finish (legacy ids fall back). */
export function floorTextureIdFor(surfaceId: string | null | undefined): string {
  if (
    typeof surfaceId === "string" &&
    (FLOOR_TEXTURE_IDS as readonly string[]).includes(surfaceId)
  ) {
    return surfaceId;
  }
  // The sample room's legacy floor id renders as light oak planks
  // (WoodFloor039): a rendering choice keyed by the surface id, never a
  // change to the room data the requests carry.
  if (surfaceId === "oak-light") return "WoodFloor039";
  return "WoodFloor070";
}

/**
 * Tiled ambientCG PBR floor, repeat derived from room metres. Each texture
 * tile spans its real size (1 m, except WoodFloor039 at 1.9 m), so the
 * plank rows read at a real board scale (about 13 cm wide on the light oak
 * planks).
 */
export function makeFloorMaterial(
  roomWM: number,
  roomDM: number,
  onLoad: () => void = () => {},
  floorId?: string,
): THREE.MeshStandardMaterial {
  const finish = floorTextureIdFor(floorId);
  const tileM = FLOOR_TILE_M[finish] ?? 1;
  const sets = pbrSet(finish, Math.max(1, roomWM / tileM), Math.max(1, roomDM / tileM), onLoad);
  return new THREE.MeshStandardMaterial({
    map: sets.map,
    normalMap: sets.normalMap,
    roughnessMap: sets.roughnessMap,
    roughness: 1,
    metalness: 0,
  });
}

/**
 * IBL from the lebombo HDRI + neutral tone mapping + sun with shadows + a
 * contact-shadow catcher plane. Shadow maps are static between changes
 * (`autoUpdate = false`): callers set `needsUpdate` after a scene change.
 * `onLoad` fires for every async texture so the app can draw a frame.
 */
export function setupStage(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  floorSize: { wM: number; dM: number; cxM: number; czM: number },
  wallHeightM: number,
  onLoad: () => void = () => {},
): StageRig {
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  scene.background = new THREE.Color(0xf6f6f6);

  const pmrem = new THREE.PMREMGenerator(renderer);
  new HDRLoader().load(
    HDRI_URL,
    (hdr) => {
      const env = pmrem.fromEquirectangular(hdr).texture;
      scene.environment = env;
      scene.environmentIntensity = 1.0;
      hdr.dispose();
      pmrem.dispose();
      onLoad();
    },
    undefined,
    () => {
      pmrem.dispose();
    },
  );

  const hemi = new THREE.HemisphereLight(0xfff6ec, 0x9aa0a6, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  const R = Math.max(floorSize.wM, floorSize.dM);
  sun.position.set(floorSize.cxM + R * 1.2, wallHeightM + R * 1.4, floorSize.czM + R * 0.8);
  sun.target.position.set(floorSize.cxM, 0, floorSize.czM);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -R;
  sun.shadow.camera.right = R;
  sun.shadow.camera.top = R;
  sun.shadow.camera.bottom = -R;
  sun.shadow.camera.far = R * 6;
  sun.shadow.radius = 8;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);

  const contactMat = new THREE.ShadowMaterial({ opacity: 0.38 });
  const contactPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(floorSize.wM, floorSize.dM),
    contactMat,
  );
  contactPlane.rotation.x = -Math.PI / 2;
  contactPlane.position.set(floorSize.cxM, 0.005, floorSize.czM);
  contactPlane.receiveShadow = true;
  contactPlane.name = "fitroom-contact";
  scene.add(contactPlane);

  return { sun, hemi, contactPlane, contactNeedsRefresh: { value: true } };
}

/** Mark contact shadows for re-render after any scene change. */
export function requestContactRefresh(rig: StageRig | null): void {
  if (rig !== null) rig.contactNeedsRefresh.value = true;
}
