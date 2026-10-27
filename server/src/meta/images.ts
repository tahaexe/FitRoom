/**
 * JPEG data URL decoding for the room routes (Node and Worker safe).
 *
 * The client sends at most 1280 px (segment) or 640 px (label) on the long
 * side; the server only checks the JPEG shape (data URL prefix plus the
 * SOI magic) and the decoded byte size, never the pixel dimensions.
 */

import { base64ToBytes } from "./base64.js";

export const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

/** Decoded JPEG bytes, or null when the value is not a JPEG data URL. */
export function decodeJpegDataUrl(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !value.startsWith(JPEG_DATA_URL_PREFIX)) return null;
  const bare = value.slice(JPEG_DATA_URL_PREFIX.length).trim();
  if (bare.length === 0) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(bare);
  } catch {
    return null;
  }
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return null;
  }
  return bytes;
}
