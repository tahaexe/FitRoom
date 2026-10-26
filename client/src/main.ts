import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CatalogItem, RoomLayout, SceneItem } from "@fitroom/shared";
import { cmToMeters, isHealthResponse } from "@fitroom/shared";
import roomJson from "../../shared/samples/living-420x360.json";
import catalogJson from "../../shared/catalog/catalog.json";
import { CatalogPanel } from "./catalog-ui";
import { applyVariant, loadModel } from "./models";
import { PlanOverlay } from "./plan";
import { Inspector } from "./inspector";
import { buildRoom, WALL_MATERIAL } from "./room";
import { makeFloorMaterial, requestContactRefresh, setupStage, type StageRig } from "./stage";
import {
  computeFitIssues,
  distanceToWallM,
  makeInstanceId,
  nearestFreeSpot,
  roomBounds,
  SceneStore,
  snapToGrid,
  type FitRecord,
} from "./state";
import "./style.css";

const ROOM = roomJson as unknown as RoomLayout;
const CATALOG = catalogJson as unknown as CatalogItem[];
const CATALOG_MAP = new Map<string, CatalogItem>(CATALOG.map((c) => [c.id, c]));

const MAX_PIXEL_RATIO = 2;
const MIN_POLAR = 0.12;
const MAX_POLAR = Math.PI / 2 - 0.03;

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
function dressWalls(): void {
  const loader = new THREE.TextureLoader();
  const base = "assets/textures/ambientcg/PaintedPlaster017/PaintedPlaster017_1K-JPG";
  const map = loader.load(`${base}_Color.jpg`);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(2, 1);
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = loader.load(`${base}_NormalGL.jpg`);
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
  private inspector: Inspector;
  private issues: FitRecord[] = [];
  private mode: "orbit" | "plan" = "orbit";
  private drag: { id: string; offsetX: number; offsetZ: number } | null = null;
  private rotating = false;
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.store = new SceneStore(ROOM.id);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
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

    dressWalls();
    const floorMat = makeFloorMaterial(wM, dM);
    const built = buildRoom(ROOM, floorMat);
    this.scene.add(built.group);
    this.scene.add(this.modelsRoot);
    const floor = built.group.getObjectByName("fitroom-floor");
    if (floor instanceof THREE.Mesh) this.floorMesh = floor;
    this.rig = setupStage(this.renderer, this.scene, built.floorSize, built.wallHeightM);
    this.roomWalls = built.group;
    this.wallEntries = built.wallEntries.map((e) => ({
      wallId: e.wallId,
      meshes: e.meshes,
      outward: e.outward,
    }));

    // Selection outline + rotate handle + size tag.
    this.rotateHandle = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x2563eb }),
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
    this.store.subscribe(() => {
      void this.syncInstances();
      this.refreshIssues();
    });

    window.addEventListener("resize", () => this.resize());
    void this.syncInstances();
    this.refreshIssues();
    this.updateMeasure();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private roomWalls: THREE.Group;
  private wallEntries: Array<{ wallId: string; meshes: THREE.Mesh[]; outward: THREE.Vector3 }>;

  // ---- mutations ----

  private async addItem(item: CatalogItem): Promise<void> {
    const spot = nearestFreeSpot(item.id, CATALOG_MAP, ROOM, this.store.state);
    const instance: SceneItem = {
      instanceId: makeInstanceId(item.id),
      productId: item.id,
      position: { x: Math.round(spot.x), z: Math.round(spot.z) },
      rotationY: 0,
      variant: item.variants[0]?.name ?? "",
    };
    this.store.commit((draft) => {
      draft.items.push(instance);
    });
    this.select(instance.instanceId);
    requestContactRefresh(this.rig);
  }

  private commitMove(id: string, x: number, z: number): void {
    this.store.commit((draft) => {
      const it = draft.items.find((i) => i.instanceId === id);
      if (it !== undefined) {
        it.position = { x: Math.round(x), z: Math.round(z) };
      }
    });
    requestContactRefresh(this.rig);
  }

  private commitRotate(id: string, deg: number): void {
    const norm = ((deg % 360) + 360) % 360;
    this.store.commit((draft) => {
      const it = draft.items.find((i) => i.instanceId === id);
      if (it !== undefined) it.rotationY = Math.round(norm * 10) / 10;
    });
    requestContactRefresh(this.rig);
  }

  private commitVariant(id: string, variant: string): void {
    this.store.commit((draft) => {
      const it = draft.items.find((i) => i.instanceId === id);
      if (it !== undefined) it.variant = variant;
    });
    requestContactRefresh(this.rig);
  }

  private deleteItem(id: string): void {
    this.store.commit((draft) => {
      draft.items = draft.items.filter((i) => i.instanceId !== id);
    });
    if (this.selectedId === id) this.select(null);
    requestContactRefresh(this.rig);
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
      const bad = id !== null && this.issues.some((f) => f.itemIds.includes(id));
      this.outline = new THREE.BoxHelper(entry.group, bad ? 0xdc2626 : 0xf59e0b);
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
          applyVariant(group, entry, item.variant);
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
            applyVariant(group, entry, item.variant);
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
  }

  private refreshIssues(): void {
    this.issues = computeFitIssues(this.store.state, CATALOG_MAP, ROOM);
    const el = document.getElementById("fit-status");
    if (el !== null) {
      const errors = this.issues.filter((i) => i.severity === "error").length;
      const warns = this.issues.length - errors;
      el.textContent =
        this.issues.length === 0
          ? "Fit: all clear"
          : `Fit: ${errors} error(s), ${warns} warning(s)`;
      el.dataset["state"] = errors > 0 ? "bad" : warns > 0 ? "warn" : "good";
    }
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
        }
      }
    });

    el.addEventListener("pointerup", () => {
      if (this.drag !== null || this.rotating) {
        this.store.touch();
        requestContactRefresh(this.rig);
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
    on("tool-orbit", () => this.setMode("orbit"));
    on("tool-plan", () => this.setMode("plan"));
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(w, h);
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
    // Never below the floor.
    if (this.orbitCam.position.y < 0.1) this.orbitCam.position.y = 0.1;
    this.controls.update();
    this.updateDollhouse();
    if (this.outline !== null) this.outline.update();
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
    this.renderer.render(this.scene, this.activeCamera());
  }
}

const container = document.getElementById("scene-container");
if (container !== null) {
  new FitRoomApp(container);
}
void refreshApiStatus();
