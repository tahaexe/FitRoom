import * as THREE from "three";
import type { RoomLayout } from "@fitroom/shared";

export interface CaptureResult {
  /** `data:image/jpeg;base64,...` URL at 1024 px wide. */
  dataUrl: string;
  /** Bare base64 JPEG bytes (no prefix), for the gateway body. */
  base64: string;
  width: number;
  height: number;
}

const CAPTURE_WIDTH = 1024;
/** About 5% margin on the tighter side of the capture frame. */
const CAPTURE_MARGIN = 1.05;
/** NDC half-extent the room must fit inside (1 / margin). */
const FRAME_LIMIT = 1 / CAPTURE_MARGIN;
/** Capture height when the room's projection is taller than the stage. */
const TALL_CAPTURE_HEIGHT = 768;
/** Centering rounds after each fit (fixed view direction, moved target). */
const CENTER_ROUNDS = 4;

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
 * World-space points of the room shell exactly as the capture sees it:
 * the world bounding-box corners of every visible mesh under
 * `fitroom-room`, honouring the dollhouse cutaway (`updateDollhouse`
 * hides two walls by flipping `visible`) and skipping the studio backdrop
 * disc. Furniture, overlays and the contact catcher live outside the
 * shell group, so they never drive the frame. Returns an empty list when
 * the shell is missing, in which case the capture keeps the live camera.
 */
export function collectShellPoints(scene: THREE.Scene): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  const shell = scene.getObjectByName("fitroom-room");
  if (shell === undefined) return points;
  shell.updateWorldMatrix(true, true);
  shell.traverse((object) => {
    if (object.name === "fitroom-backdrop") return;
    if (!(object instanceof THREE.Mesh)) return;
    let ancestor: THREE.Object3D | null = object;
    while (ancestor !== null) {
      if (!ancestor.visible) return;
      ancestor = ancestor.parent;
    }
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    for (let i = 0; i < 8; i += 1) {
      points.push(
        new THREE.Vector3(
          (i & 1) === 0 ? box.min.x : box.max.x,
          (i & 2) === 0 ? box.min.y : box.max.y,
          (i & 4) === 0 ? box.min.z : box.max.z,
        ),
      );
    }
  });
  return points;
}

