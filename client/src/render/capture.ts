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
/** Small margin around the room in the capture frame. */
const FRAME_MARGIN = 1.08;
/** Wall height used for framing when the room mesh is missing. */
const FALLBACK_WALL_HEIGHT_M = 2.6;

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

interface RoomFrame {
  cxM: number;
  czM: number;
  wM: number;
  dM: number;
}

/** Room bounds from the built floor mesh (metres, x east, z north). */
function roomFrameOf(scene: THREE.Scene): RoomFrame | null {
  const floor = scene.getObjectByName("fitroom-floor");
  if (!(floor instanceof THREE.Mesh)) return null;
  const geo = floor.geometry;
  const params = geo.parameters as { width?: unknown; height?: unknown } | undefined;
  const wM = typeof params?.width === "number" ? params.width : 0;
  const dM = typeof params?.height === "number" ? params.height : 0;
  if (!(wM > 0) || !(dM > 0)) return null;
  return { cxM: floor.position.x, czM: floor.position.z, wM, dM };
}

/**
 * Capture the current dollhouse, eye-level or plan view at 1024 px wide as
 * JPEG (quality 0.85), hiding every overlay for that frame: the verdict
 * badge, floating labels, clearance shading, door arcs and the selection
 * outline. DOM overlays never reach the WebGL pixels, but they are hidden
 * too so the frame the customer sees matches the capture.
 *
 * The room fills the frame with a small margin whatever the view on
 * screen: the capture reframes onto the room (keeping the current view
 * direction) instead of copying the on-screen camera distance, so a wide
 * first view no longer shrinks the room and the image model stops
 * re-imagining the camera. Everything is restored before returning; the
 * renderer keeps its original size and pixel ratio.
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
  const captureAspect = width / height;
  const isPerspective = camera instanceof THREE.PerspectiveCamera;
  const isOrtho = camera instanceof THREE.OrthographicCamera;
  const prevAspect = isPerspective ? camera.aspect : null;
  const prevOrtho = isOrtho
    ? {
        left: camera.left,
        right: camera.right,
        top: camera.top,
        bottom: camera.bottom,
        position: camera.position.clone(),
      }
    : null;
  const prevPosition = camera.position.clone();
  const prevQuaternion = camera.quaternion.clone();

  // Frame the room tightly for this capture only.
  const frame = roomFrameOf(scene);
  if (frame !== null) {
    const hw = (frame.wM / 2) * FRAME_MARGIN;
    const hd = (frame.dM / 2) * FRAME_MARGIN;
    if (isPerspective) {
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * captureAspect);
      const fitFov = Math.min(vFov, hFov);
      const radius = Math.sqrt(
        hw * hw + hd * hd + (FALLBACK_WALL_HEIGHT_M / 2) * (FALLBACK_WALL_HEIGHT_M / 2),
      );
      const dist = radius / Math.sin(fitFov / 2);
      const center = new THREE.Vector3(frame.cxM, 0.4, frame.czM);
      const dir = camera.position.clone().sub(center);
      if (dir.lengthSq() < 1e-6) dir.set(0.85, 0.85, 1);
      dir.normalize();
      camera.position.copy(center).addScaledVector(dir, dist);
      camera.lookAt(center);
    } else if (isOrtho) {
      const halfH = Math.max(hd, hw / captureAspect);
      camera.left = -halfH * captureAspect;
      camera.right = halfH * captureAspect;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.position.set(frame.cxM, camera.position.y, frame.czM);
      camera.updateProjectionMatrix();
    }
  }

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
  camera.position.copy(prevPosition);
  camera.quaternion.copy(prevQuaternion);
  if (isPerspective && prevAspect !== null) {
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
  }
  if (isOrtho && prevOrtho !== null) {
    camera.left = prevOrtho.left;
    camera.right = prevOrtho.right;
    camera.top = prevOrtho.top;
    camera.bottom = prevOrtho.bottom;
    camera.position.copy(prevOrtho.position);
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
