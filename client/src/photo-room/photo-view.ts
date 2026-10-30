/**
 * "See it in your photo": the built example room's placed pieces drawn over
 * the room's own wall photos at true size, with the camera the geometry
 * measured from each photo. No model call, no request: the photo loads as
 * a static image and the pieces render from the groups the scene syncer
 * already loaded (cloned, sharing their materials and geometry).
 *
 * Pure camera maths stays in `@fitroom/shared` (`recoverWallPhotoCamera`);
 * this module only classifies pieces against the photo frame and draws the
 * DOM + transparent three.js layer over the static photo.
 */

import * as THREE from "three";
import {
  projectWallPhotoCamera,
  recoverWallPhotoCamera,
  wallPhotoCameraThree,
  type RoomLayout,
  type SceneItem,
  type WallLetter,
  type CatalogItem,
} from "@fitroom/shared";
import type { WallPhotoCamera } from "@fitroom/shared";
import { exampleBadge, exampleWebpUrl } from "./example.js";
import type { ExampleWallCamera } from "./example-cameras.js";
import { PHOTO_VIEW_CLOSE, PHOTO_VIEW_LINE, PHOTO_VIEW_ROTATE, photoViewOutside } from "../copy.js";

export const PHOTO_VIEW_LETTERS: WallLetter[] = ["A", "B", "C", "D"];

/** A placed piece as a room-cm box (rotation about Y, centre-based). */
export interface PhotoPieceBox {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  rotationY: number;
}

/** Box corners in room cm: four at the floor, four at the top. */
export function photoPieceCorners(box: PhotoPieceBox): Array<{ x: number; y: number; z: number }> {
  const rad = (box.rotationY * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (const y of [0, box.h]) {
    for (const [lx, lz] of [
      [-box.w / 2, -box.d / 2],
      [box.w / 2, -box.d / 2],
      [box.w / 2, box.d / 2],
      [-box.w / 2, box.d / 2],
    ] as const) {
      out.push({ x: box.x + lx * cos + lz * sin, y, z: box.z - lx * sin + lz * cos });
    }
  }
  return out;
}

/** Contact-shadow margin all round a piece's footprint, in room cm. */
export const PHOTO_SHADOW_MARGIN_CM = 10;

/**
 * Floor-plane corners (y 0) of a piece's contact shadow: the footprint
 * widened by the shadow margin all round, centred under the piece and
 * turned with it. Pure geometry for the headless check; the view draws
 * this same rect as a soft ellipse in its three.js layer.
 */
export function photoPieceShadowCorners(
  box: PhotoPieceBox,
  marginCm: number = PHOTO_SHADOW_MARGIN_CM,
): Array<{ x: number; y: number; z: number }> {
  const rad = (box.rotationY * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (const [lx, lz] of [
    [-(box.w / 2 + marginCm), -(box.d / 2 + marginCm)],
    [box.w / 2 + marginCm, -(box.d / 2 + marginCm)],
    [box.w / 2 + marginCm, box.d / 2 + marginCm],
    [-(box.w / 2 + marginCm), box.d / 2 + marginCm],
  ] as const) {
    out.push({ x: box.x + lx * cos + lz * sin, y: 0, z: box.z - lx * sin + lz * cos });
  }
  return out;
}

export interface ClassifiedPiece {
  visible: boolean;
  projected: Array<{ x: number; y: number; z: number }>;
}

/**
 * Project a piece's box through the photo camera. A piece wholly behind
 * the camera or with no corner inside the photo frame is left out.
 */
export function classifyPhotoPiece(cam: WallPhotoCamera, box: PhotoPieceBox): ClassifiedPiece {
  const projected = photoPieceCorners(box).map((point) => projectWallPhotoCamera(cam, point));
  const inFrame = (point: { x: number; y: number }): boolean =>
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.x <= cam.imageWidth &&
    point.y >= 0 &&
    point.y <= cam.imageHeight;
  const visible = projected.some((point, index) => {
    void index;
    return point.z > 1e-9 && inFrame(point);
  });
  return { visible, projected };
}

function roomSpan(room: RoomLayout): { widthCm: number; depthCm: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const wall of room.walls) {
    for (const point of [wall.start, wall.end]) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
  }
  return {
    widthCm: Number.isFinite(minX) && Number.isFinite(maxX) ? maxX - minX : 420,
    depthCm: Number.isFinite(minZ) && Number.isFinite(maxZ) ? maxZ - minZ : 360,
  };
}

/**
 * The stored record as a live camera, measured against the built room's
 * own wall length and ceiling height so the photo and the 3D room agree.
 */
export function photoCameraForRecord(
  room: RoomLayout,
  record: ExampleWallCamera,
): WallPhotoCamera | null {
  const span = roomSpan(room);
  const wall = room.walls.find((entry) => entry.id === record.wallId);
  const wallLenCm =
    wall !== undefined
      ? Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z)
      : record.wall === "A" || record.wall === "C"
        ? span.widthCm
        : span.depthCm;
  const wallHeightCm = room.walls[0]?.height ?? 260;
  return recoverWallPhotoCamera({
    corners: record.corners,
    wall: record.wall,
    wallLenCm,
    wallHeightCm,
    roomWidthCm: span.widthCm,
    roomDepthCm: span.depthCm,
    focalPx: record.focalPx,
    imageWidth: record.width,
    imageHeight: record.height,
  });
}

