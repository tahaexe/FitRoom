/**
 * FitRoom data contracts (TypeScript side).
 *
 * Plan coordinates are centimetres: x east, z north, origin at the room's
 * inner south-west corner. The 3D scene uses metres; see `./units.js` for the
 * single mapping between the two.
 */

export interface PlanPoint {
  /** East offset in centimetres from the room's inner south-west corner. */
  x: number;
  /** North offset in centimetres from the room's inner south-west corner. */
  z: number;
}

export interface SizeCm {
  /** Width along X, centimetres. */
  w: number;
  /** Depth along Z, centimetres. */
  d: number;
  /** Height along Y, centimetres. */
  h: number;
}

export interface Wall {
  id: string;
  start: PlanPoint;
  end: PlanPoint;
  /** Wall height in centimetres. */
  height: number;
  /** Wall thickness in centimetres. */
  thickness: number;
}

export type OpeningType = "door" | "window";
export type DoorHinge = "left" | "right";
export type DoorSwing = "in" | "out";

interface OpeningBase {
  id: string;
  wallId: string;
  /** Offset from the wall start along the wall, centimetres. */
  offset: number;
  /** Opening width along the wall, centimetres. */
  width: number;
  /** Opening height, centimetres. */
  height: number;
  /** Sill height above the floor, centimetres (0 for doors). */
  sillHeight: number;
}

export interface DoorOpening extends OpeningBase {
  type: "door";
  hinge: DoorHinge;
  swing: DoorSwing;
}

export interface WindowOpening extends OpeningBase {
  type: "window";
}

export type Opening = DoorOpening | WindowOpening;

export type FixtureType = "radiator" | "column" | "other";

export interface Fixture {
  id: string;
  type: FixtureType;
  wallId: string;
  /** Offset from the wall start along the wall, centimetres. */
  offset: number;
  /** Fixture width along the wall, centimetres. */
  width: number;
  /** Fixture height, centimetres. */
  height: number;
  /** Fixture depth out from the wall, centimetres. */
  depth: number;
}

export interface Footprint {
  /** South-west corner x in centimetres (before rotation). */
  x: number;
  /** South-west corner z in centimetres (before rotation). */
  z: number;
  /** Width along X in centimetres. */
  w: number;
  /** Depth along Z in centimetres. */
  d: number;
  /** Rotation about Y in degrees. */
  rotationY: number;
}

export interface ExistingPiece {
  id: string;
  label: string;
  footprint: Footprint;
  /** Height in centimetres. */
  height: number;
}

export interface RoomSurfaces {
  /** Floor material id. */
  floor: string;
  /** Wall material id. */
  wall: string;
  /** Wall tint toward the photo colour, as `#RRGGBB`. Absent on older rooms. */
  wallTint?: string;
}

export interface RoomStyle {
  tags: string[];
  dominantColors: string[];
}

export type RoomSource = "sample" | "photos" | "manual";

export interface RoomLayout {
  id: string;
  name: string;
  units: "cm";
  /**
   * Consecutive walls form a closed polygon, counter-clockwise seen from
   * above: each wall end meets the next wall start, and the last wall end
   * meets the first wall start.
   */
  walls: Wall[];
  openings: Opening[];
  fixtures: Fixture[];
  existing: ExistingPiece[];
  surfaces: RoomSurfaces;
  style: RoomStyle;
  source: RoomSource;
  /** Confidence in 0-1. */
  confidence: number;
}

export type CatalogCategory =
  "sofa" | "armchair" | "ottoman" | "coffee-table" | "side-table" | "tv-unit" | "shelf" | "decor";

export type VariantKind = "gltf" | "fabric";

export interface CatalogVariant {
  name: string;
  /**
   * "gltf": a KHR_materials_variants name in the model.
   * "fabric": a fabric composed by the client.
   */
  kind: VariantKind;
  /** Swatch colour as "#RRGGBB". */
  swatch: string;
  /** ambientCG texture id; absent for the model's own fabric. */
  texture?: string;
}

export type FabricMaskRule = "luma" | "saturation";

export interface FabricSwitch {
  mask: {
    rule: FabricMaskRule;
    lumaMin: number;
    saturationMax?: number;
  };
  blurPx: number;
  fabricLumaMedian: number;
  uvPerMeter: number;
  tileCm: number;
}

export interface CatalogItem {
  id: string;
  name: string;
  category: CatalogCategory;
  /** Price in USD, integer, the same for every variant. */
  price: number;
  /**
   * Seats this piece offers (0 for non-seating; the ottoman is a footrest).
   * Optional — absent counts 0. Integer 0-8.
   */
  seats?: number;
  size: SizeCm;
  styleTags: string[];
  colors: string[];
  roomTypes: string[];
  /** May be empty; the first variant is the default. */
  variants: CatalogVariant[];
  /** Only for products with fabric variants. */
  fabricSwitch?: FabricSwitch;
  /** Model path under `client/public/`. */
  model: string;
  /** Thumbnail path under `client/public/`. */
  thumbnail: string;
  credit: string;
  license: string;
}

export type CameraMode = "orbit" | "plan";

export interface SceneVector {
  x: number;
  y: number;
  z: number;
}

export interface SceneItem {
  instanceId: string;
  productId: string;
  /** Placement in plan centimetres. */
  position: PlanPoint;
  /** Rotation about Y in degrees. */
  rotationY: number;
  variant: string;
}

export interface SceneCamera {
  mode: CameraMode;
  position: SceneVector;
  target: SceneVector;
}

export interface SceneState {
  roomId: string;
  items: SceneItem[];
  camera: SceneCamera;
}

export type FitIssueType =
  "overlap" | "outside" | "door-swing" | "walkway" | "walkway-entrance" | "window";
export type FitIssueSeverity = "error" | "warning";

export interface FitIssue {
  type: FitIssueType;
  severity: FitIssueSeverity;
  itemIds: string[];
  message: string;
  location: PlanPoint;
  /**
   * Measured amount in whole cm: overlap depth (smallest separating move),
   * depth past the wall face, depth inside the door swing, narrowest clear
   * width, or distance to the window.
   */
  amountCm?: number;
  /** The rule's value where one applies (e.g. 80 for a walkway). */
  limitCm?: number;
  /**
   * The other side in shopper words: the other piece's catalog name,
   * "the wall", "the door" or "the window" (with the wall when several
   * could clash, e.g. "the window on the left wall").
   */
  otherLabel?: string;
  /** Conflict region as plan-cm polygon points. */
  area?: PlanPoint[];
  /** Dimension line endpoints (plan cm). */
  dimension?: [PlanPoint, PlanPoint];
}
