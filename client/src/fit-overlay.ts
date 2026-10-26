import * as THREE from "three";
import type { DoorSector, FitAnalysis, FitIssue, PlanPoint } from "@fitroom/shared";
import { cmToMeters } from "@fitroom/shared";

const RED = 0xb3261e;
const AMBER = 0xe59500;

function shortLabel(issue: FitIssue): string {
  switch (issue.type) {
    case "overlap":
      return "Overlap";
    case "outside":
      return "Outside room";
    case "door-swing":
      return "Door swing";
    case "walkway":
      return "No walkway access";
    case "walkway-entrance":
      return "Entrance blocked";
    case "window":
      return "Near window";
  }
}

/**
 * Floor arcs for in-swing doors, the clearance overlay (blocked 1 cm cells
 * shaded red), red/amber outlines around involved pieces, and floating
 * ✕ / ! labels. Colours follow the fit-status tokens: red #B3261E for
 * problems, amber #E59500 for warnings, never the coral action colour.
 */
export class FitOverlay {
  private arcsBuilt = false;
  private clearanceMesh: THREE.Mesh | null = null;
  private clearanceTex: THREE.DataTexture | null = null;
  private clearanceNx = 0;
  private clearanceNz = 0;
  private boxes = new Map<string, THREE.BoxHelper>();
  private labelLayer: HTMLDivElement;
  private labels: Array<{ el: HTMLDivElement; at: PlanPoint }> = [];
  private groupOf: (id: string) => THREE.Object3D | undefined = () => undefined;

  constructor(
    private readonly scene: THREE.Scene,
    container: HTMLElement,
  ) {
    const layer = document.createElement("div");
    layer.className = "fit-issue-labels";
    container.appendChild(layer);
    this.labelLayer = layer;
  }

  setGroupResolver(fn: (id: string) => THREE.Object3D | undefined): void {
    this.groupOf = fn;
  }

  setAnalysis(analysis: FitAnalysis, issues: FitIssue[]): void {
    if (!this.arcsBuilt) {
      this.buildArcs(analysis.doors);
      this.arcsBuilt = true;
    }
    this.updateClearance(analysis);
    this.rebuildBoxes(issues);
    this.rebuildLabels(issues);
  }

  setClearanceVisible(visible: boolean): void {
    if (this.clearanceMesh !== null) this.clearanceMesh.visible = visible;
  }

  get clearanceVisible(): boolean {
    return this.clearanceMesh?.visible ?? false;
  }