export interface PhotoViewGroup {
  group: THREE.Group;
}

/** One piece drawn into the photo overlay: the clone and its shadow. */
export interface PhotoOverlayPiece {
  item: SceneItem;
  clone: THREE.Group;
  shadow: THREE.Mesh;
}

/** The overlay scene with each drawn piece listed for tests. */
export interface PhotoOverlayBuild {
  overlay: THREE.Scene;
  drawn: PhotoOverlayPiece[];
  outsideCount: number;
}

/**
 * Build the overlay scene: a holder per visible piece carries only the
 * contact-shadow plane at the piece's position and rotation, while the
 * piece's clone goes straight into the overlay so its transform is the
 * scene's alone (the live group already stands at the piece's room
 * position and rotation). Both the view and `check:photo-view` call this.
 */
export function buildPhotoOverlay(args: {
  items: SceneItem[];
  groups: Map<string, PhotoViewGroup>;
  catalog: Map<string, CatalogItem>;
  cam: WallPhotoCamera;
  room: RoomLayout;
}): PhotoOverlayBuild {
  const { items, groups, catalog, cam, room } = args;
  const overlay = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xfff6ec, 0x9aa0a6, 0.55);
  overlay.add(hemi);
  const span = roomSpan(room);
  const radius = Math.max(span.widthCm, span.depthCm) / 100;
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.position.set(radius * 1.2, 2.6 + radius * 1.4, radius * 0.8);
  overlay.add(sun);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    ...(typeof document !== "undefined" ? { map: photoShadowTexture() } : {}),
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const drawn: PhotoOverlayPiece[] = [];
  let outsideCount = 0;
  for (const item of items) {
    const entry = groups.get(item.instanceId);
    const product = catalog.get(item.productId);
    if (entry === undefined || product === undefined) continue;
    const box: PhotoPieceBox = {
      x: item.position.x,
      z: item.position.z,
      w: product.size.w,
      d: product.size.d,
      h: product.size.h,
      rotationY: item.rotationY,
    };
    const classified = classifyPhotoPiece(cam, box);
    if (!classified.visible) {
      outsideCount += 1;
      continue;
    }
    const holder = new THREE.Group();
    holder.position.set(item.position.x / 100, 0, item.position.z / 100);
    holder.rotation.y = (item.rotationY * Math.PI) / 180;
    const shadowMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(
        (box.w + PHOTO_SHADOW_MARGIN_CM * 2) / 100,
        (box.d + PHOTO_SHADOW_MARGIN_CM * 2) / 100,
      ),
      shadowMaterial,
    );
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.position.y = 0.002;
    holder.add(shadowMesh);
    overlay.add(holder);
    const clone = entry.group.clone(true);
    overlay.add(clone);
    drawn.push({ item, clone, shadow: shadowMesh });
  }
  return { overlay, drawn, outsideCount };
}

export interface PhotoViewDeps {
  getRoom: () => RoomLayout;
  getItems: () => SceneItem[];
  getGroups: () => Map<string, PhotoViewGroup>;
  getCatalog: () => Map<string, CatalogItem>;
  getRecords: () => ExampleWallCamera[] | null;
  onClose: () => void;
}

