import * as THREE from "three";
import type { DoorSector, FitAnalysis, FitIssue, PlanPoint } from "@fitroom/shared";
import { cmToMeters } from "@fitroom/shared";

const RED = 0xb3261e;
const AMBER = 0xe59500;
/** Vertical pitch between stacked labels sharing one anchor (px). */
const LABEL_PITCH_PX = 26;

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
  private labels: Array<{ el: HTMLDivElement; at: PlanPoint; stack: number }> = [];
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

  /**
   * One floating label per issue. Issues on the same piece share an anchor
   * and stack upward (a door-swing + entrance pair shows two labels, never
   * one); `update` then separates every visible label so none overlap.
   */
  private rebuildLabels(issues: FitIssue[]): void {
    this.labelLayer.innerHTML = "";
    this.labels = [];
    const groups = new Map<string, FitIssue[]>();
    for (const issue of issues) {
      const key = issue.itemIds[0] ?? `${issue.location.x},${issue.location.z}`;
      const list = groups.get(key);
      if (list === undefined) groups.set(key, [issue]);
      else list.push(issue);
    }
    for (const list of groups.values()) {
      const anchor = list[0]?.location ?? { x: 0, z: 0 };
      list.forEach((issue, stack) => {
        const el = document.createElement("div");
        el.className = "fit-issue-label";
        el.dataset["severity"] = issue.severity;
        el.textContent = `${issue.severity === "error" ? "✕" : "!"} ${shortLabel(issue)}`;
        this.labelLayer.appendChild(el);
        this.labels.push({ el, at: { ...anchor }, stack });
      });
    }
  }

  /** Refresh outline + label projections; call once per frame. */
  update(camera: THREE.Camera, width: number, height: number): void {
    for (const box of this.boxes.values()) box.update();
    const v = new THREE.Vector3();
    interface Placed {
      el: HTMLDivElement;
      x: number;
      y: number;
    }
    const visible: Placed[] = [];
    for (const { el, at, stack } of this.labels) {
      v.set(cmToMeters(at.x), 0.05, cmToMeters(at.z)).project(camera);
      const sx = ((v.x + 1) / 2) * width;
      const sy = ((1 - v.y) / 2) * height;
      if (v.z > 1 || !Number.isFinite(sx) || !Number.isFinite(sy)) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "block";
      // Stack mates upward so same-anchor labels never cover each other.
      visible.push({ el, x: sx, y: sy - stack * LABEL_PITCH_PX });
    }
    this.separate(visible);
    for (const p of visible) {
      p.el.style.left = `${p.x.toFixed(1)}px`;
      p.el.style.top = `${p.y.toFixed(1)}px`;
    }
  }

  /**
   * Screen-space separation until no two label boxes overlap. Boxes account
   * for the CSS translate(-50%, -130%) that lifts pills above their anchor.
   */
  private separate(placed: Array<{ el: HTMLDivElement; x: number; y: number }>): void {
    const boxes = new Map<HTMLDivElement, { w: number; h: number }>();
    const boxOf = (p: {
      el: HTMLDivElement;
      x: number;
      y: number;
    }): {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    } => {
      let size = boxes.get(p.el);
      if (size === undefined) {
        size = { w: p.el.offsetWidth || 120, h: p.el.offsetHeight || 22 };
        boxes.set(p.el, size);
      }
      return {
        x0: p.x - size.w / 2,
        y0: p.y - size.h * 1.3,
        x1: p.x + size.w / 2,
        y1: p.y - size.h * 0.3,
      };
    };
    const GAP = 4;
    for (let round = 0; round < 10; round += 1) {
      let moved = false;
      for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) {
          const a = placed[i];
          const b = placed[j];
          if (a === undefined || b === undefined) continue;
          const ba = boxOf(a);
          const bb = boxOf(b);
          const overlapX = Math.min(ba.x1, bb.x1) - Math.max(ba.x0, bb.x0) + GAP;
          const overlapY = Math.min(ba.y1, bb.y1) - Math.max(ba.y0, bb.y0) + GAP;
          if (overlapX <= 0 || overlapY <= 0) continue;
          moved = true;
          // Push the lower label down; ties go by document order.
          if (a.y <= b.y) b.y += overlapY / 2;
          else a.y += overlapY / 2;
        }
      }
      if (!moved) return;
    }
  }
}
