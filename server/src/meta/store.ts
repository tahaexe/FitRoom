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
  pruneRateHits,
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
  /** Sum of `upstream` USD (the global budget), optionally from an ISO start. */
  upstreamTotalUsd(fromIso?: string | null): Promise<number>;
  /** Sliding-window per-IP rate check; records the weighted hit when allowed. */
  checkRateLimit(
    ip: string,
    limitPerMinute: number,
    nowMs: number,
    weight?: number,
  ): Promise<boolean>;
  /** Delete rate rows older than a day (bounded); never fails a request. */
  pruneStaleRateRows(nowMs: number): Promise<void>;
  /** Session + global-budget check before a generation. */
  checkGenerationCap(
    sessionId: string,
    isMock: boolean,
    sessionMaxCalls: number,
    sessionMaxUsd: number,
    globalBudgetUsd: number,
    budgetFromIso?: string | null,
    weight?: number,
  ): Promise<CapVerdict>;
  /** Count one generation toward the session caps (USD always in full). */
  noteGeneration(
    sessionId: string,
    usd: number,
    isUpstream: boolean,
    weight?: number,
  ): Promise<void>;
}

/**
 * The per-IP rate limit never stores a raw address: the row id (D1) or map
 * key (Node) is the hex SHA-256 of `salt + ":" + ip`. The salt is random
 * per deployment, kept server-side only, and never logged or sent out.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function newSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function rateRowId(salt: string, ip: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`))
    .then((digest) => bytesToHex(new Uint8Array(digest)));
}

// ---- Node file implementation ---------------------------------------------

export interface NodeStoreOptions {
  dataDir: string;
  logsDir: string;
}

export function createNodeStore(options: NodeStoreOptions): GatewayStore {
  const { dataDir, logsDir } = options;
  const caps: CapsState = createCapsState();
  // One salt per server process (the Node deployment); it lives in this
  // closure only, so it is never logged or sent to a client.
  const rateSalt = newSalt();
  // Cached upstream total, loaded from costs.csv on first use so the
  // budget survives restarts (mirrors the previous caps behaviour). The
  // cache only covers the unfiltered (today's) total; a dated window reads
  // the file fresh through the same shared query as `metering.ts`.
  let upstreamTotalUsd: number | null = null;
  const loadUpstreamTotal = (fromIso?: string | null): number => {
    if (fromIso !== undefined && fromIso !== null && fromIso !== "") {
      return readUpstreamTotalUsd(logsDir, fromIso);
    }
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
    upstreamTotalUsd(fromIso?: string | null): Promise<number> {
      return Promise.resolve(loadUpstreamTotal(fromIso));
    },
    async checkRateLimit(ip, limitPerMinute, nowMs, weight = 1): Promise<boolean> {
      // Hash first: the raw address never reaches the map (nor any log).
      const allowed = checkNodeRateLimit(
        caps,
        limitPerMinute,
        await rateRowId(rateSalt, ip),
        nowMs,
        weight,
      );
      return allowed;
    },
    pruneStaleRateRows(nowMs): Promise<void> {
      pruneRateHits(caps, nowMs);
      return Promise.resolve();
    },
    checkGenerationCap(
      sessionId,
      isMock,
      sessionMaxCalls,
      sessionMaxUsd,
      globalBudgetUsd,
      budgetFromIso?: string | null,
      weight = 1,
    ): Promise<CapVerdict> {
      return Promise.resolve(
        checkNodeGenerationCap(
          caps,
          {
            sessionMaxCalls,
            sessionMaxUsd,
            globalBudgetUsd,
            upstreamTotalUsd: loadUpstreamTotal(budgetFromIso),
          },
          sessionId,
          isMock,
          weight,
        ),
      );
    },
    noteGeneration(sessionId, usd, isUpstream, weight = 1): Promise<void> {
      noteNodeGeneration(caps, sessionId, usd, weight);
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
      generations:
        Number.isFinite(generations) && generations > 0
          ? Math.round(generations * 1_000_000) / 1_000_000
          : 0,
      usd: Number.isFinite(usd) && usd > 0 ? usd : 0,
    };
  } catch {
    return { generations: 0, usd: 0 };
  }
}

interface RateHit {
  at: number;
  weight: number;
}

/**
 * Stored rate hits: weighted `{ at, weight }` objects, with plain numbers
 * (weight 1) accepted for rows written before weights existed.
 */
