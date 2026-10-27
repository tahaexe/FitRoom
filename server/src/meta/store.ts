/**
 * One storage interface for the gateway pipeline, with two implementations:
 *
 * - `createNodeStore`: today's files under `server/data/` (`FITROOM_DATA_DIR`)
 *   and `server/logs/` (`FITROOM_LOGS_DIR`) — demo store, mock fixtures,
 *   cache files, `costs.csv` and in-memory session/rate state.
 * - `createD1Store`: the same behaviour on Cloudflare D1. The demo store
 *   and mock fixtures come from the build-time bundle (no file reads at
 *   run time); cache rows, cost lines and session/rate counters live in D1.
 *
 * The pipeline (`pipeline.ts`) only talks to `GatewayStore`, so routes,
 * caps and metering behave the same on Node and on the Worker.
 */

import type { DemoStoreFile, GatewaySource } from "@fitroom/shared";
import { readCache, writeCache } from "./cache.js";
import {
  checkGenerationCap as checkNodeGenerationCap,
  checkRateLimit as checkNodeRateLimit,
  createCapsState,
  noteGeneration as noteNodeGeneration,
  type CapsState,
} from "./caps.js";
import { listDemoStore, readDemoStore } from "./demo.js";
import { readMockFixture } from "./fixtures.js";
import { appendCostLine, readUpstreamTotalUsd } from "./metering.js";
import type { TokenUsage } from "./pricing.js";

export interface CostLine {
  time: string;
  session: string;
  route: string;
  model: string;
  source: GatewaySource;
  usage: TokenUsage;
  usd: number;
}

export interface CacheEntry {
  route: string;
  model: string;
  input: unknown;
  data: unknown;
  time: string;
}

export interface MockAnswer {
  data: unknown;
  usage: TokenUsage;
}

export type CapVerdict =
  { ok: true } | { ok: false; reason: "session-calls" | "session-usd" | "global-budget" };

/**
 * Gateway storage: demo-store read, cache read and write, cost lines
 * append and sums, session and per-IP counters.
 */
export interface GatewayStore {
  /** A stored demo answer for an exact key, or null. */
  readDemo(route: string, model: string, key: string): Promise<DemoStoreFile | null>;
  /** Every stored demo answer for a route (demo chips and spots). */
  listDemo(route: string): Promise<DemoStoreFile[]>;
  /** The mock fixture for a route, or null when missing. */
  readMock(route: string): Promise<MockAnswer | null>;
  /** A cache entry for an exact key, or null. */
  readCache(route: string, model: string, key: string): Promise<CacheEntry | null>;
  /** Store a cache entry (large image rows may be skipped). */
  writeCache(
    route: string,
    model: string,
    key: string,
    keyInput: unknown,
    data: unknown,
  ): Promise<void>;
  /** Append one metering line. */
  appendCost(line: CostLine): Promise<void>;
  /** Sum of `upstream` USD (the global budget). */
  upstreamTotalUsd(): Promise<number>;
  /** Sliding-window per-IP rate check; records the hit when allowed. */
  checkRateLimit(ip: string, limitPerMinute: number, nowMs: number): Promise<boolean>;
  /** Session + global-budget check before a generation. */
  checkGenerationCap(
    sessionId: string,
    isMock: boolean,
    sessionMaxCalls: number,
    sessionMaxUsd: number,
    globalBudgetUsd: number,
  ): Promise<CapVerdict>;
  /** Count one generation toward the session caps. */
  noteGeneration(sessionId: string, usd: number, isUpstream: boolean): Promise<void>;
}

// ---- Node file implementation ---------------------------------------------

export interface NodeStoreOptions {
  dataDir: string;
  logsDir: string;
}

