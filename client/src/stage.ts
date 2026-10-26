import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

const HDRI_URL = "assets/hdri/polyhaven/lebombo_1k.hdr";

export interface StageRig {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  contactPlane: THREE.Mesh;
  contactNeedsRefresh: { value: boolean };
}

function pbrSet(
  base: string,
  repeatX: number,
  repeatY: number,
): { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture } {
  const loader = new THREE.TextureLoader();
  const load = (url: string, srgb: boolean): THREE.Texture => {
    const tex = loader.load(url);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    tex.anisotropy = 8;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  return {
    map: load(`${base}_Color.jpg`, true),
    normalMap: load(`${base}_NormalGL.jpg`, false),
    roughnessMap: load(`${base}_Roughness.jpg`, false),
  };
}

/** Tiled ambientCG PBR floor: WoodFloor070, repeat derived from room metres. */
export function makeFloorMaterial(roomWM: number, roomDM: number): THREE.MeshStandardMaterial {
  const tileM = 2;
  const sets = pbrSet(
    "assets/textures/ambientcg/WoodFloor070/WoodFloor070_1K-JPG",
    Math.max(1, roomWM / tileM),
    Math.max(1, roomDM / tileM),
  );
  return new THREE.MeshStandardMaterial({
    map: sets.map,
    normalMap: sets.normalMap,
    roughnessMap: sets.roughnessMap,
    roughness: 1,
    metalness: 0,
  });
}

/**
 * IBL from the lebombo HDRI + filmic tone mapping + sun with soft shadows +
 * a contact-shadow catcher plane re-rendered whenever contactNeedsRefresh
 * is set by scene changes.
 */
export function setupStage(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  floorSize: { wM: number; dM: number; cxM: number; czM: number },
  wallHeightM: number,
): StageRig {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene.background = new THREE.Color(0x8f959c);

  const pmrem = new THREE.PMREMGenerator(renderer);
  new RGBELoader().load(
    HDRI_URL,
    (hdr) => {
      const env = pmrem.fromEquirectangular(hdr).texture;
      scene.environment = env;
      scene.environmentIntensity = 0.55;
      hdr.dispose();
      pmrem.dispose();
    },
    undefined,
    () => {
      pmrem.dispose();
    },
  );

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f96, 0.35);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
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
  sun.shadow.radius = 6;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);

  const contactMat = new THREE.ShadowMaterial({ opacity: 0.28 });
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
