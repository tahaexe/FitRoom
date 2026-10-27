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
