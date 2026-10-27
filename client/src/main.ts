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
  FreeRun,
  PlanPoint,
  RoomLayout,
  SceneItem,
  SceneState,
} from "@fitroom/shared";
import {
  FitEngine,
  cmToMeters,
  createManualRoom,
  describeRun,
  dollhouseWallView,
  isHealthResponse,
  orientedFootprint,
  setRectangleWallLength,
  wallDisplayHex,
  type RenderWallView,
} from "@fitroom/shared";
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
import rotatedOverlapScene from "../../shared/samples/fit-tests/rotated-overlap.json";
import rotatedOutsideScene from "../../shared/samples/fit-tests/rotated-outside.json";
import rotatedInsideScene from "../../shared/samples/fit-tests/rotated-inside.json";
import { initLiveSwitch } from "./api";
import { CatalogPanel, formatMeasure, formatTopBar } from "./catalog-ui";
import { RecommendPanel } from "./recommend/panel";
import { AssistantPanel } from "./assistant/panel";
import { applyVariant, loadModel } from "./models";
import { PlanOverlay } from "./plan";
import { FitOverlay } from "./fit-overlay";
import { Inspector } from "./inspector";
import { captureView } from "./render/capture";
import { RenderViewer } from "./render/viewer";
import { buildRoom, WALL_MATERIAL } from "./room";
import { makeFloorMaterial, requestContactRefresh, setupStage, type StageRig } from "./stage";
import { OrbitResolutionController } from "./orbit-resolution";
import { PointerOwnership } from "./pointer-ownership";
import { SceneSynchronizer } from "./scene-sync";
import { EditorStore } from "./editor/editor-store";
import { RoomEditor } from "./editor/editor";
import { RoomMenu } from "./editor/room-menu";
import { PhotoFlow, type PhotoFlowDone } from "./photo-room/flow";
import { clearAllPhotos, loadPhoto } from "./photo-room/photo-store";
import { FirstOpen, type RoomSize } from "./first-open";
import { resolveFirstOpen } from "./room-units";
import "./photo-room/photo-room.css";
import "./editor/editor.css";
import {
  catalogProducts,
  clampFootprintToRoom,
  clearRoomLayout,
  cornersOverlap,
  distanceToWallM,
  emptyScene,
  hasAutosave,
  itemCorners,
  loadRoomLayout,
  makeInstanceId,
  nearestFreeSpot,
  roomBounds,
  saveRoomLayout,
  SceneStore,
  snapToGrid,
} from "./state";
import "./style.css";

/** Dev menu: the twelve fit-test scenes, loadable from the bottom toolbar. */
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
  "rotated-overlap": rotatedOverlapScene as unknown as SceneState,
  "rotated-outside": rotatedOutsideScene as unknown as SceneState,
  "rotated-inside": rotatedInsideScene as unknown as SceneState,
};

const ROOM = roomJson as unknown as RoomLayout;
/** Pristine sample room: a deep copy, since ROOM is mutated in place. */
const SAMPLE_ROOM = JSON.parse(JSON.stringify(roomJson)) as unknown as RoomLayout;
const CATALOG = catalogJson as unknown as CatalogItem[];

/**
 * Replace a live room's contents in place: panels hold the room reference,
 * so the identity never changes while walls, openings and pieces do.
 */
function applyRoomLayout(target: RoomLayout, source: RoomLayout): void {
  const clone = JSON.parse(JSON.stringify(source)) as RoomLayout;
  target.id = clone.id;
  target.name = clone.name;
  target.units = clone.units;
  target.walls = clone.walls;
  target.openings = clone.openings;
  target.fixtures = clone.fixtures;
  target.existing = clone.existing;
  target.surfaces = clone.surfaces;
  target.style = clone.style;
  target.source = clone.source;
  target.confidence = clone.confidence;
}
const CATALOG_MAP = new Map<string, CatalogItem>(CATALOG.map((c) => [c.id, c]));

const MAX_PIXEL_RATIO = 2;
const MIN_POLAR = 0.12;
const MAX_POLAR = Math.PI / 2 - 0.03;
/** Selection coral (matches --coral) + a lighter hover coral, both readable on dark and light. */
const SELECT_CORAL = 0xf54e49;
const HOVER_CORAL = 0xff8f88;

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

/** Wall finish ids the builder knows (legacy ids fall back to paint). */
export const WALL_TEXTURE_IDS = ["PaintedPlaster017", "Wallpaper002A"] as const;

export function wallTextureIdFor(surfaceId: string | null | undefined): string {
  if (
    typeof surfaceId === "string" &&
    (WALL_TEXTURE_IDS as readonly string[]).includes(surfaceId)
  ) {
    return surfaceId;
  }
  return "PaintedPlaster017";
}

/**
 * Display colour over the wall texture: the photo albedo divided by the
 * finish mean (the texture is normalised to a mean of 1), else neutral.
 */
export function wallTintFor(
  surfaceId: string | null | undefined,
  textureId?: string | null,
): number {
  if (typeof surfaceId === "string" && /^#[0-9a-fA-F]{6}$/.test(surfaceId)) {
    const display =
      textureId === undefined || textureId === null
        ? surfaceId
        : (wallDisplayHex(surfaceId, textureId) ?? surfaceId);
    return parseInt(display.slice(1), 16);
  }
  return 0xf1ece2;
}

