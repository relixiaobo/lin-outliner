/**
 * Failure backoff for the scheduled Dream pass.
 *
 * The Dream scheduler ticks every 60s and the fixed-time due gate may retry the same due up to a
 * small durable run-meta cap. A failed Dream advances neither the derived completed-date cursor nor
 * the Dream channel's clean `dream.finished` window, so without a transient backoff a provider error
 * would re-fire on every tick until the cap is hit. After a failure the runtime holds the principal off
 * for this long before the next scheduled attempt; the window grows exponentially with consecutive
 * failures, is capped, and resets on the first success.
 *
 * This is transient scheduler control state (it lives in-memory beside the `dreamingPrincipals` guard),
 * not durable memory — durable memory lives in ordinary outline nodes and Dream completion is
 * audited by the protected Dream channel. A restart costs one extra attempt, never a flood.
 */
export const DREAM_FAILURE_BACKOFF_BASE_MS = 5 * 60_000; // 5 minutes after the first failure
export const DREAM_FAILURE_BACKOFF_CAP_MS = 6 * 60 * 60_000; // capped at 6 hours

/**
 * Backoff delay before the next scheduled Dream attempt, given how many times in a row it has
 * failed. `consecutiveFailures` is 1 right after the first failure. Exponential (base · 2^(n-1)),
 * clamped to the cap; the exponent is bounded so a long failure streak can't overflow.
 */
export function dreamFailureBackoffMs(consecutiveFailures: number): number {
  const steps = Math.min(Math.max(consecutiveFailures - 1, 0), 20);
  return Math.min(DREAM_FAILURE_BACKOFF_BASE_MS * 2 ** steps, DREAM_FAILURE_BACKOFF_CAP_MS);
}