  /** Door swing sectors as flat red sectors on the floor. */
  private buildArcs(doors: DoorSector[]): void {
    const mat = new THREE.MeshBasicMaterial({
      color: RED,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (const door of doors) {
      // Shape space maps to world as (sx, -sy): pre-negate the z sign so
      // the flat-rotated mesh lands on the plan coordinates.
      const shape = new THREE.Shape();
      const hx = cmToMeters(door.hx);
      const hz = cmToMeters(door.hz);
      shape.moveTo(hx, -hz);
      const steps = 24;
      for (let i = 0; i <= steps; i += 1) {
        const phi = (i / steps) * (Math.PI / 2);
        const dx = door.ax * Math.cos(phi) + door.nx * Math.sin(phi);
        const dz = door.az * Math.cos(phi) + door.nz * Math.sin(phi);
        shape.lineTo(hx + cmToMeters(dx * door.radius), -(hz + cmToMeters(dz * door.radius)));
      }
      shape.closePath();
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 4), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.02;
      mesh.name = `fit-swing-${door.doorId}`;
      mesh.renderOrder = 1;
      this.scene.add(mesh);
    }
  }

  /** Shade the circulation-blocked cells; rebuilt from each analysis. */
  private updateClearance(analysis: FitAnalysis): void {
    const { nx, nz, blockedCirculation } = analysis;
    if (
      this.clearanceMesh === null ||
      this.clearanceTex === null ||
      this.clearanceNx !== nx ||
      this.clearanceNz !== nz
    ) {
      if (this.clearanceMesh !== null) {
        this.scene.remove(this.clearanceMesh);
        this.clearanceMesh.geometry.dispose();
        this.clearanceMesh = null;
      }
      if (this.clearanceTex !== null) {
        this.clearanceTex.dispose();
        this.clearanceTex = null;
      }
      const data = new Uint8Array(nx * nz * 4);
      this.clearanceTex = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat);
      this.clearanceTex.flipY = false;
      this.clearanceTex.magFilter = THREE.NearestFilter;
      this.clearanceTex.minFilter = THREE.NearestFilter;
      this.clearanceTex.generateMipmaps = false;
      const mat = new THREE.MeshBasicMaterial({
        map: this.clearanceTex,
        transparent: true,
        depthWrite: false,
      });
      const geo = new THREE.PlaneGeometry(cmToMeters(nx), cmToMeters(nz));
      this.clearanceMesh = new THREE.Mesh(geo, mat);
      this.clearanceMesh.rotation.x = -Math.PI / 2;
      this.clearanceMesh.position.set(
        cmToMeters(analysis.originX + nx / 2),
        0.015,
        cmToMeters(analysis.originZ + nz / 2),
      );
      this.clearanceMesh.visible = false;
      this.clearanceMesh.name = "fit-clearance";
      this.clearanceMesh.renderOrder = 2;
      this.scene.add(this.clearanceMesh);
      this.clearanceNx = nx;
      this.clearanceNz = nz;
    }
    const tex = this.clearanceTex;
    if (tex === null) return;
    const data = tex.image.data as Uint8Array;
    for (let iz = 0; iz < nz; iz += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        // DataTexture rows start at v = 0 (flipY false): row 0 is the far
        // (north) grid row.
        const blocked = (blockedCirculation[(nz - 1 - iz) * nx + ix] ?? 0) === 1;
        const o = (iz * nx + ix) * 4;
        data[o] = 179;
        data[o + 1] = 38;
        data[o + 2] = 30;
        data[o + 3] = blocked ? 89 : 0;
      }
    }
    tex.needsUpdate = true;
  }

  private rebuildBoxes(issues: FitIssue[]): void {
    for (const box of this.boxes.values()) {
      this.scene.remove(box);
      box.geometry.dispose();
      const mat = box.material;
      if (mat instanceof THREE.Material) mat.dispose();
    }
    this.boxes.clear();
    const severityOf = new Map<string, "error" | "warning">();
    for (const issue of issues) {
      for (const id of issue.itemIds) {
        if (issue.severity === "error") {
          severityOf.set(id, "error");
        } else if (!severityOf.has(id)) {
          severityOf.set(id, "warning");
        }
      }
    }
    for (const [id, severity] of severityOf) {
      const group = this.groupOf(id);
      if (group === undefined) continue;
      const box = new THREE.BoxHelper(group, severity === "error" ? RED : AMBER);
      this.scene.add(box);
      this.boxes.set(id, box);
    }
  }

  private rebuildLabels(issues: FitIssue[]): void {
    this.labelLayer.innerHTML = "";
    this.labels = [];
    for (const issue of issues) {
      const el = document.createElement("div");
      el.className = "fit-issue-label";
      el.dataset["severity"] = issue.severity;
      el.textContent = `${issue.severity === "error" ? "✕" : "!"} ${shortLabel(issue)}`;
      this.labelLayer.appendChild(el);
      this.labels.push({ el, at: { ...issue.location } });
    }
  }

  /** Refresh outline + label projections; call once per frame. */
  update(camera: THREE.Camera, width: number, height: number): void {
    for (const box of this.boxes.values()) box.update();
    const v = new THREE.Vector3();
    for (const { el, at } of this.labels) {
      v.set(cmToMeters(at.x), 0.05, cmToMeters(at.z)).project(camera);
      if (v.z > 1) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "block";
      el.style.left = `${(((v.x + 1) / 2) * width).toFixed(1)}px`;
      el.style.top = `${(((1 - v.y) / 2) * height).toFixed(1)}px`;
    }
  }
}
