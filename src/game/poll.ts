/** Polling delay and local heart override logic for the gift tree scene (ADR-7). */

/** A pure random number generator returning a value in [0, 1). */
export type Rng = () => number

/** State of a gift's heart counter as seen by the client. */
export interface HeartState {
  asOf: number  // monotonic timestamp (ms) of the last server response
  count: number // heart count at that point
}

const BASE_MS = 15_000          // base delay at failures=0 with mid jitter
const JITTER_MS = 6_000         // full jitter range: (rng-0.5)*6000 → ±3 000 ms
const BACKOFF = 1.5             // multiplier per failure (strictly monotonic for 0..5 within cap)
const MAX_MS = 120_000          // hard cap; failures ≥ ~6 saturate here

/**
 * Returns the next poll delay in milliseconds.
 * - failures=0, rng=0 → 12 000 ms; rng=0.5 → 15 000 ms.
 * - Grows by 1.5× per failure before jitter; capped at 120 000 ms.
 */
export function nextPollDelay(rng: Rng, failures: number): number {
  const base = BASE_MS * Math.pow(BACKOFF, failures)
  const jitter = (rng() - 0.5) * JITTER_MS
  return Math.min(base + jitter, MAX_MS)
}

/**
 * Keeps the local heart override until the server response is both
 * later (server.asOf > local.asOf) and confirmed (server.count >= local.count).
 * Returns server if both conditions hold; otherwise returns local.
 * If local is null (no override yet), always returns server.
 */
export function mergeHeart(local: HeartState | null, server: HeartState): HeartState {
  if (local === null) return server
  if (server.asOf > local.asOf && server.count >= local.count) return server
  return local
}