/** NDC bounds of world points through the camera (projection must be current). */
export function projectBounds(
  camera: THREE.Camera,
  points: readonly THREE.Vector3[],
): { minX: number; maxX: number; minY: number; maxY: number } {
  camera.updateMatrixWorld();
  const probe = new THREE.Vector3();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    probe.copy(point).project(camera);
    if (!Number.isFinite(probe.x) || !Number.isFinite(probe.y)) continue;
    minX = Math.min(minX, probe.x);
    maxX = Math.max(maxX, probe.x);
    minY = Math.min(minY, probe.y);
    maxY = Math.max(maxY, probe.y);
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Closest distance along `dir` from `target` where every point projects
 * inside the frame with margin. Bisected (48 rounds): nearer fails, farther
 * always fits.
 */
function fitDistance(
  camera: THREE.PerspectiveCamera,
  points: THREE.Vector3[],
  target: THREE.Vector3,
  dir: THREE.Vector3,
): number {
  const probe = new THREE.Vector3();
  const fits = (dist: number): boolean => {
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    for (const point of points) {
      probe.copy(point).applyMatrix4(camera.matrixWorldInverse);
      if (!(probe.z < -0.2)) return false;
      probe.copy(point).project(camera);
      if (!Number.isFinite(probe.x) || !Number.isFinite(probe.y)) return false;
      if (Math.abs(probe.x) > FRAME_LIMIT || Math.abs(probe.y) > FRAME_LIMIT) return false;
    }
    return true;
  };
  let lo = 0.2;
  let hi = 1;
  if (fits(lo)) return lo;
  let guard = 0;
  while (!fits(hi) && guard < 64) {
    hi *= 2;
    guard += 1;
  }
  for (let i = 0; i < 48; i += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Horizontal camera-side direction for the dollhouse first view: opposite
 * the average outward of the walls holding windows, so the window walls
 * are the drawn (far) pair instead of the cut-away pair. Rooms without
 * windows keep the south-east corner. Pure plan maths, headless-testable.
 */
export function facingDirForRoom(room: RoomLayout): { x: number; z: number } {
  let cx = 0;
  let cz = 0;
  for (const wall of room.walls) {
    cx += (wall.start.x + wall.end.x) / 2;
    cz += (wall.start.z + wall.end.z) / 2;
  }
  cx /= Math.max(1, room.walls.length);
  cz /= Math.max(1, room.walls.length);
  const windowWalls = new Set(
    room.openings.filter((o) => o.type === "window").map((o) => o.wallId),
  );
  let ax = 0;
  let az = 0;
  let count = 0;
  for (const wall of room.walls) {
    if (!windowWalls.has(wall.id)) continue;
    const mx = (wall.start.x + wall.end.x) / 2;
    const mz = (wall.start.z + wall.end.z) / 2;
    const len = Math.hypot(mx - cx, mz - cz) || 1;
    ax += (mx - cx) / len;
    az += (mz - cz) / len;
    count += 1;
  }
  if (count === 0 || Math.hypot(ax, az) < 1e-6) {
    const dl = Math.hypot(0.85, 1) || 1;
    return { x: 0.85 / dl, z: 1 / dl };
  }
  const hl = Math.hypot(ax, az) || 1;
  return { x: -ax / hl, z: -az / hl };
}

/**
 * Frame a perspective camera onto the room shell with a small margin,
 * keeping the current view direction. The distance fits every visible
 * shell point; the target then slides (fixed direction) until the
 * projected room sits centred, so the span — not just one edge — fills
 * the frame. Leaves the camera framed on the room.
 */
export function fitRoomPerspective(
  camera: THREE.PerspectiveCamera,
  points: THREE.Vector3[],
  aspect: number,
): { target: THREE.Vector3; distance: number } {
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  const box = new THREE.Box3().setFromPoints(points);
  const target = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const dir = camera.position.clone().sub(target);
  if (dir.lengthSq() < 1e-6) dir.set(0.85, 0.85, 1);
  dir.normalize();
  let distance = fitDistance(camera, points, target, dir);
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  for (let round = 0; round < CENTER_ROUNDS; round += 1) {
    camera.position.copy(target).addScaledVector(dir, distance);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const bounds = projectBounds(camera, points);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    if (Math.abs(cx) < 0.005 && Math.abs(cy) < 0.005) break;
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance;
    const halfW = halfH * camera.aspect;
    target.addScaledVector(right, cx * halfW).addScaledVector(up, cy * halfH);
    distance = fitDistance(camera, points, target, dir);
  }
  camera.position.copy(target).addScaledVector(dir, distance);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return { target: target.clone(), distance };
}

/**
 * Capture size for a room of projected aspect `roomAspect` (pixels wide /
 * pixels tall) on a stage of `stageW` × `stageH`: when the room's
 * projection is taller than the stage, capture at about 4:3 (1024 × 768)
 * so the room fills the width too; otherwise keep the stage's aspect at
 * 1024 px wide.
 */
export function captureSizeForRoom(
  stageW: number,
  stageH: number,
  roomAspect: number,
): { width: number; height: number } {
  const stageAspect = stageW > 0 && stageH > 0 ? stageW / stageH : 16 / 9;
  if (roomAspect < stageAspect) return { width: CAPTURE_WIDTH, height: TALL_CAPTURE_HEIGHT };
  return {
    width: CAPTURE_WIDTH,
    height: Math.max(1, Math.round(CAPTURE_WIDTH / stageAspect)),
  };
}

/**
 * Capture the current dollhouse, eye-level or plan view at 1024 px wide as
 * JPEG (quality 0.85), hiding every overlay for that frame: the verdict
 * badge, floating labels, clearance shading, door arcs and the selection
 * outline. DOM overlays never reach the WebGL pixels, but they are hidden
 * too so the frame the customer sees matches the capture.
 *
 * The room fills the frame with a small margin whatever the view on
 * screen: the capture reframes onto the visible room shell (floor plus
 * the walls the dollhouse cutaway keeps, in world space — never the
 * hidden pair and never the studio backdrop), centred, keeping the
 * current view direction, instead of copying the on-screen camera
 * distance. When the room's projection is taller than the stage the
 * capture is 1024 × 768 so the room fills the width too. Everything is
 * restored before returning; the renderer keeps its original size and
 * pixel ratio.
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
  const stageAspect = prevSize.x > 0 && prevSize.y > 0 ? prevSize.x / prevSize.y : 16 / 9;
  let width = CAPTURE_WIDTH;
  let height = Math.max(1, Math.round(CAPTURE_WIDTH / stageAspect));
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

  const points = collectShellPoints(scene);
  if (points.length > 0) {
    if (isPerspective) {
      // Provisional fit at the stage aspect to learn the room's projected
      // shape, then capture tall rooms at 4:3 and fit again.
      fitRoomPerspective(camera, points, stageAspect);
      const bounds = projectBounds(camera, points);
      const spanY = Math.max(1e-6, bounds.maxY - bounds.minY);
      const roomAspect = ((bounds.maxX - bounds.minX) * stageAspect) / spanY;
      const size = captureSizeForRoom(prevSize.x, prevSize.y, roomAspect);
      width = size.width;
      height = size.height;
      if (Math.abs(width / height - stageAspect) > 1e-6) {
        fitRoomPerspective(camera, points, width / height);
      }
    } else if (isOrtho) {
      const box = new THREE.Box3().setFromPoints(points);
      if (!box.isEmpty()) {
        const size3 = box.getSize(new THREE.Vector3());
        const centre = box.getCenter(new THREE.Vector3());
        const roomAspect = size3.x > 1e-9 && size3.z > 1e-9 ? size3.x / size3.z : stageAspect;
        const size = captureSizeForRoom(prevSize.x, prevSize.y, roomAspect);
        width = size.width;
        height = size.height;
        const sizedAspect = width / height;
        const hw = (size3.x / 2) * CAPTURE_MARGIN;
        const hd = (size3.z / 2) * CAPTURE_MARGIN;
        const halfH = Math.max(hd, hw / sizedAspect);
        camera.left = -halfH * sizedAspect;
        camera.right = halfH * sizedAspect;
        camera.top = halfH;
        camera.bottom = -halfH;
        camera.position.set(centre.x, camera.position.y, centre.z);
        camera.updateProjectionMatrix();
      }
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