function parseRateHits(raw: string | null): RateHit[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RateHit[] = [];
    for (const entry of parsed) {
      if (typeof entry === "number" && Number.isFinite(entry) && entry > 0) {
        out.push({ at: entry, weight: 1 });
      } else if (typeof entry === "object" && entry !== null) {
        const record = entry as Record<string, unknown>;
        const at = record["at"];
        const weight = record["weight"];
        if (
          typeof at === "number" &&
          Number.isFinite(at) &&
          typeof weight === "number" &&
          Number.isFinite(weight) &&
          weight > 0
        ) {
          out.push({ at, weight });
        }
      }
    }
    return out;
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

/**
 * The Worker's rate-limit salt: random hex, generated once and kept in D1
 * (`config` / `rate-salt`) so every isolate of the deployment hashes an
 * address to the same row id. `INSERT OR IGNORE` plus a re-read keeps
 * concurrent first writes to one salt; the value is never logged or sent
 * to a client.
 */
async function d1RateSalt(db: D1DatabaseLike): Promise<string> {
  const existing = await readCounter(db, "config", "rate-salt");
  if (typeof existing === "string" && /^[0-9a-f]{64}$/.test(existing)) return existing;
  await db
    .prepare("INSERT OR IGNORE INTO counters (kind, id, value, updated_at) VALUES (?, ?, ?, ?)")
    .bind("config", "rate-salt", newSalt(), Date.now())
    .run();
  const stored = await readCounter(db, "config", "rate-salt");
  if (typeof stored === "string" && stored !== "") return stored;
  return newSalt();
}

/**
 * One shared upstream-sum query for both the cap check and the total: when
 * `fromIso` is set, only rows with `time` at or after it count (both sides
 * are `toISOString`, so the comparison is lexicographic).
 */
async function upstreamTotalFor(db: D1DatabaseLike, fromIso?: string | null): Promise<number> {
  const hasFrom = fromIso !== undefined && fromIso !== null && fromIso !== "";
  const query = hasFrom
    ? "SELECT COALESCE(SUM(usd), 0) AS total FROM costs WHERE source = 'upstream' AND time >= ?"
    : "SELECT COALESCE(SUM(usd), 0) AS total FROM costs WHERE source = 'upstream'";
  const statement = db.prepare(query);
  const row = hasFrom
    ? await statement.bind(fromIso as string).first<{ total: number }>()
    : await statement.first<{ total: number }>();
  const total = row?.total ?? 0;
  return typeof total === "number" && Number.isFinite(total)
    ? Math.round(total * 1_000_000) / 1_000_000
    : 0;
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
    async upstreamTotalUsd(fromIso?: string | null): Promise<number> {
      return upstreamTotalFor(db, fromIso);
    },
    async checkRateLimit(ip, limitPerMinute, nowMs, weight = 1): Promise<boolean> {
      // Hash first: the raw address never reaches the row (nor any log).
      const id = await rateRowId(await d1RateSalt(db), ip);
      const windowStart = nowMs - 60_000;
      const hits = parseRateHits(await readCounter(db, "rate", id)).filter(
        (hit) => hit.at > windowStart,
      );
      const spent = hits.reduce((sum, hit) => sum + hit.weight, 0);
      if (spent + weight > limitPerMinute + 1e-9) return false;
      hits.push({ at: nowMs, weight });
      await writeCounter(db, "rate", id, JSON.stringify(hits), nowMs);
      return true;
    },
    async pruneStaleRateRows(nowMs): Promise<void> {
      // Cheap, bounded prune of rate rows older than one day. The rowid
      // sub-select needs no SQLite build option.
      await db
        .prepare(
          "DELETE FROM counters WHERE rowid IN (SELECT rowid FROM counters WHERE kind = 'rate' AND updated_at < ? LIMIT 50)",
        )
        .bind(nowMs - 86_400_000)
        .run();
    },
    async checkGenerationCap(
      sessionId,
      isMock,
      sessionMaxCalls,
      sessionMaxUsd,
      globalBudgetUsd,
      budgetFromIso?: string | null,
      weight = 1,
    ): Promise<CapVerdict> {
      const session = parseSessionCounter(await readCounter(db, "session", sessionId));
      if (session.generations + weight > sessionMaxCalls + 1e-9) {
        return { ok: false, reason: "session-calls" };
      }
      if (session.usd >= sessionMaxUsd) return { ok: false, reason: "session-usd" };
      if (!isMock) {
        const total = await upstreamTotalFor(db, budgetFromIso);
        if (total >= globalBudgetUsd) return { ok: false, reason: "global-budget" };
      }
      return { ok: true };
    },
    async noteGeneration(
      sessionId: string,
      usd: number,
      _isUpstream: boolean,
      weight = 1,
    ): Promise<void> {
      const nowMs = Date.now();
      const session = parseSessionCounter(await readCounter(db, "session", sessionId));
      const next: SessionCounter = {
        generations: Math.round((session.generations + weight) * 1_000_000) / 1_000_000,
        usd: Math.round((session.usd + usd) * 1_000_000) / 1_000_000,
      };
      await writeCounter(db, "session", sessionId, JSON.stringify(next), nowMs);
    },
  };
}
