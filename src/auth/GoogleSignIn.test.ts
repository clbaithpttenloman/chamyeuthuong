// @vitest-environment node
/**
 * src/auth/GoogleSignIn.test.ts
 *
 * Tests for the pure helpers extracted from GoogleSignIn for testability.
 * No React, no DOM, no network calls.
 *
 * Covers:
 *   signInFailureNeedsNonceRefresh — retry decision after a sign-in callback failure
 *   GSI_SCRIPT_LOAD_ERROR          — Vietnamese message for script load failure
 *
 * Ref: review.md Cycle 1 Warning; tasks.md Fix Group 5a Accept 2.
 */
import { describe, it, expect } from 'vitest'
import { signInFailureNeedsNonceRefresh, GSI_SCRIPT_LOAD_ERROR } from './googleSignInHelpers.ts'
import { ApiError } from '../api.ts'

// ── signInFailureNeedsNonceRefresh ────────────────────────────────────────
//
// Nonce is single-use: the server clears it after every sign-in attempt.
// A retry always needs a fresh nonce, regardless of the error type.
// ─────────────────────────────────────────────────────────────────────────

describe('signInFailureNeedsNonceRefresh — always true (single-use nonce)', () => {
  it('returns true for 401 (nonce invalid or expired)', () => {
    expect(signInFailureNeedsNonceRefresh(new ApiError(401, 'unauthorized'))).toBe(true)
  })

  it('returns true for 429 rate limit (nonce was consumed)', () => {
    expect(signInFailureNeedsNonceRefresh(new ApiError(429, 'rate_limited'))).toBe(true)
  })

  it('returns true for 500 server error (nonce may have been consumed)', () => {
    expect(signInFailureNeedsNonceRefresh(new ApiError(500, 'server_error'))).toBe(true)
  })

  it('returns true for a network error', () => {
    expect(signInFailureNeedsNonceRefresh(new Error('fetch failed'))).toBe(true)
  })

  it('returns true for null (unexpected callback failure)', () => {
    expect(signInFailureNeedsNonceRefresh(null)).toBe(true)
  })

  it('returns true for undefined', () => {
    expect(signInFailureNeedsNonceRefresh(undefined)).toBe(true)
  })
})

// ── GSI_SCRIPT_LOAD_ERROR ─────────────────────────────────────────────────

describe('GSI_SCRIPT_LOAD_ERROR', () => {
  it('is a non-empty string', () => {
    expect(typeof GSI_SCRIPT_LOAD_ERROR).toBe('string')
    expect(GSI_SCRIPT_LOAD_ERROR.length).toBeGreaterThan(10)
  })

  it('contains Vietnamese text (no raw ASCII error codes)', () => {
    // Must be a user-readable Vietnamese message, not a raw error string
    expect(GSI_SCRIPT_LOAD_ERROR).toMatch(/[àáảãạăắặẵẩêếềệẻẽủụưứừởổỗọôốộổỗòóõủùú]|đ|ă|ơ|ư/i)
  })
})
