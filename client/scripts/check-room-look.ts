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
import { facingDirForRoom } from "@fitroom/shared";
import { buildRoom } from "../src/room.js";
import {
  applyFloorContrast,
  envYawForCameraSide,
  FLOOR_CONTRAST,
  SURROUND_COLOR,
} from "../src/stage.js";

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
    SURROUND_COLOR === 0xe2dbd3,
    `0x${SURROUND_COLOR.toString(16)}`,
  );

  for (const [label, room] of [
    ["living", living],
    ["example", example],
  ] as const) {
    const yaw = envYawForCameraSide(facingDirForRoom(room));
    const dist = Math.abs(((yaw - Math.PI + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    check(`bright side faces the camera-side walls in ${label}`, dist < 1e-9, String(yaw));
  }

  const stageSrc = readFileSync(join(clientDir, "src", "stage.ts"), "utf8");
  const mainSrc = readFileSync(join(clientDir, "src", "main.ts"), "utf8");
  const yawUses =
    mainSrc.split("environmentRotation.set(0, envYawForCameraSide(facingDirForRoom(ROOM)), 0)")
      .length - 1;
  check(
    "camera side sets the environment yaw on start and rebuild",
    yawUses >= 2,
    `${String(yawUses)} use(s)`,
  );
  check(
    "default wall renders through the finish-mean path",
    mainSrc.includes('wallDisplayLinear("#F3EFE8", textureId)'),
    'main.ts must call wallDisplayLinear("#F3EFE8", textureId)',
  );
  check(
    "daylight exposure is calm",
    stageSrc.includes("toneMappingExposure = 1.15"),
    "stage.ts must set toneMappingExposure = 1.15",
  );
  check(
    "sun reads as soft daylight",
    stageSrc.includes("DirectionalLight(0xfff1dc, 2.3)"),
    "stage.ts must use DirectionalLight(0xfff1dc, 2.3)",
  );
  check(
    "contact shadows stay light",
    stageSrc.includes("ShadowMaterial({ opacity: 0.22 })"),
    "stage.ts must use ShadowMaterial({ opacity: 0.22 })",
  );

  for (const [label, room] of [
    ["living", living],
    ["example", example],
  ] as const) {
    const withGlass = buildRoom(room, new THREE.MeshStandardMaterial({ color: 0xffffff }));
    const panes: THREE.Mesh[] = [];
    withGlass.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.name.startsWith("opening-glass-")) panes.push(obj);
    });
    check(`${label} room has daylight panes`, panes.length > 0, "no opening-glass-* mesh");
    for (const pane of panes) {
      const mat = pane.material as THREE.Material;
      check(
        `${label} ${pane.name} is unlit daylight glass`,
        mat instanceof THREE.MeshBasicMaterial &&
          mat.toneMapped === false &&
          (mat as THREE.MeshBasicMaterial).color.getHex() === 0xf3f7fa,
        mat.type,
      );
    }
  }

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

  check(
    "light oak floor stretches contrast around its mean",
    FLOOR_CONTRAST["WoodFloor039"] === 2.5,
    String(FLOOR_CONTRAST["WoodFloor039"]),
  );
  {
    const probed = new THREE.MeshStandardMaterial({ color: 0xffffff });
    applyFloorContrast(probed, "WoodFloor039");
    check(
      "floor contrast hooks the light oak material",
      Object.prototype.hasOwnProperty.call(probed, "onBeforeCompile"),
      "no own onBeforeCompile",
    );
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      fragmentShader: "#include <common>\nvoid main() {\n#include <map_fragment>\n}",
    };
    probed.onBeforeCompile?.(
      shader as unknown as Parameters<NonNullable<typeof probed.onBeforeCompile>>[0],
      {} as never,
    );
    const mean = shader.uniforms["floorMean"]?.value as THREE.Color | undefined;
    check(
      "floor contrast centres on the measured mean",
      mean instanceof THREE.Color && mean.equals(new THREE.Color("#E0C59B")),
      mean instanceof THREE.Color ? `#${mean.getHexString()}` : typeof mean,
    );
    check(
      "floor contrast stretches by 2.5",
      shader.uniforms["floorContrast"]?.value === 2.5,
      String(shader.uniforms["floorContrast"]?.value),
    );
    check(
      "floor contrast declares its uniforms",
      shader.fragmentShader.includes("uniform vec3 floorMean;") &&
        shader.fragmentShader.includes("uniform float floorContrast;"),
      shader.fragmentShader,
    );
    check(
      "floor contrast stretches right after the map sample",
      shader.fragmentShader.includes(
        "#include <map_fragment>\n\tdiffuseColor.rgb = max( floorMean + ( diffuseColor.rgb - floorMean ) * floorContrast, floorMean * 0.35 );",
      ),
      shader.fragmentShader,
    );
    check(
      "floor contrast keys its program",
      typeof probed.customProgramCacheKey === "function" &&
        probed.customProgramCacheKey() === "fitroom-floor-contrast-2.5",
      String(
        typeof probed.customProgramCacheKey === "function"
          ? probed.customProgramCacheKey()
          : typeof probed.customProgramCacheKey,
      ),
    );
    const plain = new THREE.MeshStandardMaterial({ color: 0xffffff });
    applyFloorContrast(plain, "WoodFloor070");
    check(
      "other floors keep the stock shader",
      !Object.prototype.hasOwnProperty.call(plain, "onBeforeCompile"),
      "unexpected own onBeforeCompile",
    );
  }
  check(
    "floor material applies its contrast stretch",
    stageSrc.includes("applyFloorContrast(material, finish)"),
    "stage.ts must call applyFloorContrast(material, finish)",
  );

  console.log(
    failures === 0
      ? "check:room-look: all checks passed"
      : `check:room-look: ${String(failures)} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
