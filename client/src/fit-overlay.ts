import * as THREE from "three";
import type { FitAnalysis, FitIssue, OrientedRect, PlanPoint } from "@fitroom/shared";
import { cmToMeters } from "@fitroom/shared";

const RED = 0xb3261e;
const AMBER = 0xe59500;
/** Vertical pitch between stacked labels sharing one anchor (px). */
const LABEL_PITCH_PX = 26;
/** Floor height of the footprint outlines (m). */
const OUTLINE_Y = 0.025;
/**
 * Outline ribbon width in plan centimetres: about 2 px at plan scale, so
 * the footprint stays readable from the top view (a plain line is always
 * 1 px on screen).
 */
const OUTLINE_WIDTH_CM = 1.5;
/** End-tick length for dimension lines in plan centimetres. */
const DIM_TICK_CM = 10;
/** Perpendicular offset of a dimension number chip from its line (plan cm). */
const DIM_CHIP_OFFSET_CM = 14;
/** Floor height of the conflict-area fills (m). */
const AREA_Y = 0.02;
/** Floor height of the dimension lines (m). */
const DIM_Y = 0.03;

function severityColor(severity: FitIssue["severity"]): number {
  return severity === "error" ? RED : AMBER;
}

function floorPoint(p: PlanPoint, y: number): THREE.Vector3 {
  return new THREE.Vector3(cmToMeters(p.x), y, cmToMeters(p.z));
}

/**
 * Floor marks for fit verdicts: each piece with an issue gets its true
 * rotated footprint outlined on the floor (visible in the plan view and
 * the 3D view), the conflict area filled in the same colour at 35 %
 * opacity, a dimension line with the number, and a chip with the verdict
 * that sits on its piece and follows it. Colours follow the fit-status
 * tokens: red #B3261E for problems, amber #E59500 for warnings, green
 * #0E9F7E for the brief "Fits" confirmation — never the coral action
 * colour.
 */