export function createNodeStore(options: NodeStoreOptions): GatewayStore {
  const { dataDir, logsDir } = options;
  const caps: CapsState = createCapsState();
  // Cached upstream total, loaded from costs.csv on first use so the
  // budget survives restarts (mirrors the previous caps behaviour).
  let upstreamTotalUsd: number | null = null;
  const loadUpstreamTotal = (): number => {
    if (upstreamTotalUsd === null) upstreamTotalUsd = readUpstreamTotalUsd(logsDir);
    return upstreamTotalUsd;
  };
  return {
    readDemo(route, model, key): Promise<DemoStoreFile | null> {
      return Promise.resolve(readDemoStore(dataDir, route, model, key));
    },
    listDemo(route): Promise<DemoStoreFile[]> {
      return Promise.resolve(listDemoStore(dataDir, route));
    },
    readMock(route): Promise<MockAnswer | null> {
      try {
        return Promise.resolve(readMockFixture(dataDir, route));
      } catch {
        return Promise.resolve(null);
      }
    },
    readCache(route, model, key): Promise<CacheEntry | null> {
      return Promise.resolve(readCache(dataDir, route, model, key));
    },
    writeCache(route, model, key, keyInput, data): Promise<void> {
      writeCache(dataDir, route, model, key, keyInput, data);
      return Promise.resolve();
    },
    appendCost(line): Promise<void> {
      appendCostLine(logsDir, line);
      return Promise.resolve();
    },
    upstreamTotalUsd(): Promise<number> {
      return Promise.resolve(loadUpstreamTotal());
    },
    checkRateLimit(ip, limitPerMinute, nowMs): Promise<boolean> {
      return Promise.resolve(checkNodeRateLimit(caps, limitPerMinute, ip, nowMs));
    },
    checkGenerationCap(
      sessionId,
      isMock,
      sessionMaxCalls,
      sessionMaxUsd,
      globalBudgetUsd,
    ): Promise<CapVerdict> {
      return Promise.resolve(
        checkNodeGenerationCap(
          caps,
          {
            sessionMaxCalls,
            sessionMaxUsd,
            globalBudgetUsd,
            upstreamTotalUsd: loadUpstreamTotal(),
          },
          sessionId,
          isMock,
        ),
      );
    },
    noteGeneration(sessionId, usd, isUpstream): Promise<void> {
      noteNodeGeneration(caps, sessionId, usd);
      if (isUpstream && upstreamTotalUsd !== null) {
        upstreamTotalUsd = Math.round((upstreamTotalUsd + usd) * 1_000_000) / 1_000_000;
      }
      return Promise.resolve();
    },
  };
}

// ---- D1 implementation ------------------------------------------------------

/** Minimal structural D1 binding (the real `D1Database` satisfies it). */
export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface BundledGatewayData {
  /** Demo answers by `${route}\n${model}\n${key}`. */
  demo: Map<string, DemoStoreFile>;
  /** Mock fixtures by route. */
  mock: Map<string, MockAnswer>;
}

export function bundledDemoKey(route: string, model: string, key: string): string {
  return `${route}\n${model}\n${key}`;
}

/**
 * D1 rows hold at most 2 MB: cache rows carrying a large image answer stay
 * safely under it, and anything bigger is served without being cached.
 */
const MAX_CACHE_BYTES = 1_900_000;

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

interface SessionCounter {
  generations: number;
  usd: number;
}

function parseSessionCounter(raw: string | null): SessionCounter {
  if (raw === null) return { generations: 0, usd: 0 };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { generations: 0, usd: 0 };
    const record = parsed as Record<string, unknown>;
    const generations = typeof record["generations"] === "number" ? record["generations"] : 0;
    const usd = typeof record["usd"] === "number" ? record["usd"] : 0;
    return {
      generations: Number.isFinite(generations) && generations > 0 ? Math.floor(generations) : 0,
      usd: Number.isFinite(usd) && usd > 0 ? usd : 0,
    };
  } catch {
    return { generations: 0, usd: 0 };
  }
}

function parseRateHits(raw: string | null): number[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
    );
  } catch {
    return [];
  }
}

