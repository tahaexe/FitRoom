import * as THREE from "three";
import { GLTFLoader, type GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CatalogItem } from "@fitroom/shared";
import { applyFabricVariant } from "./fabric";

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

interface VariantMapping {
  material: number;
  variants: number[];
}

interface SheenEntry {
  parser: GLTFParser;
  variants: string[];
  meshMappings: Map<string, VariantMapping[]>;
}

const sheenCache = new Map<string, SheenEntry>();

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

/**
 * Clone a cached model root with fresh per-instance materials, so fabric and
 * variant switches on one instance never leak into another (THREE shares
 * materials across Object3D.clone()).
 */
function instantiate(cached: THREE.Group): THREE.Group {
  const root = cached.clone(true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!("material" in mesh) || mesh.material === undefined) return;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => m.clone());
    } else {
      mesh.material = mesh.material.clone();
    }
  });
  return root;
}

interface VariantsJson {
  extensions?: {
    KHR_materials_variants?: { variants?: Array<{ name?: string }> };
  };
  meshes?: Array<{
    name?: string;
    primitives?: Array<{
      extensions?: {
        KHR_materials_variants?: { mappings?: VariantMapping[] };
      };
    }>;
  }>;
}

/** Index the model's own KHR_materials_variants table for later switches. */
function indexSheenVariants(productId: string, parser: GLTFParser): void {
  if (sheenCache.has(productId)) return;
  const json = parser.json as VariantsJson;
  const variants =
    json.extensions?.KHR_materials_variants?.variants?.map((v) => v.name ?? "") ?? [];
  const meshMappings = new Map<string, VariantMapping[]>();
  for (const mesh of json.meshes ?? []) {
    if (mesh.name === undefined) continue;
    const mappings: VariantMapping[] = [];
    for (const prim of mesh.primitives ?? []) {
      for (const m of prim.extensions?.KHR_materials_variants?.mappings ?? []) {
        mappings.push({ material: m.material, variants: [...m.variants] });
      }
    }
    if (mappings.length > 0) meshMappings.set(mesh.name, mappings);
  }
  sheenCache.set(productId, { parser, variants, meshMappings });
}

export function loadModel(item: CatalogItem): Promise<THREE.Group> {
  const cached = loadCache.get(item.id);
  if (cached !== undefined) return Promise.resolve(instantiate(cached));
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
    if (item.id === "SheenChair") indexSheenVariants(item.id, gltf.parser);
    loadCache.set(item.id, root);
    return instantiate(root);
  });
}

/**
 * SheenChair variant switch using the model's real KHR_materials_variants
 * materials (never a tint): each mesh's variant mapping selects a material
 * index, loaded via `parser.getDependency('material', index)` and assigned —
 * as in three's official `webgl_loader_gltf_variants` example.
 */
export async function applySheenVariant(
  root: THREE.Object3D,
  item: CatalogItem,
  variantName: string,
): Promise<void> {
  const entry = sheenCache.get(item.id);
  if (entry === undefined) return;
  const variantIndex = entry.variants.indexOf(variantName);
  if (variantIndex === -1) return;
  const jobs: Array<Promise<void>> = [];
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!("material" in mesh) || mesh.material === undefined) return;
    const mappings = entry.meshMappings.get(mesh.name);
    if (mappings === undefined) return;
    const hit = mappings.find((m) => m.variants.includes(variantIndex));
    if (hit === undefined) return;
    jobs.push(
      entry.parser.getDependency("material", hit.material).then((resolved: unknown) => {
        const material = resolved as THREE.Material;
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map(() => material);
        } else {
          mesh.material = material;
        }
        material.needsUpdate = true;
      }),
    );
  });
  await Promise.all(jobs);
}

/** Apply the named variant (fabric recipe or Sheen KHR switch) to an instance. */
export async function applyVariant(
  root: THREE.Object3D,
  item: CatalogItem,
  variantName: string,
): Promise<void> {
  if (variantName === "") return;
  if (item.id === "SheenChair") {
    await applySheenVariant(root, item, variantName);
    return;
  }
  const variant = item.variants.find((v) => v.name === variantName);
  if (variant === undefined) return;
  if (variant.kind === "fabric" && item.fabricSwitch !== undefined) {
    applyFabricVariant(root, item, variantName);
  }
}
