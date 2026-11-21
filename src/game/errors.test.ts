// @vitest-environment node
/**
 * Tests for src/game/errors.ts
 *
 * Verifies that every error code returned by the worker endpoints has a
 * user-facing Vietnamese message.  The codes are listed by reading
 * worker/gifts.ts, worker/tree.ts, and worker/me.ts; they are tested
 * here so the map can never silently miss a code.
 */
import { describe, it, expect } from 'vitest'
import { ERROR_MESSAGES, errorMessage } from './errors.ts'

// ── Codes extracted from worker source files ──────────────────────────────────
//
// worker/gifts.ts  → handleCreateGift, handleHeart, handleReport, handleDeleteGift
// worker/tree.ts   → handleTreeEndpoint, handleGiftList, handleGiftById
// worker/me.ts     → handleAuth, handleMe
//
// Every `{ error: '<code>' }` response body is listed once.

const WORKER_CODES = [
  // worker/gifts.ts
  'forbidden',
  'unauthorized',
  'rate_limited',
  'bad_request',
  'not_found',
  'campaign_closed',
  'banned',
  'limit_reached',
  'daily_limit',
  'gift_not_found',
  'already_hearted',
  'own_gift',
  'hearts_exhausted',
  'already_reported',
  'pending_review',
  'reports_exhausted',
  'owner_banned',
  // worker/tree.ts (extra codes beyond gifts.ts)
  // bad_request, not_found, rate_limited — already listed above
  // worker/me.ts (extra codes beyond the above)
  'misconfigured',
  'method',
] as const

describe('errors.ts — all worker codes covered', () => {
  for (const code of WORKER_CODES) {
    it(`${code} has a non-empty message`, () => {
      const msg = ERROR_MESSAGES[code]
      expect(typeof msg).toBe('string')
      expect(msg!.length).toBeGreaterThan(0)
    })
  }
})

describe('errorMessage()', () => {
  it('returns the mapped message for a known code', () => {
    expect(errorMessage('campaign_closed')).toBe(ERROR_MESSAGES['campaign_closed'])
    expect(errorMessage('hearts_exhausted')).toBe(ERROR_MESSAGES['hearts_exhausted'])
  })

  it('returns a non-empty fallback for an unknown code', () => {
    const msg = errorMessage('totally_unknown_xyz')
    expect(typeof msg).toBe('string')
    expect(msg.length).toBeGreaterThan(0)
  })

  it('fallback differs from any known message (proves it is a real fallback)', () => {
    const fallback = errorMessage('____no_such_code____')
    expect(Object.values(ERROR_MESSAGES)).not.toContain(fallback)
  })
})
