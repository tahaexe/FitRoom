import type { TokenUsage } from "./pricing.js";

/**
 * Thrown by a route's upstream call when the model answer is unusable after
 * its retry: the pipeline answers HTTP 200 `{ status: "error", ... }` with
 * this friendly message instead of the generic "unavailable" 502.
 *
 * Carries the usage Meta reported for the billed call, so the pipeline can
 * still write its `upstream` cost line: every billed call is counted.
 */
export class UpstreamFriendlyError extends Error {
  override name = "UpstreamFriendlyError";
  readonly usage?: TokenUsage;

  constructor(message: string, usage?: TokenUsage) {
    super(message);
    if (usage !== undefined) this.usage = usage;
  }
}

/**
 * A refused or spent credit: the upstream answered 401, 402 or 429, or its
 * error body names a quota, credit or billing limit. The pipeline answers it
 * like a reached cap (HTTP 429 `capped` with the resting line): no cost line
 * (the call was not billed) and no session-counter change.
 */
export class UpstreamQuotaError extends Error {
  override name = "UpstreamQuotaError";

  constructor(message = "The live AI is resting.") {
    super(message);
  }
}
