/**
 * Meta Model API facts and prices.
 *
 * Facts checked with real calls on 2026-10-26 — keep them in sync with the
 * task spec. This module has no Node imports so the Worker bundle can use
 * it; `config.ts` re-exports these for the existing Node imports.
 */

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
