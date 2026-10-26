/**
 * Canonical pipeline keys: SHA-256 of (route, model, canonical input).
 *
 * Canonical input means object keys sorted recursively and every number
 * rounded to 0.1, so 3.04 and 3.05 hit the same cache entry.
 */

import { createHash } from "node:crypto";

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

export function gatewayKey(route: string, model: string, keyInput: unknown): string {
  const canonical = JSON.stringify(canonicalize(keyInput));
  return createHash("sha256").update(`${route}\n${model}\n${canonical}`, "utf8").digest("hex");
}
