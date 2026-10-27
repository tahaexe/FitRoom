/**
 * Room size units: pure parser + formatting + limits + first-open choice.
 *
 * No DOM, no storage, no network: safe for `check:guidance`.
 */

export type SizeUnit = "cm" | "ftin";
export type MeasureKind = "side" | "ceiling";

export const SIDE_MIN_CM = 100;
export const SIDE_MAX_CM = 1500;
export const CEIL_MIN_CM = 200;
export const CEIL_MAX_CM = 400;

const CM_PER_IN = 2.54;
const CM_PER_FT = 30.48;

/** Browser language default: en-US reads feet/inches, everything else reads cm. */
export function detectDefaultUnit(lang: string): SizeUnit {
  const norm = lang.toLowerCase().replace("_", "-");
  return norm === "en-us" || norm.startsWith("en-us-") ? "ftin" : "cm";
}

/** Normalize quotes, decimal commas and whitespace before parsing. */
function normalize(raw: string): string {
  return raw
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/\s+/g, " ");
}

/**
 * Parse a typed length to whole centimetres.
 * Accepts: 420, 420 cm, 4.2 m, 4,2 m, 13'9", 13' 9", 13 9, 165", 13.75 ft.
 * Bare single numbers read as centimetres; bare pairs read as feet + inches.
 * Returns null when nothing parses or the value is not finite/positive.
 */
export function parseLengthToCm(raw: string): number | null {
  const text = normalize(raw);
  if (text === "") return null;
  const lower = text.toLowerCase();

  // Feet + inches with an apostrophe: 13'9", 13' 9, 13'.
  const feetMatch = /^(\d+(?:\.\d+)?)\s*'\s*(\d+(?:\.\d+)?)?\s*(")?$/.exec(text);
  if (feetMatch !== null) {
    const feet = Number(feetMatch[1]);
    const inches = feetMatch[2] === undefined || feetMatch[2] === "" ? 0 : Number(feetMatch[2]);
    if (!Number.isFinite(feet) || !Number.isFinite(inches)) return null;
    return Math.round(feet * CM_PER_FT + inches * CM_PER_IN);
  }
  // Inches only: 165", 165 in.
  const inchMatch = /^(\d+(?:\.\d+)?)\s*("|\bin\b)$/.exec(lower);
  if (inchMatch !== null) {
    const inches = Number(inchMatch[1]);
    if (!Number.isFinite(inches) || inches <= 0) return null;
    return Math.round(inches * CM_PER_IN);
  }
  // Feet only: 13.75 ft, 13 ft, 13'.
  const ftMatch = /^(\d+(?:\.\d+)?)\s*(ft|feet)$/.exec(lower);
  if (ftMatch !== null) {
    const feet = Number(ftMatch[1]);
    if (!Number.isFinite(feet) || feet <= 0) return null;
    return Math.round(feet * CM_PER_FT);
  }
  // Centimetres: 420 cm (checked before metres so "cm" never reads as "m").
  const cmMatch = /^(\d+(?:\.\d+)?)\s*cm$/.exec(lower);
  if (cmMatch !== null) {
    const cm = Number(cmMatch[1]);
    if (!Number.isFinite(cm) || cm <= 0) return null;
    return Math.round(cm);
  }
  // Metres: 4.2 m.
  const mMatch = /^(\d+(?:\.\d+)?)\s*m$/.exec(lower);
  if (mMatch !== null) {
    const m = Number(mMatch[1]);
    if (!Number.isFinite(m) || m <= 0) return null;
    return Math.round(m * 100);
  }
  // Bare feet + inches: 13 9.
  const pairMatch = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)$/.exec(text);
  if (pairMatch !== null) {
    const feet = Number(pairMatch[1]);
    const inches = Number(pairMatch[2]);
    if (!Number.isFinite(feet) || !Number.isFinite(inches)) return null;
    return Math.round(feet * CM_PER_FT + inches * CM_PER_IN);
  }
  // Bare number: centimetres.
  const bareMatch = /^(\d+(?:\.\d+)?)$/.exec(text);
  if (bareMatch !== null) {
    const cm = Number(bareMatch[1]);
    if (!Number.isFinite(cm) || cm <= 0) return null;
    return Math.round(cm);
  }
  return null;
}

/** 419 -> `13'9"`. */
export function formatCmAsFtIn(cm: number): string {
  const totalIn = cm / CM_PER_IN;
  let feet = Math.floor(totalIn / 12);
  let inches = Math.round(totalIn - feet * 12);
  if (inches === 12) {
    feet += 1;
    inches = 0;
  }
  return `${String(feet)}'${String(inches)}"`;
}

/** Value shown back under the field, always in the *other* unit. */
export function echoFor(cm: number, unit: SizeUnit): string {
  if (unit === "cm") return `= ${formatCmAsFtIn(cm)}`;
  return `= ${String(cm)} cm`;
}

