import type { CatalogItem, RoomLayout, SceneState } from "../types.js";
import { wallDisplayName } from "../recommend/walls.js";

function roomSizeText(room: RoomLayout): string {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const wall of room.walls) {
    for (const p of [wall.start, wall.end]) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  const w = Math.round(maxX - minX);
  const d = Math.round(maxZ - minZ);
  return `${String(w)} × ${String(d)} cm`;
}

function variantText(
  catalog: Map<string, CatalogItem>,
  productId: string,
  variant: string,
): string {
  const entry = catalog.get(productId);
  if (entry === undefined) return variant === "" ? "default" : variant;
  if (variant === "" || variant === "default") {
    const first = entry.variants[0];
    const base = first !== undefined ? `default (${first.name})` : "default";
    return base;
  }
  const match = entry.variants.find((v) => v.name === variant);
  if (match === undefined) return variant;
  return match.texture !== undefined
    ? `${match.name} fabric (${match.texture}, ${match.swatch})`
    : `${match.name} (${match.kind}, ${match.swatch})`;
}

/** One wall the capture shows: its id and its place in the image. */
export interface RenderVisibleWall {
  wallId: string;
  place: "left" | "back" | "right";
}

/**
 * Walls as the capture shows them: the walls in frame (each with its
 * place in the image) and the cut-away wall ids behind the camera. The
 * client builds this from the live camera with {@link dollhouseWallView}.
 */
export interface RenderWallView {
  visible: RenderVisibleWall[];
  hidden: string[];
}

/**
 * Dollhouse cutaway for a camera ray: the two walls whose outward normal
 * points most towards the camera are cut away (as the viewer hides them),
 * the rest stay in frame. Places come from the lateral order of the walls'
 * midpoints on the camera's screen-right axis: leftmost is left, rightmost
 * is right, a middle one is back (a lone wall keeps its lateral side, or
 * back when centred). Pure plan maths over centimetre coordinates; `toCam`
 * and `right` are the camera's horizontal direction and screen-right axis.
 */
export function dollhouseWallView(
  room: RoomLayout,
  toCam: { x: number; z: number },
  right: { x: number; z: number },
): RenderWallView {
  let cx = 0;
  let cz = 0;
  for (const wall of room.walls) {
    cx += (wall.start.x + wall.end.x) / 2;
    cz += (wall.start.z + wall.end.z) / 2;
  }
  cx /= Math.max(1, room.walls.length);
  cz /= Math.max(1, room.walls.length);
  const scored = room.walls.map((wall) => {
    const mx = (wall.start.x + wall.end.x) / 2;
    const mz = (wall.start.z + wall.end.z) / 2;
    let ox = mx - cx;
    let oz = mz - cz;
    const len = Math.hypot(ox, oz) || 1;
    ox /= len;
    oz /= len;
    return {
      wall,
      toward: ox * toCam.x + oz * toCam.z,
      lateral: (mx - cx) * right.x + (mz - cz) * right.z,
    };
  });
  scored.sort((a, b) => b.toward - a.toward);
  const hidden = new Set(scored.slice(0, 2).map((s) => s.wall.id));
  const shown = scored.filter((s) => !hidden.has(s.wall.id)).sort((a, b) => a.lateral - b.lateral);
  const visible: RenderVisibleWall[] = shown.map((s, index) => {
    let place: RenderVisibleWall["place"];
    if (shown.length === 1) {
      place = s.lateral < 0 ? "left" : s.lateral > 0 ? "right" : "back";
    } else if (shown.length === 2) {
      place = index === 0 ? "left" : "right";
    } else {
      place = index === 0 ? "left" : index === shown.length - 1 ? "right" : "back";
    }
    return { wallId: s.wall.id, place };
  });
  return { visible, hidden: [...hidden] };
}

/** Openings of one wall in prompt words, without the wall name. */
function openingPhrases(room: RoomLayout, wallId: string): string[] {
  return room.openings
    .filter((o) => o.wallId === wallId)
    .map((o) => {
      const width = `${String(Math.round(o.width))} cm wide`;
      if (o.type === "door") {
        return `closed solid door ${o.id} (${width}, hinged ${o.hinge})`;
      }
      return `window ${o.id} (${width}, sill ${String(Math.round(o.sillHeight))} cm)`;
    });
}

