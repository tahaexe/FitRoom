/**
 * Caps: per-session upstream generations and USD, a global USD budget and a
 * per-IP rate limit. Over any cap the routes answer HTTP 429 with the
 * friendly capped copy. In mock mode the fixture stands in for upstream, so
 * mock generations count toward the session caps (they never touch the
 * global budget, which sums only `upstream` lines in costs.csv).
 */

import { randomBytes } from "node:crypto";
import type { GatewayConfig } from "../config.js";
import { readUpstreamTotalUsd } from "./metering.js";

export const SESSION_COOKIE = "fitroom_sid";

export function newSessionId(): string {
  return randomBytes(16).toString("hex");
}

interface SessionState {
  generations: number;
  usd: number;
}

export interface CapsState {
  sessions: Map<string, SessionState>;
  rateHits: Map<string, number[]>;
  /** Cached upstream total; null until first loaded from costs.csv. */
  upstreamTotalUsd: number | null;
}

export function createCapsState(): CapsState {
  return { sessions: new Map(), rateHits: new Map(), upstreamTotalUsd: null };
}

function sessionOf(state: CapsState, sessionId: string): SessionState {
  let entry = state.sessions.get(sessionId);
  if (entry === undefined) {
    entry = { generations: 0, usd: 0 };
    state.sessions.set(sessionId, entry);
  }
  return entry;
}

/** Sliding-window rate check; true when the request may proceed. */
export function checkRateLimit(
  state: CapsState,
  config: GatewayConfig,
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
  if (hits.length >= config.ratePerMinutePerIp) return false;
  hits.push(nowMs);
  return true;
}

export type CapVerdict =
  { ok: true } | { ok: false; reason: "session-calls" | "session-usd" | "global-budget" };

function upstreamTotal(state: CapsState, config: GatewayConfig): number {
  if (state.upstreamTotalUsd === null) {
    // Read from costs.csv so the budget survives restarts.
    state.upstreamTotalUsd = readUpstreamTotalUsd(config.logsDir);
  }
  return state.upstreamTotalUsd;
}

/**
 * Session + global-budget check before a generation (upstream or mock).
 * Mock generations check the session caps but never the global budget:
 * only `upstream` lines cost money.
 */
export function checkGenerationCap(
  state: CapsState,
  config: GatewayConfig,
  sessionId: string,
  isMock: boolean,
): CapVerdict {
  const session = sessionOf(state, sessionId);
  if (session.generations >= config.sessionMaxCalls) return { ok: false, reason: "session-calls" };
  if (session.usd >= config.sessionMaxUsd) return { ok: false, reason: "session-usd" };
  if (!isMock && upstreamTotal(state, config) >= config.globalBudgetUsd) {
    return { ok: false, reason: "global-budget" };
  }
  return { ok: true };
}

export function noteGeneration(
  state: CapsState,
  sessionId: string,
  usd: number,
  isUpstream: boolean,
): void {
  const session = sessionOf(state, sessionId);
  session.generations += 1;
  session.usd = Math.round((session.usd + usd) * 1_000_000) / 1_000_000;
  if (isUpstream && state.upstreamTotalUsd !== null) {
    state.upstreamTotalUsd = Math.round((state.upstreamTotalUsd + usd) * 1_000_000) / 1_000_000;
  }
}
