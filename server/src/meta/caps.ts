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
  generations: number;
  usd: number;
}

export interface CapsState {
  sessions: Map<string, SessionState>;
  rateHits: Map<string, number[]>;
}

export function createCapsState(): CapsState {
  return { sessions: new Map(), rateHits: new Map() };
}

function sessionOf(state: CapsState, sessionId: string): SessionState {
  let entry = state.sessions.get(sessionId);
  if (entry === undefined) {
    entry = { generations: 0, usd: 0 };
    state.sessions.set(sessionId, entry);
  }
  return entry;
}

/** Sliding-window rate check; records the hit and returns true when allowed. */
export function checkRateLimit(
  state: CapsState,
  limitPerMinute: number,
  ip: string,
  nowMs: number,
): boolean {
  const windowStart = nowMs - 60_000;
  let hits = state.rateHits.get(ip);
  if (hits === undefined) {
    hits = [];
    state.rateHits.set(ip, hits);
  }
  while (hits.length > 0 && (hits[0] ?? 0) <= windowStart) hits.shift();
  if (hits.length >= limitPerMinute) return false;
  hits.push(nowMs);
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
): CapVerdict {
  const session = sessionOf(state, sessionId);
  if (session.generations >= limits.sessionMaxCalls) {
    return { ok: false, reason: "session-calls" };
  }
  if (session.usd >= limits.sessionMaxUsd) return { ok: false, reason: "session-usd" };
  if (!isMock && limits.upstreamTotalUsd >= limits.globalBudgetUsd) {
    return { ok: false, reason: "global-budget" };
  }
  return { ok: true };
}

export function noteGeneration(state: CapsState, sessionId: string, usd: number): void {
  const session = sessionOf(state, sessionId);
  session.generations += 1;
  session.usd = Math.round((session.usd + usd) * 1_000_000) / 1_000_000;
}
