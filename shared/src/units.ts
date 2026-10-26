/**
 * The single mapping between JSON plan coordinates (centimetres: x east,
 * z north, origin at the room's inner south-west corner) and the 3D scene
 * (metres, x east, z north, y up, same origin). Client and server must use
 * these helpers instead of inline `/ 100` conversions.
 */

export const CM_PER_METER = 100;

export function cmToMeters(cm: number): number {
  return cm / CM_PER_METER;
}

export function metersToCentimeters(meters: number): number {
  return meters * CM_PER_METER;
}

export interface PlanPointCm {
  x: number;
  z: number;
}

export interface ScenePointM {
  x: number;
  z: number;
}

/** Plan centimetres to scene metres; axes and origin are preserved. */
export function planPointToScene(point: PlanPointCm): ScenePointM {
  return { x: cmToMeters(point.x), z: cmToMeters(point.z) };
}

/** Scene metres back to plan centimetres. */
export function scenePointToPlan(point: ScenePointM): PlanPointCm {
  return { x: metersToCentimeters(point.x), z: metersToCentimeters(point.z) };
}

/** Rotation about Y: JSON degrees to scene radians. */
export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Rotation about Y: scene radians back to JSON degrees. */
export function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** Length of a wall segment in centimetres. */
export function wallLengthCm(start: PlanPointCm, end: PlanPointCm): number {
  return Math.hypot(end.x - start.x, end.z - start.z);
}
