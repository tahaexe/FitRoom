import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CatalogItem } from "@fitroom/shared";
import { applyFabricVariant, applySheenVariant } from "./fabric";

/**
 * Model normalisation registry.
 * Every model is centred on XZ, has its base at y=0, faces front (+Z),
 * renders at real-world size, and ships with no embedded lights.
 *
 * Per-model notes (authoring fixes):
 * - coffee_table_round_01: authored rotated -90deg about Y; +90deg yaw fix.
 * - modern_coffee_table_01: authored rotated -90deg about Y; +90deg yaw fix.
 * - wooden_display_shelves_01: back panel faced +Z; +90deg yaw fix so the
 *   open face fronts +Z.
 * - SheenChair: Khronos sample with KHR_materials_variants (Mango/Peacock).
 * - Sofa_01 / ArmChair_01 ("Provence pair"): fabric variants via the
 *   mask-recipe switch in fabric.ts.
 * - All others: already front +Z, base y=0; centred only.
 */
export const MODEL_YAW_FIX_DEG: Record<string, number> = {
  coffee_table_round_01: 90,
  modern_coffee_table_01: 90,
  wooden_display_shelves_01: 90,
};

export const MODEL_NOTES: Record<string, string> = {
  sofa_02: "Front +Z already; centred, grounded.",
  sofa_03: "Front +Z already; centred, grounded.",
  Sofa_01: "Provence pair: fabric variants via mask-recipe switch.",
  mid_century_lounge_chair: "Front +Z already; centred, grounded.",
  modern_arm_chair_01: "Front +Z already; centred, grounded.",
  SheenChair: "KHR_materials_variants Mango/Peacock velvet.",
  GreenChair_01: "Front +Z already; centred, grounded.",
  ArmChair_01: "Provence pair: fabric variants via mask-recipe switch.",
  Ottoman_01: "Front +Z already; centred, grounded.",
  modern_coffee_table_01: "Authored -90deg yaw; +90deg fix applied.",
  coffee_table_round_01: "Authored -90deg yaw; +90deg fix applied.",
  side_table_01: "Front +Z already; centred, grounded.",
  modern_wooden_cabinet: "Front +Z already; centred, grounded.",
  wooden_display_shelves_01: "Open face faced sideways; +90deg fix applied.",
  potted_plant_02: "Radial decor; centred, grounded.",
};

const loader = new GLTFLoader();
const loadCache = new Map<string, THREE.Group>();

function stripLights(root: THREE.Object3D): void {
  const doomed: THREE.Object3D[] = [];
  root.traverse((obj) => {
    if (
      obj instanceof THREE.PointLight ||
      obj instanceof THREE.SpotLight ||
      obj instanceof THREE.DirectionalLight
    ) {
      doomed.push(obj);
    }
  });
  for (const l of doomed) l.parent?.remove(l);
}

function normalise(root: THREE.Object3D, productId: string): void {
  const fixDeg = MODEL_YAW_FIX_DEG[productId] ?? 0;
  if (fixDeg !== 0) root.rotation.y = (fixDeg * Math.PI) / 180;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
}

export function loadModel(item: CatalogItem): Promise<THREE.Group> {
  const cached = loadCache.get(item.id);
  if (cached !== undefined) return Promise.resolve(cached.clone(true));
  return loader.loadAsync(item.model).then((gltf) => {
    const root = gltf.scene;
    stripLights(root);
    normalise(root, item.id);
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if ("isMesh" in mesh && (mesh as { isMesh?: boolean }).isMesh === true) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    loadCache.set(item.id, root);
    return root.clone(true);
  });
}

/** Apply the named variant (fabric recipe or Sheen KHR switch) to an instance. */
export function applyVariant(root: THREE.Object3D, item: CatalogItem, variantName: string): void {
  if (variantName === "") return;
  if (item.id === "SheenChair") {
    applySheenVariant(root, variantName);
    return;
  }
  const variant = item.variants.find((v) => v.name === variantName);
  if (variant === undefined) return;
  if (variant.kind === "fabric" && item.fabricSwitch !== undefined) {
    applyFabricVariant(root, item, variantName);
  }
}
