import "@fontsource/nunito/400.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type {
  CatalogItem,
  FitAnalysis,
  FitIssue,
  PlanPoint,
  RoomLayout,
  SceneItem,
  SceneState,
} from "@fitroom/shared";
import { FitEngine, cmToMeters, isHealthResponse } from "@fitroom/shared";
import roomJson from "../../shared/samples/living-420x360.json";
import catalogJson from "../../shared/catalog/catalog.json";
import validScene from "../../shared/samples/fit-tests/valid.json";
import overlapScene from "../../shared/samples/fit-tests/overlap.json";
import outsideScene from "../../shared/samples/fit-tests/outside.json";
import doorSwingScene from "../../shared/samples/fit-tests/door-swing.json";
import walkway70Scene from "../../shared/samples/fit-tests/walkway-70.json";
import walkway78Scene from "../../shared/samples/fit-tests/walkway-78.json";
import walkway82Scene from "../../shared/samples/fit-tests/walkway-82.json";
import shallowWallScene from "../../shared/samples/fit-tests/shallow-wall.json";
import shallowBoxedScene from "../../shared/samples/fit-tests/shallow-boxed.json";
import { CatalogPanel } from "./catalog-ui";
import { applyVariant, loadModel } from "./models";
import { PlanOverlay } from "./plan";
import { FitOverlay } from "./fit-overlay";
import { Inspector } from "./inspector";
import { buildRoom, WALL_MATERIAL } from "./room";
import { makeFloorMaterial, requestContactRefresh, setupStage, type StageRig } from "./stage";
import {
  catalogProducts,
  distanceToWallM,
  makeInstanceId,
  nearestFreeSpot,
  roomBounds,
  SceneStore,
  snapToGrid,
} from "./state";
import "./style.css";

/** Dev menu: the nine fit-test scenes, loadable from the bottom toolbar. */
const TEST_SCENES: Record<string, SceneState> = {
  valid: validScene as unknown as SceneState,
  overlap: overlapScene as unknown as SceneState,
  outside: outsideScene as unknown as SceneState,
  "door-swing": doorSwingScene as unknown as SceneState,
  "walkway-70": walkway70Scene as unknown as SceneState,
  "walkway-78": walkway78Scene as unknown as SceneState,
  "walkway-82": walkway82Scene as unknown as SceneState,
  "shallow-wall": shallowWallScene as unknown as SceneState,
  "shallow-boxed": shallowBoxedScene as unknown as SceneState,
};

const ROOM = roomJson as unknown as RoomLayout;
const CATALOG = catalogJson as unknown as CatalogItem[];
const CATALOG_MAP = new Map<string, CatalogItem>(CATALOG.map((c) => [c.id, c]));

const MAX_PIXEL_RATIO = 2;
const MIN_POLAR = 0.12;
const MAX_POLAR = Math.PI / 2 - 0.03;
// Reduced-resolution orbit on fill-rate-limited GPUs: while the camera moves,
// render at baseRatio * orbitScale, starting at 0.75 and adapting between
// 0.5 and 1.0 so frames stay under budget. Settles with one full-res frame.
const ORBIT_START_SCALE = 0.75;
const ORBIT_MIN_SCALE = 0.5;
const ORBIT_MAX_SCALE = 1.0;
const ORBIT_FRAME_BUDGET_MS = 16;

function apiPill(): HTMLElement | null {
  return document.getElementById("api-status");
}

async function refreshApiStatus(): Promise<void> {
  const pill = apiPill();
  if (pill === null) return;
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error("offline");
    const payload: unknown = await res.json();
    pill.dataset["state"] = isHealthResponse(payload) ? "ok" : "offline";
    pill.textContent = isHealthResponse(payload) ? "API: ok" : "API: offline";
  } catch {
    pill.dataset["state"] = "offline";
    pill.textContent = "API: offline";
  }
}

/** Plaster PBR on the shared wall material (ambientCG tiling). */
function dressWalls(onLoad: () => void): void {
  const loader = new THREE.TextureLoader();
  const base = "assets/textures/ambientcg/PaintedPlaster017/PaintedPlaster017_1K-JPG";
  const map = loader.load(`${base}_Color.jpg`, onLoad);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(2, 1);
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = loader.load(`${base}_NormalGL.jpg`, onLoad);
  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat.set(2, 1);
  WALL_MATERIAL.map = map;
  WALL_MATERIAL.normalMap = normalMap;
  WALL_MATERIAL.needsUpdate = true;
}

