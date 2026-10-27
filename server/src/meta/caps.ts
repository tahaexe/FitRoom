/**
 * Caps: per-session upstream generations and USD, a global USD budget and a
 * per-IP rate limit. Over any cap the routes answer HTTP 429 with the
 * friendly capped copy. In mock mode the fixture stands in for upstream, so
 * mock generations count toward the session caps (they never touch the
 * global budget, which sums only `upstream` lines).
 *
 * This module holds the in-memory state behind the Node store
 * (`store.ts`); the D1 store implements the same checks in SQL.
 */

export function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface SessionState {
  /** Fractional generations: a SAM request counts 0.2. */
  generations: number;
  usd: number;
}

/** One rate-limit hit with its fractional weight. */
export interface RateHit {
  at: number;
  weight: number;
}

export interface CapsState {
  sessions: Map<string, SessionState>;
  rateHits: Map<string, RateHit[]>;
}

export function createCapsState(): CapsState {
  return { sessions: new Map(), rateHits: new Map() };
}

/**
 * Drop rate buckets idle for longer than `maxAgeMs`, visiting at most
 * `maxSweep` keys so the sweep stays cheap. Callers run this as part of a
 * normal rate-limit write; the limit itself is unchanged.
 */
export function pruneRateHits(
  state: CapsState,
  nowMs: number,
  maxAgeMs = 86_400_000,
  maxSweep = 100,
): number {
  let removed = 0;
  let visited = 0;
  for (const [key, hits] of state.rateHits) {
    if (visited >= maxSweep) break;
    visited += 1;
    while (hits.length > 0 && (hits[0]?.at ?? 0) <= nowMs - 60_000) hits.shift();
    const last = hits.length === 0 ? 0 : (hits[hits.length - 1]?.at ?? 0);
    if (hits.length === 0 || last < nowMs - maxAgeMs) {
      state.rateHits.delete(key);
      removed += 1;
    }
  }
  return removed;
}

function sessionOf(state: CapsState, sessionId: string): SessionState {
  let entry = state.sessions.get(sessionId);
  if (entry === undefined) {
    entry = { generations: 0, usd: 0 };
    state.sessions.set(sessionId, entry);
  }
  return entry;
}

/**
 * Sliding-window rate check; records the weighted hit and returns true when
 * allowed. Weights are fractional (a SAM request weighs 0.2), with a small
 * epsilon so five 0.2 requests weigh exactly one call.
 */
export function checkRateLimit(
  state: CapsState,
  limitPerMinute: number,
  ip: string,
  nowMs: number,
  weight = 1,
): boolean {
  const windowStart = nowMs - 60_000;
  let hits = state.rateHits.get(ip);
  if (hits === undefined) {
    hits = [];
    state.rateHits.set(ip, hits);
  }
  while (hits.length > 0 && (hits[0]?.at ?? 0) <= windowStart) hits.shift();
  const spent = hits.reduce((sum, hit) => sum + hit.weight, 0);
  if (spent + weight > limitPerMinute + 1e-9) return false;
  hits.push({ at: nowMs, weight });
  return true;
}

export type CapVerdict =
  { ok: true } | { ok: false; reason: "session-calls" | "session-usd" | "global-budget" };

export interface CapLimits {
  sessionMaxCalls: number;
  sessionMaxUsd: number;
  globalBudgetUsd: number;
  /** Sum of `upstream` USD; mock generations never check it. */
  upstreamTotalUsd: number;
}

/**
 * Session + global-budget check before a generation (upstream or mock).
 * Mock generations check the session caps but never the global budget:
 * only `upstream` lines cost money.
 */
export function checkGenerationCap(
  state: CapsState,
  limits: CapLimits,
  sessionId: string,
  isMock: boolean,
  weight = 1,
): CapVerdict {
  const session = sessionOf(state, sessionId);
  if (session.generations + weight > limits.sessionMaxCalls + 1e-9) {
    return { ok: false, reason: "session-calls" };
  }
  if (session.usd >= limits.sessionMaxUsd) return { ok: false, reason: "session-usd" };
  if (!isMock && limits.upstreamTotalUsd >= limits.globalBudgetUsd) {
    return { ok: false, reason: "global-budget" };
  }
  return { ok: true };
}

export function noteGeneration(state: CapsState, sessionId: string, usd: number, weight = 1): void {
  const session = sessionOf(state, sessionId);
  session.generations = Math.round((session.generations + weight) * 1_000_000) / 1_000_000;
  session.usd = Math.round((session.usd + usd) * 1_000_000) / 1_000_000;
}