/** ambientCG PBR on the shared wall material, tinted toward the photo. */
function dressWalls(onLoad: () => void, wallId?: string, wallTint?: string): void {
  const loader = new THREE.TextureLoader();
  const finish = wallTextureIdFor(wallId);
  const base = `assets/textures/ambientcg/${finish}/${finish}_1K-JPG`;
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
  WALL_MATERIAL.color.setHex(wallTintFor(wallTint, finish));
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
  private modelsRoot = new THREE.Group();
  private get instances(): Map<string, InstanceEntry> {
    return this.syncer?.instances ?? new Map<string, InstanceEntry>();
  }
  private raycaster = new THREE.Raycaster();
  private floorMesh: THREE.Mesh | null = null;
  private selectedId: string | null = null;
  /** Coral selection outline: the footprint on the floor, turns with the piece. */
  private outline: THREE.LineLoop | null = null;
  /** Lighter coral hover outline for the piece under the pointer. */
  private hoverOutline: THREE.LineLoop | null = null;
  private hoverId: string | null = null;
  private rotateHandle: THREE.Group;
  private rotateRingRadiusM = 0.5;
  private sizeTag: HTMLElement;
  private measureEl: HTMLElement;
  private planOverlay: PlanOverlay;
  private fitOverlay: FitOverlay;
  private inspector: Inspector;
  private recommendPanel: RecommendPanel | null = null;
  private assistantPanel: AssistantPanel | null = null;
  private renderViewer: RenderViewer | null = null;
  private runHighlight: THREE.Mesh | null = null;
  private fitEngine: FitEngine;
  private analysis: FitAnalysis | null = null;
  private issues: FitIssue[] = [];
  private mode: "orbit" | "plan" = "orbit";
  /** Developer camera hook: exact frozen pose, 4:3 frame, known scene. */
  private devCam = false;
  /** Reframe + republish intrinsics together (hook window resizes). */
  private devRefresh: (() => void) | null = null;
  /** Built room group, floor material and own-piece boxes (rebuilt per room). */
  private roomGroup: THREE.Group | null = null;
  private floorMaterial: THREE.Material | null = null;
  private existingGroup: THREE.Group | null = null;
  /** Plan editor state, screen and header menu. */
  private editorStore: EditorStore | null = null;
  private editor: RoomEditor | null = null;
  private roomMenu: RoomMenu | null = null;
  private editing = false;
  private editorBase: RoomLayout | null = null;
  private menuChoice = "sample";
  private menuBeforePhotos = "sample";
  private photoFlow: PhotoFlow | null = null;
  private firstOpen: FirstOpen | null = null;
  private firstOpenSetup = false;
  /** Photo-built draft kept while its editor session is open (photos + solver output). */
  private photoDraft: import("@fitroom/shared").RoomDraft | null = null;
  private photoMeta: import("./photo-room/flow").PhotoFlowDone["meta"] | null = null;
  /** Edited room layouts stashed by room id, so each room keeps its own walls, openings and own blocks. */
  private savedRoomLayouts = new Map<string, RoomLayout>();
  private drag: { pointerId: number; id: string; offsetX: number; offsetZ: number } | null = null;
  private rotating = false;
  private rotatePointerId: number | null = null;
  private ownership = new PointerOwnership();
  private syncer: SceneSynchronizer<THREE.Group> | null = null;
  private toastTimer = 0;
  private toastEl: HTMLElement | null = null;
  /** Throttled live fit feedback while dragging (moved id, consumed once per frame). */
  private liveDirty: string | null = null;
  private container: HTMLElement;
  /** Render-on-demand: a queued rAF id (0 = none) plus a shadow refresh flag. */
  private rafId = 0;
  private shadowNeedsUpdate = true;
  /** Adaptive orbit resolution: full pixel ratio, hysteresis controller, last cost. */
  private basePixelRatio = 1;
  private orbitResolution = new OrbitResolutionController();
  private lastFrameCostMs = 0;
  private pendingResize = false;

  constructor(container: HTMLElement) {
    this.container = container;
    // `camroom=manual` (dev only) renders the plan-editor room: the saved
    // manual layout when one survives the reload, else the starter manual
    // room. Runs before the store so the scene id already matches the room.
    if (import.meta.env.DEV) {
      const camroom = ((): string | null => {
        try {
          return new URLSearchParams(window.location.search).get("camroom");
        } catch {
          return null;
        }
      })();
      if (camroom === "manual" && ROOM.id !== "manual-room") {
        applyRoomLayout(ROOM, loadRoomLayout("manual-room") ?? createManualRoom());
      }
    }
    // A saved built room reopens with its pieces; with no saved room the
    // first visit shows the setup screen over the softly blurred sample
    // room. Runs before the store so the scene id already matches the room.
    const roomParam = ((): string | null => {
      try {
        return new URLSearchParams(window.location.search).get("room");
      } catch {
        return null;
      }
    })();
    const storedManualRoom = ROOM.id === "manual-room" ? null : loadRoomLayout("manual-room");
    const storedPhotosRoom = ROOM.id === "photos-room" ? null : loadRoomLayout("photos-room");
    let hasSavedScene = false;
    for (const id of [ROOM.id, SAMPLE_ROOM.id, "manual-room", "photos-room"]) {
      try {
        if (hasAutosave(id)) {
          hasSavedScene = true;
          break;
        }
      } catch {
        // Storage may be unavailable; treat as a first visit.
      }
    }
    const hasSavedRoom = storedManualRoom !== null || storedPhotosRoom !== null || hasSavedScene;
    const firstChoice = resolveFirstOpen({ hasSavedRoom, roomParam });
    this.firstOpenSetup = firstChoice === "setup";
    if (roomParam === "sample") {
      if (ROOM.id !== SAMPLE_ROOM.id) {
        applyRoomLayout(ROOM, JSON.parse(JSON.stringify(SAMPLE_ROOM)) as RoomLayout);
      }
      this.menuChoice = "sample";
    } else if (storedManualRoom !== null) {
      applyRoomLayout(ROOM, storedManualRoom);
      this.menuChoice = "manual";
    } else if (storedPhotosRoom !== null) {
      applyRoomLayout(ROOM, storedPhotosRoom);
      this.menuChoice = "photos";
    }
    // First visit (no saved room) opens the furnished demo room behind the
    // setup screen — the scene the chips reset to — while returning visits
    // restore the autosave.
    const firstVisit = firstChoice !== "room";
    this.store = new SceneStore(ROOM.id, validScene as unknown as SceneState);
    // Developer camera hook: a known scene, never the saved shopper state.
    // The scene menu still works on top; `camitems=0` hides every piece.
    // Assigned directly (no replace event) so the shopper autosave survives.
    // Detection and the scene choice run synchronously in this DEV-only
    // block, so the first frame already sees the hook state (frozen pose,
    // every wall visible, no cutaway); the whole block is erased from the
    // production build.
    if (import.meta.env.DEV) {
      const hookParam = (key: string): string | null => {
        try {
          return new URLSearchParams(window.location.search).get(key);
        } catch {
          return null;
        }
      };
      const wantsHook = [
        "camx",
        "camz",
        "cameye",
        "camyaw",
        "campitch",
        "camfov",
        "camitems",
        "camroom",
      ].some((key) => hookParam(key) !== null);
      this.devCam = wantsHook;
      if (wantsHook) {
        const hideAll = hookParam("camitems") === "0";
        const base = JSON.parse(JSON.stringify(validScene)) as SceneState;
        this.store.state = hideAll ? { ...base, items: [] } : base;
      }
      if (ROOM.id === "manual-room") this.menuChoice = "manual";
      if (ROOM.id === "manual-room" && this.store.state.roomId !== ROOM.id) {
        // Keep the scene's room id with the manual room from the first
        // frame (assigned directly, so no autosave is written yet).
        this.store.state = { ...this.store.state, roomId: ROOM.id };
      }
    }

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // The app uses only built-in materials, so there are no custom shaders
    // to validate: skip reading the GL program info log, which software
    // renderers fill with benign driver notes (precision remarks) that would
    // otherwise surface as console warnings.
    this.renderer.debug.checkShaderErrors = false;
    this.basePixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    // Guarded: a zero-width container (narrow viewport) must never yield a
    // degenerate plan frustum (left == right collapses the projection to
    // NaN and every plan label along with it).
    const aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
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
    if (firstVisit) this.frameDollhouse(cxM, czM, wM, dM, aspect);

    dressWalls(() => this.requestRender(), ROOM.surfaces.wall, ROOM.surfaces.wallTint);
    const floorMat = makeFloorMaterial(wM, dM, () => this.requestRender(), ROOM.surfaces.floor);
    this.floorMaterial = floorMat;
    const built = buildRoom(ROOM, floorMat);
    this.scene.add(built.group);
    this.roomGroup = built.group;
    this.scene.add(this.modelsRoot);
    this.syncer = new SceneSynchronizer<THREE.Group>({
      load: async (item) => {
        const catalogEntry = CATALOG_MAP.get(item.productId);
        if (catalogEntry === undefined) throw new Error(`unknown product ${item.productId}`);
        const group = await loadModel(catalogEntry);
        group.position.set(cmToMeters(item.position.x), 0, cmToMeters(item.position.z));
        group.rotation.y = (item.rotationY * Math.PI) / 180;
        await applyVariant(group, catalogEntry, item.variant);
        return group;
      },
      place: (group, item) => {
        group.position.set(cmToMeters(item.position.x), 0, cmToMeters(item.position.z));
        group.rotation.y = (item.rotationY * Math.PI) / 180;
      },
      attach: (group) => {
        this.modelsRoot.add(group);
      },
      detach: (group) => {
        this.modelsRoot.remove(group);
      },
      dispose: (group) => {
        group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) obj.geometry.dispose();
        });
      },
    });
    this.rebuildExistingGroup();
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

    // Selection outline + rotate ring + size tag.
    this.rotateHandle = new THREE.Group();
    this.rotateHandle.name = "fitroom-rotate-handle";
    const ringVisible = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.5, 48),
      new THREE.MeshBasicMaterial({
        color: SELECT_CORAL,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ringVisible.rotation.x = -Math.PI / 2;
    ringVisible.renderOrder = 6;
    // Generous invisible hit ring so the ring is easy to grab.
    const ringHit = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.62, 32),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    );
    ringHit.rotation.x = -Math.PI / 2;
    ringHit.name = "fitroom-rotate-hit";
    this.rotateHandle.add(ringVisible, ringHit);
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

    const inspectorHost = document.getElementById("inspector");
    const host = inspectorHost ?? document.createElement("div");
    this.inspector = new Inspector(host, CATALOG_MAP, {
      onMove: (id, x, z) => this.commitMove(id, x, z),
      onRotate: (id, deg) => this.commitRotate(id, deg),
      onVariant: (id, variant) => this.commitVariant(id, variant),
      onDelete: (id) => this.deleteItem(id),
    });
    this.inspector.setBounds(roomBounds(ROOM));

    const catalogHost = document.getElementById("catalog");
    if (catalogHost !== null) {
      new CatalogPanel(catalogHost, CATALOG, (item) => void this.addItem(item));
    }

    const recommendHost = document.getElementById("recommend-panel");
    if (recommendHost !== null) {
      this.recommendPanel = new RecommendPanel(recommendHost, {
        room: ROOM,
        catalog: CATALOG,
        getScene: () => this.store.state,
        checkItems: (items) => this.fitEngine.check({ ...this.store.state, items }),
        placeItem: (productId, x, z, rotationY) =>
          this.placeRecommendation(productId, x, z, rotationY),
        swapItem: (oldInstanceId, productId, x, z, rotationY) =>
          this.swapRecommendation(oldInstanceId, productId, x, z, rotationY),
        selectItem: (id) => this.select(id),
        showRecommend: () => this.showSidePanel("recommend"),
        resetDemoRoom: () => this.resetDemoRoom(),
        hoverRun: (run) => this.hoverRun(run),
      });
      this.recommendPanel.refresh();
    }

    const assistantHost = document.getElementById("assistant-panel");
    if (assistantHost !== null) {
      this.assistantPanel = new AssistantPanel(assistantHost, {
        room: ROOM,
        catalog: CATALOG,
        getScene: () => this.store.state,
        applyTurn: (endScene) => this.applyAssistantTurn(endScene),
        resetDemoRoom: () => this.resetDemoRoom(),
        isSampleScene: () => this.isSampleScene(),
        onFurnished: () => this.showFurnishedToast(),
      });
    }

    const renderHost = document.getElementById("render-viewer");
    if (renderHost !== null) {
      this.renderViewer = new RenderViewer(renderHost, {
        room: ROOM,
        catalog: CATALOG,
        getScene: () => this.store.state,
        resetDemoRoom: () => this.resetDemoRoom(),
        getCapture: () => {
          const shot = captureView(this.renderer, this.scene, this.activeCamera(), this.container);
          return {
            dataUrl: shot.dataUrl,
            base64: shot.base64,
            width: shot.width,
            height: shot.height,
          };
        },
        cameraPreset: () => this.renderPreset(),
        wallView: () => this.renderWallView(),
      });
    }

    this.bindToolbar();
    this.bindPointer();
    this.bindKeys();
    this.controls.addEventListener("change", () => this.requestRender());
    this.store.subscribe(() => {
      void this.syncInstances();
      this.refreshIssues();
      this.recommendPanel?.refresh();
      this.updateUndoRedo();
      this.markSceneChanged();
    });

    const roomNameHost = document.getElementById("room-name");
    if (roomNameHost !== null) {
      roomNameHost.textContent = "";
      this.roomMenu = new RoomMenu(roomNameHost, (id) => this.pickRoom(id));
      this.refreshMenu();
    }
    this.editorStore = new EditorStore(ROOM);
    this.editorStore.onCommitted((room) => {
      applyRoomLayout(ROOM, room);
      // Every committed plan edit saves a built room beside the scene
      // autosave, so the built room survives a reload.
      if (ROOM.id === "manual-room" || ROOM.id === "photos-room") saveRoomLayout(ROOM);
      this.syncRoomId();
      this.rebuildRoom();
    });
    this.editor = new RoomEditor(this.editorStore, {
      onBuild: () => this.finishBuild(),
      onCancel: () => this.cancelEditor(),
    });
    document.body.appendChild(this.editor.element);
    document.getElementById("fit-badge")?.addEventListener("click", () => {
      document.getElementById("fit-list")?.toggleAttribute("hidden");
    });

    window.addEventListener("resize", () => this.resize());
    this.applyDevGating();
    // Nothing open on first load: the side column starts empty.
    this.showSidePanel("none");
    void this.syncInstances();
    this.refreshIssues();
    this.updateSelectionTools();
    this.updateMeasure();
    this.updateTopBar();
    this.maybeShowCoachMarks();
    this.updateUndoRedo();
    this.firstOpen = new FirstOpen({
      onUsePhotos: () => {
        this.firstOpen?.hide();
        if (this.menuChoice !== "photos") this.menuBeforePhotos = this.menuChoice;
        this.menuChoice = "photos";
        this.openPhotoFlow();
      },
      onTryExample: () => {
        this.firstOpen?.hide();
        if (this.menuChoice !== "photos") this.menuBeforePhotos = this.menuChoice;
        this.menuChoice = "photos";
        this.openPhotoFlow();
        void this.photoFlow?.tryExample();
      },
      onExploreSample: () => {
        this.firstOpen?.hide();
        this.menuChoice = "sample";
        this.refreshMenu();
      },
      onBuildRoom: (size) => this.buildRoomAtSize(size),
      onShapeInEditor: (size) => this.shapeInEditor(size),
    });
    document.body.appendChild(this.firstOpen.element);
    if (this.firstOpenSetup && roomParam !== "sample") this.firstOpen.showCards();
    // Render on demand: frames only while the camera moves, after scene or
    // selection changes, or when a texture finishes loading. No idle loop.
    this.requestRender();
    // Developer camera hook: dev server only, erased from the prod build.
    // The dev module import sits behind import.meta.env.DEV so the
    // production bundle keeps none of it; the module self-guards on the
    // cam* parameters (the host already chose the known scene above).
    if (import.meta.env.DEV) {
      void import("./dev-camera").then((mod) => {
        const bounds = roomBounds(ROOM);
        mod.initDevCamera({
          renderer: this.renderer,
          camera: this.orbitCam,
          controls: this.controls,
          container: this.container,
          roomCentre: {
            x: (bounds.minX + bounds.maxX) / 2,
            z: (bounds.minZ + bounds.maxZ) / 2,
          },
          room: ROOM,
          requestRender: () => this.requestRender(),
          onReady: (refresh) => {
            this.devRefresh = refresh;
          },
        });
      });
    }
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
    // The spot must also pass the fit engine, so nothing lands in the
    // door's swing or the entrance; otherwise the fewest-errors spot wins.
    const spot = nearestFreeSpot(item.id, CATALOG_MAP, ROOM, this.store.state, start, (items) =>
      this.fitEngine.check({ ...this.store.state, items }),
    );
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
    // The fit engine already picked the nearest spot with no problems when
    // one exists; when the best spot still has a problem, show the list.
    if (this.issues.some((issue) => issue.itemIds.includes(instance.instanceId))) {
      document.getElementById("fit-list")?.removeAttribute("hidden");
    }
  }

  /** Place a recommendation at its checked spot, as one undo step. */
  private placeRecommendation(productId: string, x: number, z: number, rotationY: number): void {
    const entry = CATALOG_MAP.get(productId);
    if (entry === undefined) return;
    const instance: SceneItem = {
      instanceId: makeInstanceId(productId),
      productId,
      position: { x: Math.round(x), z: Math.round(z) },
      rotationY,
      variant: entry.variants[0]?.name ?? "",
    };
    // Seat accessories (coffee-table, ottoman, side-table) are sited
    // ignoring same-category pieces: placing one replaces a conflicting
    // same-category piece, so "Place it" never stacks two tables in one
    // slot. Still a single undo step.
    const replacesSameCategory =
      entry.category === "coffee-table" ||
      entry.category === "ottoman" ||
      entry.category === "side-table";
    this.store.commit((draft) => {
      if (replacesSameCategory) {
        const corners = itemCorners(instance, CATALOG_MAP);
        draft.items = draft.items.filter((other) => {
          if (CATALOG_MAP.get(other.productId)?.category !== entry.category) return true;
          return !cornersOverlap(corners, itemCorners(other, CATALOG_MAP));
        });
      }
      draft.items.push(instance);
    });
    this.select(instance.instanceId);
  }

  /** Swap the selected piece for a replacement, as one undo step. */
  private swapRecommendation(
    oldInstanceId: string,
    productId: string,
    x: number,
    z: number,
    rotationY: number,
  ): void {
    const entry = CATALOG_MAP.get(productId);
    if (entry === undefined) return;
    const instance: SceneItem = {
      instanceId: makeInstanceId(productId),
      productId,
      position: { x: Math.round(x), z: Math.round(z) },
      rotationY,
      variant: entry.variants[0]?.name ?? "",
    };
    this.store.commit((draft) => {
      draft.items = draft.items.filter((i) => i.instanceId !== oldInstanceId);
      draft.items.push(instance);
    });
    this.select(instance.instanceId);
  }

  /** Apply an assistant turn's end scene, as one undo step. */
  private applyAssistantTurn(endScene: SceneState): void {
    const items = JSON.parse(JSON.stringify(endScene.items)) as SceneState["items"];
    this.store.commit((draft) => {
      draft.items = items;
    });
  }

  /**
   * Reset to the demo room scene, as one undo step. From any other room this
   * first switches to the sample room itself (room and layout, stashing the
   * live room so it stays saved in the room menu), then resets the layout.
   */
  private resetDemoRoom(): void {
    if (ROOM.id !== SAMPLE_ROOM.id) {
      const leavingPhotos = ROOM.id === "photos-room";
      this.stashRoomLayout();
      applyRoomLayout(
        ROOM,
        this.roomLayoutFor(
          SAMPLE_ROOM.id,
          () => JSON.parse(JSON.stringify(SAMPLE_ROOM)) as RoomLayout,
        ),
      );
      if (leavingPhotos) clearRoomLayout("photos-room");
      if (this.photoDraft !== null || leavingPhotos) this.discardPhotoSession();
      this.editor?.setPhotoDraft(null);
      this.closeEditor();
      this.rebuildRoom();
      this.menuChoice = "sample";
      this.refreshMenu();
    }
    const clone = JSON.parse(JSON.stringify(validScene)) as SceneState;
    this.select(null);
    this.store.commit((draft) => {
      draft.items = clone.items;
    });
    this.syncRoomId();
  }

  /** True when live in the sample room with the sample layout. */
  private isSampleScene(): boolean {
    if (ROOM.id !== SAMPLE_ROOM.id) return false;
    const sample = (validScene as unknown as SceneState).items.map((item) => ({
      productId: item.productId,
      position: item.position,
      rotationY: item.rotationY,
      variant: item.variant,
    }));
    const live = this.store.state.items.map((item) => ({
      productId: item.productId,
      position: item.position,
      rotationY: item.rotationY,
      variant: item.variant,
    }));
    return JSON.stringify(live) === JSON.stringify(sample);
  }

  /** Stash the live room layout so switching rooms keeps each room's own walls, openings and blocks. */
  private stashRoomLayout(): void {
    this.savedRoomLayouts.set(ROOM.id, JSON.parse(JSON.stringify(ROOM)) as RoomLayout);
    // A built room survives a reload: its layout is saved beside the scene
    // autosave whenever the live room is stashed.
    if (ROOM.id === "manual-room" || ROOM.id === "photos-room") saveRoomLayout(ROOM);
  }

  /** Stashed layout for a room id, or a fresh layout the first time the room opens. */
  private roomLayoutFor(id: string, fresh: () => RoomLayout): RoomLayout {
    if (id === "manual-room" || id === "photos-room") {
      // A reloaded visit restores the built room from storage.
      const stored = loadRoomLayout(id);
      if (stored !== null) {
        this.savedRoomLayouts.set(id, JSON.parse(JSON.stringify(stored)) as RoomLayout);
        return stored;
      }
    }
    const saved = this.savedRoomLayouts.get(id);
    if (saved !== undefined) return JSON.parse(JSON.stringify(saved)) as RoomLayout;
    return fresh();
  }

  /**
   * Drop a photo-built session the way Cancel does: the stored photos go
   * and the editor loses its draft, while the room layout itself stays as
   * the Cancel path leaves it (callers clearing the saved layout do so).
   */
  private discardPhotoSession(): void {
    this.photoDraft = null;
    this.photoMeta = null;
    this.editor?.setPhotoDraft(null);
    void clearAllPhotos();
  }

  /** Header room menu: sample room, size-built room, or reopen the editor. Each room keeps its own placed pieces. */
  private pickRoom(id: string): void {
    if (id === "manual") {
      // "Build a room" opens the same size screen as first open instead of
      // the fixed start: Enter builds the plan editor at the typed size.
      this.closeEditor();
      this.firstOpen?.showSize();
      this.menuChoice = "manual";
    } else if (id === "edit") {
      this.editorStore?.load(ROOM);
      this.openEditor();
    } else if (id === "reset-demo") {
      // A reset that always exists: restores the sample layout as one
      // undoable step, even from another room.
      if (ROOM.id !== SAMPLE_ROOM.id) {
        const leavingPhotos = ROOM.id === "photos-room";
        this.stashRoomLayout();
        applyRoomLayout(
          ROOM,
          this.roomLayoutFor(
            SAMPLE_ROOM.id,
            () => JSON.parse(JSON.stringify(SAMPLE_ROOM)) as RoomLayout,
          ),
        );
        // Leaving the photo-built room drops its saved layout so the
        // sample room opens again on reload.
        if (leavingPhotos) clearRoomLayout("photos-room");
        // Leaving its plan editor by Reset drops the photo session too.
        if (this.photoDraft !== null || leavingPhotos) this.discardPhotoSession();
        this.editor?.setPhotoDraft(null);
        this.closeEditor();
        this.rebuildRoom();
      }
      this.resetDemoRoom();
      this.menuChoice = "sample";
    } else if (id === "photos") {
      // A new photo flow leaves the photo-built plan editor, so the old
      // stored photos go and its session drops as Cancel does.
      if (this.photoDraft !== null) {
        this.discardPhotoSession();
        this.closeEditor();
      }
      if (this.menuChoice !== "photos") this.menuBeforePhotos = this.menuChoice;
      this.menuChoice = "photos";
      this.openPhotoFlow();
    } else {
      if (ROOM.id !== SAMPLE_ROOM.id) {
        const leavingPhotos = ROOM.id === "photos-room";
        this.stashRoomLayout();
        applyRoomLayout(
          ROOM,
          this.roomLayoutFor(
            SAMPLE_ROOM.id,
            () => JSON.parse(JSON.stringify(SAMPLE_ROOM)) as RoomLayout,
          ),
        );
        // Leaving the photo-built room drops its saved layout so the
        // sample room opens again on reload.
        if (leavingPhotos) clearRoomLayout("photos-room");
        // Leaving its plan editor by the sample room drops the session too.
        if (this.photoDraft !== null || leavingPhotos) this.discardPhotoSession();
        const fallback = JSON.parse(JSON.stringify(validScene)) as SceneState;
        fallback.roomId = ROOM.id;
        this.store.switchRoom(ROOM.id, fallback);
        this.select(null);
        this.editor?.setPhotoDraft(null);
        this.closeEditor();
        this.rebuildRoom();
        this.menuChoice = "sample";
      } else {
        this.closeEditor();
        this.rebuildRoom();
      }
    }
    this.refreshMenu();
  }

  private refreshMenu(): void {
    const current =
      this.menuChoice === "edit"
        ? ROOM.source === "manual"
          ? "manual"
          : ROOM.source === "photos"
            ? "photos"
            : "sample"
        : this.menuChoice;
    this.roomMenu?.setItems(
      [
        { id: "sample", label: "Sample living room", hint: "Today's furnished demo room" },
        {
          id: "reset-demo",
          label: "Reset demo room",
          hint: "Restore the sample layout (one undo step)",
        },
        {
          id: "manual",
          label: "Build a room",
          hint: "Enter your room size, then shape it in the plan editor",
        },
        { id: "edit", label: "Edit plan", hint: "Reopen the plan editor for the current room" },
        {
          id: "photos",
          label: "From photos",
          hint: "Photograph four walls and confirm the draft plan",
        },
      ],
      current,
    );
  }

  /** Build a rectangle room at the typed size, then shape it in the plan editor. */
  private sizedBase(size: RoomSize): RoomLayout {
    let base = createManualRoom();
    base = setRectangleWallLength(base, "wall-1", size.widthCm);
    base = setRectangleWallLength(base, "wall-2", size.lengthCm);
    for (const wall of base.walls) wall.height = size.ceilingCm;
    return base;
  }

  /** "Build my room": the size screen opens the plan editor at those sizes. */
  private buildRoomAtSize(size: RoomSize): void {
    if (this.photoDraft !== null || ROOM.id === "photos-room") this.discardPhotoSession();
    this.stashRoomLayout();
    const base = this.sizedBase(size);
    const sameRoom = ROOM.id === base.id;
    applyRoomLayout(ROOM, base);
    if (sameRoom) {
      this.store.replace({ ...emptyScene(ROOM.id), camera: this.store.state.camera });
    } else {
      this.store.switchRoom(ROOM.id, emptyScene(ROOM.id));
    }
    this.select(null);
    this.rebuildRoom();
    this.editorStore?.load(ROOM);
    this.editor?.setPhotoDraft(null);
    this.openEditor();
    this.firstOpen?.hide();
    this.menuChoice = "manual";
    this.refreshMenu();
  }

  /** "Not a rectangle?": open the editor at the typed size for shaping. */
  private shapeInEditor(size: RoomSize | null): void {
    const at = size ?? { widthCm: 420, lengthCm: 360, ceilingCm: 250 };
    this.buildRoomAtSize(at);
  }

  /** One dismissible tip after the first build, shown once. */
  private maybeShowDoorTip(): void {
    const seen = ((): boolean => {
      try {
        return window.localStorage.getItem("fitroom.doors-tip-seen") === "1";
      } catch {
        return true;
      }
    })();
    if (seen) return;
    let tip = document.getElementById("door-tip");
    if (tip === null) {
      tip = document.createElement("div");
      tip.id = "door-tip";
      tip.className = "door-tip";
      tip.setAttribute("role", "status");
      const text = document.createElement("span");
      text.textContent = "Add your door and windows; clearance checks use them.";
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "door-tip-dismiss";
      dismiss.textContent = "Got it";
      dismiss.addEventListener("click", () => {
        try {
          window.localStorage.setItem("fitroom.doors-tip-seen", "1");
        } catch {
          // Private mode: the tip simply shows again next visit.
        }
        tip?.remove();
      });
      tip.append(text, dismiss);
      this.container.appendChild(tip);
    } else {
      tip.removeAttribute("hidden");
    }
  }

  /** "From photos": the capture flow floats above everything. */
  private openPhotoFlow(): void {
    this.closePhotoFlow();
    const flow = new PhotoFlow({
      onDone: (result) => this.openPhotoDraft(result),
      onClose: () => {
        this.closePhotoFlow();
        this.menuChoice = this.menuBeforePhotos;
        this.refreshMenu();
        if (
          this.firstOpenSetup &&
          loadRoomLayout("manual-room") === null &&
          loadRoomLayout("photos-room") === null
        ) {
          this.firstOpen?.showCards();
        }
      },
    });
    this.photoFlow = flow;
    document.body.appendChild(flow.element);
    this.refreshMenu();
  }

  private closePhotoFlow(): void {
    this.photoFlow?.element.remove();
    this.photoFlow = null;
  }

  /** A solved photo draft becomes the live room, confirmed in the plan editor. */
  private openPhotoDraft(result: PhotoFlowDone): void {
    this.closePhotoFlow();
    this.stashRoomLayout();
    applyRoomLayout(ROOM, result.draft.layout);
    this.store.switchRoom(ROOM.id, emptyScene(ROOM.id));
    this.select(null);
    this.closeEditor();
    this.rebuildRoom();
    this.editorStore?.load(ROOM);
    this.editor?.setPhotoDraft(result.meta);
    // The shopper's photos and what the solver found on them stay available
    // while the editor is open for this photo-built room; they are deleted
    // on Build ("finishBuild") or Cancel ("cancelEditor"), never sent
    // anywhere else. The layout itself is saved like a built room, so a
    // reload reopens it with its pieces.
    this.photoDraft = result.draft;
    this.photoMeta = result.meta;
    void (async (): Promise<void> => {
      const sizes = {
        A: { width: 1280, height: 960 },
        B: { width: 1280, height: 960 },
        C: { width: 1280, height: 960 },
        D: { width: 1280, height: 960 },
      };
      for (const letter of ["A", "B", "C", "D"] as const) {
        try {
          const stored = (await loadPhoto(letter)) as unknown as {
            segWidth?: number;
            segHeight?: number;
          } | null;
          if (stored !== null && stored !== undefined) {
            sizes[letter] = {
              width: stored.segWidth ?? 1280,
              height: stored.segHeight ?? 960,
            };
          }
        } catch {
          // Keep the fallback frame; the solver refuses out-of-frame moves.
        }
      }
      this.editorStore?.setPhoto({
        draft: result.draft,
        sizes,
        activeWall: "A",
        seen: ["A"],
      });
    })();
    if (ROOM.id === "photos-room") saveRoomLayout(ROOM);
    this.openEditor();
    this.menuChoice = "photos";
    this.refreshMenu();
  }

  private openEditor(): void {
    this.editing = true;
    this.editorBase = JSON.parse(JSON.stringify(ROOM)) as RoomLayout;
    this.select(null);
    this.showSidePanel("none");
    this.editor?.element.removeAttribute("hidden");
    this.updateEmptyHint(this.store.state.items.length);
  }

  private closeEditor(): void {
    this.editing = false;
    this.editor?.element.setAttribute("hidden", "");
    this.updateEmptyHint(this.store.state.items.length);
  }

  /** Leave the editor for the 3D room view with catalogue and fit checks. */
  private finishBuild(): void {
    this.menuChoice =
      ROOM.source === "manual" ? "manual" : ROOM.source === "photos" ? "photos" : "sample";
    // A photo-built room is saved like a built room, so a reload reopens
    // it with its pieces; the sample room opens only when none is saved.
    if (ROOM.id === "photos-room") saveRoomLayout(ROOM);
    this.editorBase = null;
    // Building consumes the photo session: drop the stored photos now that
    // the room is confirmed, as before.
    if (this.photoDraft !== null) {
      this.photoDraft = null;
      this.photoMeta = null;
      this.editor?.setPhotoDraft(null);
      this.editorStore?.setPhoto(null);
      void clearAllPhotos();
    }
    this.closeEditor();
    this.rebuildRoom();
    this.refreshMenu();
    this.maybeShowDoorTip();
  }

  /** Cancel leaves the room with no change: restore the pre-edit layout. */
  private cancelEditor(): void {
    const base = this.editorBase;
    if (base !== null) {
      applyRoomLayout(ROOM, base);
      this.editorStore?.load(ROOM);
      this.syncRoomId();
      this.rebuildRoom();
    }
    // Cancelling a photo-built room also drops its stored photos.
    if (this.photoDraft !== null) {
      this.photoDraft = null;
      this.photoMeta = null;
      this.editor?.setPhotoDraft(null);
      this.editorStore?.setPhoto(null);
      void clearAllPhotos();
    }
    this.editorBase = null;
    this.closeEditor();
    this.refreshMenu();
  }

  /** Keep the scene's room id with the live room (autosave coherence). */
  private syncRoomId(): void {
    if (this.store.state.roomId !== ROOM.id) {
      this.store.replace({ ...this.store.state, roomId: ROOM.id });
    }
  }

  /** Rebuild the 3D room, fit engine and overlays after a plan edit. */
  private rebuildRoom(): void {
    if (this.roomGroup !== null) {
      this.scene.remove(this.roomGroup);
      this.roomGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
      });
      this.roomGroup = null;
    }
    const bounds = roomBounds(ROOM);
    const wM = cmToMeters(bounds.maxX - bounds.minX);
    const dM = cmToMeters(bounds.maxZ - bounds.minZ);
    const cxM = cmToMeters((bounds.minX + bounds.maxX) / 2);
    const czM = cmToMeters((bounds.minZ + bounds.maxZ) / 2);
    if (this.floorMaterial !== null) {
      const owned = this.floorMaterial;
      this.floorMaterial = null;
      owned.dispose();
    }
    dressWalls(() => this.requestRender(), ROOM.surfaces.wall, ROOM.surfaces.wallTint);
    const floorMat = makeFloorMaterial(wM, dM, () => this.requestRender(), ROOM.surfaces.floor);
    this.floorMaterial = floorMat;
    const built = buildRoom(ROOM, floorMat);
    this.scene.add(built.group);
    this.roomGroup = built.group;
    this.roomWalls = built.group;
    this.wallEntries = built.wallEntries.map((e) => ({
      wallId: e.wallId,
      meshes: e.meshes,
      outward: e.outward,
    }));
    const floor = built.group.getObjectByName("fitroom-floor");
    this.floorMesh = floor instanceof THREE.Mesh ? floor : null;
    this.rebuildExistingGroup();
    if (this.rig !== null) {
      this.scene.remove(this.rig.contactPlane);
      this.rig.contactPlane.geometry.dispose();
      const contact = new THREE.Mesh(
        new THREE.PlaneGeometry(wM, dM),
        this.rig.contactPlane.material,
      );
      contact.rotation.x = -Math.PI / 2;
      contact.position.set(cxM, 0.005, czM);
      contact.receiveShadow = true;
      contact.name = "fitroom-contact";
      this.scene.add(contact);
      this.rig.contactPlane = contact;
    }
    const aspect =
      Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight);
    const half = Math.max(wM, dM) / 2 + 1;
    this.planCam.top = half;
    this.planCam.bottom = -half;
    this.planCam.left = -half * aspect;
    this.planCam.right = half * aspect;
    this.planCam.position.set(cxM, 12, czM);
    this.planCam.lookAt(cxM, 0, czM);
    this.planCam.updateProjectionMatrix();
    this.planOverlay.svg.remove();
    this.planOverlay = new PlanOverlay(this.container, ROOM);
    this.planOverlay.setVisible(this.mode === "plan");
    this.fitEngine = new FitEngine(ROOM, catalogProducts(CATALOG_MAP));
    this.inspector.setBounds(roomBounds(ROOM));
    this.refreshIssues();
    this.updateMeasure();
    this.recommendPanel?.refresh();
    this.markSceneChanged();
  }

  /** Own pieces as simple blocks in the 3D room. */
  private rebuildExistingGroup(): void {
    if (this.existingGroup !== null) {
      this.scene.remove(this.existingGroup);
      this.existingGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const material = obj.material;
          if (material instanceof THREE.Material) material.dispose();
        }
      });
      this.existingGroup = null;
    }
    const group = new THREE.Group();
    group.name = "fitroom-existing";
    for (const piece of ROOM.existing) {
      const geometry = new THREE.BoxGeometry(
        cmToMeters(piece.footprint.w),
        cmToMeters(piece.height),
        cmToMeters(piece.footprint.d),
      );
      const material = new THREE.MeshStandardMaterial({ color: 0xd8d3cc, roughness: 0.9 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(
        cmToMeters(piece.footprint.x + piece.footprint.w / 2),
        cmToMeters(piece.height / 2),
        cmToMeters(piece.footprint.z + piece.footprint.d / 2),
      );
      mesh.rotation.y = (piece.footprint.rotationY * Math.PI) / 180;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `existing-${piece.id}`;
      group.add(mesh);
    }
    this.scene.add(group);
    this.existingGroup = group;
  }

  /** Highlight a free wall run on the floor while it is hovered. */
  private hoverRun(run: FreeRun | null): void {
    if (this.runHighlight !== null) {
      this.scene.remove(this.runHighlight);
      this.runHighlight.geometry.dispose();
      (this.runHighlight.material as THREE.Material).dispose();
      this.runHighlight = null;
    }
    if (run === null) {
      this.requestRender();
      return;
    }
    const desc = describeRun(ROOM, run);
    if (desc === null) return;
    const geometry = new THREE.PlaneGeometry(cmToMeters(desc.length_cm), cmToMeters(desc.depth_cm));
    geometry.rotateX(-Math.PI / 2);
    const wall = ROOM.walls.find((w) => w.id === run.wall);
    let yaw = 0;
    if (wall !== undefined) {
      const dx = wall.end.x - wall.start.x;
      const dz = wall.end.z - wall.start.z;
      yaw = Math.atan2(-dz, dx);
    }
    const material = new THREE.MeshBasicMaterial({
      color: 0x0e9f7e,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.y = yaw;
    mesh.position.set(cmToMeters(desc.x), 0.02, cmToMeters(desc.z));
    mesh.renderOrder = 5;
    this.scene.add(mesh);
    this.runHighlight = mesh;
    this.requestRender();
  }

  private commitMove(id: string, x: number, z: number): void {
    const clamped = this.clampToRoom(x, z, id);
    this.store.commit((draft) => {
      const it = draft.items.find((i) => i.instanceId === id);
      if (it !== undefined) {
        it.position = { x: clamped.x, z: clamped.z };
      }
    });
  }

  /** Arrow-key nudge as one undo step per press, with live fit feedback. */
  private nudgeSelected(dxCm: number, dzCm: number): void {
    const id = this.selectedId;
    if (id === null) return;
    const item = this.store.state.items.find((i) => i.instanceId === id);
    if (item === undefined) return;
    this.store.checkpoint();
    // Same whole-footprint clamp as the Inspector, so nudges never push
    // half a piece into a wall.
    const clamped = this.clampToRoom(item.position.x + dxCm, item.position.z + dzCm, id);
    item.position = { x: clamped.x, z: clamped.z };
    const live = this.instances.get(id);
    if (live !== undefined) {
      live.group.position.set(cmToMeters(clamped.x), 0, cmToMeters(clamped.z));
      this.positionHandle(live);
    }
    this.updateMeasure();
    this.refreshIssues([id]);
    this.store.touch();
    this.requestRender();
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
    const item = this.store.state.items.find((i) => i.instanceId === id);
    const entry = item === undefined ? undefined : CATALOG_MAP.get(item.productId);
    const label = entry?.name ?? "Piece";
    this.store.commit((draft) => {
      draft.items = draft.items.filter((i) => i.instanceId !== id);
    });
    if (this.selectedId === id) this.select(null);
    this.updateUndoRedo();
    this.showDeleteToast(label);
  }

  private doUndo(): void {
    if (this.editing) {
      this.editorStore?.undo();
      return;
    }
    if (this.store.undo()) {
      void this.syncInstances();
      this.refreshIssues();
    }
    this.updateUndoRedo();
  }

  private doRedo(): void {
    if (this.editing) return;
    if (this.store.redo()) {
      void this.syncInstances();
      this.refreshIssues();
    }
    this.updateUndoRedo();
  }

  private updateUndoRedo(): void {
    const undo = document.getElementById("tool-undo");
    const redo = document.getElementById("tool-redo");
    if (undo instanceof HTMLButtonElement) undo.disabled = !this.store.canUndo();
    if (redo instanceof HTMLButtonElement) redo.disabled = !this.store.canRedo();
  }

  private showDeleteToast(label: string): void {
    let host = document.getElementById("delete-toast");
    if (host === null) {
      host = document.createElement("div");
      host.id = "delete-toast";
      host.className = "delete-toast";
      host.setAttribute("hidden", "");
      document.getElementById("scene-container")?.appendChild(host);
      this.toastEl = host;
    }
    host.innerHTML = "";
    const text = document.createElement("span");
    text.textContent = `Deleted ${label} · `;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Undo";
    btn.addEventListener("click", () => {
      this.hideDeleteToast();
      this.doUndo();
    });
    host.append(text, btn);
    host.removeAttribute("hidden");
    this.placeToastAboveToolbar(host);
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.hideDeleteToast(), 5000);
  }

  /** Toasts sit above the toolbar whatever its wrapped height is, so the toast never covers a control. */
  private placeToastAboveToolbar(host: HTMLElement): void {
    const toolbar = this.container.querySelector(".bottom-toolbar");
    const toolbarHeight =
      toolbar instanceof HTMLElement ? toolbar.getBoundingClientRect().height : 52;
    host.style.bottom = `${String(Math.ceil(toolbarHeight) + 24)}px`;
  }

  private hideDeleteToast(): void {
    window.clearTimeout(this.toastTimer);
    document.getElementById("delete-toast")?.setAttribute("hidden", "");
  }

  /** Pan stays inside the room: clamp the orbit target to the floor + 1 m. */
  private clampTarget(): void {
    const bounds = roomBounds(ROOM);
    const minX = cmToMeters(bounds.minX) - 1;
    const maxX = cmToMeters(bounds.maxX) + 1;
    const minZ = cmToMeters(bounds.minZ) - 1;
    const maxZ = cmToMeters(bounds.maxZ) + 1;
    const t = this.controls.target;
    t.x = Math.min(maxX, Math.max(minX, t.x));
    t.z = Math.min(maxZ, Math.max(minZ, t.z));
    t.y = Math.min(0.5, Math.max(0, t.y));
  }

  /** Frame the whole room from the default angle (button + Home key). */
  private resetView(): void {
    const bounds = roomBounds(ROOM);
    const wM = cmToMeters(bounds.maxX - bounds.minX);
    const dM = cmToMeters(bounds.maxZ - bounds.minZ);
    const cxM = cmToMeters((bounds.minX + bounds.maxX) / 2);
    const czM = cmToMeters((bounds.minZ + bounds.maxZ) / 2);
    const aspect =
      Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight);
    if (this.mode !== "orbit") this.setMode("orbit");
    this.frameDollhouse(cxM, czM, wM, dM, aspect);
    this.clampTarget();
    this.controls.update();
    this.requestRender();
  }

  /** Follow the selected piece every frame so the outline turns with it. */
  private updateOutline(): void {
    if (this.outline !== null && this.selectedId !== null) {
      const item = this.store.state.items.find((i) => i.instanceId === this.selectedId);
      const entry = item === undefined ? undefined : CATALOG_MAP.get(item.productId);
      if (item !== undefined && entry !== undefined) {
        const rect = orientedFootprint(entry.size, item.position, item.rotationY);
        const pos = this.outline.geometry.getAttribute("position") as THREE.BufferAttribute;
        rect.corners.forEach((c, i) => {
          pos.setXYZ(i, cmToMeters(c.x), 0.03, cmToMeters(c.z));
        });
        pos.needsUpdate = true;
      }
    }
    if (this.hoverOutline !== null && this.hoverId !== null) {
      const item = this.store.state.items.find((i) => i.instanceId === this.hoverId);
      const entry = item === undefined ? undefined : CATALOG_MAP.get(item.productId);
      if (item !== undefined && entry !== undefined) {
        const rect = orientedFootprint(entry.size, item.position, item.rotationY);
        const pos = this.hoverOutline.geometry.getAttribute("position") as THREE.BufferAttribute;
        rect.corners.forEach((c, i) => {
          pos.setXYZ(i, cmToMeters(c.x), 0.03, cmToMeters(c.z));
        });
        pos.needsUpdate = true;
      }
    }
  }

  /** Rebuild the neutral selection outline from the current scene item. */
  private rebuildOutline(): void {
    if (this.outline !== null) {
      this.scene.remove(this.outline);
      this.outline.geometry.dispose();
      (this.outline.material as THREE.Material).dispose();
      this.outline = null;
    }
    const id = this.selectedId;
    const item = id === null ? undefined : this.store.state.items.find((i) => i.instanceId === id);
    const entry = id === null ? undefined : CATALOG_MAP.get(item?.productId ?? "");
    if (item === undefined || entry === undefined) return;
    const rect = orientedFootprint(entry.size, item.position, item.rotationY);
    const geo = new THREE.BufferGeometry().setFromPoints(
      rect.corners.map((c) => new THREE.Vector3(cmToMeters(c.x), 0.03, cmToMeters(c.z))),
    );
    this.outline = new THREE.LineLoop(
      geo,
      new THREE.LineBasicMaterial({ color: SELECT_CORAL, depthWrite: false }),
    );
    this.outline.renderOrder = 5;
    this.scene.add(this.outline);
  }

  /** Rebuild the lighter hover outline for the piece under the pointer. */
  private rebuildHoverOutline(): void {
    if (this.hoverOutline !== null) {
      this.scene.remove(this.hoverOutline);
      this.hoverOutline.geometry.dispose();
      (this.hoverOutline.material as THREE.Material).dispose();
      this.hoverOutline = null;
    }
    const id = this.hoverId;
    if (id === null || id === this.selectedId) return;
    const item = this.store.state.items.find((i) => i.instanceId === id);
    const entry = item === undefined ? undefined : CATALOG_MAP.get(item.productId);
    if (item === undefined || entry === undefined) return;
    const rect = orientedFootprint(entry.size, item.position, item.rotationY);
    const geo = new THREE.BufferGeometry().setFromPoints(
      rect.corners.map((c) => new THREE.Vector3(cmToMeters(c.x), 0.03, cmToMeters(c.z))),
    );
    this.hoverOutline = new THREE.LineLoop(
      geo,
      new THREE.LineBasicMaterial({ color: HOVER_CORAL, depthWrite: false }),
    );
    this.hoverOutline.renderOrder = 4;
    this.scene.add(this.hoverOutline);
  }

  private setHover(id: string | null): void {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.rebuildHoverOutline();
    this.renderer.domElement.style.cursor = id === null ? "" : "grab";
    this.requestRender();
  }

  private select(id: string | null): void {
    this.selectedId = id;
    this.rebuildOutline();
    // The hover outline never doubles the selection.
    if (this.hoverId !== null && this.hoverId === id) this.setHover(null);
    else this.rebuildHoverOutline();
    const entry = id === null ? undefined : this.instances.get(id);
    if (entry !== undefined) {
      this.rotateHandle.visible = true;
      this.positionHandle(entry);
    } else {
      this.rotateHandle.visible = false;
    }
    const current =
      id === null ? null : (this.store.state.items.find((i) => i.instanceId === id) ?? null);
    this.inspector.setSelection(current);
    this.recommendPanel?.setSelected(current);
    // Selecting a piece shows the Inspector floating over the 3D view: the
    // stage never narrows and the camera never moves.
    if (id !== null) this.showSidePanel("inspector");
    this.updateSelectionTools();
    this.updateMeasure();
    this.requestRender();
  }

  /** Selection tools (rotate, delete) exist only while a piece is selected. */
  private updateSelectionTools(): void {
    const has = this.selectedId !== null;
    for (const id of ["tool-rot-left", "tool-rot-right", "tool-delete"]) {
      const el = document.getElementById(id);
      if (el === null) continue;
      if (has) el.removeAttribute("hidden");
      else el.setAttribute("hidden", "");
      if (el instanceof HTMLButtonElement) el.disabled = !has;
    }
  }

  /** Clamp a room position so the whole rotated footprint stays inside:
   * the Inspector and arrow keys can never push half a piece into a wall. */
  private clampToRoom(x: number, z: number, id: string | null = null): { x: number; z: number } {
    const b = roomBounds(ROOM);
    const item = id === null ? undefined : this.store.state.items.find((i) => i.instanceId === id);
    const entry = item === undefined ? undefined : CATALOG_MAP.get(item.productId);
    if (item === undefined || entry === undefined) {
      return {
        x: Math.min(b.maxX, Math.max(b.minX, Math.round(x))),
        z: Math.min(b.maxZ, Math.max(b.minZ, Math.round(z))),
      };
    }
    const next = clampFootprintToRoom(
      Math.round(x),
      Math.round(z),
      entry.size.w,
      entry.size.d,
      item.rotationY,
      b,
    );
    return { x: Math.round(next.x), z: Math.round(next.z) };
  }

  /** Toolbar toggle state, announced (aria-pressed) and visible. */
  private setToggle(id: string, on: boolean): void {
    const el = document.getElementById(id);
    if (el === null) return;
    el.setAttribute("data-active", String(on));
    el.setAttribute("aria-pressed", String(on));
  }

  /** Right-hand column: one panel at a time (Inspector, Recommend, Arrange). */
  private showSidePanel(name: "inspector" | "recommend" | "assistant" | "none"): void {
    const inspector = document.getElementById("inspector");
    const recommend = document.getElementById("recommend-panel");
    const assistant = document.getElementById("assistant-panel");
    if (name === "inspector") inspector?.removeAttribute("hidden");
    else inspector?.setAttribute("hidden", "");
    if (name === "recommend") recommend?.removeAttribute("hidden");
    else recommend?.setAttribute("hidden", "");
    if (name === "assistant") {
      assistant?.removeAttribute("hidden");
      this.assistantPanel?.syncMode();
    } else {
      assistant?.setAttribute("hidden", "");
    }
    this.setToggle("tool-recommend", name === "recommend");
    this.setToggle("tool-assistant", name === "assistant");
    // Panels float over the 3D view: the stage keeps its size, so the
    // cameras keep their aspect and nothing under the pointer moves.
    // While any panel is open the fit badge sits left of it (see
    // `has-side-panel` in style.css), never over the panel's tabs.
    this.container.classList.toggle("has-side-panel", name !== "none");
    this.resize();
  }

  /** Hide developer controls unless the address has `?dev=1`. */
  private applyDevGating(): void {
    let dev = false;
    try {
      dev = new URLSearchParams(window.location.search).get("dev") === "1";
    } catch {
      // Non-browser context: stay non-dev.
    }
    if (dev) return;
    document.getElementById("tool-scenes")?.setAttribute("hidden", "");
    document.getElementById("api-status")?.setAttribute("hidden", "");
  }

  /** Ring around the footprint centre on the floor; radius follows the piece. */
  private positionHandle(entry: InstanceEntry): void {
    const box = new THREE.Box3().setFromObject(entry.group);
    const center = box.getCenter(new THREE.Vector3());
    const sizeX = box.max.x - box.min.x;
    const sizeZ = box.max.z - box.min.z;
    const radiusM = Math.hypot(sizeX, sizeZ) / 2 + 0.22;
    this.rotateRingRadiusM = Math.min(1.6, Math.max(0.45, radiusM));
    const visible = this.rotateHandle.children[0];
    const hit = this.rotateHandle.children[1];
    if (visible instanceof THREE.Mesh) {
      visible.geometry.dispose();
      visible.geometry = new THREE.RingGeometry(
        Math.max(0.05, this.rotateRingRadiusM - 0.045),
        this.rotateRingRadiusM,
        48,
      );
    }
    if (hit instanceof THREE.Mesh) {
      hit.geometry.dispose();
      hit.geometry = new THREE.RingGeometry(
        Math.max(0.05, this.rotateRingRadiusM - 0.2),
        this.rotateRingRadiusM + 0.2,
        32,
      );
    }
    this.rotateHandle.position.set(center.x, 0.045, center.z);
  }

  // ---- sync ----

  private async syncInstances(): Promise<void> {
    // Single sync path: the synchronizer reconciles the whole scene from
    // the store state, serializing concurrent runs so a delete or undo
    // landing mid-load can never leave a ghost model behind or add a
    // second one.
    if (this.syncer !== null) {
      await this.syncer.sync(this.store.state.items);
    }
    if (this.selectedId !== null && !this.instances.has(this.selectedId)) {
      this.select(null);
    } else if (this.selectedId !== null) {
      this.select(this.selectedId);
    }
    if (this.hoverId !== null && !this.instances.has(this.hoverId)) this.setHover(null);
    else this.rebuildHoverOutline();
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
      if (errors > 0 && warns > 0) {
        badge.dataset["state"] = "bad";
        badge.textContent =
          `✕ ${errors} problem${errors === 1 ? "" : "s"} · ` +
          `${warns} warning${warns === 1 ? "" : "s"}`;
      } else if (errors > 0) {
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

  /** Live fit feedback while dragging, re-checked at most once per frame. */
  private scheduleLiveIssues(movedId: string): void {
    this.liveDirty = movedId;
    this.requestRender();
  }

  /** Green "Fits" confirmation on release when the piece has no issue. */
  private maybeShowFits(id: string): void {
    if (this.issues.some((issue) => issue.itemIds.includes(id))) return;
    const item = this.store.state.items.find((i) => i.instanceId === id);
    if (item === undefined) return;
    this.fitOverlay.showFits({ ...item.position }, id);
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
      const suffix =
        entry === undefined || issue.message.includes(entry.name) ? "" : ` — ${entry.name}`;
      b.textContent = `${issue.severity === "error" ? "✕" : "!"} ${issue.message}${suffix}`;
      b.title = issue.message;
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
    if (this.devCam) return;
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

  /** Scene menu: start from an empty room (items only, keep the camera). */
  private startEmptyRoom(): void {
    this.select(null);
    const next = emptyScene(ROOM.id);
    this.store.replace({ ...next, camera: this.store.state.camera });
  }

  /** Room total in the top bar: "4 items · $3,280" (labelled, tabular figures). */
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
    el.textContent = formatTopBar(count, total);
    el.title = count === 0 ? "Your cart is empty" : `${formatTopBar(count, total)} in your cart`;
    const cart = document.getElementById("tool-cart");
    if (cart instanceof HTMLButtonElement) {
      cart.disabled = total === 0;
      cart.title = total === 0 ? "Add furniture to the room first" : "Download your cart as JSON";
    }
    this.updateEmptyHint(count);
  }

  /** Empty room hint: the 3D view never sits blank without a next step. */
  private updateEmptyHint(count: number): void {
    let hint = document.getElementById("empty-hint");
    if (count > 0 || this.editing) {
      hint?.setAttribute("hidden", "");
      return;
    }
    if (hint === null) {
      hint = document.createElement("div");
      hint.id = "empty-hint";
      hint.className = "empty-hint";
      const text = document.createElement("span");
      text.textContent = "This room is empty. Add furniture from the catalog on the left. ";
      const furnish = document.createElement("button");
      furnish.type = "button";
      furnish.className = "empty-hint-link";
      furnish.textContent = "Furnish it for me";
      furnish.addEventListener("click", () => {
        this.showSidePanel("assistant");
        this.assistantPanel?.openFurnish();
      });
      hint.append(text, furnish);
      this.container.appendChild(hint);
    }
    hint.removeAttribute("hidden");
  }

  /** Furnish-turn toast: applied as one undo step, undoable from the toast. */
  private showFurnishedToast(): void {
    let host = document.getElementById("delete-toast");
    if (host === null) {
      host = document.createElement("div");
      host.id = "delete-toast";
      host.className = "delete-toast";
      host.setAttribute("hidden", "");
      document.getElementById("scene-container")?.appendChild(host);
      this.toastEl = host;
    }
    host.innerHTML = "";
    const text = document.createElement("span");
    text.textContent = "Furnished · ";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Undo";
    btn.addEventListener("click", () => {
      this.hideDeleteToast();
      this.doUndo();
    });
    host.append(text, btn);
    host.removeAttribute("hidden");
    this.placeToastAboveToolbar(host);
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.hideDeleteToast(), 5000);
  }

  /**
   * First-visit coach marks: three short steps in order (click a piece,
   * drag it, add more from the catalog), dismissible, shown once
   * (remembered locally). The bar is anchored to the bottom chrome above
   * the toolbar, so it never covers a piece in the room.
   */
  private maybeShowCoachMarks(): void {
    const seen = ((): boolean => {
      try {
        return window.localStorage.getItem("fitroom.coach-seen") === "1";
      } catch {
        return true;
      }
    })();
    if (seen) return;
    const steps = [
      "Click a piece to select it.",
      "Drag a piece to move it.",
      "Add more from the catalog on the left.",
    ];
    let at = 0;
    const bar = document.createElement("div");
    bar.className = "coach-marks";
    bar.setAttribute("role", "status");
    const text = document.createElement("span");
    text.className = "coach-text";
    const next = document.createElement("button");
    next.type = "button";
    next.className = "coach-next";
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "coach-skip";
    skip.textContent = "Skip tour";
    const done = (): void => {
      try {
        window.localStorage.setItem("fitroom.coach-seen", "1");
      } catch {
        // Private mode: the tour simply shows again next visit.
      }
      bar.remove();
    };
    const draw = (): void => {
      text.textContent = `${String(at + 1)} of ${String(steps.length)} · ${steps[at] ?? ""}`;
      next.textContent = at === steps.length - 1 ? "Got it" : "Next";
    };
    next.addEventListener("click", () => {
      at += 1;
      if (at >= steps.length) done();
      else draw();
    });
    skip.addEventListener("click", done);
    bar.append(text, next, skip);
    this.container.appendChild(bar);
    // Sit above the toolbar whatever its wrapped height is, so the bar
    // never covers the Recommend or Arrange buttons.
    const toolbar = this.container.querySelector(".bottom-toolbar");
    const toolbarHeight =
      toolbar instanceof HTMLElement ? toolbar.getBoundingClientRect().height : 52;
    bar.style.bottom = `${String(Math.ceil(toolbarHeight) + 24)}px`;
    draw();
  }

  /** Download the current cart (room + placed pieces + total) as JSON. */
  private downloadCart(): void {
    if (this.store.state.items.length === 0) return;
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
      const count = this.store.state.items.length;
      this.measureEl.textContent =
        `Room ${Math.round(b.maxX - b.minX)} × ${Math.round(b.maxZ - b.minZ)} cm · ` +
        `${String(count)} ${count === 1 ? "item" : "items"}`;
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
    this.measureEl.textContent = formatMeasure(
      entry.name,
      entry.size.w,
      entry.size.d,
      wallM * 100,
      item.rotationY,
    );
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

  private applyCameraLock(): void {
    this.controls.enabled = !this.ownership.locked;
  }

  private pickInstanceId(): string | null {
    const targets = [...this.instances.values()].map((e) => e.group);
    if (targets.length === 0) return null;
    const picks = this.raycaster.intersectObjects(targets, true);
    if (picks.length === 0) return null;
    let obj: THREE.Object3D | null = picks[0]?.object ?? null;
    while (obj !== null && ![...this.instances.values()].some((e) => e.group === obj)) {
      obj = obj.parent;
    }
    const found = [...this.instances.entries()].find(([, e]) => e.group === obj);
    return found?.[0] ?? null;
  }

  private bindPointer(): void {
    const el = this.renderer.domElement;
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();

    // Capture phase: own piece/handle pointers before OrbitControls sees
    // them, so holding a piece never moves the camera. Stopping the event
    // here keeps OrbitControls (listening on the same canvas) from
    // starting an orbit with the same pointer. A second finger that goes
    // down while a piece is held is owned too.
    el.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        if (this.ownership.locked) {
          this.ownership.own(event.pointerId, event.clientX, event.clientY);
          this.applyCameraLock();
          event.stopImmediatePropagation();
          event.preventDefault();
          try {
            el.setPointerCapture(event.pointerId);
          } catch {
            // Capture may be unavailable; the ownership set still locks.
          }
          return;
        }
        const ndc = this.setPointer(event);
        this.raycaster.setFromCamera(ndc, this.activeCamera());
        if (this.rotateHandle.visible) {
          const hits = this.raycaster.intersectObject(this.rotateHandle, true);
          if (hits.length > 0 && this.selectedId !== null) {
            this.ownership.own(event.pointerId, event.clientX, event.clientY);
            this.rotating = true;
            this.rotatePointerId = event.pointerId;
            el.style.cursor = "grabbing";
            this.store.checkpoint();
            this.applyCameraLock();
            event.stopImmediatePropagation();
            event.preventDefault();
            try {
              el.setPointerCapture(event.pointerId);
            } catch {
              // ignore
            }
            return;
          }
        }
        const foundId = this.pickInstanceId();
        if (foundId !== null) {
          this.ownership.own(event.pointerId, event.clientX, event.clientY);
          this.select(foundId);
          el.style.cursor = "grabbing";
          const item = this.store.state.items.find((i) => i.instanceId === foundId);
          if (item !== undefined && this.raycaster.ray.intersectPlane(floorPlane, hit)) {
            this.drag = {
              pointerId: event.pointerId,
              id: foundId,
              offsetX: item.position.x - hit.x * 100,
              offsetZ: item.position.z - hit.z * 100,
            };
            this.store.checkpoint();
            try {
              el.setPointerCapture(event.pointerId);
            } catch {
              // ignore
            }
          } else {
            this.drag = { pointerId: event.pointerId, id: foundId, offsetX: 0, offsetZ: 0 };
            this.store.checkpoint();
          }
          this.applyCameraLock();
          event.stopImmediatePropagation();
          event.preventDefault();
          return;
        }
        this.ownership.noteEmptyDown(event.pointerId, event.clientX, event.clientY);
      },
      true,
    );

    el.addEventListener("pointermove", (event) => {
      if (!this.ownership.isOwned(event.pointerId)) {
        // Hover highlight + grab cursor when no drag/rotate is active. The
        // NDC comes straight from the canvas rect, so the mapping is exact
        // in both Orbit and Plan modes.
        if (this.drag === null && !this.rotating && event.pointerType === "mouse") {
          const ndc = this.setPointer(event);
          this.raycaster.setFromCamera(ndc, this.activeCamera());
          this.setHover(this.pickInstanceId());
        }
        return;
      }
      const ndc = this.setPointer(event);
      this.raycaster.setFromCamera(ndc, this.activeCamera());
      if (this.rotating && event.pointerId === this.rotatePointerId && this.selectedId !== null) {
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
            // Live fit feedback without stutter: re-checked once per frame.
            this.scheduleLiveIssues(item.instanceId);
          }
        }
        return;
      }
      if (this.drag !== null && event.pointerId === this.drag.pointerId) {
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

    el.addEventListener("pointerup", (event) => {
      const wasOwned = this.ownership.isOwned(event.pointerId);
      const down = this.ownership.downRecord(event.pointerId);
      const isDragPointer = this.drag !== null && event.pointerId === this.drag.pointerId;
      const isRotatePointer = this.rotating && event.pointerId === this.rotatePointerId;
      const releasedId = isDragPointer
        ? (this.drag?.id ?? null)
        : isRotatePointer
          ? this.selectedId
          : null;
      if (wasOwned) {
        // Flush one last live check before the commit so the release
        // verdict matches the final pose.
        if (this.liveDirty !== null) {
          const movedId = this.liveDirty;
          this.liveDirty = null;
          this.refreshIssues([movedId]);
        }
        if (isDragPointer || isRotatePointer) {
          // Commit: the store emits, which runs the full (non-incremental)
          // fit check once.
          this.store.touch();
        }
      }
      this.ownership.release(event.pointerId);
      this.ownership.forget(event.pointerId);
      el.style.cursor = "";
      if (isDragPointer) this.drag = null;
      if (isRotatePointer) {
        this.rotating = false;
        this.rotatePointerId = null;
      }
      if (!this.ownership.locked) {
        this.drag = null;
        this.rotating = false;
        this.rotatePointerId = null;
        this.applyCameraLock();
      }
      if (releasedId !== null) {
        this.maybeShowFits(releasedId);
        this.requestRender();
        return;
      }
      if (!wasOwned) {
        // Empty space: only a click (down and up within 5 px) deselects;
        // an orbit or pan drag keeps the selection.
        if (PointerOwnership.isClick(down, event.clientX, event.clientY)) {
          this.select(null);
        }
        this.ownership.forget(event.pointerId);
      }
      this.requestRender();
    });

    const cancelPointer = (event: PointerEvent): void => {
      const isDragPointer = this.drag !== null && event.pointerId === this.drag.pointerId;
      const isRotatePointer = this.rotating && event.pointerId === this.rotatePointerId;
      if (isDragPointer || isRotatePointer) {
        if (this.liveDirty !== null) {
          const movedId = this.liveDirty;
          this.liveDirty = null;
          this.refreshIssues([movedId]);
        }
        this.store.touch();
      }
      this.ownership.cancel(event.pointerId);
      if (isDragPointer) this.drag = null;
      if (isRotatePointer) {
        this.rotating = false;
        this.rotatePointerId = null;
      }
      if (!this.ownership.locked) {
        this.drag = null;
        this.rotating = false;
        this.rotatePointerId = null;
        this.applyCameraLock();
      }
      this.requestRender();
    };
    el.addEventListener("pointercancel", cancelPointer);
    el.addEventListener("lostpointercapture", cancelPointer);
    window.addEventListener("blur", () => {
      if (this.liveDirty !== null) {
        const movedId = this.liveDirty;
        this.liveDirty = null;
        this.refreshIssues([movedId]);
      }
      if (this.drag !== null || this.rotating) this.store.touch();
      this.drag = null;
      this.rotating = false;
      this.rotatePointerId = null;
      this.ownership.clear();
      this.applyCameraLock();
      this.requestRender();
    });
  }

  private bindKeys(): void {
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        const openDialog = document.querySelector("dialog[open]");
        if (openDialog !== null) return;
        if (this.photoFlow !== null) return;
        if (this.editing) {
          this.cancelEditor();
          return;
        }
        if (this.renderViewer !== null) {
          // Only close the viewer when it is actually open.
          const host = document.getElementById("render-viewer");
          const isOpen = host !== null && !host.hasAttribute("hidden") && host.children.length > 0;
          if (isOpen) {
            this.renderViewer.close();
            return;
          }
        }
        const fitList = document.getElementById("fit-list");
        if (fitList !== null && !fitList.hasAttribute("hidden")) {
          fitList.setAttribute("hidden", "");
          return;
        }
        this.select(null);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        this.resetView();
        return;
      }
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.isContentEditable) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        this.doRedo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          this.doRedo();
          return;
        }
        this.doUndo();
        return;
      }
      if (this.selectedId === null) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        this.deleteItem(this.selectedId);
      } else if (event.key.toLowerCase() === "r") {
        const item = this.store.state.items.find((i) => i.instanceId === this.selectedId);
        if (item !== undefined) {
          const step = event.shiftKey ? 1 : 15;
          this.commitRotate(item.instanceId, item.rotationY + step);
        }
      } else if (event.key.startsWith("Arrow")) {
        // Arrow keys move the selected piece 1 cm (Shift: 10 cm) as one
        // undo step per press, with live fit checks.
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        if (event.key === "ArrowLeft") this.nudgeSelected(-step, 0);
        else if (event.key === "ArrowRight") this.nudgeSelected(step, 0);
        else if (event.key === "ArrowUp") this.nudgeSelected(0, -step);
        else if (event.key === "ArrowDown") this.nudgeSelected(0, step);
      }
    });
  }

  private bindToolbar(): void {
    const on = (id: string, fn: () => void): void => {
      document.getElementById(id)?.addEventListener("click", fn);
    };
    on("tool-cart", () => this.downloadCart());
    on("tool-recommend", () => {
      const panel = document.getElementById("recommend-panel");
      if (panel === null) return;
      this.showSidePanel(panel.hasAttribute("hidden") ? "recommend" : "none");
    });
    on("tool-assistant", () => {
      const panel = document.getElementById("assistant-panel");
      if (panel === null) return;
      this.showSidePanel(panel.hasAttribute("hidden") ? "assistant" : "none");
    });
    on("tool-orbit", () => this.setMode("orbit"));
    on("tool-plan", () => this.setMode("plan"));
    on("tool-render", () => {
      this.showSidePanel("none");
      this.select(null);
      void this.renderViewer?.visualise();
    });
    on("tool-clearance", () => this.toggleClearance());
    const scenes = document.getElementById("tool-scenes");
    if (scenes instanceof HTMLSelectElement) {
      scenes.addEventListener("change", () => {
        if (scenes.value === "empty") this.startEmptyRoom();
        else if (scenes.value !== "") this.loadTestScene(scenes.value);
        scenes.value = "";
      });
    }
    on("tool-rot-left", () => this.nudgeRotate(-15));
    on("tool-rot-right", () => this.nudgeRotate(15));
    on("tool-delete", () => {
      if (this.selectedId !== null) this.deleteItem(this.selectedId);
    });
    on("tool-undo", () => this.doUndo());
    on("tool-redo", () => this.doRedo());
    on("tool-reset-view", () => this.resetView());
    on("tool-credits", () => {
      const dlg = document.getElementById("credits-dialog");
      if (dlg instanceof HTMLDialogElement) dlg.showModal();
    });
  }

  /**
   * Dollhouse framing for the first visit: the whole room in view with a
   * margin, from a raised front corner so the two cutaway walls (hidden by
   * updateDollhouse) face the camera. Fits the room's bounding sphere
   * inside the smaller of the vertical/horizontal fields of view.
   */
  private frameDollhouse(cxM: number, czM: number, wM: number, dM: number, aspect: number): void {
    const wallHeightM = 2.6;
    const radius = Math.sqrt(
      (wM / 2) * (wM / 2) + (dM / 2) * (dM / 2) + (wallHeightM / 2) * (wallHeightM / 2),
    );
    const vFov = (this.orbitCam.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const fitFov = Math.min(vFov, hFov);
    const dist = (radius / Math.sin(fitFov / 2)) * 1.12;
    const dir = new THREE.Vector3(0.85, 0.85, 1).normalize();
    this.controls.target.set(cxM, 0.3, czM);
    this.orbitCam.position.set(cxM + dir.x * dist, 0.3 + dir.y * dist, czM + dir.z * dist);
    this.controls.update();
  }

  /** Preset name for the render key: plan, eye-level, or dollhouse. */
  private renderPreset(): string {
    if (this.mode === "plan") return "plan";
    const y = this.orbitCam.position.y;
    return y <= 2.0 ? "eye-level" : "dollhouse";
  }

  /**
   * Walls as the capture shows them (dollhouse only): the cut-away pair
   * and every visible wall's place in the image, from the live camera —
   * the same pair `updateDollhouse` hides, so the prompt can no longer
   * list windows on walls the capture cut away.
   */
  private renderWallView(): RenderWallView | undefined {
    if (this.mode === "plan" || this.renderPreset() !== "dollhouse") return undefined;
    const cam = this.activeCamera();
    const bounds = roomBounds(ROOM);
    const cx = cmToMeters((bounds.minX + bounds.maxX) / 2);
    const cz = cmToMeters((bounds.minZ + bounds.maxZ) / 2);
    const toCam = new THREE.Vector3(cam.position.x - cx, 0, cam.position.z - cz);
    if (toCam.lengthSq() < 1e-6) toCam.set(0.85, 0, 1);
    toCam.normalize();
    const forward = new THREE.Vector3();
    cam.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    return dollhouseWallView(ROOM, { x: toCam.x, z: toCam.z }, { x: right.x, z: right.z });
  }

  /** Clearance overlay toggle: shade the circulation-blocked 1 cm cells. */
  private toggleClearance(): void {
    const next = !this.fitOverlay.clearanceVisible;
    this.fitOverlay.setClearanceVisible(next);
    this.setToggle("tool-clearance", next);
    this.requestRender();
  }

  private nudgeRotate(delta: number): void {
    if (this.selectedId === null) return;
    const item = this.store.state.items.find((i) => i.instanceId === this.selectedId);
    if (item !== undefined) this.commitRotate(item.instanceId, item.rotationY + delta);
  }

  private setMode(mode: "orbit" | "plan"): void {
    if (this.devCam) return;
    this.mode = mode;
    this.setToggle("tool-orbit", mode === "orbit");
    this.setToggle("tool-plan", mode === "plan");
    this.planOverlay.setVisible(mode === "plan");
    this.controls.object = mode === "plan" ? this.planCam : this.orbitCam;
    this.controls.enableRotate = mode === "orbit";
    this.controls.maxPolarAngle = mode === "plan" ? 0.01 : MAX_POLAR;
    if (mode === "plan") {
      const bounds = roomBounds(ROOM);
      this.controls.target.set(
        cmToMeters((bounds.minX + bounds.maxX) / 2),
        0,
        cmToMeters((bounds.minZ + bounds.maxZ) / 2),
      );
    }
    this.controls.update();
    // Walls hide in plan view, so the shadow map must render again without
    // them: otherwise the orbit view's wall shadows spill outside the room.
    requestContactRefresh(this.rig);
    this.shadowNeedsUpdate = true;
    this.requestRender();
  }

  // ---- frame ----

  private resize(): void {
    // Developer camera hook: a window resize redoes the frame and the
    // intrinsics together, never the frame alone.
    if (this.devCam) {
      this.devRefresh?.();
      this.requestRender();
      return;
    }
    // Defer every size change to the start of the next frame: frame()
    // applies it before rendering, so no resize ever lands between a draw
    // and the browser showing that frame.
    this.pendingResize = true;
    this.requestRender();
  }

  /** Apply a pending window resize before drawing (frame start only). */
  private applyResize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.orbitCam.aspect = w / h;
    this.orbitCam.updateProjectionMatrix();
    this.planCam.left = -this.planCam.top * (w / h);
    this.planCam.right = this.planCam.top * (w / h);
    this.planCam.updateProjectionMatrix();
    this.basePixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.renderer.setPixelRatio(this.basePixelRatio * this.orbitResolution.scale);
    this.renderer.setSize(w, h);
  }

  /** Dollhouse: hide the 2 walls nearest the camera (orbit mode only). */
  private updateDollhouse(): void {
    if (this.devCam) return;
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
    // Anchor the pill at the top far corner, never at the footprint centre,
    // so it can never cover the floor rotation ring (identical in plan,
    // where height does not separate the two).
    const v = new THREE.Vector3(box.max.x, box.max.y + 0.14, box.max.z).project(
      this.activeCamera(),
    );
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const sx = ((v.x + 1) / 2) * w;
    const sy = ((1 - v.y) / 2) * h;
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
      this.sizeTag.style.display = "none";
      return;
    }
    this.sizeTag.style.display = "block";
    this.sizeTag.style.left = `${sx}px`;
    this.sizeTag.style.top = `${sy}px`;
    this.sizeTag.textContent = `${Math.round(catalogEntry.size.w)}×${Math.round(catalogEntry.size.d)}cm`;
  }

  private frame(): void {
    // Developer camera hook: the pose is exact and frozen — draw the frame
    // without touching the position, rotation or projection.
    if (this.devCam) {
      if (this.shadowNeedsUpdate) {
        this.renderer.shadowMap.needsUpdate = true;
        this.shadowNeedsUpdate = false;
      }
      this.renderer.render(this.scene, this.orbitCam);
      return;
    }
    const t0 = performance.now();
    // Every resize (pixel-ratio or window size) lands here, before the
    // draw: nothing changes the drawing buffer after render() below.
    if (this.pendingResize) {
      this.pendingResize = false;
      this.applyResize();
    }
    // Never below the floor.
    if (this.orbitCam.position.y < 0.1) this.orbitCam.position.y = 0.1;
    // OrbitControls.update() returns true while the camera is still moving
    // (including damping glide): keep drawing until it settles, then stop.
    const moved = this.controls.update();
    this.clampTarget();
    // Decide this frame's resolution first and apply it before drawing.
    const scale = this.orbitResolution.update(moved, this.lastFrameCostMs, t0);
    const pixelRatio = this.basePixelRatio * scale;
    if (pixelRatio !== this.renderer.getPixelRatio()) {
      this.renderer.setPixelRatio(pixelRatio);
    }
    this.updateDollhouse();
    if (this.liveDirty !== null) {
      // Live fit feedback while dragging: at most one re-check per frame.
      const movedId = this.liveDirty;
      this.liveDirty = null;
      this.refreshIssues([movedId]);
    }
    this.updateOutline();
    if (this.selectedId !== null) {
      const entry = this.instances.get(this.selectedId);
      if (entry !== undefined) this.positionHandle(entry);
    }
    this.updateTag();
    if (this.mode === "plan") {
      // Plan labels land first so the fit chips avoid their fresh boxes.
      this.planOverlay.update(
        this.planCam,
        ROOM,
        this.container.clientWidth,
        this.container.clientHeight,
      );
    }
    this.fitOverlay.update(
      this.activeCamera(),
      this.container.clientWidth,
      this.container.clientHeight,
    );
    if (this.rig !== null && this.rig.contactNeedsRefresh.value) {
      this.rig.contactNeedsRefresh.value = false;
    }
    // Shadow maps are static between changes: refresh only after a change.
    if (this.shadowNeedsUpdate) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowNeedsUpdate = false;
    }
    this.renderer.render(this.scene, this.activeCamera());
    this.lastFrameCostMs = performance.now() - t0;
    if (moved) {
      this.requestRender();
    } else if (this.orbitResolution.inMotion) {
      // Still settling: keep drawing until the controller restores full
      // resolution after 200 ms still; that exit frame already draws full-res.
      this.requestRender();
    }
  }
}

const container = document.getElementById("scene-container");
if (container !== null) {
  new FitRoomApp(container);
}
void refreshApiStatus();
initLiveSwitch();
