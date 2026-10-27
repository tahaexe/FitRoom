/**
 * JPEG data URL shape check for the room routes (Node and Worker safe).
 *
 * The client sends at most 1280 px (segment) or 640 px (label) on the long
 * side; the server only checks the JPEG shape and the decoded byte size,
 * never the pixel dimensions — and it decodes nothing:
 * - the data URL prefix,
 * - the first base64 characters, which for bytes `FF D8 FF` are `/9j/`,
 * - the decoded size from the base64 length and its padding.
 *
 * No `atob`, no byte arrays: on a fresh Worker isolate even a 287 KB image
 * stays far inside the 10 ms of CPU per request.
 */

export const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

/** `FF D8 FF` (the JPEG SOI magic) as the first four base64 characters. */
const JPEG_MAGIC_BASE64 = "/9j/";

function base64Padding(bare: string): number {
  if (bare.endsWith("==")) return 2;
  if (bare.endsWith("=")) return 1;
  return 0;
}

function isBase64Body(bare: string): boolean {
  // One scan, no decoding: length multiple of 4, alphabet plus padding.
  if (bare.length % 4 !== 0) return false;
  const padding = base64Padding(bare);
  const body = padding === 0 ? bare : bare.slice(0, -padding);
  // Padding is only valid at the very end, never inside the body.
  for (let i = 0; i < body.length; i += 1) {
    const code = body.charCodeAt(i) ?? 0;
    const digit = code >= 48 && code <= 57;
    const upper = code >= 65 && code <= 90;
    const lower = code >= 97 && code <= 122;
    if (!digit && !upper && !lower && code !== 43 && code !== 47) return false;
  }
  return true;
}

/**
 * Decoded JPEG byte size, or null when the value is not a JPEG data URL.
 * The server decodes nothing else: the magic comes from the first base64
 * characters and the size from the base64 length and its padding.
 */
export function jpegDataUrlSize(value: unknown): number | null {
  if (typeof value !== "string" || !value.startsWith(JPEG_DATA_URL_PREFIX)) return null;
  const bare = value.slice(JPEG_DATA_URL_PREFIX.length).trim();
  if (bare.length < 4 || !bare.startsWith(JPEG_MAGIC_BASE64)) return null;
  if (!isBase64Body(bare)) return null;
  const size = (bare.length / 4) * 3 - base64Padding(bare);
  if (!Number.isInteger(size) || size < 3) return null;
  return size;
}
