/**
 * `npm run check:room-look` — headless room-look check (no browser, no live calls).
 *
 * It builds both shipped rooms with `buildRoom()` and a plain floor material
 * and asserts the calm rendering-only look: skirting boards on every wall
 * (never across a door), window cross bars, decor seam strips and bars that
 * hide with their wall, a calm basic-material surround and stronger floor
 * seams.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import type { RoomLayout } from "@fitroom/shared";
import { buildRoom } from "../src/room.js";
import { SURROUND_COLOR } from "../src/stage.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");
const repoRoot = resolve(clientDir, "..");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function wallDir(wall: { start: { x: number; z: number }; end: { x: number; z: number } }): {
  dirX: number;
  dirZ: number;
  lenCm: number;
} {
  const lenCm = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z) || 1;
  return {
    dirX: (wall.end.x - wall.start.x) / lenCm,
    dirZ: (wall.end.z - wall.start.z) / lenCm,
    lenCm,
  };
}

function boardSpanCm(
  mesh: THREE.Mesh,
  wall: { start: { x: number; z: number }; end: { x: number; z: number } },
): [number, number] | null {
  const geo = mesh.geometry as THREE.BoxGeometry;
  const widthM = geo.parameters?.width;
  if (typeof widthM !== "number") return null;
  const { dirX, dirZ } = wallDir(wall);
  const startXM = wall.start.x / 100;
  const startZM = wall.start.z / 100;
  const alongM = (mesh.position.x - startXM) * dirX + (mesh.position.z - startZM) * dirZ;
  const alongCm = alongM * 100;
  const halfCm = (widthM * 100) / 2;
  return [alongCm - halfCm, alongCm + halfCm];
}

function main(): void {
  const living = JSON.parse(
    readFileSync(join(repoRoot, "shared", "samples", "living-420x360.json"), "utf8"),
  ) as RoomLayout;
  const example = JSON.parse(
    readFileSync(join(repoRoot, "shared", "samples", "example-room.json"), "utf8"),
  ) as RoomLayout;

  check(
    "surround colour is the calm warm grey",
    SURROUND_COLOR === 0xece8e3,
    `0x${SURROUND_COLOR.toString(16)}`,
  );

  const stageSrc = readFileSync(join(clientDir, "src", "stage.ts"), "utf8");
  check(
    "floor material sets normalScale to 1.6 on both axes",
    /normalScale\.set\(\s*1\.6\s*,\s*1\.6\s*\)/.test(stageSrc),
    "stage.ts must call normalScale.set(1.6, 1.6)",
  );
  check(
    "stage background uses the shared surround colour",
    stageSrc.includes("SURROUND_COLOR") && stageSrc.includes("scene.background"),
    "stage.ts must set scene.background from SURROUND_COLOR",
  );
  const roomSrc = readFileSync(join(clientDir, "src", "room.ts"), "utf8");
  check(
    "room backdrop uses the shared surround colour",
    roomSrc.includes("SURROUND_COLOR"),
    "room.ts must import SURROUND_COLOR for the backdrop",
  );

  for (const [label, room] of [
    ["living", living],
    ["example", example],
  ] as const) {
    const built = buildRoom(room, new THREE.MeshStandardMaterial({ color: 0xffffff }));
    const byWall = new Map(built.wallEntries.map((e) => [e.wallId, e]));

    for (const wall of room.walls) {
      const entry = byWall.get(wall.id);
      check(`${label} ${wall.id} builds a wall entry`, entry !== undefined, wall.id);
      if (entry === undefined) continue;
      const boards = entry.meshes.filter((m) => m.name.startsWith(`skirting-${wall.id}-`));
      check(
        `${label} ${wall.id} has at least one board`,
        boards.length >= 1,
        `${String(boards.length)} board(s)`,
      );
      const doors = room.openings.filter((o) => o.wallId === wall.id && o.type === "door");
      let overlap = "";
      for (const board of boards) {
        const span = boardSpanCm(board, wall);
        if (span === null) {
          overlap = `${board.name} has no box width`;
          break;
        }
        for (const door of doors) {
          if (span[0] < door.offset + door.width - 1e-6 && span[1] > door.offset + 1e-6) {
            overlap = `${board.name} span ${span[0].toFixed(1)}..${span[1].toFixed(1)} overlaps door ${door.id} ${String(door.offset)}..${String(door.offset + door.width)}`;
          }
        }
      }
      check(`${label} ${wall.id} board never crosses a door`, overlap === "", overlap);
    }

    for (const opening of room.openings.filter((o) => o.type === "window")) {
      const entry = byWall.get(opening.wallId);
      const bars =
        entry?.meshes.filter((m) => m.name.startsWith(`opening-bar-${opening.id}-`)) ?? [];
      const hasV = bars.some((m) => m.name === `opening-bar-${opening.id}-v`);
      const hasH = bars.some((m) => m.name === `opening-bar-${opening.id}-h`);
      check(
        `${label} ${opening.id} has exactly two bars`,
        bars.length === 2 && hasV && hasH,
        bars.map((m) => m.name).join(","),
      );
    }

    const decorMeshes: THREE.Mesh[] = [];
    for (const entry of built.wallEntries) {
      for (const mesh of entry.meshes) {
        if (
          mesh.name.startsWith(`skirting-${entry.wallId}-`) ||
          mesh.name.startsWith(`seam-${entry.wallId}-`) ||
          mesh.name.startsWith("opening-bar-")
        ) {
          decorMeshes.push(mesh);
        }
      }
    }
    check(`${label} room has boards, strips and bars`, decorMeshes.length > 0, "none found");
    let membershipOk = true;
    let membershipDetail = "";
    let raycastOk = true;
    let raycastDetail = "";
    const inEntries = new Set<THREE.Mesh>();
    for (const entry of built.wallEntries) for (const mesh of entry.meshes) inEntries.add(mesh);
    for (const mesh of decorMeshes) {
      if (!inEntries.has(mesh)) {
        membershipOk = false;
        membershipDetail = mesh.name;
        break;
      }
      if (mesh.raycast === THREE.Mesh.prototype.raycast) {
        raycastOk = false;
        raycastDetail = mesh.name;
        break;
      }
    }
    check(`${label} boards, strips and bars hide with their wall`, membershipOk, membershipDetail);
    check(`${label} boards, strips and bars skip picking`, raycastOk, raycastDetail);

    const backdrop = built.group.getObjectByName("fitroom-backdrop") as THREE.Mesh | undefined;
    check(`${label} backdrop builds`, backdrop !== undefined);
    if (backdrop !== undefined) {
      const mat = backdrop.material as THREE.Material;
      check(
        `${label} backdrop is an unlit surround disc`,
        mat instanceof THREE.MeshBasicMaterial,
        mat.type,
      );
      if (mat instanceof THREE.MeshBasicMaterial) {
        check(
          `${label} backdrop ignores tone mapping`,
          mat.toneMapped === false,
          String(mat.toneMapped),
        );
        check(
          `${label} backdrop matches the surround colour`,
          mat.color.getHex() === SURROUND_COLOR,
          `0x${mat.color.getHex().toString(16)}`,
        );
      }
    }
  }

  console.log(
    failures === 0
      ? "check:room-look: all checks passed"
      : `check:room-look: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
