import type { CatalogItem, RoomLayout, SceneState } from "../types.js";

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

/**
 * Photoreal edit prompt built from the live scene.
 *
 * Names the room size, floor and wall materials, every product with its
 * colour and fabric variant, and the window light; then asks to keep the
 * camera, the room shell, every product and its exact placement, rendered
 * as a photoreal photograph.
 */
export function buildRenderPrompt(
  scene: SceneState,
  room: RoomLayout,
  catalog: CatalogItem[],
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
  return (
    `Photorealistic interior photo of ${room.name}, ${size}, ` +
    `floor ${room.surfaces.floor}, walls ${room.surfaces.wall}, ${windowText}.\n` +
    `Furniture in place:\n${furniture}\n` +
    `Keep the camera viewpoint, the room shell, every product and its exact placement exactly as shown. ` +
    `Do not move, add, remove or restyle anything. Render as a photoreal photograph with natural ` +
    `colours and soft contact shadows.`
  );
}
