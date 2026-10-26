/**
 * Committed demo store: `server/data/demo/<route>/<key>.json`.
 *
 * Each file holds route, model, canonical input, response and time. In demo
 * mode answers come only from here, never upstream; in live mode a
 * demo-store hit is used too (free).
 */

import { isDemoStoreFile, type DemoStoreFile } from "@fitroom/shared";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type { DemoStoreFile };

export function readDemoStore(
  dataDir: string,
  route: string,
  model: string,
  key: string,
): DemoStoreFile | null {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, "demo", route, `${key}.json`), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isDemoStoreFile(parsed)) return null;
    if (parsed.route !== route || parsed.model !== model) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** List every stored demo answer for a route (used by checks). */
export function listDemoStore(dataDir: string, route: string): DemoStoreFile[] {
  let names: string[];
  try {
    names = readdirSync(join(dataDir, "demo", route))
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const out: DemoStoreFile[] = [];
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dataDir, "demo", route, name), "utf8"));
      if (isDemoStoreFile(parsed)) out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

export function writeRecorded(
  dataDir: string,
  route: string,
  model: string,
  key: string,
  keyInput: unknown,
  data: unknown,
): void {
  const file: DemoStoreFile = {
    route: route as DemoStoreFile["route"],
    model,
    input: keyInput,
    response: data,
    time: new Date().toISOString(),
  };
  mkdirSync(join(dataDir, "recorded", route), { recursive: true });
  writeFileSync(
    join(dataDir, "recorded", route, `${key}.json`),
    `${JSON.stringify(file, null, 2)}\n`,
    "utf8",
  );
}
