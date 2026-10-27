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
  painted_wooden_sofa:
    "Oversized source scaled 0.7857 to a 44cm seat; front +Z, centred, grounded.",
  vintage_day_bed: "Oversized source scaled 0.8462 to a 44cm seat; front +Z, centred, grounded.",
  Rockingchair_01: "Oversized source scaled 0.8036 to a 45cm seat; front +Z, centred, grounded.",
  round_wooden_table_01: "Oversized source scaled 0.7463 to a 75cm top; centred, grounded.",
  painted_wooden_table: "Oversized source scaled 0.7821 to a 75cm top; centred, grounded.",
  painted_wooden_chair_01: "Front +Z already; centred, grounded.",
  painted_wooden_chair_02:
    "Oversized source scaled 0.7895 to a 45cm seat; front +Z, centred, grounded.",
  modern_coffee_table_02: "Front +Z already; centred, grounded.",
  industrial_coffee_table: "Front +Z already; centred, grounded.",
  CoffeeTable_01: "Oversized source scaled 0.956 to a 50cm top; centred, grounded.",
  GothicBed_01: "Headboard at -Z, front +Z; centred, grounded.",
  GothicCabinet_01: "Front +Z already; centred, grounded.",
  vintage_cabinet_01: "Front +Z already; centred, grounded.",
  Shelf_01: "Front +Z already; centred, grounded.",
  steel_frame_shelves_01: "Decimetre-unit source scaled 0.1; front +Z, centred, grounded.",
  steel_frame_shelves_02: "Front +Z already; centred, grounded.",
  drawer_cabinet: "Front +Z already; centred, grounded.",
  WoodenTable_03: "Front +Z already; centred, grounded.",
  vintage_wooden_drawer_01: "Front +Z already; centred, grounded.",
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
  rug_160x230: "FitRoom Studio original, built in code: flat 160x230cm rug in Carpet012.",
  rug_200x300: "FitRoom Studio original, built in code: flat 200x300cm rug in Carpet015.",
  rug_240x340: "FitRoom Studio original, built in code: flat 240x340cm rug in Carpet016.",
  fitroom_floor_lamp:
    "FitRoom Studio original, built in code: disc base, pole and Fabric040 shade.",
  fitroom_wardrobe: "FitRoom Studio original, built in code: two-door wardrobe in WoodFloor051.",
  fitroom_platform_bed:
    "FitRoom Studio original, built in code: platform bed with headboard in WoodFloor070.",
  fitroom_sofa_3seat:
    "FitRoom Studio original, built in code: three-seat sofa with Fabric075 cushions.",
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
  // Bake the yaw fix and the centring into an inner alignment group. The
  // scene sync overwrites the outer root's position/rotation with the item
  // transform on every change, so anything stored on the root itself is
  // lost — which is how the coffee table and the shelf ended up 90° off
  // their footprints. The outer root stays at identity here, so callers can
  // freely set position/rotation from the item.
  const fixDeg = MODEL_YAW_FIX_DEG[productId] ?? 0;
  const align = new THREE.Group();
  align.name = "fitroom-align";
  align.rotation.y = (fixDeg * Math.PI) / 180;
  for (const child of [...root.children]) align.add(child);
  root.add(align);
  root.rotation.set(0, 0, 0);
  root.position.set(0, 0, 0);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  align.position.x -= center.x;
  align.position.z -= center.z;
  align.position.y -= box.min.y;
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
  sheenCache.set(productId, { parser, variants });
}

/** Variant mappings of one glTF primitive (empty when it has no switch). */
function primitiveMappings(
  parser: GLTFParser,
  meshIndex: number,
  primIndex: number,
): VariantMapping[] {
  const json = parser.json as VariantsJson;
  const prim = json.meshes?.[meshIndex]?.primitives?.[primIndex];
  return prim?.extensions?.KHR_materials_variants?.mappings ?? [];
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
 * materials (never a tint): each primitive's variant mapping selects a
 * material index, loaded via `parser.getDependency('material', index)` and
 * assigned — as in three's official `webgl_loader_gltf_variants` example.
 * Primitives are located through the loader's own `associations` (mesh and
 * primitive index), zipped from the cached source root onto the instance, so
 * multi-primitive meshes resolve to their own material.
 */
export async function applySheenVariant(
  root: THREE.Object3D,
  item: CatalogItem,
  variantName: string,
): Promise<void> {
  const entry = sheenCache.get(item.id);
  const source = loadCache.get(item.id);
  if (entry === undefined || source === undefined) return;
  const variantIndex = entry.variants.indexOf(variantName);
  if (variantIndex === -1) return;
  // Object3D.clone() preserves traversal order: zip source meshes with the
  // instance's meshes to recover each primitive's identity.
  const isMesh = (obj: THREE.Object3D): obj is THREE.Mesh =>
    "material" in obj && obj.material !== undefined;
  const sourceMeshes: THREE.Mesh[] = [];
  source.traverse((obj) => {
    if (isMesh(obj)) sourceMeshes.push(obj);
  });
  const cloneMeshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if (isMesh(obj)) cloneMeshes.push(obj);
  });
  const jobs: Array<Promise<void>> = [];
  for (let i = 0; i < cloneMeshes.length; i += 1) {
    const mesh = cloneMeshes[i];
    const srcMesh = sourceMeshes[i];
    if (mesh === undefined || srcMesh === undefined) continue;
    const ref = entry.parser.associations.get(srcMesh) as
      { meshes?: number; primitives?: number } | undefined;
    if (ref?.meshes === undefined || ref?.primitives === undefined) continue;
    const mappings = primitiveMappings(entry.parser, ref.meshes, ref.primitives);
    const hit = mappings.find((m) => m.variants.includes(variantIndex));
    if (hit === undefined) continue;
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
  }
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
