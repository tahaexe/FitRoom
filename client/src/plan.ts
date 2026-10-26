import * as THREE from "three";
import type { RoomLayout } from "@fitroom/shared";
import { cmToMeters, wallLengthCm } from "@fitroom/shared";
import { pointAlongWall } from "./room";

/**
 * Top plan overlay: SVG labels drawn from JSON values (±1cm rounding).
 * Wall lengths in cm at each wall midpoint; opening labels (id + width).
 */
export class PlanOverlay {
  readonly svg: SVGSVGElement;
  private wallTexts: SVGTextElement[] = [];
  private openingTexts: SVGTextElement[] = [];

  constructor(parent: HTMLElement, room: RoomLayout) {
    const NS = "http://www.w3.org/2000/svg";
    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("class", "plan-overlay");
    parent.appendChild(this.svg);
    for (const wall of room.walls) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("class", "plan-wall-label");
      t.textContent = `${wall.id}: ${Math.round(wallLengthCm(wall.start, wall.end))}cm`;
      this.svg.appendChild(t);
      this.wallTexts.push(t);
    }
    for (const o of room.openings) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("class", "plan-opening-label");
      t.textContent = `${o.id} · ${Math.round(o.width)}cm`;
      this.svg.appendChild(t);
      this.openingTexts.push(t);
    }
  }

  setVisible(v: boolean): void {
    this.svg.style.display = v ? "block" : "none";
  }

  update(camera: THREE.Camera, room: RoomLayout, width: number, height: number): void {
    this.svg.setAttribute("width", String(width));
    this.svg.setAttribute("height", String(height));
    const v = new THREE.Vector3();
    const place = (el: SVGTextElement, xM: number, yM: number, zM: number): void => {
      v.set(xM, yM, zM).project(camera);
      const sx = ((v.x + 1) / 2) * width;
      const sy = ((1 - v.y) / 2) * height;
      el.setAttribute("x", String(sx.toFixed(1)));
      el.setAttribute("y", String(sy.toFixed(1)));
    };
    room.walls.forEach((wall, i) => {
      const el = this.wallTexts[i];
      if (el === undefined) return;
      const mx = (wall.start.x + wall.end.x) / 2;
      const mz = (wall.start.z + wall.end.z) / 2;
      place(el, cmToMeters(mx), 0.05, cmToMeters(mz));
    });
    room.openings.forEach((o, i) => {
      const el = this.openingTexts[i];
      if (el === undefined) return;
      const wall = room.walls.find((w) => w.id === o.wallId);
      if (wall === undefined) return;
      const p = pointAlongWall(wall, o.offset + o.width / 2);
      place(el, cmToMeters(p.x), 0.05, cmToMeters(p.z));
    });
  }
}
