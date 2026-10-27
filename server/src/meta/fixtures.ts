/**
 * Mock fixtures from `server/data/mock/<route>.json` (Node only).
 *
 * In mock mode (`META_MOCK=1`) answers come from these fixtures with
 * realistic `usage` blocks instead of calling upstream. The Worker serves
 * the same fixtures from its build-time bundle (see `store.ts`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeMockUsage, type TokenUsage } from "./pricing.js";

export interface MockFixture {
  data: unknown;
  usage: TokenUsage;
}

const fixtureCache = new Map<string, MockFixture>();

/** Mock answer for a route, from `server/data/mock/<route>.json`. */
export function readMockFixture(dataDir: string, route: string): MockFixture {
  const cached = fixtureCache.get(`${dataDir}\n${route}`);
  if (cached !== undefined) return cached;
  const parsed: unknown = JSON.parse(readFileSync(join(dataDir, "mock", `${route}.json`), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Mock fixture for route ${route} is not an object`);
  }
  const record = parsed as Record<string, unknown>;
  const fixture: MockFixture = {
    data: "data" in record ? record["data"] : parsed,
    usage: normalizeMockUsage(record["usage"]),
  };
  fixtureCache.set(`${dataDir}\n${route}`, fixture);
  return fixture;
}

/** Test hook: drop cached fixtures (isolated check runs). */
export function clearMockFixtures(): void {
  fixtureCache.clear();
}