interface InstanceEntry {
  item: SceneItem;
  group: THREE.Group;
  variant: string;
}

class FitRoomApp {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private orbitCam: THREE.PerspectiveCamera;
  private planCam: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private rig: StageRig | null = null;
  private store: SceneStore;
  private instances = new Map<string, InstanceEntry>();
  private modelsRoot = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private floorMesh: THREE.Mesh | null = null;
  private selectedId: string | null = null;
  private outline: THREE.BoxHelper | null = null;
  private rotateHandle: THREE.Mesh;
  private sizeTag: HTMLElement;
  private measureEl: HTMLElement;
  private planOverlay: PlanOverlay;
  private fitOverlay: FitOverlay;
  private inspector: Inspector;
  private fitEngine: FitEngine;
  private analysis: FitAnalysis | null = null;
  private issues: FitIssue[] = [];
  private mode: "orbit" | "plan" = "orbit";
  private drag: { id: string; offsetX: number; offsetZ: number } | null = null;
  private rotating = false;
  /** Trailing debounce for live fit feedback while dragging (ms). */
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private container: HTMLElement;
  /** Render-on-demand: a queued rAF id (0 = none) plus a shadow refresh flag. */
  private rafId = 0;
  private shadowNeedsUpdate = true;
  /** Adaptive orbit resolution: full pixel ratio, current scale, motion flag. */
  private basePixelRatio = 1;
  private orbitScale = ORBIT_MAX_SCALE;
  private orbiting = false;
  private orbitEmaMs = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.store = new SceneStore(ROOM.id);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.basePixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    this.orbitCam = new THREE.PerspectiveCamera(50, aspect, 0.05, 200);
    this.orbitCam.position.set(3.4, 3.1, 4.2);

    const bounds = roomBounds(ROOM);
    const wM = cmToMeters(bounds.maxX - bounds.minX);
    const dM = cmToMeters(bounds.maxZ - bounds.minZ);
    const cxM = cmToMeters((bounds.minX + bounds.maxX) / 2);
    const czM = cmToMeters((bounds.minZ + bounds.maxZ) / 2);
    const half = Math.max(wM, dM) / 2 + 1;
    this.planCam = new THREE.OrthographicCamera(
      -half * aspect,
      half * aspect,
      half,
      -half,
      0.05,
      100,
    );
    this.planCam.position.set(cxM, 12, czM);
    this.planCam.up.set(0, 0, -1);
    this.planCam.lookAt(cxM, 0, czM);