export class FitOverlay {
  private arcMeshes: THREE.Mesh[] = [];
  private clearanceMesh: THREE.Mesh | null = null;
  private clearanceTex: THREE.DataTexture | null = null;
  private clearanceNx = 0;
  private clearanceNz = 0;
  private marks = new THREE.Group();
  private labelLayer: HTMLDivElement;
  private labels: Array<{ el: HTMLDivElement; at: PlanPoint; stack: number }> = [];
  private fitsEl: HTMLDivElement;
  private fitsAt: PlanPoint | null = null;
  private fitsId: string | null = null;
  private fitsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    container: HTMLElement,
  ) {
    this.marks.name = "fit-marks";
    this.scene.add(this.marks);
    const layer = document.createElement("div");
    layer.className = "fit-issue-labels";
    container.appendChild(layer);
    this.labelLayer = layer;
    const fits = document.createElement("div");
    fits.className = "fit-fits-label";
    fits.style.display = "none";
    fits.textContent = "✓ Fits";
    container.appendChild(fits);
    this.fitsEl = fits;
  }

  setAnalysis(analysis: FitAnalysis, issues: FitIssue[]): void {
    this.clearArcs();
    this.buildArcs(analysis.doors);
    this.updateClearance(analysis);
    this.rebuildMarks(analysis, issues);
    this.rebuildLabels(issues);
    // A piece that earned "Fits" and then picked up an issue loses it.
    const fitsId: string | null = this.fitsId;
    if (fitsId !== null && issues.some((issue) => issue.itemIds.includes(fitsId))) {
      this.hideFits();
    }
  }

  setClearanceVisible(visible: boolean): void {
    if (this.clearanceMesh !== null) this.clearanceMesh.visible = visible;
  }

  get clearanceVisible(): boolean {
    return this.clearanceMesh?.visible ?? false;
  }

  /** Door swing sectors as flat red sectors on the floor: rebuilt for the
   * current doors only, so rooms with no door show no sector. */
  private clearArcs(): void {
    for (const mesh of this.arcMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) {
        for (const m of mat) m.dispose();
      } else {
        mat.dispose();
      }
    }
    this.arcMeshes = [];
  }

  /** Door swing sectors as flat red sectors on the floor. */
  private buildArcs(doors: FitAnalysis["doors"]): void {
    if (doors.length === 0) return;
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
      this.arcMeshes.push(mesh);
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

  /** Dispose every mark mesh (geometries and materials). */
  private clearMarks(): void {
    for (let i = this.marks.children.length - 1; i >= 0; i -= 1) {
      const child = this.marks.children[i];
      if (child === undefined) continue;
      this.marks.remove(child);
      child.traverse((obj) => {
        const typed = obj as unknown as {
          geometry?: THREE.BufferGeometry;
          material?: THREE.Material | THREE.Material[];
        };
        typed.geometry?.dispose();
        const mat = typed.material;
        if (Array.isArray(mat)) {
          for (const m of mat) m.dispose();
        } else {
          mat?.dispose();
        }
      });
    }
  }

  /**
   * Rotated footprint outlines per involved piece, plus the conflict area
   * fill and dimension line per issue. Rebuilt from each analysis, so
   * everything follows the piece live while dragging.
   */
  private rebuildMarks(analysis: FitAnalysis, issues: FitIssue[]): void {
    this.clearMarks();
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
      const rect = analysis.footprints.get(id);
      if (rect === undefined) continue;
      this.marks.add(this.footprintLine(rect, severityColor(severity)));
    }
    for (const issue of issues) {
      const color = severityColor(issue.severity);
      const area = issue.area ?? [];
      if (area.length >= 3) this.marks.add(this.areaFill(area, color));
      const dimension = issue.dimension;
      if (dimension !== undefined) {
        const [from, to] = dimension;
        if (Math.hypot(to.x - from.x, to.z - from.z) >= 1) {
          this.marks.add(this.dimensionLine(from, to, color));
        }
      }
    }
  }

  /**
   * Rotated footprint outline on the floor (turns with the piece), drawn
   * as a flat ribbon so it reads about 2 px at plan scale in both views.
   */
  private footprintLine(rect: OrientedRect, color: number): THREE.Mesh {
    const halfM = cmToMeters(OUTLINE_WIDTH_CM) / 2;
    const corners = rect.corners.map((c) => floorPoint(c, OUTLINE_Y));
    const positions: number[] = [];
    for (let i = 0; i < corners.length; i += 1) {
      const a = corners[i] as THREE.Vector3;
      const b = corners[(i + 1) % corners.length] as THREE.Vector3;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = (-dz / len) * halfM;
      const nz = (dx / len) * halfM;
      const p0x = a.x + nx;
      const p0z = a.z + nz;
      const p1x = b.x + nx;
      const p1z = b.z + nz;
      const p2x = b.x - nx;
      const p2z = b.z - nz;
      const p3x = a.x - nx;
      const p3z = a.z - nz;
      positions.push(p0x, OUTLINE_Y, p0z, p1x, OUTLINE_Y, p1z, p2x, OUTLINE_Y, p2z);
      positions.push(p0x, OUTLINE_Y, p0z, p2x, OUTLINE_Y, p2z, p3x, OUTLINE_Y, p3z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color, depthWrite: false, side: THREE.DoubleSide }),
    );
    mesh.renderOrder = 3;
    return mesh;
  }

  /** Conflict region filled in the issue colour at 35 % opacity. */
  private areaFill(area: PlanPoint[], color: number): THREE.Mesh {
    const shape = new THREE.Shape();
    area.forEach((p, i) => {
      const sx = cmToMeters(p.x);
      const sy = -cmToMeters(p.z);
      if (i === 0) shape.moveTo(sx, sy);
      else shape.lineTo(sx, sy);
    });
    shape.closePath();
    const mesh = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = AREA_Y;
    mesh.renderOrder = 2;
    return mesh;
  }

  /** Dimension line between two plan points, with short end ticks. */
  private dimensionLine(from: PlanPoint, to: PlanPoint, color: number): THREE.Group {
    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color, depthWrite: false });
    const main = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([floorPoint(from, DIM_Y), floorPoint(to, DIM_Y)]),
      mat,
    );
    main.renderOrder = 4;
    group.add(main);
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    const tx = (-dz / len) * (DIM_TICK_CM / 2);
    const tz = (dx / len) * (DIM_TICK_CM / 2);
    for (const p of [from, to]) {
      const tick = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          floorPoint({ x: p.x - tx, z: p.z - tz }, DIM_Y),
          floorPoint({ x: p.x + tx, z: p.z + tz }, DIM_Y),
        ]),
        mat,
      );
      tick.renderOrder = 4;
      group.add(tick);
    }
    return group;
  }

  /**
   * One short chip per piece (its most serious issue: errors before
   * warnings, then the largest number) plus one small dimension number for
   * that same issue. Everything else lives in the problem list, so pills
   * never stack on one anchor; `update` still separates neighbours so no
   * two pills overlap. Tooltips repeat the verdict text (ids never appear
   * in any label or tooltip).
   */
  private rebuildLabels(issues: FitIssue[]): void {
    this.labelLayer.innerHTML = "";
    this.labels = [];
    const byPiece = new Map<string, FitIssue[]>();
    for (const issue of issues) {
      if (issue.itemIds.length === 0) {
        const key = `unplaced:${issue.location.x},${issue.location.z}`;
        const list = byPiece.get(key);
        if (list === undefined) byPiece.set(key, [issue]);
        else list.push(issue);
        continue;
      }
      for (const id of issue.itemIds) {
        const list = byPiece.get(id);
        if (list === undefined) byPiece.set(id, [issue]);
        else list.push(issue);
      }
    }
    const rank = (issue: FitIssue): number =>
      (issue.severity === "error" ? 0 : 1) * 100000 - (issue.amountCm ?? 0);
    // The same issue (e.g. one overlap naming both pieces) renders once,
    // merged at its conflict centre, so pills never cover each other.
    const shown = new Set<string>();
    const keyOf = (issue: FitIssue): string =>
      `${issue.type}|${[...issue.itemIds].sort().join(",")}|${issue.location.x},${issue.location.z}`;
    for (const list of byPiece.values()) {
      const sorted = [...list].sort((a, b) => rank(a) - rank(b));
      const issue = sorted.find((candidate) => !shown.has(keyOf(candidate)));
      if (issue === undefined) continue;
      shown.add(keyOf(issue));
      const anchor = issue.location;
      const el = document.createElement("div");
      el.className = "fit-issue-label";
      el.dataset["severity"] = issue.severity;
      el.textContent = `${issue.severity === "error" ? "✕" : "!"} ${issue.message}`;
      el.title = issue.message;
      this.labelLayer.appendChild(el);
      this.labels.push({ el, at: { ...anchor }, stack: 0 });
      const dimension = issue.dimension;
      if (dimension !== undefined && issue.amountCm !== undefined) {
        const [from, to] = dimension;
        if (Math.hypot(to.x - from.x, to.z - from.z) >= 1) {
          const dim = document.createElement("div");
          dim.className = "fit-dim-label";
          dim.dataset["severity"] = issue.severity;
          dim.textContent = `${String(issue.amountCm)} cm`;
          dim.title = issue.message;
          this.labelLayer.appendChild(dim);
          // Beside the dimension line, never on it: offset the chip
          // perpendicular to the line so it cannot cover the line — or a
          // wall/opening label under it — before separation runs.
          const ddx = to.x - from.x;
          const ddz = to.z - from.z;
          const dlen = Math.hypot(ddx, ddz) || 1;
          this.labels.push({
            el: dim,
            at: {
              x: (from.x + to.x) / 2 + (-ddz / dlen) * DIM_CHIP_OFFSET_CM,
              z: (from.z + to.z) / 2 + (ddx / dlen) * DIM_CHIP_OFFSET_CM,
            },
            stack: 0,
          });
        }
      }
    }
  }

  /**
   * Brief green confirmation on release for a piece with no issue
   * (about 1.5 s). The chip is projected every frame like the rest.
   */
  showFits(at: PlanPoint, instanceId: string): void {
    this.fitsId = instanceId;
    this.fitsAt = { ...at };
    this.fitsEl.style.display = "block";
    if (this.fitsTimer !== null) clearTimeout(this.fitsTimer);
    this.fitsTimer = setTimeout(() => {
      this.fitsTimer = null;
      this.hideFits();
    }, 1500);
  }

  private hideFits(): void {
    this.fitsId = null;
    this.fitsAt = null;
    this.fitsEl.style.display = "none";
    if (this.fitsTimer !== null) {
      clearTimeout(this.fitsTimer);
      this.fitsTimer = null;
    }
  }

  /** Refresh chip projections; call once per frame. */
  update(camera: THREE.Camera, width: number, height: number): void {
    const v = new THREE.Vector3();
    interface Placed {
      el: HTMLDivElement;
      x: number;
      y: number;
    }
    const visible: Placed[] = [];
    const place = (el: HTMLDivElement, at: PlanPoint, lift: number): void => {
      v.set(cmToMeters(at.x), 0.05, cmToMeters(at.z)).project(camera);
      const sx = ((v.x + 1) / 2) * width;
      const sy = ((1 - v.y) / 2) * height;
      if (v.z > 1 || !Number.isFinite(sx) || !Number.isFinite(sy)) {
        el.style.display = "none";
        return;
      }
      el.style.display = "block";
      // Stack mates upward so same-anchor labels never cover each other.
      visible.push({ el, x: sx, y: sy - lift * LABEL_PITCH_PX });
    };
    for (const { el, at, stack } of this.labels) place(el, at, stack);
    if (this.fitsAt !== null) place(this.fitsEl, this.fitsAt, 0);
    this.separate(visible, this.planLabelBoxes());
    for (const p of visible) {
      p.el.style.left = `${p.x.toFixed(1)}px`;
      p.el.style.top = `${p.y.toFixed(1)}px`;
    }
  }

  /**
   * Screen boxes of the plan wall/opening labels: fixed obstacles the fit
   * chips yield to. Empty outside plan view, where that overlay is hidden.
   */
  private planLabelBoxes(): Array<{ x0: number; y0: number; x1: number; y1: number }> {
    const svg = document.querySelector("svg.plan-overlay");
    if (!(svg instanceof SVGSVGElement) || svg.style.display === "none") return [];
    const boxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    for (const el of svg.querySelectorAll("text")) {
      const x = Number(el.getAttribute("x"));
      const y = Number(el.getAttribute("y"));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      let w: number;
      try {
        w = el.getComputedTextLength();
      } catch {
        w = Number.NaN;
      }
      if (!(w > 0)) w = (el.textContent?.length ?? 8) * 8;
      const anchor = el.getAttribute("text-anchor") ?? "middle";
      const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
      boxes.push({ x0: x0 - 8, y0: y - 32, x1: x0 + w + 8, y1: y + 8 });
    }
    return boxes;
  }

  /**
   * Screen-space separation until no two label boxes overlap, and no fit
   * chip overlaps a plan wall/opening label (only the fit chip moves).
   * Boxes account for the CSS translate(-50%, -130%) that lifts pills
   * above their anchor.
   */
  private separate(
    placed: Array<{ el: HTMLDivElement; x: number; y: number }>,
    fixed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [],
  ): void {
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
    const GAP = 6;
    for (let round = 0; round < 60; round += 1) {
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
      // Fit chips yield to plan wall/opening labels: only the fit chip
      // moves, away from the plan label's centre.
      for (const p of placed) {
        const box = boxOf(p);
        for (const f of fixed) {
          const overlapX = Math.min(box.x1, f.x1) - Math.max(box.x0, f.x0) + GAP;
          const overlapY = Math.min(box.y1, f.y1) - Math.max(box.y0, f.y0) + GAP;
          if (overlapX <= 0 || overlapY <= 0) continue;
          moved = true;
          const fx = (f.x0 + f.x1) / 2;
          const fy = (f.y0 + f.y1) / 2;
          if (overlapX < overlapY) {
            p.x += p.x >= fx ? overlapX : -overlapX;
          } else {
            p.y += p.y >= fy ? overlapY : -overlapY;
          }
        }
      }
      if (!moved) return;
    }
  }
}
