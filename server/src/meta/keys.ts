/**
 * Canonical pipeline keys: SHA-256 of (route, model, canonical input).
 *
 * Canonical input means object keys sorted recursively and every number
 * rounded to 0.1, so 3.04 and 3.05 hit the same cache entry.
 *
 * The hash is a small dependency-free SHA-256 (same digests as
 * `node:crypto`'s `createHash("sha256")`) so the same code runs on Node
 * and in the Worker.
 */

import { utf8Bytes } from "./base64.js";

export function canonicalize(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const rounded = Math.round(value * 10) / 10;
    return rounded === 0 ? 0 : rounded;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256HexBytes(input: Uint8Array): string {
  const bitLength = input.length * 8;
  const paddedLength = (((input.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(block + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const x15 = w[i - 15] ?? 0;
      const x2 = w[i - 2] ?? 0;
      const x16 = w[i - 16] ?? 0;
      const x7 = w[i - 7] ?? 0;
      const s0 = ((x15 >>> 7) | (x15 << 25)) ^ ((x15 >>> 18) | (x15 << 14)) ^ (x15 >>> 3);
      const s1 = ((x2 >>> 17) | (x2 << 15)) ^ ((x2 >>> 19) | (x2 << 13)) ^ (x2 >>> 10);
      w[i] = (x16 + s0 + x7 + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/**
 * SHA-256 hex of a string (byte-identical to Web Crypto's SHA-256 over the
 * UTF-8 bytes, so keys match on Node and in the Worker).
 */
export function sha256Hex(text: string): string {
  return sha256HexBytes(utf8Bytes(text));
}

export function gatewayKey(route: string, model: string, keyInput: unknown): string {
  const canonical = JSON.stringify(canonicalize(keyInput));
  return sha256HexBytes(utf8Bytes(`${route}\n${model}\n${canonical}`));
}
