import * as THREE from "three";

export interface CaptureResult {
  /** `data:image/jpeg;base64,...` URL at 1024 px wide. */
  dataUrl: string;
  /** Bare base64 JPEG bytes (no prefix), for the gateway body. */
  base64: string;
  width: number;
  height: number;
}

const CAPTURE_WIDTH = 1024;

function domToHide(container: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const ids = ["fit-badge", "fit-list", "size-tag"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el instanceof HTMLElement) out.push(el);
  }
  for (const cls of ["fit-issue-labels", "plan-overlay"]) {
    for (const el of container.querySelectorAll(`.${cls}`)) {
      if (el instanceof HTMLElement) out.push(el);
    }
  }
  return out;
}

function isOverlayObject(object: THREE.Object3D): boolean {
  if (object instanceof THREE.BoxHelper) return true;
  const name = object.name;
  if (name === "fit-clearance") return true;
  if (name.startsWith("fit-swing-")) return true;
  if (name === "fitroom-rotate-handle") return true;
  return false;
}

/**
 * Capture the current dollhouse or eye-level view at 1024 px wide as JPEG
 * (quality 0.85), hiding every overlay for that frame: the verdict badge,
 * floating labels, clearance shading, door arcs and the selection outline.
 * DOM overlays never reach the WebGL pixels, but they are hidden too so the
 * frame the customer sees matches the capture. Everything is restored before
 * returning; the renderer keeps its original size and pixel ratio.
 */
export function captureView(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  container: HTMLElement,
): CaptureResult {
  const dom = domToHide(container);
  const prevDisplay = dom.map((el) => el.style.display);
  for (const el of dom) el.style.display = "none";

  const hidden: THREE.Object3D[] = [];
  scene.traverse((object) => {
    if (isOverlayObject(object) && object.visible) {
      object.visible = false;
      hidden.push(object);
    }
  });

  const prevSize = new THREE.Vector2();
  renderer.getSize(prevSize);
  const prevRatio = renderer.getPixelRatio();
  const aspect = prevSize.x > 0 && prevSize.y > 0 ? prevSize.x / prevSize.y : 16 / 9;
  const width = CAPTURE_WIDTH;
  const height = Math.max(1, Math.round(CAPTURE_WIDTH / aspect));
  const isPerspective = camera instanceof THREE.PerspectiveCamera;
  const prevAspect = isPerspective ? camera.aspect : null;

  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  if (isPerspective) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL("image/jpeg", 0.85);

  // Restore everything, then draw the live frame again.
  renderer.setPixelRatio(prevRatio);
  renderer.setSize(prevSize.x, prevSize.y, false);
  if (isPerspective && prevAspect !== null) {
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
  }
  for (const object of hidden) object.visible = true;
  dom.forEach((el, index) => {
    el.style.display = prevDisplay[index] ?? "";
  });
  renderer.render(scene, camera);

  const base64 = dataUrl.includes(",") ? (dataUrl.split(",").pop() ?? "") : "";
  return { dataUrl, base64, width, height };
}