/** Ceiling prefill echoed in the other unit: 250 cm <-> 8'2". */
export function ceilingPrefillEcho(unit: SizeUnit): string {
  return echoFor(250, unit);
}

function fieldName(field: "width" | "length"): string {
  return field === "width" ? "Width" : "Length";
}

/** Limit message in the visitor's unit, the other unit in brackets. */
export function sideLimitMessage(field: "width" | "length", unit: SizeUnit): string {
  if (unit === "cm") return `${fieldName(field)} must be 1-15 m (3'3"-49'2")`;
  return `${fieldName(field)} must be 3'3"-49'2" (1-15 m)`;
}

/** Ceiling limit message in the visitor's unit, the other unit in brackets. */
export function ceilingLimitMessage(unit: SizeUnit): string {
  if (unit === "cm") return "Ceiling height must be 2-4 m (6'7\"-13'1\")";
  return "Ceiling height must be 6'7\"-13'1\" (2-4 m)";
}

/** Null when in range; otherwise the visitor-unit message for the field. */
export function validateSide(field: "width" | "length", cm: number, unit: SizeUnit): string | null {
  if (!Number.isFinite(cm) || cm < SIDE_MIN_CM || cm > SIDE_MAX_CM) {
    return sideLimitMessage(field, unit);
  }
  return null;
}

/** Null when in range; otherwise the visitor-unit ceiling message. */
export function validateCeiling(cm: number, unit: SizeUnit): string | null {
  if (!Number.isFinite(cm) || cm < CEIL_MIN_CM || cm > CEIL_MAX_CM) {
    return ceilingLimitMessage(unit);
  }
  return null;
}

export interface SlipSuggestion {
  suggestedCm: number;
  /** e.g. "4.2 cm? Did you mean 4.2 m (420 cm)?" */
  message: string;
  /** e.g. "Use 420 cm" */
  action: string;
}

/** True when the typed text reads as feet/inches (the echo then shows cm). */
export function isImperialInput(raw: string): boolean {
  const text = normalize(raw);
  if (/['"]/.test(text)) return true;
  if (/\b(ft|feet|inch|inches|in)\b/i.test(text)) return true;
  if (/^\d+(?:\.\d+)? \d+(?:\.\d+)?$/.test(text)) return true;
  return false;
}

/** Echo in the *other* unit of what was typed: 13'9" -> "= 419 cm". */
export function echoForRaw(raw: string, cm: number): string {
  if (isImperialInput(raw)) return `= ${String(cm)} cm`;
  return `= ${formatCmAsFtIn(cm)}`;
}

/** One-line build-gate reason: both sides must read 1-15 m. */
export function sidesLimitLine(unit: SizeUnit): string {
  if (unit === "cm") return `Width and length must be 1-15 m (3'3"-49'2")`;
  return `Width and length must be 3'3"-49'2" (1-15 m)`;
}

function trimNum(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * A likely slip is asked, never applied by itself: a tiny side value that
 * reads exactly like metres (1-15 with a decimal point or not) offers ×100.
 * Only for a bare number in cm mode or an explicit "cm" reading — never for
 * an ft/in reading that happens to be small.
 */
export function detectSlip(
  raw: string,
  cm: number,
  kind: MeasureKind,
  unit: SizeUnit = "cm",
): SlipSuggestion | null {
  if (kind !== "side") return null;
  if (!Number.isFinite(cm) || cm >= SIDE_MIN_CM) return null;
  const text = normalize(raw);
  const first = /^(\d+(?:\.\d+)?)/.exec(text);
  if (first === null) return null;
  const value = Number(first[1]);
  if (!Number.isFinite(value) || value < 1 || value > 15) return null;
  const suggested = Math.round(value * 100);
  if (suggested < SIDE_MIN_CM || suggested > SIDE_MAX_CM) return null;
  const explicitCm = /cm\s*$/.test(text.toLowerCase());
  if (!explicitCm) {
    // A bare number slips only in cm mode; metres, ft/in and pairs never do.
    if (unit !== "cm") return null;
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  }
  const shown = trimNum(value);
  return {
    suggestedCm: suggested,
    message: `${shown} cm? Did you mean ${shown} m (${String(suggested)} cm)?`,
    action: `Use ${String(suggested)} cm`,
  };
}

export type FirstOpenChoice = "sample" | "room" | "setup";

export interface FirstOpenInput {
  /** True when a built room layout or any autosave survives from a visit. */
  hasSavedRoom: boolean;
  /** Raw `room` address parameter, if any. */
  roomParam: string | null;
}

/**
 * First-open choice: `?room=sample` always opens the sample room, a
 * returning visitor with a saved room lands in that room, otherwise the
 * setup screen shows over the softly blurred sample room.
 */
export function resolveFirstOpen(input: FirstOpenInput): FirstOpenChoice {
  if (input.roomParam === "sample") return "sample";
  if (input.hasSavedRoom) return "room";
  return "setup";
}
