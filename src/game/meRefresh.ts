/**
 * src/game/meRefresh.ts — pure helpers for /api/me refresh scheduling and
 * heart-rejection reconciliation (ADR-7, FR-24).
 *
 * No React, no DOM — fully unit-testable.
 */

// ── Vietnam midnight ──────────────────────────────────────────────────────────

/**
 * Computes the number of milliseconds until the next Vietnam midnight (UTC+7).
 * Vietnam midnight = 00:00:00 ICT = 17:00:00 UTC (previous calendar day).
 *
 * This is used to schedule a /api/me?campaign= refresh so that heartsLeft is
 * updated at midnight without the user having to reload.
 *
 * @param now  Current timestamp in epoch ms (use Date.now() in production).
 * @returns    Milliseconds until the next 17:00:00 UTC, always > 0.
 */
/**
 * Returns an array of `n` successive Vietnam midnight delays from `now`.
 *
 * delays[0] = ms until the first midnight from `now`.
 * delays[1] = ms until the second midnight (always ~24 h).
 * Useful for self-rescheduling timers.
 *
 * @param now  Current epoch ms.
 * @param n    Number of delays to compute.
 */
export function nextMidnightDelays(now: number, n: number): number[] {
  const delays: number[] = []
  let t = now
  for (let i = 0; i < n; i++) {
    const ms = msUntilVietnamMidnight(t)
    delays.push(ms)
    t += ms
  }
  return delays
}

export function msUntilVietnamMidnight(now: number): number {
  const d = new Date(now)
  // Find the next occurrence of 17:00:00 UTC
  const next = new Date(d)
  next.setUTCHours(17, 0, 0, 0)
  if (next.getTime() <= now) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next.getTime() - now
}

// ── Heart rejection reconciliation ───────────────────────────────────────────

export interface HeartRejectionResult {
  heartedIds: ReadonlySet<string>
  heartsLeft: number
  campaignOpen: boolean
  /** True when /api/me should be re-fetched to sync server state. */
  needsRefreshMe: boolean
}

/**
 * Returns the reconciled UI state after a heart API call rejects with an error
 * code, without calling the API (pure function — caller performs the refresh).
 *
 * Codes handled:
 *   already_hearted  → add publicId to heartedIds (the gift was hearted in a
 *                      previous session that the client didn't know about)
 *   hearts_exhausted → set heartsLeft = 0 (the user is out of hearts)
 *   campaign_closed  → set campaignOpen = false
 *
 * All three codes set needsRefreshMe = true so the caller can follow up with
 * GET /api/me?campaign= to get authoritative values.
 *
 * Unknown codes are returned unchanged with needsRefreshMe = false.
 */
export function reconcileHeartRejection(
  code: string,
  publicId: string,
  heartedIds: ReadonlySet<string>,
  heartsLeft: number,
  campaignOpen: boolean,
): HeartRejectionResult {
  switch (code) {
    case 'already_hearted':
      return {
        heartedIds: new Set([...heartedIds, publicId]),
        heartsLeft,
        campaignOpen,
        needsRefreshMe: true,
      }
    case 'hearts_exhausted':
      return {
        heartedIds,
        heartsLeft: 0,
        campaignOpen,
        needsRefreshMe: true,
      }
    case 'campaign_closed':
      return {
        heartedIds,
        heartsLeft,
        campaignOpen: false,
        needsRefreshMe: true,
      }
    default:
      return { heartedIds, heartsLeft, campaignOpen, needsRefreshMe: false }
  }
}