    this.controls = new OrbitControls(this.orbitCam, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(cxM, 0.4, czM);
    this.controls.minPolarAngle = MIN_POLAR;
    this.controls.maxPolarAngle = MAX_POLAR;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 18;

    dressWalls(() => this.requestRender());
    const floorMat = makeFloorMaterial(wM, dM, () => this.requestRender());
    const built = buildRoom(ROOM, floorMat);
    this.scene.add(built.group);
    this.scene.add(this.modelsRoot);
    const floor = built.group.getObjectByName("fitroom-floor");
    if (floor instanceof THREE.Mesh) this.floorMesh = floor;
    this.rig = setupStage(this.renderer, this.scene, built.floorSize, built.wallHeightM, () =>
      this.requestRender(),
    );
    this.roomWalls = built.group;
    this.wallEntries = built.wallEntries.map((e) => ({
      wallId: e.wallId,
      meshes: e.meshes,
      outward: e.outward,
    }));

    // Selection outline + rotate handle + size tag.
    this.rotateHandle = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xf54e49 }),
    );
    this.rotateHandle.name = "fitroom-rotate-handle";
    this.rotateHandle.visible = false;
    this.scene.add(this.rotateHandle);

    const tagHost = document.getElementById("size-tag");
    this.sizeTag = tagHost ?? document.createElement("div");
    const measureHost = document.getElementById("measure-readout");
    this.measureEl = measureHost ?? document.createElement("div");

    this.planOverlay = new PlanOverlay(container, ROOM);
    this.planOverlay.setVisible(false);

    // Fit engine: wall + fixture blocking is precomputed once per room; each
    // check only re-stamps the footprints (or, while dragging, the moved
    // item's neighbourhood) before the two grid floods.
    this.fitEngine = new FitEngine(ROOM, catalogProducts(CATALOG_MAP));
    this.fitOverlay = new FitOverlay(this.scene, container);
    this.fitOverlay.setGroupResolver((id) => this.instances.get(id)?.group);

    const inspectorHost = document.getElementById("inspector");
    const host = inspectorHost ?? document.createElement("div");
    this.inspector = new Inspector(host, CATALOG_MAP, {
      onMove: (id, x, z) => this.commitMove(id, x, z),
      onRotate: (id, deg) => this.commitRotate(id, deg),
      onVariant: (id, variant) => this.commitVariant(id, variant),
      onDelete: (id) => this.deleteItem(id),
    });

    const catalogHost = document.getElementById("catalog");
    if (catalogHost !== null) {
      new CatalogPanel(catalogHost, CATALOG, (item) => void this.addItem(item));
    }

    this.bindToolbar();
    this.bindPointer();
    this.bindKeys();
    this.controls.addEventListener("change", () => this.requestRender());
    this.store.subscribe(() => {
      void this.syncInstances();
      this.refreshIssues();
      this.markSceneChanged();
    });

    const roomName = document.getElementById("room-name");
    if (roomName !== null) roomName.textContent = ROOM.name;
    document.getElementById("fit-badge")?.addEventListener("click", () => {
      document.getElementById("fit-list")?.toggleAttribute("hidden");
    });

    window.addEventListener("resize", () => this.resize());
    void this.syncInstances();
    this.refreshIssues();
    this.updateMeasure();
    this.updateTopBar();
    // Render on demand: frames only while the camera moves, after scene or
    // selection changes, or when a texture finishes loading. No idle loop.
    this.requestRender();
  }

  /** Queue a single frame unless one is already queued. */
  private requestRender(): void {
    if (this.rafId !== 0) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.frame();
    });
  }

  /** Scene or selection changed: refresh shadows once, then draw. */
  private markSceneChanged(): void {
    requestContactRefresh(this.rig);
    this.shadowNeedsUpdate = true;
    this.requestRender();
  }

  private roomWalls: THREE.Group;
  private wallEntries: Array<{ wallId: string; meshes: THREE.Mesh[]; outward: THREE.Vector3 }>;

  // ---- mutations ----

  private async addItem(item: CatalogItem): Promise<void> {
    // Start the search where the user is looking (camera target on the floor).
    const start = { x: this.controls.target.x * 100, z: this.controls.target.z * 100 };
    const spot = nearestFreeSpot(item.id, CATALOG_MAP, ROOM, this.store.state, start);
    const instance: SceneItem = {
      instanceId: makeInstanceId(item.id),
      productId: item.id,
      position: { x: Math.round(spot.x), z: Math.round(spot.z) },
      rotationY: spot.rotationY,
      variant: item.variants[0]?.name ?? "",
    };
    this.store.commit((draft) => {
      draft.items.push(instance);
    });
    this.select(instance.instanceId);
  }

  private commitMove(id: string, x: number, z: number): void {
    this.store.commit((draft) => {
      const it = draft.items.find((i) => i.instanceId === id);
      if (it !== undefined) {
        it.position = { x: Math.round(x), z: Math.round(z) };
      }
    });
  }

  private commitRotate(id: string, deg: number): void {
    const norm = ((deg % 360) + 360) % 360;
    this.store.commit((draft) => {
      const it = draft.items.find((i) => i.instanceId === id);
      if (it !== undefined) it.rotationY = Math.round(norm * 10) / 10;
    });
  }

  private commitVariant(id: string, variant: string): void {
    this.store.commit((draft) => {
      const it = draft.items.find((i) => i.instanceId === id);
      if (it !== undefined) it.variant = variant;
    });
  }

  private deleteItem(id: string): void {
    this.store.commit((draft) => {
      draft.items = draft.items.filter((i) => i.instanceId !== id);
    });
    if (this.selectedId === id) this.select(null);
  }

  private select(id: string | null): void {
    this.selectedId = id;
    if (this.outline !== null) {
      this.scene.remove(this.outline);
      this.outline.geometry.dispose();
      this.outline = null;
    }
    const entry = id === null ? undefined : this.instances.get(id);
    if (entry !== undefined) {
      const inError =
        id !== null && this.issues.some((f) => f.severity === "error" && f.itemIds.includes(id));
      this.outline = new THREE.BoxHelper(entry.group, inError ? 0xb3261e : 0xe59500);
      this.scene.add(this.outline);
      this.rotateHandle.visible = true;
      this.positionHandle(entry);
    } else {
      this.rotateHandle.visible = false;
    }
    const current =
      id === null ? null : (this.store.state.items.find((i) => i.instanceId === id) ?? null);
    this.inspector.setSelection(current);
    this.updateMeasure();
    this.requestRender();
  }

  private positionHandle(entry: InstanceEntry): void {
    const box = new THREE.Box3().setFromObject(entry.group);
    const center = box.getCenter(new THREE.Vector3());
    this.rotateHandle.position.set(center.x, box.max.y + 0.25, center.z);
  }

  // ---- sync ----

  private async syncInstances(): Promise<void> {
    const seen = new Set<string>();
    for (const item of this.store.state.items) {
      seen.add(item.instanceId);
      const existing = this.instances.get(item.instanceId);
      const entry = CATALOG_MAP.get(item.productId);
      if (entry === undefined) continue;
      if (existing === undefined) {
        try {
          const group = await loadModel(entry);
          group.position.set(cmToMeters(item.position.x), 0, cmToMeters(item.position.z));
          group.rotation.y = (item.rotationY * Math.PI) / 180;
          await applyVariant(group, entry, item.variant);
          this.modelsRoot.add(group);
          this.instances.set(item.instanceId, { item: { ...item }, group, variant: item.variant });
        } catch {
          continue;
        }
      } else {
        existing.group.position.set(cmToMeters(item.position.x), 0, cmToMeters(item.position.z));
        existing.group.rotation.y = (item.rotationY * Math.PI) / 180;
        if (existing.variant !== item.variant) {
          const parent = existing.group.parent;
          if (parent !== null) parent.remove(existing.group);
          try {
            const group = await loadModel(entry);
            group.position.copy(existing.group.position);
            group.rotation.y = (item.rotationY * Math.PI) / 180;
            await applyVariant(group, entry, item.variant);
            this.modelsRoot.add(group);
            existing.group = group;
            existing.variant = item.variant;
          } catch {
            continue;
          }
        }
        existing.item = { ...item };
      }
    }
    for (const [id, entry] of this.instances) {
      if (!seen.has(id)) {
        this.modelsRoot.remove(entry.group);
        this.instances.delete(id);
      }
    }
    if (this.selectedId !== null && !this.instances.has(this.selectedId)) {
      this.select(null);
    } else if (this.selectedId !== null) {
      this.select(this.selectedId);
    }
    this.updateMeasure();
    // Models (and their textures) arrived asynchronously: draw + refresh shadows.
    this.markSceneChanged();
    // Newly loaded groups may complete the issue outlines: refresh the check.
    this.refreshIssues();
  }

  /**
   * Re-run the fit check. While dragging, pass the moved item id so only
   * its neighbourhood is re-stamped; commits re-check everything.
   */
  private refreshIssues(movedIds?: readonly string[]): void {
    this.analysis = this.fitEngine.analyze(this.store.state, movedIds);
    this.issues = this.analysis.issues;
    const badge = document.getElementById("fit-badge");
    if (badge instanceof HTMLButtonElement) {
      const errors = this.issues.filter((i) => i.severity === "error").length;
      const warns = this.issues.length - errors;
      if (errors > 0) {
        badge.dataset["state"] = "bad";
        badge.textContent = `✕ ${errors} problem${errors === 1 ? "" : "s"}`;
      } else if (warns > 0) {
        badge.dataset["state"] = "warn";
        badge.textContent = `! ${warns} warning${warns === 1 ? "" : "s"}`;
      } else {
        badge.dataset["state"] = "good";
        badge.textContent = "✓ Everything fits";
      }
    }
    this.fitOverlay.setAnalysis(this.analysis, this.issues);
    this.renderFitList();
    this.updateTopBar();
  }

  /** Live fit feedback while dragging, trailing-debounced to stay smooth. */
  private scheduleLiveIssues(movedId: string): void {
    if (this.liveTimer !== null) clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      this.refreshIssues([movedId]);
    }, 120);
  }

  /** Problem list opened from the fit badge; picking one focuses the camera. */
  private renderFitList(): void {
    const host = document.getElementById("fit-list");
    if (host === null) return;
    host.innerHTML = "";
    if (this.issues.length === 0) {
      host.setAttribute("hidden", "");
      return;
    }
    for (const issue of this.issues) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset["severity"] = issue.severity;
      const first = issue.itemIds[0];
      const item =
        first === undefined
          ? undefined
          : this.store.state.items.find((i) => i.instanceId === first);
      const entry = item === undefined ? undefined : CATALOG_MAP.get(item.productId);
      b.textContent = `${issue.severity === "error" ? "✕" : "!"} ${issue.message}${entry === undefined ? "" : ` — ${entry.name}`}`;
      b.addEventListener("click", () => {
        if (first !== undefined) this.select(first);
        this.focusCameraOn(issue.location);
        host.setAttribute("hidden", "");
      });
      host.appendChild(b);
    }
  }

  /** Point the orbit camera at a plan position (issue focus). */
  private focusCameraOn(point: PlanPoint): void {
    if (this.mode !== "orbit") this.setMode("orbit");
    const target = new THREE.Vector3(cmToMeters(point.x), 0.4, cmToMeters(point.z));
    const offset = this.orbitCam.position.clone().sub(this.controls.target);
    if (offset.lengthSq() < 1e-6) offset.set(1.5, 2.2, 2.2);
    offset.setLength(3.2);
    this.orbitCam.position.copy(target).add(offset);
    this.controls.target.copy(target);
    this.controls.update();
    this.requestRender();
  }

  /** Load a fit-test scene from the dev menu (items only, keep the camera). */
  private loadTestScene(name: string): void {
    const scene = TEST_SCENES[name];
    if (scene === undefined) return;
    const clone = JSON.parse(JSON.stringify(scene)) as SceneState;
    this.select(null);
    this.store.replace({ ...clone, camera: this.store.state.camera });
  }

  /** Room total in the top bar (sum of placed pieces, tabular figures). */
  private updateTopBar(): void {
    const el = document.getElementById("cart-total");
    if (el === null) return;
    let total = 0;
    let count = 0;
    for (const item of this.store.state.items) {
      const entry = CATALOG_MAP.get(item.productId);
      if (entry === undefined) continue;
      total += entry.price;
      count += 1;
    }
    el.textContent = count === 0 ? "$0" : `$${total.toLocaleString("en-US")} · ${count}`;
  }

  /** Download the current cart (room + placed pieces + total) as JSON. */
  private downloadCart(): void {
    const items = this.store.state.items.map((item) => {
      const entry = CATALOG_MAP.get(item.productId);
      return {
        instanceId: item.instanceId,
        productId: item.productId,
        name: entry?.name ?? item.productId,
        price: entry?.price ?? 0,
        variant: item.variant,
        position: item.position,
        rotationY: item.rotationY,
      };
    });
    const total = items.reduce((sum, i) => sum + i.price, 0);
    const payload = { room: ROOM.id, roomName: ROOM.name, items, total };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "fitroom-cart.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private updateMeasure(): void {
    const id = this.selectedId;
    if (id === null) {
      const b = roomBounds(ROOM);
      this.measureEl.textContent = `Room ${Math.round(b.maxX - b.minX)}×${Math.round(b.maxZ - b.minZ)}cm · ${this.store.state.items.length} piece(s)`;
      this.sizeTag.style.display = "none";
      return;
    }
    const item = this.store.state.items.find((i) => i.instanceId === id);
    const entry = item === undefined ? undefined : CATALOG_MAP.get(item.productId);
    if (item === undefined || entry === undefined) {
      this.measureEl.textContent = "";
      return;
    }
    const wallM = distanceToWallM(item.position, ROOM);
    this.measureEl.textContent =
      `${entry.name} ${Math.round(entry.size.w)}×${Math.round(entry.size.d)}cm · ` +
      `Δwall ${(wallM * 100).toFixed(0)}cm · ∠${Math.round(item.rotationY)}°`;
  }

  // ---- input ----

  private setPointer(event: PointerEvent): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private activeCamera(): THREE.Camera {
    return this.mode === "plan" ? this.planCam : this.orbitCam;
  }

  private bindPointer(): void {
    const el = this.renderer.domElement;
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();

    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const ndc = this.setPointer(event);
      this.raycaster.setFromCamera(ndc, this.activeCamera());
      if (this.rotateHandle.visible) {
        const hits = this.raycaster.intersectObject(this.rotateHandle, false);
        if (hits.length > 0) {
          this.rotating = this.selectedId !== null;
          if (this.rotating) this.store.checkpoint();
          el.setPointerCapture(event.pointerId);
          return;
        }
      }
      const targets = [...this.instances.values()].map((e) => e.group);
      const picks = this.raycaster.intersectObjects(targets, true);
      if (picks.length > 0) {
        let obj: THREE.Object3D | null = picks[0]?.object ?? null;
        while (obj !== null && ![...this.instances.values()].some((e) => e.group === obj)) {
          obj = obj.parent;
        }
        const found = [...this.instances.entries()].find(([, e]) => e.group === obj);
        if (found !== undefined) {
          const [id] = found;
          this.select(id);
          const item = this.store.state.items.find((i) => i.instanceId === id);
          if (item !== undefined && this.raycaster.ray.intersectPlane(floorPlane, hit)) {
            this.drag = {
              id,
              offsetX: item.position.x - hit.x * 100,
              offsetZ: item.position.z - hit.z * 100,
            };
            this.store.checkpoint();
            el.setPointerCapture(event.pointerId);
          }
          return;
        }
      }
      this.select(null);
    });

    el.addEventListener("pointermove", (event) => {
      const ndc = this.setPointer(event);
      this.raycaster.setFromCamera(ndc, this.activeCamera());
      if (this.rotating && this.selectedId !== null) {
        const item = this.store.state.items.find((i) => i.instanceId === this.selectedId);
        const entry = this.selectedId === null ? undefined : this.instances.get(this.selectedId);
        if (item !== undefined && entry !== undefined) {
          const box = new THREE.Box3().setFromObject(entry.group);
          const c = box.getCenter(new THREE.Vector3());
          if (this.raycaster.ray.intersectPlane(floorPlane, hit)) {
            const ang = (Math.atan2(hit.x - c.x, hit.z - c.z) * 180) / Math.PI;
            const snap = event.shiftKey ? 1 : 15;
            item.rotationY = Math.round(ang / snap) * snap;
            entry.group.rotation.y = (item.rotationY * Math.PI) / 180;
            this.positionHandle(entry);
            this.updateMeasure();
            this.requestRender();
          }
        }
        return;
      }
      if (this.drag !== null) {
        const item = this.store.state.items.find((i) => i.instanceId === this.drag?.id);
        if (item !== undefined && this.raycaster.ray.intersectPlane(floorPlane, hit)) {
          // 5cm wall snap: snap to the 5cm grid while dragging.
          const rawX = hit.x * 100 + this.drag.offsetX;
          const rawZ = hit.z * 100 + this.drag.offsetZ;
          item.position = { x: snapToGrid(rawX), z: snapToGrid(rawZ) };
          const live = this.instances.get(item.instanceId);
          if (live !== undefined) {
            live.group.position.set(cmToMeters(item.position.x), 0, cmToMeters(item.position.z));
            this.positionHandle(live);
          }
          this.updateMeasure();
          // Live fit feedback without stutter: debounced, and only the
          // dragged item's neighbourhood is re-stamped by the engine.
          this.scheduleLiveIssues(item.instanceId);
          this.requestRender();
        }
      }
    });

    el.addEventListener("pointerup", () => {
      if (this.liveTimer !== null) {
        clearTimeout(this.liveTimer);
        this.liveTimer = null;
      }
      if (this.drag !== null || this.rotating) {
        // Commit: the store emits, which runs the full (non-incremental)
        // fit check once.
        this.store.touch();
      }
      this.drag = null;
      this.rotating = false;
    });
  }

  private bindKeys(): void {
    window.addEventListener("keydown", (event) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (this.store.undo()) {
          void this.syncInstances();
          this.refreshIssues();
        }
        return;
      }
      if (this.selectedId === null) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        this.deleteItem(this.selectedId);
      } else if (event.key.toLowerCase() === "r") {
        const item = this.store.state.items.find((i) => i.instanceId === this.selectedId);
        if (item !== undefined) {
          const step = event.shiftKey ? 1 : 15;
          this.commitRotate(item.instanceId, item.rotationY + step);
        }
      }
    });
  }

  private bindToolbar(): void {
    const on = (id: string, fn: () => void): void => {
      document.getElementById(id)?.addEventListener("click", fn);
    };
    on("tool-cart", () => this.downloadCart());
    on("tool-orbit", () => this.setMode("orbit"));
    on("tool-plan", () => this.setMode("plan"));
    on("tool-clearance", () => this.toggleClearance());
    const scenes = document.getElementById("tool-scenes");
    if (scenes instanceof HTMLSelectElement) {
      scenes.addEventListener("change", () => {
        if (scenes.value !== "") this.loadTestScene(scenes.value);
      });
    }
    on("tool-rot-left", () => this.nudgeRotate(-15));
    on("tool-rot-right", () => this.nudgeRotate(15));
    on("tool-delete", () => {
      if (this.selectedId !== null) this.deleteItem(this.selectedId);
    });
    on("tool-undo", () => {
      if (this.store.undo()) {
        void this.syncInstances();
        this.refreshIssues();
      }
    });
    on("tool-credits", () => {
      const dlg = document.getElementById("credits-dialog");
      if (dlg instanceof HTMLDialogElement) dlg.showModal();
    });
  }

  /** Clearance overlay toggle: shade the circulation-blocked 1 cm cells. */
  private toggleClearance(): void {
    const next = !this.fitOverlay.clearanceVisible;
    this.fitOverlay.setClearanceVisible(next);
    document.getElementById("tool-clearance")?.setAttribute("data-active", String(next));
    this.requestRender();
  }

  private nudgeRotate(delta: number): void {
    if (this.selectedId === null) return;
    const item = this.store.state.items.find((i) => i.instanceId === this.selectedId);
    if (item !== undefined) this.commitRotate(item.instanceId, item.rotationY + delta);
  }

  private setMode(mode: "orbit" | "plan"): void {
    this.mode = mode;
    document.getElementById("tool-orbit")?.setAttribute("data-active", String(mode === "orbit"));
    document.getElementById("tool-plan")?.setAttribute("data-active", String(mode === "plan"));
    this.planOverlay.setVisible(mode === "plan");
    this.controls.object = mode === "plan" ? this.planCam : this.orbitCam;
    this.controls.enableRotate = mode === "orbit";
    this.controls.maxPolarAngle = mode === "plan" ? 0.01 : MAX_POLAR;
    if (mode === "plan") {
      this.controls.target.set(cmToMeters(210), 0, cmToMeters(180));
    }
    this.controls.update();
    this.requestRender();
  }

  // ---- frame ----

  private resize(): void {
    const w = this.container.clientWidth;
    const h = Math.max(1, this.container.clientHeight);
    this.orbitCam.aspect = w / h;
    this.orbitCam.updateProjectionMatrix();
    this.planCam.left = -this.planCam.top * (w / h);
    this.planCam.right = this.planCam.top * (w / h);
    this.planCam.updateProjectionMatrix();
    this.basePixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.renderer.setPixelRatio(this.basePixelRatio * this.orbitScale);
    this.renderer.setSize(w, h);
    this.requestRender();
  }

  /** Apply a clamped orbit scale (no-op when unchanged). */
  private setOrbitScale(scale: number): void {
    const clamped = Math.min(ORBIT_MAX_SCALE, Math.max(ORBIT_MIN_SCALE, scale));
    if (clamped === this.orbitScale) return;
    this.orbitScale = clamped;
    this.renderer.setPixelRatio(this.basePixelRatio * this.orbitScale);
  }

  /** Nudge the orbit scale so the frame cost stays under budget. */
  private adaptOrbitScale(costMs: number): void {
    this.orbitEmaMs = this.orbitEmaMs === 0 ? costMs : this.orbitEmaMs * 0.8 + costMs * 0.2;
    if (this.orbitEmaMs > ORBIT_FRAME_BUDGET_MS + 0.5) {
      this.setOrbitScale(this.orbitScale - 0.1);
    } else if (this.orbitEmaMs < ORBIT_FRAME_BUDGET_MS - 4) {
      this.setOrbitScale(this.orbitScale + 0.05);
    }
  }

  /** Dollhouse: hide the 2 walls nearest the camera (orbit mode only). */
  private updateDollhouse(): void {
    const cam = this.activeCamera();
    if (this.mode === "plan") {
      for (const e of this.wallEntries) for (const m of e.meshes) m.visible = false;
      return;
    }
    const bounds = roomBounds(ROOM);
    const cx = cmToMeters((bounds.minX + bounds.maxX) / 2);
    const cz = cmToMeters((bounds.minZ + bounds.maxZ) / 2);
    const toCam = new THREE.Vector3(cam.position.x - cx, 0, cam.position.z - cz).normalize();
    const scored = this.wallEntries.map((e) => ({ e, d: e.outward.dot(toCam) }));
    scored.sort((a, b) => b.d - a.d);
    const hidden = new Set([scored[0]?.e.wallId, scored[1]?.e.wallId]);
    for (const { e } of scored) {
      const show = !hidden.has(e.wallId);
      for (const m of e.meshes) m.visible = show;
    }
  }

  private updateTag(): void {
    if (this.selectedId === null) {
      this.sizeTag.style.display = "none";
      return;
    }
    const entry = this.instances.get(this.selectedId);
    const item = this.store.state.items.find((i) => i.instanceId === this.selectedId);
    const catalogEntry = item === undefined ? undefined : CATALOG_MAP.get(item.productId);
    if (entry === undefined || item === undefined || catalogEntry === undefined) {
      this.sizeTag.style.display = "none";
      return;
    }
    const box = new THREE.Box3().setFromObject(entry.group);
    const c = box.getCenter(new THREE.Vector3());
    const v = new THREE.Vector3(c.x, box.max.y + 0.12, c.z).project(this.activeCamera());
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.sizeTag.style.display = "block";
    this.sizeTag.style.left = `${((v.x + 1) / 2) * w}px`;
    this.sizeTag.style.top = `${((1 - v.y) / 2) * h}px`;
    this.sizeTag.textContent = `${Math.round(catalogEntry.size.w)}×${Math.round(catalogEntry.size.d)}cm`;
  }

  private frame(): void {
    const t0 = performance.now();
    // Never below the floor.
    if (this.orbitCam.position.y < 0.1) this.orbitCam.position.y = 0.1;
    // OrbitControls.update() returns true while the camera is still moving
    // (including damping glide): keep drawing until it settles, then stop.
    const moved = this.controls.update();
    if (moved && !this.orbiting) {
      // Camera in motion: drop to a reduced pixel ratio first, then adapt.
      this.orbiting = true;
      this.orbitEmaMs = 0;
      this.setOrbitScale(ORBIT_START_SCALE);
    }
    this.updateDollhouse();
    if (this.outline !== null) this.outline.update();
    this.fitOverlay.update(
      this.activeCamera(),
      this.container.clientWidth,
      this.container.clientHeight,
    );
    if (this.selectedId !== null) {
      const entry = this.instances.get(this.selectedId);
      if (entry !== undefined) this.positionHandle(entry);
    }
    this.updateTag();
    if (this.mode === "plan") {
      this.planOverlay.update(
        this.planCam,
        ROOM,
        this.container.clientWidth,
        this.container.clientHeight,
      );
    }
    if (this.rig !== null && this.rig.contactNeedsRefresh.value) {
      this.rig.contactNeedsRefresh.value = false;
    }
    // Shadow maps are static between changes: refresh only after a change.
    if (this.shadowNeedsUpdate) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowNeedsUpdate = false;
    }
    this.renderer.render(this.scene, this.activeCamera());
    if (this.orbiting) this.adaptOrbitScale(performance.now() - t0);
    if (moved) {
      this.requestRender();
    } else if (this.orbiting) {
      // Camera settled: one full-resolution frame, then idle draws nothing.
      this.orbiting = false;
      this.setOrbitScale(ORBIT_MAX_SCALE);
      this.requestRender();
    }
  }
}

const container = document.getElementById("scene-container");
if (container !== null) {
  new FitRoomApp(container);
}
void refreshApiStatus();