/**
 * The photo view over the 3D room: static wall photo with the placed
 * pieces rendered over it on a transparent layer. Own renderer, scene and
 * camera: closing it leaves the 3D view, its camera and its renderer
 * exactly as they were (the live groups are only cloned, never moved).
 */
export class PhotoView {
  readonly element: HTMLElement;
  private letter: WallLetter = "A";
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly deps: PhotoViewDeps;
  private stage: HTMLElement | null = null;
  private outside: HTMLElement | null = null;
  private tabs: HTMLElement | null = null;
  private photoW = 0;
  private photoH = 0;
  private fitListener: (() => void) | null = null;

  constructor(deps: PhotoViewDeps) {
    this.deps = deps;
    this.element = document.createElement("div");
    this.element.className = "photo-view";
    this.element.setAttribute("role", "dialog");
    this.element.setAttribute("aria-label", PHOTO_VIEW_LINE);
  }

  /** Build the DOM (photo A first) and draw. */
  open(): HTMLElement {
    this.element.innerHTML = "";
    const bar = document.createElement("div");
    bar.className = "photo-view-bar";
    const caption = document.createElement("p");
    caption.className = "photo-example-caption";
    caption.textContent = exampleBadge(this.letter);
    const tabs = document.createElement("div");
    tabs.className = "photo-view-tabs";
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Wall photo");
    for (const wall of PHOTO_VIEW_LETTERS) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "photo-view-tab";
      tab.textContent = wall;
      tab.setAttribute("aria-pressed", String(wall === this.letter));
      tab.addEventListener("click", () => this.setLetter(wall));
      tabs.appendChild(tab);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "photo-view-close";
    close.textContent = PHOTO_VIEW_CLOSE;
    close.addEventListener("click", () => this.deps.onClose());
    bar.append(caption, tabs, close);
    const line = document.createElement("p");
    line.className = "photo-view-line";
    line.textContent = PHOTO_VIEW_LINE;
    const stage = document.createElement("div");
    stage.className = "photo-view-stage";
    const outside = document.createElement("p");
    outside.className = "photo-view-outside";
    outside.setAttribute("hidden", "");
    const rotate = document.createElement("p");
    rotate.className = "photo-view-rotate";
    rotate.textContent = PHOTO_VIEW_ROTATE;
    this.element.append(bar, line, stage, rotate, outside);
    this.stage = stage;
    this.outside = outside;
    this.tabs = tabs;
    this.draw();
    if (typeof window !== "undefined") {
      this.fitListener = () => this.fitStage();
      window.addEventListener("resize", this.fitListener);
    }
    return this.element;
  }

  get activeLetter(): WallLetter {
    return this.letter;
  }

  setLetter(letter: WallLetter): void {
    if (this.letter === letter) return;
    this.letter = letter;
    if (this.tabs !== null) {
      for (const [index, wall] of PHOTO_VIEW_LETTERS.entries()) {
        const tab = this.tabs.children[index];
        if (tab instanceof HTMLElement) tab.setAttribute("aria-pressed", String(wall === letter));
      }
    }
    const caption = this.element.querySelector(".photo-example-caption");
    if (caption !== null) caption.textContent = exampleBadge(letter);
    this.draw();
  }

  /** Re-draw the current photo (placed pieces changed). */
  refresh(): void {
    if (this.stage === null) return;
    this.draw();
  }

  /** Tear down the overlay renderer; the 3D view is untouched. */
  close(): void {
    try {
      this.renderer?.dispose();
    } catch {
      // Disposal is best-effort; the live scene keeps its own state.
    }
    if (typeof window !== "undefined" && this.fitListener !== null) {
      window.removeEventListener("resize", this.fitListener);
    }
    this.fitListener = null;
    this.renderer = null;
    this.stage = null;
    this.outside = null;
    this.tabs = null;
    this.element.remove();
  }

  private record(): ExampleWallCamera | null {
    return this.deps.getRecords()?.find((entry) => entry.wall === this.letter) ?? null;
  }

