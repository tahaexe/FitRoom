/**
 * The single Ajv-based validator for FitRoom contracts, shared by client and
 * server. JSON Schema covers document shapes; the functions below add the
 * checks a schema cannot express (closed counter-clockwise wall polygon, wall
 * references, opening/fixture extents, fabricSwitch placement) and report
 * every failure with a `$`-style JSON path such as `$.walls[2].end.x`.
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { catalogItemSchema } from "./schemas/catalog-item.js";
import { fitIssueSchema } from "./schemas/fit-issue.js";
import { roomLayoutSchema } from "./schemas/room-layout.js";
import { sceneStateSchema } from "./schemas/scene-state.js";
import { wallLengthCm } from "./units.js";

export interface ValidationError {
  /** `$`-style JSON path, e.g. `$.walls[2].end.x`. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

export const fitroomAjv = new Ajv2020({ allErrors: true, strict: true });

const validateRoomSchemaFn = fitroomAjv.compile(roomLayoutSchema);
const validateCatalogItemSchemaFn = fitroomAjv.compile(catalogItemSchema);
const validateSceneSchemaFn = fitroomAjv.compile(sceneStateSchema);
const validateFitIssueSchemaFn = fitroomAjv.compile(fitIssueSchema);

/** Tolerance for wall-joint coincidence, in centimetres. */
const JOINT_EPS_CM = 1e-6;

export function formatInstancePath(pointer: string): string {
  if (pointer === "") {
    return "$";
  }
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let out = "$";
  for (const part of parts) {
    if (/^(0|[1-9][0-9]*)$/.test(part)) {
      out += `[${part}]`;
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) {
      out += `.${part}`;
    } else {
      out += `[${JSON.stringify(part)}]`;
    }
  }
  return out;
}

function fromAjv(validateFn: ValidateFunction): ValidationError[] {
  const errors: ErrorObject[] = validateFn.errors ?? [];
  return errors.map((error) => ({
    path: formatInstancePath(error.instancePath),
    message: error.message ?? "is invalid",
  }));
}

interface PointLike {
  x: number;
  z: number;
}

function isPointLike(value: unknown): value is PointLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record["x"] === "number" && typeof record["z"] === "number";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function samePoint(a: PointLike, b: PointLike): boolean {
  return Math.abs(a.x - b.x) <= JOINT_EPS_CM && Math.abs(a.z - b.z) <= JOINT_EPS_CM;
}

interface WallInfo {
  index: number;
  id: string;
  start: PointLike;
  end: PointLike;
  length: number;
  height: number;
}

function readWalls(value: unknown): WallInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const walls: WallInfo[] = [];
  value.forEach((entry, index) => {
    const record = asRecord(entry);
    const id = record?.["id"];
    const start = record?.["start"];
    const end = record?.["end"];
    const height = record?.["height"];
    if (typeof id !== "string" || !isPointLike(start) || !isPointLike(end)) {
      return;
    }
    walls.push({
      index,
      id,
      start,
      end,
      length: wallLengthCm(start, end),
      height: typeof height === "number" ? height : Number.NaN,
    });
  });
  return walls;
}

function checkWallPolygon(walls: WallInfo[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  for (const wall of walls) {
    if (seen.has(wall.id)) {
      errors.push({ path: `$.walls[${wall.index}].id`, message: `duplicate wall id "${wall.id}"` });
    }
    seen.add(wall.id);
  }
  if (walls.length === 0) {
    return errors;
  }
  let connected = true;
  for (let i = 0; i < walls.length; i += 1) {
    const current = walls[i] as WallInfo | undefined;
    const next = walls[(i + 1) % walls.length] as WallInfo | undefined;
    if (current === undefined || next === undefined) {
      connected = false;
      continue;
    }
    if (!samePoint(current.end, next.start)) {
      connected = false;
      errors.push({
        path: `$.walls[${current.index}].end`,
        message:
          `wall "${current.id}" end (${current.end.x}, ${current.end.z}) does not meet ` +
          `start of wall "${next.id}" (${next.start.x}, ${next.start.z}): ` +
          `walls must form a closed polygon`,
      });
    }
  }
  if (connected) {
    let area = 0;
    for (let i = 0; i < walls.length; i += 1) {
      const current = walls[i] as WallInfo | undefined;
      const next = walls[(i + 1) % walls.length] as WallInfo | undefined;
      if (current === undefined || next === undefined) {
        continue;
      }
      area += current.start.x * next.start.z - next.start.x * current.start.z;
    }
    if (area <= 0) {
      errors.push({
        path: "$.walls",
        message:
          "walls run clockwise seen from above: walls must form a closed polygon " +
          "counter-clockwise seen from above",
      });
    }
  }
  return errors;
}

interface WallMount {
  index: number;
  id: string;
  wallId: string;
  offset: number;
  width: number;
}

function readWallMounts(value: unknown): WallMount[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const mounts: WallMount[] = [];
  value.forEach((entry, index) => {
    const record = asRecord(entry);
    const id = record?.["id"];
    const wallId = record?.["wallId"];
    const offset = record?.["offset"];
    const width = record?.["width"];
    if (
      typeof id !== "string" ||
      typeof wallId !== "string" ||
      typeof offset !== "number" ||
      typeof width !== "number"
    ) {
      return;
    }
    mounts.push({ index, id, wallId, offset, width });
  });
  return mounts;
}

function checkWallMounts(
  kind: "openings" | "fixtures",
  mounts: WallMount[],
  wallsById: Map<string, WallInfo>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const mount of mounts) {
    const wall = wallsById.get(mount.wallId);
    if (wall === undefined) {
      errors.push({
        path: `$.${kind}[${mount.index}].wallId`,
        message: `${kind === "openings" ? "opening" : "fixture"} "${mount.id}" references unknown wall "${mount.wallId}"`,
      });
      continue;
    }
    if (mount.offset + mount.width > wall.length + JOINT_EPS_CM) {
      errors.push({
        path: `$.${kind}[${mount.index}]`,
        message:
          `${kind === "openings" ? "opening" : "fixture"} "${mount.id}" spans ` +
          `${mount.offset}–${mount.offset + mount.width} cm but wall "${wall.id}" is only ` +
          `${wall.length} cm long`,
      });
    }
  }
  return errors;
}

