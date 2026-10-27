import * as THREE from "three";

/**
 * Developer camera hook: exact wall views from URL parameters. This module
 * is loaded only through a dynamic `import()` guarded by
 * `import.meta.env.DEV`, so the production build contains no trace of it.
 *
 * Query parameters (all numbers; any subset may be given):
 * - camx, camz: camera position in plan centimetres (default: room centre)
 * - cameye: eye height in centimetres (default 160)
 * - camyaw: yaw in degrees, clockwise from north (default 0 = facing north)
 * - campitch: pitch in degrees, positive looks up (default 0 = level)
 * - camfov: vertical field of view in degrees (default 60)
 *
 * When any parameter is present the hook frames a 4:3 view, hides the
 * interface chrome and publishes the calibrated camera on
 * `window.__fitroomCamera` ({ width, height, fx, fy, cx, cy in pixels,
 * position in metres, yawDeg, pitchDeg, fovDeg }).
 */

export interface DevCameraDeps {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: { enabled: boolean };
  container: HTMLElement;
  /** Room centre in plan centimetres (default camera position). */
  roomCentre: { x: number; z: number };
  requestRender: () => void;
}

declare global {
  interface Window {
    __fitroomCamera?: {
      width: number;
      height: number;
      fx: number;
      fy: number;
      cx: number;
      cy: number;
      position: { x: number; y: number; z: number };
      yawDeg: number;
      pitchDeg: number;
      fovDeg: number;
    };
  }
}

const PARAMS = ["camx", "camz", "cameye", "camyaw", "campitch", "camfov"] as const;

function param(search: URLSearchParams, key: string, fallback: number): number {
  const raw = search.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Hide every interface surface so only the 3D view remains. */
function hideChrome(): void {
  const style = document.createElement("style");
  style.id = "devcam-style";
  style.textContent = [
    ".top-bar, #catalog, #inspector, #recommend-panel, #assistant-panel,",
    "#render-viewer, .bottom-toolbar, .fit-badge, .fit-list, .size-tag,",
    ".fit-issue-labels, .plan-overlay, .measure { display: none !important; }",
    "#scene-container { top: 0 !important; left: 0 !important; right: 0 !important;",
    "bottom: 0 !important; border: 0 !important; border-radius: 0 !important;",
    "display: grid !important; place-items: center !important; background: #111 !important; }",
  ].join("\n");
  document.head.appendChild(style);
}

export function initDevCamera(deps: DevCameraDeps): void {
  let search: URLSearchParams;
  try {
    search = new URLSearchParams(window.location.search);
  } catch {
    return;
  }
  if (!PARAMS.some((key) => search.get(key) !== null)) return;

  const x = param(search, "camx", deps.roomCentre.x);
  const z = param(search, "camz", deps.roomCentre.z);
  const eye = param(search, "cameye", 160);
  const yawDeg = param(search, "camyaw", 0);
  const pitchDeg = param(search, "campitch", 0);
  const fovDeg = param(search, "camfov", 60);
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;

  hideChrome();
  deps.controls.enabled = false;

  // Exact 1:1 pixels so the published intrinsics match the image.
  deps.renderer.setPixelRatio(1);
  const fullW = Math.max(1, deps.container.clientWidth);
  const fullH = Math.max(1, deps.container.clientHeight);
  const frameW = Math.max(2, Math.floor(Math.min(fullW, (fullH * 4) / 3)));
  const frameH = Math.max(2, Math.floor((frameW * 3) / 4));
  deps.renderer.setSize(frameW, frameH, false);
  const canvas = deps.renderer.domElement;
  canvas.style.width = `${String(frameW)}px`;
  canvas.style.height = `${String(frameH)}px`;

  const px = x / 100;
  const py = eye / 100;
  const pz = z / 100;
  const dir = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  );
  deps.camera.position.set(px, py, pz);
  deps.camera.lookAt(px + dir.x, py + dir.y, pz + dir.z);
  deps.camera.fov = fovDeg;
  deps.camera.aspect = 4 / 3;
  deps.camera.updateProjectionMatrix();

  const size = deps.renderer.getDrawingBufferSize(new THREE.Vector2());
  const w = size.x;
  const h = size.y;
  const halfVFov = (fovDeg * Math.PI) / 180 / 2;
  const fy = h / 2 / Math.tan(halfVFov);
  // Square pixels: both focal lengths derive from the same pixel pitch, so
  // fx equals fy (the 4:3 frame keeps the horizontal field consistent).
  const fx = fy;
  window.__fitroomCamera = {
    width: w,
    height: h,
    fx: Math.round(fx * 100) / 100,
    fy: Math.round(fy * 100) / 100,
    cx: w / 2,
    cy: h / 2,
    position: { x: px, y: py, z: pz },
    yawDeg,
    pitchDeg,
    fovDeg,
  };
  deps.requestRender();
}
