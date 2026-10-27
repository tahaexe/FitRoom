import * as THREE from "three";
import type { Opening, RoomLayout, Wall } from "@fitroom/shared";
import { cmToMeters, wallLengthCm } from "@fitroom/shared";

export const WALL_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xf1ece2,
  roughness: 0.94,
  metalness: 0,
});

export const FRAME_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x8a6f4d,
  roughness: 0.6,
  metalness: 0.05,
});

export const GLASS_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xbcd4e6,
  roughness: 0.08,
  metalness: 0,
  transparent: true,
  opacity: 0.35,
});

export interface WallMeshEntry {
  wallId: string;
  meshes: THREE.Mesh[];
  outward: THREE.Vector3;
}

export interface RoomBuild {
  group: THREE.Group;
  floorSize: { wM: number; dM: number; cxM: number; czM: number };
  wallEntries: WallMeshEntry[];
  wallHeightM: number;
}

function wallFrame(wall: Wall): { dirX: number; dirZ: number; lenCm: number; angleY: number } {
  const lenCm = wallLengthCm(wall.start, wall.end) || 1;
  const dirX = (wall.end.x - wall.start.x) / lenCm;
  const dirZ = (wall.end.z - wall.start.z) / lenCm;
  // Box X-axis aligned to the wall direction: rotation about Y.
  const angleY = -Math.atan2(dirZ, dirX);
  return { dirX, dirZ, lenCm, angleY };
}

/** Point along a wall at a given offset (plan cm). */
export function pointAlongWall(wall: Wall, offsetCm: number): { x: number; z: number } {
  const { dirX, dirZ } = wallFrame(wall);
  return { x: wall.start.x + dirX * offsetCm, z: wall.start.z + dirZ * offsetCm };
}

function addBox(
  group: THREE.Group,
  list: THREE.Mesh[],
  cxCm: number,
  czCm: number,
  lenCm: number,
  heightCm: number,
  yBaseCm: number,
  thicknessCm: number,
  angleY: number,
  material: THREE.Material,
): void {
  const geo = new THREE.BoxGeometry(
    cmToMeters(lenCm),
    cmToMeters(heightCm),
    cmToMeters(thicknessCm),
  );
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(cmToMeters(cxCm), cmToMeters(yBaseCm + heightCm / 2), cmToMeters(czCm));
  mesh.rotation.y = angleY;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  list.push(mesh);
}

/**
 * Build wall runs split around openings: segments beside each opening,
 * a lintel above it, a sill below windows, plus a timber frame lining.
 * 1 scene unit = 1 metre.
 */
