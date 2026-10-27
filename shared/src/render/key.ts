import type { SceneState } from "../types.js";

export interface RenderKeySceneItem {
  instanceId: string;
  productId: string;
  position: { x: number; z: number };
  rotationY: number;
  variant: string;
}

export interface RenderKeyInput {
  scene: {
    roomId: string;
    items: RenderKeySceneItem[];
  };
  camera: { preset: string } | { mode: string; position: unknown; target: unknown };
  prompt: string;
}

function roundCm(value: number): number {
  return Math.round(value);
}

function roundPoseM(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Cache/demo key input for a render: the normalised scene (room id, items
 * with positions rounded to 1 cm, rotations and variants), the camera (its
 * preset name for a preset view, else the pose rounded to 1 cm) and the
 * prompt. Never image bytes.
 */
export function buildRenderKeyInput(
  scene: SceneState,
  prompt: string,
  cameraPreset?: string,
): RenderKeyInput {
  const items: RenderKeySceneItem[] = scene.items
    .map((item) => ({
      instanceId: item.instanceId,
      productId: item.productId,
      position: { x: roundCm(item.position.x), z: roundCm(item.position.z) },
      rotationY: Math.round(item.rotationY),
      variant: item.variant,
    }))
    .sort((a, b) => (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0));
  const camera =
    cameraPreset !== undefined && cameraPreset !== ""
      ? { preset: cameraPreset }
      : {
          mode: scene.camera.mode,
          position: {
            x: roundPoseM(scene.camera.position.x),
            y: roundPoseM(scene.camera.position.y),
            z: roundPoseM(scene.camera.position.z),
          },
          target: {
            x: roundPoseM(scene.camera.target.x),
            y: roundPoseM(scene.camera.target.y),
            z: roundPoseM(scene.camera.target.z),
          },
        };
  return { scene: { roomId: scene.roomId, items }, camera, prompt };
}
