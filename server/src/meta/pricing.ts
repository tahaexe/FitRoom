/**
 * Price table maths: tokens and images from each response × the Meta prices
 * give USD. Only `upstream` lines cost money; everything else is free.
 */

import { META_PRICES } from "../config.js";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  images: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Normalise an upstream `usage` block (OpenAI shape) to TokenUsage. */
export function usageFromUpstream(usage: unknown, images: number): TokenUsage {
  if (typeof usage !== "object" || usage === null) {
    return { ...emptyUsage(), images };
  }
  const record = usage as Record<string, unknown>;
  const details = record["prompt_tokens_details"];
  const cached =
    typeof details === "object" && details !== null
      ? nonNegative((details as Record<string, unknown>)["cached_tokens"])
      : 0;
  const input = nonNegative(record["prompt_tokens"]);
  return {
    inputTokens: input,
    cachedInputTokens: Math.min(cached, input),
    outputTokens: nonNegative(record["completion_tokens"]),
    images,
  };
}

/** USD for one response, rounded to 6 decimals. */
export function costUsd(model: string, usage: TokenUsage): number {
  let usd: number;
  if (model === "muse-image-1.0") {
    usd = usage.images * META_PRICES.imagePerImage;
  } else if (model === "sam-3.1") {
    usd = usage.images * META_PRICES.samPerImage;
  } else {
    const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
    usd =
      (fresh / 1_000_000) * META_PRICES.sparkInputPer1M +
      (usage.cachedInputTokens / 1_000_000) * META_PRICES.sparkCachedInputPer1M +
      (usage.outputTokens / 1_000_000) * META_PRICES.sparkOutputPer1M;
  }
  return Math.round(usd * 1_000_000) / 1_000_000;
}
