/**
 * On-disk cache: `server/data/cache/<route>/<key>.json`. A hit makes no
 * upstream call. Entries hold the model, the canonical key input and the
 * response data so a stale entry can never serve the wrong request.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CacheEntry {
  route: string;
  model: string;
  input: unknown;
  data: unknown;
  time: string;
}

function cacheFile(dataDir: string, route: string, key: string): string {
  return join(dataDir, "cache", route, `${key}.json`);
}

export function readCache(
  dataDir: string,
  route: string,
  model: string,
  key: string,
): CacheEntry | null {
  let raw: string;
  try {
    raw = readFileSync(cacheFile(dataDir, route, key), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const entry = parsed as Partial<CacheEntry>;
    if (entry["route"] !== route || entry["model"] !== model) return null;
    if (!("data" in (parsed as Record<string, unknown>))) return null;
    return parsed as CacheEntry;
  } catch {
    return null;
  }
}

export function writeCache(
  dataDir: string,
  route: string,
  model: string,
  key: string,
  keyInput: unknown,
  data: unknown,
): void {
  const entry: CacheEntry = {
    route,
    model,
    input: keyInput,
    data,
    time: new Date().toISOString(),
  };
  mkdirSync(join(dataDir, "cache", route), { recursive: true });
  writeFileSync(cacheFile(dataDir, route, key), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}