/**
 * Walls as the capture shows them, each named by its place in the image
 * with its openings (or "plain wall, no openings"); the cut-away walls and
 * their windows are named as behind the camera, lighting the room from
 * there. The image model can no longer paint windows on plain walls.
 */
export function describeOpeningsForView(room: RoomLayout, view: RenderWallView): string {
  const order = { left: 0, back: 1, right: 2 } as const;
  const visible = [...view.visible].sort((a, b) => order[a.place] - order[b.place]);
  const lines = visible.map((v) => {
    const name = wallDisplayName(room, v.wallId);
    const openings = openingPhrases(room, v.wallId);
    const detail = openings.length === 0 ? "plain wall, no openings" : openings.join("; ");
    return `- ${v.place} wall in the image: ${name} — ${detail}`;
  });
  if (view.hidden.length > 0) {
    const names = [...view.hidden].map((id) => wallDisplayName(room, id)).sort();
    const windows = view.hidden
      .flatMap((id) => openingPhrases(room, id))
      .filter((p) => p.startsWith("window"));
    const lit =
      windows.length === 0 ? "" : ` their ${windows.join("; ")} light the room from there`;
    lines.push(
      `The cut-away ${names.join(" and ")} ${names.length === 1 ? "is" : "are"} behind the camera${lit === "" ? "" : `;${lit}`}.`,
    );
  }
  return lines.join("\n");
}

/**
 * One line per wall naming its openings with kind and place, e.g.
 * "Door wall: closed solid door door-1 (90 cm wide, hinged left)".
 * Walls without openings say "no openings".
 */
export function describeOpenings(room: RoomLayout): string {
  return room.walls
    .map((wall) => {
      const name = wallDisplayName(room, wall.id);
      const openings = room.openings.filter((o) => o.wallId === wall.id);
      if (openings.length === 0) return `- ${name}: no openings`;
      const parts = openings.map((o) => {
        const width = `${String(Math.round(o.width))} cm wide`;
        if (o.type === "door") {
          return `closed solid door ${o.id} (${width}, hinged ${o.hinge})`;
        }
        return `window ${o.id} (${width}, sill ${String(Math.round(o.sillHeight))} cm)`;
      });
      return `- ${name}: ${parts.join("; ")}`;
    })
    .join("\n");
}

/**
 * Photoreal edit prompt built from the live scene.
 *
 * Names the room size, floor and wall materials, the openings (by wall
 * name, or by place in the image when `wallView` names the capture's
 * walls), every product with its colour and fabric variant, and the window
 * light; then asks to keep the camera, the room shell, every product and
 * its exact placement, rendered as a photoreal photograph. The door stays
 * a closed solid door where it is; windows appear only where the room has
 * them.
 */
export function buildRenderPrompt(
  scene: SceneState,
  room: RoomLayout,
  catalog: CatalogItem[],
  wallView?: RenderWallView,
): string {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const size = roomSizeText(room);
  const windows = room.openings.filter((o) => o.type === "window");
  const windowText =
    windows.length === 0
      ? "soft indoor lighting"
      : windows.length === 1
        ? "bright window daylight from 1 window"
        : `bright window daylight from ${String(windows.length)} windows`;
  const lines: string[] = [];
  for (const item of scene.items) {
    const entry = byId.get(item.productId);
    const name = entry?.name ?? item.productId;
    const colours = entry?.colors.join(", ") ?? "";
    const variant = variantText(byId, item.productId, item.variant);
    const colourPart = colours === "" ? variant : `${colours} — variant ${variant}`;
    lines.push(`- ${name} (${colourPart})`);
  }
  const furniture = lines.length === 0 ? "- (empty room)" : lines.join("\n");
  const openings =
    wallView === undefined ? describeOpenings(room) : describeOpeningsForView(room, wallView);
  return (
    `Photorealistic interior photo of ${room.name}, ${size}, ` +
    `floor ${room.surfaces.floor}, walls ${room.surfaces.wall}, ${windowText}.\n` +
    `Openings:\n${openings}\n` +
    `Furniture in place:\n${furniture}\n` +
    `Keep the camera viewpoint, the room shell, every product and its exact placement exactly as shown. ` +
    `Keep every opening where it is: the door stays a closed solid door where it is, ` +
    `windows only where the room has them — do not turn the door into a window or a glass door ` +
    `and do not add windows or doors. ` +
    `Do not move, add, remove or restyle anything. Render as a photoreal photograph with natural ` +
    `colours and soft contact shadows.`
  );
}
