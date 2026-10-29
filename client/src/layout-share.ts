import type { CatalogItem, RoomLayout, SceneState } from "@fitroom/shared";
import { validateRoomLayout, validateSceneState } from "@fitroom/shared";
import {
  FLOOR_FINISHES,
  SAMPLE_FLOOR_SURFACE,
  SAMPLE_WALL_SURFACE,
  WALL_FINISHES,
} from "@fitroom/shared";
import { CEIL_MAX_CM, CEIL_MIN_CM, SIDE_MAX_CM, SIDE_MIN_CM } from "./room-units";

export const LAYOUT_VERSION = 1;
export const LAYOUT_PREFIX = "layout=1.";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_KEYS = new Set(["w", "o", "f", "e", "s", "p"]);

function toB64Url(json: string): string {
  const bytes =
    typeof Buffer !== "undefined" ? Buffer.from(json, "utf8") : new TextEncoder().encode(json);
  let b64: string;
  if (typeof Buffer !== "undefined") {
    b64 = (bytes as Buffer).toString("base64");
  } else {
    let bin = "";
    for (const byte of bytes as Uint8Array) bin += String.fromCharCode(byte);
    b64 = btoa(bin);
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64Url(payload: string): string | null {
  if (!/^[A-Za-z0-9\-_]+$/.test(payload) || payload.length === 0) return null;
  let b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  try {
    if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function wallLen(a: number[]): number {
  return Math.hypot(a[2]! - a[0]!, a[3]! - a[1]!);
}

/** Compact, versioned fragment carrying only the allowed layout fields. */
export function encodeLayout(room: RoomLayout, scene: SceneState): string {
  const payload = {
    w: room.walls.map((wl) => [
      Math.round(wl.start.x),
      Math.round(wl.start.z),
      Math.round(wl.end.x),
      Math.round(wl.end.z),
      Math.round(wl.height),
      Math.round(wl.thickness),
    ]),
    o: room.openings.map((op) => {
      const wallIdx = room.walls.findIndex((wl) => wl.id === op.wallId);
      if (op.type === "door") {
        return [
          wallIdx,
          0,
          Math.round(op.offset),
          Math.round(op.width),
          Math.round(op.height),
          Math.round(op.sillHeight),
          op.hinge === "right" ? 1 : 0,
          op.swing === "out" ? 1 : 0,
        ];
      }
      return [
        wallIdx,
        1,
        Math.round(op.offset),
        Math.round(op.width),
        Math.round(op.height),
        Math.round(op.sillHeight),
        0,
        0,
      ];
    }),
    f: room.fixtures.map((fx) => [
      room.walls.findIndex((wl) => wl.id === fx.wallId),
      fx.type === "radiator" ? 0 : fx.type === "column" ? 1 : 2,
      Math.round(fx.offset),
      Math.round(fx.width),
      Math.round(fx.height),
      Math.round(fx.depth),
    ]),
    e: room.existing.map((own) => [
      Math.round(own.footprint.x),
      Math.round(own.footprint.z),
      Math.round(own.footprint.w),
      Math.round(own.footprint.d),
      Math.round(own.footprint.rotationY),
      Math.round(own.height),
    ]),
    s: [room.surfaces.floor, room.surfaces.wall, room.surfaces.wallTint ?? null],
    p: scene.items.map((item) => [
      item.productId,
      item.variant,
      Math.round(item.position.x),
      Math.round(item.position.z),
      Math.round(item.rotationY),
    ]),
  };
  return `#${LAYOUT_PREFIX}${toB64Url(JSON.stringify(payload))}`;
}

export interface DecodedLayout {
  room: RoomLayout;
  scene: SceneState;
}

/** Decode a `#layout=1.…` fragment; null when broken, unknown or out of range. */
export function decodeLayout(
  hash: string,
  catalog: ReadonlyMap<string, CatalogItem>,
): DecodedLayout | null {
  const text = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!text.startsWith(LAYOUT_PREFIX)) return null;
  const json = fromB64Url(text.slice(LAYOUT_PREFIX.length));
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) return null;
  }
  if (
    !Array.isArray(record["w"]) ||
    !Array.isArray(record["o"]) ||
    !Array.isArray(record["f"]) ||
    !Array.isArray(record["e"]) ||
    !Array.isArray(record["s"]) ||
    !Array.isArray(record["p"])
  ) {
    return null;
  }
  const wallsRaw = record["w"] as unknown[];
  const walls: RoomLayout["walls"] = [];
  for (let i = 0; i < wallsRaw.length; i += 1) {
    const row = wallsRaw[i];
    if (!Array.isArray(row) || row.length !== 6) return null;
    const nums = row.map(num);
    if (nums.some((n) => n === null)) return null;
    const [x1, z1, x2, z2, h, t] = nums as number[];
    if (h! < CEIL_MIN_CM || h! > CEIL_MAX_CM) return null;
    if (
      wallLen([x1!, z1!, x2!, z2!]) < SIDE_MIN_CM ||
      wallLen([x1!, z1!, x2!, z2!]) > SIDE_MAX_CM
    ) {
      return null;
    }
    if (!Number.isFinite(t!) || t! < 1 || t! > 100) return null;
    for (const c of [x1!, z1!, x2!, z2!]) {
      if (c < -SIDE_MAX_CM || c > SIDE_MAX_CM * 2) return null;
    }
    walls.push({
      id: `wall-${String(i + 1)}`,
      start: { x: Math.round(x1!), z: Math.round(z1!) },
      end: { x: Math.round(x2!), z: Math.round(z2!) },
      height: Math.round(h!),
      thickness: Math.round(t!),
    });
  }
  if (walls.length === 0 || walls.length > 32) return null;
  const minX = Math.min(...walls.flatMap((wl) => [wl.start.x, wl.end.x]));
  const maxX = Math.max(...walls.flatMap((wl) => [wl.start.x, wl.end.x]));
  const minZ = Math.min(...walls.flatMap((wl) => [wl.start.z, wl.end.z]));
  const maxZ = Math.max(...walls.flatMap((wl) => [wl.start.z, wl.end.z]));

  const openings: RoomLayout["openings"] = [];
  for (let i = 0; i < (record["o"] as unknown[]).length; i += 1) {
    const row = (record["o"] as unknown[])[i];
    if (!Array.isArray(row) || row.length !== 8) return null;
    const [wi, ty, off, w, h, sill, hinge, swing] = row as unknown[];
    if (
      typeof wi !== "number" ||
      !Number.isInteger(wi) ||
      wi < 0 ||
      wi >= walls.length ||
      (ty !== 0 && ty !== 1)
    ) {
      return null;
    }
    const nums = [off, w, h, sill].map(num);
    if (nums.some((n) => n === null)) return null;
    if (hinge !== 0 && hinge !== 1) return null;
    if (swing !== 0 && swing !== 1) return null;
    const wallId = walls[wi as number]!.id;
    const width = Math.round(w as number);
    if (width <= 0 || width > SIDE_MAX_CM) return null;
    if (ty === 0) {
      openings.push({
        id: `door-${String(i + 1)}`,
        wallId,
        type: "door",
        offset: Math.round(off as number),
        width,
        height: Math.round(h as number),
        sillHeight: 0,
        hinge: hinge === 1 ? "right" : "left",
        swing: swing === 1 ? "out" : "in",
      });
    } else {
      openings.push({
        id: `window-${String(i + 1)}`,
        wallId,
        type: "window",
        offset: Math.round(off as number),
        width,
        height: Math.round(h as number),
        sillHeight: Math.round(sill as number),
      });
    }
  }

  const fixtures: RoomLayout["fixtures"] = [];
  for (let i = 0; i < (record["f"] as unknown[]).length; i += 1) {
    const row = (record["f"] as unknown[])[i];
    if (!Array.isArray(row) || row.length !== 6) return null;
    const [wi, ty, off, w, h, d] = row as unknown[];
    if (typeof wi !== "number" || !Number.isInteger(wi) || wi < 0 || wi >= walls.length)
      return null;
    if (ty !== 0 && ty !== 1 && ty !== 2) return null;
    const nums = [off, w, h, d].map(num);
    if (nums.some((n) => n === null)) return null;
    fixtures.push({
      id: `fixture-${String(i + 1)}`,
      wallId: walls[wi as number]!.id,
      type: ty === 0 ? "radiator" : ty === 1 ? "column" : "other",
      offset: Math.round(off as number),
      width: Math.round(w as number),
      height: Math.round(h as number),
      depth: Math.round(d as number),
    });
  }

  const existing: RoomLayout["existing"] = [];
  for (let i = 0; i < (record["e"] as unknown[]).length; i += 1) {
    const row = (record["e"] as unknown[])[i];
    if (!Array.isArray(row) || row.length !== 6) return null;
    const nums = (row as unknown[]).map(num);
    if (nums.some((n) => n === null)) return null;
    const [x, z, w, d, r, h] = nums as number[];
    if (w! <= 0 || d! <= 0 || h! <= 0 || h! > CEIL_MAX_CM) return null;
    existing.push({
      id: `own-${String(i + 1)}`,
      // Labels never travel in the link: a neutral placeholder keeps the
      // room valid (`label` needs a non-empty string) without inventing a
      // shopper-typed name.
      label: "Own piece",
      footprint: {
        x: Math.round(x!),
        z: Math.round(z!),
        w: Math.round(w!),
        d: Math.round(d!),
        rotationY: Math.round(r!),
      },
      height: Math.round(h!),
    });
  }

  const s = record["s"] as unknown[];
  if (s.length !== 3) return null;
  const [floor, wall, tint] = s as unknown[];
  const floorOk =
    typeof floor === "string" &&
    ((FLOOR_FINISHES as readonly string[]).includes(floor) || floor === SAMPLE_FLOOR_SURFACE);
  const wallOk =
    typeof wall === "string" &&
    ((WALL_FINISHES as readonly string[]).includes(wall) || wall === SAMPLE_WALL_SURFACE);
  if (!floorOk || !wallOk) return null;
  if (tint !== null && (typeof tint !== "string" || !HEX_RE.test(tint))) return null;

  const itemsRaw = record["p"] as unknown[];
  if (itemsRaw.length > 60) return null;
  const items: SceneState["items"] = [];
  for (let i = 0; i < itemsRaw.length; i += 1) {
    const row = itemsRaw[i];
    if (!Array.isArray(row) || row.length !== 5) return null;
    const [pid, variant, x, z, r] = row as unknown[];
    if (typeof pid !== "string" || typeof variant !== "string") return null;
    const entry = catalog.get(pid);
    if (entry === undefined) return null;
    if (entry.variants.length === 0) {
      if (variant !== "" && variant !== "default") return null;
    } else if (!entry.variants.some((v) => v.name === variant)) {
      return null;
    }
    const px = num(x);
    const pz = num(z);
    const pr = num(r);
    if (px === null || pz === null || pr === null) return null;
    if (px < minX || px > maxX || pz < minZ || pz > maxZ) return null;
    items.push({
      instanceId: `shared-${String(i + 1)}-${pid}`,
      productId: pid,
      position: { x: Math.round(px), z: Math.round(pz) },
      rotationY: Math.round(pr),
      variant,
    });
  }

  const room: RoomLayout = {
    id: "manual-room",
    name: "My room",
    units: "cm",
    walls,
    openings,
    fixtures,
    existing,
    surfaces:
      tint === null
        ? { floor: floor as string, wall: wall as string }
        : { floor: floor as string, wall: wall as string, wallTint: tint as string },
    style: { tags: [], dominantColors: [] },
    source: "manual",
    confidence: 1,
  };
  const scene: SceneState = {
    roomId: "manual-room",
    items,
    camera: {
      mode: "orbit",
      position: { x: 3.4, y: 3.1, z: 4.2 },
      target: { x: 2.1, y: 0, z: 1.8 },
    },
  };
  if (!validateRoomLayout(room).ok) return null;
  if (!validateSceneState(scene).ok) return null;
  return { room, scene };
}