function checkOpeningHeights(
  openings: unknown[],
  wallsById: Map<string, WallInfo>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!Array.isArray(openings)) {
    return errors;
  }
  openings.forEach((entry, index) => {
    const record = asRecord(entry);
    const id = record?.["id"];
    const wallId = record?.["wallId"];
    const height = record?.["height"];
    const sillHeight = record?.["sillHeight"];
    if (
      typeof id !== "string" ||
      typeof wallId !== "string" ||
      typeof height !== "number" ||
      typeof sillHeight !== "number"
    ) {
      return;
    }
    const wall = wallsById.get(wallId);
    if (wall === undefined || Number.isNaN(wall.height)) {
      return;
    }
    if (sillHeight + height > wall.height + JOINT_EPS_CM) {
      errors.push({
        path: `$.openings[${index}]`,
        message:
          `opening "${id}" reaches ${sillHeight + height} cm but wall "${wall.id}" is only ` +
          `${wall.height} cm high`,
      });
    }
  });
  return errors;
}

export function validateRoomLayout(data: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  validateRoomSchemaFn(data);
  errors.push(...fromAjv(validateRoomSchemaFn));
  const record = asRecord(data);
  const walls = readWalls(record?.["walls"]);
  if (Array.isArray(record?.["walls"]) && walls.length > 0) {
    errors.push(...checkWallPolygon(walls));
    const wallsById = new Map(walls.map((wall) => [wall.id, wall]));
    errors.push(...checkWallMounts("openings", readWallMounts(record?.["openings"]), wallsById));
    errors.push(...checkWallMounts("fixtures", readWallMounts(record?.["fixtures"]), wallsById));
    if (Array.isArray(record?.["openings"])) {
      errors.push(...checkOpeningHeights(record?.["openings"], wallsById));
    }
  }
  return { ok: errors.length === 0, errors };
}

function hasFabricVariant(variants: unknown): boolean {
  if (!Array.isArray(variants)) {
    return false;
  }
  return variants.some((entry) => asRecord(entry)?.["kind"] === "fabric");
}

export function validateCatalogItem(data: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  validateCatalogItemSchemaFn(data);
  errors.push(...fromAjv(validateCatalogItemSchemaFn));
  const record = asRecord(data);
  if (record !== undefined && record["fabricSwitch"] !== undefined) {
    if (!hasFabricVariant(record["variants"])) {
      errors.push({
        path: "$.fabricSwitch",
        message: "fabricSwitch is only for products with fabric variants",
      });
    }
  }
  const variants = record?.["variants"];
  if (Array.isArray(variants)) {
    const seen = new Set<string>();
    variants.forEach((entry: unknown, index: number) => {
      const name = asRecord(entry)?.["name"];
      if (typeof name !== "string") {
        return;
      }
      if (seen.has(name)) {
        errors.push({
          path: `$.variants[${index}].name`,
          message: `duplicate variant name "${name}"`,
        });
      }
      seen.add(name);
    });
  }
  return { ok: errors.length === 0, errors };
}

export function validateCatalog(data: unknown): ValidationResult {
  if (!Array.isArray(data)) {
    return { ok: false, errors: [{ path: "$", message: "expected an array of catalog items" }] };
  }
  const errors: ValidationError[] = [];
  data.forEach((entry, index) => {
    for (const error of validateCatalogItem(entry).errors) {
      errors.push({
        path: `$[${index}]${error.path === "$" ? "" : error.path.slice(1)}`,
        message: error.message,
      });
    }
  });
  return { ok: errors.length === 0, errors };
}

export function validateSceneState(data: unknown): ValidationResult {
  validateSceneSchemaFn(data);
  const errors = fromAjv(validateSceneSchemaFn);
  return { ok: errors.length === 0, errors };
}

export function validateFitIssue(data: unknown): ValidationResult {
  validateFitIssueSchemaFn(data);
  const errors = fromAjv(validateFitIssueSchemaFn);
  return { ok: errors.length === 0, errors };
}