  private draw(): void {
    const stage = this.stage;
    const outside = this.outside;
    if (stage === null || outside === null) return;
    stage.innerHTML = "";
    outside.setAttribute("hidden", "");
    outside.textContent = "";
    const room = this.deps.getRoom();
    const record = this.record();
    if (record === null) return;
    const cam = photoCameraForRecord(room, record);
    if (cam === null) return;
    const img = document.createElement("img");
    img.className = "photo-view-img";
    img.src = exampleWebpUrl(this.letter);
    img.alt = `Wall ${this.letter} generated example photo`;
    img.draggable = false;
    stage.appendChild(img);
    const layer = document.createElement("div");
    layer.className = "photo-view-layer";
    stage.appendChild(layer);
    const catalog = this.deps.getCatalog();
    const groups = this.deps.getGroups();
    const three = wallPhotoCameraThree(cam);
    const built = buildPhotoOverlay({
      items: this.deps.getItems(),
      groups,
      catalog,
      cam,
      room,
    });
    const overlay = built.overlay;
    const camera = new THREE.PerspectiveCamera(cam.vfovDeg, cam.aspect, 0.05, 200);
    camera.position.set(three.positionM.x, three.positionM.y, three.positionM.z);
    camera.quaternion.set(
      three.quaternion.x,
      three.quaternion.y,
      three.quaternion.z,
      three.quaternion.w,
    );
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const outsideCount = built.outsideCount;
    this.photoW = cam.imageWidth;
    this.photoH = cam.imageHeight;
    try {
      if (this.renderer === null) {
        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        this.renderer.toneMapping = THREE.NeutralToneMapping;
        this.renderer.toneMappingExposure = 1.35;
      }
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setSize(record.width, record.height, false);
      this.renderer.render(overlay, camera);
      const canvas = this.renderer.domElement;
      canvas.className = "photo-view-canvas";
      layer.appendChild(canvas);
    } catch {
      // Headless or WebGL-less contexts keep the photo with its caption.
    }
    if (outsideCount > 0) {
      outside.textContent = photoViewOutside(outsideCount);
      outside.removeAttribute("hidden");
    }
    this.fitStage();
  }

  /**
   * Size the stage to the largest box that keeps the photo's aspect ratio
   * and fits both the view's width and the height left between the view's
   * top rows (caption, tabs, Close, the line) and the outside-photo line,
   * never wider than the photo itself. The layer, canvas and shadows are
   * absolutely positioned over the stage, so they stay exactly on the
   * photo at every size and after a window resize.
   */
  private fitStage(): void {
    const stage = this.stage;
    if (stage === null) return;
    if (this.photoW <= 0 || this.photoH <= 0) return;
    if (typeof window === "undefined") return;
    const view = this.element;
    const style = window.getComputedStyle(view);
    const padX =
      (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const padY =
      (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const gap = Number.parseFloat(style.rowGap || style.gap) || 0;
    let usedY = padY;
    let count = 1;
    const bar = view.querySelector(".photo-view-bar");
    if (bar instanceof HTMLElement) {
      usedY += bar.offsetHeight;
      count += 1;
    }
    const line = view.querySelector(".photo-view-line");
    if (line instanceof HTMLElement) {
      usedY += line.offsetHeight;
      count += 1;
    }
    if (this.outside instanceof HTMLElement && !this.outside.hasAttribute("hidden")) {
      usedY += this.outside.offsetHeight;
      count += 1;
    }
    usedY += gap * Math.max(0, count - 1);
    const availW = Math.max(0, view.clientWidth - padX);
    const availH = Math.max(0, view.clientHeight - usedY);
    if (availW <= 0 || availH <= 0) return;
    const aspect = this.photoW / this.photoH;
    const width = Math.min(availW, this.photoW, availH * aspect);
    if (width <= 0) return;
    stage.style.width = `${String(width)}px`;
    stage.style.height = `${String(width / aspect)}px`;
  }
}

let contactTexture: THREE.CanvasTexture | null = null;

/**
 * Shared soft-edged dark ellipse texture for contact shadows: about 0.35
 * opacity at the centre fading to transparent at the edge. Stretched over
 * each piece's footprint-plus-margin plane it reads as an ellipse and
 * takes the photo's perspective from the shared camera by itself.
 */
function photoShadowTexture(): THREE.CanvasTexture {
  if (contactTexture === null) {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx !== null) {
      const gradient = ctx.createRadialGradient(
        size / 2,
        size / 2,
        0,
        size / 2,
        size / 2,
        size / 2,
      );
      gradient.addColorStop(0, "rgba(0,0,0,0.35)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }
    contactTexture = new THREE.CanvasTexture(canvas);
  }
  return contactTexture;
}