async function readCounter(db: D1DatabaseLike, kind: string, id: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM counters WHERE kind = ? AND id = ?")
    .bind(kind, id)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function writeCounter(
  db: D1DatabaseLike,
  kind: string,
  id: string,
  value: string,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO counters (kind, id, value, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (kind, id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(kind, id, value, nowMs)
    .run();
}

export function createD1Store(db: D1DatabaseLike, bundled: BundledGatewayData): GatewayStore {
  return {
    readDemo(route, model, key): Promise<DemoStoreFile | null> {
      return Promise.resolve(bundled.demo.get(bundledDemoKey(route, model, key)) ?? null);
    },
    listDemo(route): Promise<DemoStoreFile[]> {
      const entries: Array<[string, DemoStoreFile]> = [];
      for (const [mapKey, file] of bundled.demo) {
        if (file.route === route) entries.push([mapKey, file]);
      }
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return Promise.resolve(entries.map(([, file]) => file));
    },
    readMock(route): Promise<MockAnswer | null> {
      return Promise.resolve(bundled.mock.get(route) ?? null);
    },
    async readCache(route, model, key): Promise<CacheEntry | null> {
      const row = await db
        .prepare(
          "SELECT key_input, data, time FROM cache WHERE route = ? AND model = ? AND key = ?",
        )
        .bind(route, model, key)
        .first<{ key_input: string; data: string; time: string }>();
      if (row === null) return null;
      try {
        // One parse per stored string; the large answer parses exactly once.
        const data: unknown = JSON.parse(row.data);
        const input: unknown = JSON.parse(row.key_input);
        return { route, model, input, data, time: row.time };
      } catch {
        return null;
      }
    },
    async writeCache(route, model, key, keyInput, data): Promise<void> {
      // A single encode of the answer; image answers bigger than the row
      // limit are served without being cached.
      const encoded = JSON.stringify(data);
      if (utf8Length(encoded) > MAX_CACHE_BYTES) return;
      const time = new Date().toISOString();
      await db
        .prepare(
          "INSERT INTO cache (route, model, key, key_input, data, time) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (route, model, key) DO UPDATE SET key_input = excluded.key_input, " +
            "data = excluded.data, time = excluded.time",
        )
        .bind(route, model, key, JSON.stringify(keyInput), encoded, time)
        .run();
    },
    async appendCost(line: CostLine): Promise<void> {
      await db
        .prepare(
          "INSERT INTO costs (time, session, route, model, source, input_tokens, " +
            "cached_input_tokens, output_tokens, images, usd) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          line.time,
          line.session,
          line.route,
          line.model,
          line.source,
          line.usage.inputTokens,
          line.usage.cachedInputTokens,
          line.usage.outputTokens,
          line.usage.images,
          line.usd,
        )
        .run();
    },
    async upstreamTotalUsd(): Promise<number> {
      const row = await db
        .prepare("SELECT COALESCE(SUM(usd), 0) AS total FROM costs WHERE source = 'upstream'")
        .first<{ total: number }>();
      const total = row?.total ?? 0;
      return typeof total === "number" && Number.isFinite(total)
        ? Math.round(total * 1_000_000) / 1_000_000
        : 0;
    },
    async checkRateLimit(ip, limitPerMinute, nowMs): Promise<boolean> {
      const windowStart = nowMs - 60_000;
      const hits = parseRateHits(await readCounter(db, "rate", ip)).filter((t) => t > windowStart);
      if (hits.length >= limitPerMinute) return false;
      hits.push(nowMs);
      await writeCounter(db, "rate", ip, JSON.stringify(hits), nowMs);
      return true;
    },
    async checkGenerationCap(
      sessionId,
      isMock,
      sessionMaxCalls,
      sessionMaxUsd,
      globalBudgetUsd,
    ): Promise<CapVerdict> {
      const session = parseSessionCounter(await readCounter(db, "session", sessionId));
      if (session.generations >= sessionMaxCalls) return { ok: false, reason: "session-calls" };
      if (session.usd >= sessionMaxUsd) return { ok: false, reason: "session-usd" };
      if (!isMock) {
        const row = await db
          .prepare("SELECT COALESCE(SUM(usd), 0) AS total FROM costs WHERE source = 'upstream'")
          .first<{ total: number }>();
        const total = typeof row?.total === "number" ? row.total : 0;
        if (total >= globalBudgetUsd) return { ok: false, reason: "global-budget" };
      }
      return { ok: true };
    },
    async noteGeneration(sessionId, usd): Promise<void> {
      const nowMs = Date.now();
      const session = parseSessionCounter(await readCounter(db, "session", sessionId));
      const next: SessionCounter = {
        generations: session.generations + 1,
        usd: Math.round((session.usd + usd) * 1_000_000) / 1_000_000,
      };
      await writeCounter(db, "session", sessionId, JSON.stringify(next), nowMs);
    },
  };
}
