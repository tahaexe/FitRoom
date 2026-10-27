/**
 * Thrown by a route's upstream call when the model answer is unusable after
 * its retry: the pipeline answers HTTP 200 `{ status: "error", ... }` with
 * this friendly message instead of the generic "unavailable" 502.
 */
export class UpstreamFriendlyError extends Error {
  override name = "UpstreamFriendlyError";
}