export function buildRoom(room: RoomLayout, floorMaterial: THREE.Material): RoomBuild {
  const group = new THREE.Group();
  group.name = "fitroom-room";

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const wall of room.walls) {
    for (const p of [wall.start, wall.end]) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
  }
  const wM = cmToMeters(maxX - minX);
  const dM = cmToMeters(maxZ - minZ);
  const cxM = cmToMeters((minX + maxX) / 2);
  const czM = cmToMeters((minZ + maxZ) / 2);

  const floorGeo = new THREE.PlaneGeometry(wM, dM);
  const floor = new THREE.Mesh(floorGeo, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cxM, 0, czM);
  floor.receiveShadow = true;
  floor.name = "fitroom-floor";
  group.add(floor);

  // Light neutral studio backdrop disc far below the visual floor edge.
  const backdropGeo = new THREE.CircleGeometry(Math.max(wM, dM) * 4, 48);
  const backdropMat = new THREE.MeshStandardMaterial({ color: 0xe8e6e3, roughness: 1 });
  const backdrop = new THREE.Mesh(backdropGeo, backdropMat);
  backdrop.rotation.x = -Math.PI / 2;
  backdrop.position.set(cxM, -0.02, czM);
  // The backdrop never receives shadows: every shadow lands on the room's
  // own floor (or the floor-sized contact catcher), so in plan view no sofa
  // or armchair shadow can spill past a wall onto the background.
  backdrop.receiveShadow = false;
  backdrop.name = "fitroom-backdrop";
  group.add(backdrop);

  const wallEntries: WallMeshEntry[] = [];
  let wallHeightM = 2.6;

  for (const wall of room.walls) {
    const { dirX, dirZ, lenCm, angleY } = wallFrame(wall);
    wallHeightM = cmToMeters(wall.height);
    const thickCm = wall.thickness;
    const meshes: THREE.Mesh[] = [];
    const openings: Opening[] = room.openings
      .filter((o) => o.wallId === wall.id)
      .sort((a, b) => a.offset - b.offset);

    // Wall runs between openings.
    let cursor = 0;
    const runs: Array<[number, number]> = [];
    for (const o of openings) {
      if (o.offset > cursor) runs.push([cursor, o.offset]);
      cursor = Math.max(cursor, o.offset + o.width);
    }
    if (cursor < lenCm) runs.push([cursor, lenCm]);

    for (const [a, b] of runs) {
      const mid = (a + b) / 2;
      const p = pointAlongWall(wall, mid);
      addBox(group, meshes, p.x, p.z, b - a, wall.height, 0, thickCm, angleY, WALL_MATERIAL);
    }

    // Lintel / sill / frame per opening.
    for (const o of openings) {
      const top = o.sillHeight + o.height;
      if (top < wall.height) {
        const p = pointAlongWall(wall, o.offset + o.width / 2);
        addBox(
          group,
          meshes,
          p.x,
          p.z,
          o.width,
          wall.height - top,
          top,
          thickCm,
          angleY,
          WALL_MATERIAL,
        );
      }
      if (o.sillHeight > 0) {
        const p = pointAlongWall(wall, o.offset + o.width / 2);
        addBox(group, meshes, p.x, p.z, o.width, o.sillHeight, 0, thickCm, angleY, WALL_MATERIAL);
      }
      // Timber frame lining (two jambs + head), 6cm deep profile.
      const frameCm = 6;
      const startP = pointAlongWall(wall, o.offset);
      const endP = pointAlongWall(wall, o.offset + o.width);
      void dirX;
      void dirZ;
      addBox(
        group,
        meshes,
        startP.x,
        startP.z,
        frameCm,
        o.height,
        o.sillHeight,
        thickCm + 2,
        angleY,
        FRAME_MATERIAL,
      );
      addBox(
        group,
        meshes,
        endP.x,
        endP.z,
        frameCm,
        o.height,
        o.sillHeight,
        thickCm + 2,
        angleY,
        FRAME_MATERIAL,
      );
      const midP = pointAlongWall(wall, o.offset + o.width / 2);
      addBox(
        group,
        meshes,
        midP.x,
        midP.z,
        o.width + frameCm,
        frameCm,
        o.sillHeight + o.height - frameCm / 2,
        thickCm + 2,
        angleY,
        FRAME_MATERIAL,
      );
      if (o.type === "window") {
        const gp = pointAlongWall(wall, o.offset + o.width / 2);
        const geo = new THREE.BoxGeometry(cmToMeters(o.width - 4), cmToMeters(o.height - 4), 0.01);
        const pane = new THREE.Mesh(geo, GLASS_MATERIAL);
        pane.position.set(
          cmToMeters(gp.x),
          cmToMeters(o.sillHeight + o.height / 2),
          cmToMeters(gp.z),
        );
        pane.rotation.y = angleY;
        pane.name = `opening-glass-${o.id}`;
        group.add(pane);
        meshes.push(pane);
      } else {
        // Door leaf shown ajar at 30deg from the hinge side.
        const hingeOffset = o.offset + 3;
        const hp = pointAlongWall(wall, hingeOffset);
        const leafGeo = new THREE.BoxGeometry(
          cmToMeters(o.width - 6),
          cmToMeters(o.height - 4),
          0.04,
        );
        const leaf = new THREE.Mesh(leafGeo, FRAME_MATERIAL);
        leaf.position.set(cmToMeters(hp.x), cmToMeters(o.height / 2), cmToMeters(hp.z));
        leaf.rotation.y = angleY + Math.PI / 6;
        leaf.castShadow = true;
        leaf.name = `opening-leaf-${o.id}`;
        group.add(leaf);
        meshes.push(leaf);
      }
      // Fixtures drawn as shallow boxes on their wall.
      for (const fx of room.fixtures.filter((f) => f.wallId === wall.id)) {
        const fp = pointAlongWall(wall, fx.offset + fx.width / 2);
        const normal = new THREE.Vector3(-dirZ, 0, dirX);
        const insetM = cmToMeters(fx.depth / 2);
        const fgeo = new THREE.BoxGeometry(
          cmToMeters(fx.width),
          cmToMeters(fx.height),
          cmToMeters(fx.depth),
        );
        const fmat = new THREE.MeshStandardMaterial({
          color: 0xe5e7eb,
          roughness: 0.5,
          metalness: 0.3,
        });
        const fmesh = new THREE.Mesh(fgeo, fmat);
        fmesh.position.set(
          cmToMeters(fp.x) + normal.x * insetM,
          cmToMeters(fx.height / 2),
          cmToMeters(fp.z) + normal.z * insetM,
        );
        fmesh.rotation.y = angleY;
        fmesh.castShadow = true;
        fmesh.name = `fixture-${fx.id}`;
        group.add(fmesh);
        meshes.push(fmesh);
      }
    }

    // Outward normal: polygon is CCW from above, so outward is right of direction.
    const outward = new THREE.Vector3(dirZ, 0, -dirX).normalize();
    wallEntries.push({ wallId: wall.id, meshes, outward });
  }

  return { group, floorSize: { wM, dM, cxM, czM }, wallEntries, wallHeightM };
}

/** Wall length labels straight from JSON (cm), for the plan overlay. */
export function wallLengthLabels(room: RoomLayout): Array<{ wallId: string; lengthCm: number }> {
  return room.walls.map((w) => ({
    wallId: w.id,
    lengthCm: Math.round(wallLengthCm(w.start, w.end)),
  }));
}

/** Opening labels in shopper words ("Door · 90 cm", "Window · 120 cm"). */
export function openingLabels(room: RoomLayout): Array<{ id: string; text: string }> {
  return room.openings.map((o) => ({
    id: o.id,
    text: `${o.type === "door" ? "Door" : "Window"} · ${Math.round(o.width)} cm`,
  }));
}
