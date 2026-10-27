/**
 * Base64 helpers without `Buffer`, so gateway code runs on Node and on the
 * Worker (both provide `atob`/`btoa` globally).
 */

const CHUNK = 8192;

/** Decode a base64 string to bytes. Throws on invalid input. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i) & 0xff;
  }
  return out;
}

/** Encode bytes as a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.subarray(offset, offset + CHUNK);
    let piece = "";
    for (let i = 0; i < slice.length; i += 1) {
      piece += String.fromCharCode(slice[i] ?? 0);
    }
    binary += piece;
  }
  return btoa(binary);
}

/** UTF-8 bytes of a string. */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
