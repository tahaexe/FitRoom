/**
 * Gateway configuration: Meta Model API facts, prices and caps.
 *
 * Facts checked with real calls on 2026-10-26 — keep them in sync with the
 * task spec. The API key comes only from the `META_API_KEY` environment
 * variable and is never logged, returned or written anywhere.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const META_BASE_URL = "https://api.meta.ai/v1";

/** The only model ids the app may call. */
export const META_MODELS = {
  spark: "muse-spark-1.3",
  image: "muse-image-1.0",
  sam: "sam-3.1",
} as const;

export type MetaModelId = (typeof META_MODELS)[keyof typeof META_MODELS];

/** Prices per 1M tokens, except where noted. */
export const META_PRICES = {
  /** Muse Spark input USD per 1M tokens. */
  sparkInputPer1M: 1.25,
  /** Muse Spark cached input USD per 1M tokens. */
  sparkCachedInputPer1M: 0.15,
  /** Muse Spark output USD per 1M tokens (reasoning is billed as output). */
  sparkOutputPer1M: 4.25,
  /** Muse Image USD per image. */
  imagePerImage: 0.01,
  /** SAM USD per image. */
  samPerImage: 0.0025,
} as const;

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function serverRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export interface GatewayConfig {
  /** Meta API key; empty string when unset (mock/demo only). */
  apiKey: string;
  /** META_MOCK=1: answer from fixtures instead of calling upstream. */
  mock: boolean;
  /** META_RECORD=1 (development only): also write upstream answers out. */
  record: boolean;
  /** Per-session upstream-call cap. */
  sessionMaxCalls: number;
  /** Per-session upstream USD cap. */
  sessionMaxUsd: number;
  /** Global upstream USD budget, checked against costs.csv. */
  globalBudgetUsd: number;
  /** AI requests per minute per IP. */
  ratePerMinutePerIp: number;
  /** Directory holding cache/, demo/, mock/ and recorded/. */
  dataDir: string;
  /** Directory holding costs.csv. */
  logsDir: string;
}

export function loadGatewayConfig(): GatewayConfig {
  const root = serverRoot();
  return {
    apiKey: process.env["META_API_KEY"] ?? "",
    mock: process.env["META_MOCK"] === "1",
    record: process.env["META_RECORD"] === "1",
    sessionMaxCalls: numEnv("META_SESSION_MAX_CALLS", 20),
    sessionMaxUsd: numEnv("META_SESSION_MAX_USD", 0.5),
    globalBudgetUsd: numEnv("META_BUDGET_USD", 5),
    ratePerMinutePerIp: numEnv("META_RATE_PER_MIN", 30),
    dataDir: process.env["FITROOM_DATA_DIR"] ?? resolve(root, "data"),
    logsDir: process.env["FITROOM_LOGS_DIR"] ?? resolve(root, "logs"),
  };
}
