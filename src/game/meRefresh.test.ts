// @vitest-environment node
/**
 * Tests for src/game/meRefresh.ts — Vietnam midnight delay and heart reconciliation.
 */

import { describe, it, expect } from 'vitest'
import { msUntilVietnamMidnight, reconcileHeartRejection } from './meRefresh.ts'

// ── msUntilVietnamMidnight ────────────────────────────────────────────────────

describe('msUntilVietnamMidnight', () => {
  // Vietnam midnight = 17:00:00 UTC (00:00:00 UTC+7)

  it('from 16:00:00 UTC → exactly 1 hour until midnight', () => {
    const now = Date.UTC(2024, 11, 20, 16, 0, 0)  // 2024-12-20T16:00:00Z
    expect(msUntilVietnamMidnight(now)).toBe(3_600_000)
  })

  it('from exactly 17:00:00 UTC → exactly 24 hours (not zero)', () => {
    const now = Date.UTC(2024, 11, 20, 17, 0, 0)  // at midnight exactly
    expect(msUntilVietnamMidnight(now)).toBe(24 * 3_600_000)
  })

  it('from just before 17:00:00 UTC → less than 1 second', () => {
    const now = Date.UTC(2024, 11, 20, 16, 59, 59, 999)
    expect(msUntilVietnamMidnight(now)).toBe(1)
  })

  it('from 18:00:00 UTC → 23 hours until next midnight', () => {
    const now = Date.UTC(2024, 11, 20, 18, 0, 0)
    expect(msUntilVietnamMidnight(now)).toBe(23 * 3_600_000)
  })

  it('from just after 17:00:00 UTC → approximately 24 hours', () => {
    const now = Date.UTC(2024, 11, 20, 17, 0, 0, 500)
    const ms = msUntilVietnamMidnight(now)
    expect(ms).toBeCloseTo(24 * 3_600_000 - 500, -3) // within 1 second
  })

  it('always returns a positive value', () => {
    // Test various times of day
    for (let h = 0; h < 24; h++) {
      const now = Date.UTC(2024, 11, 20, h, 0, 0)
      expect(msUntilVietnamMidnight(now)).toBeGreaterThan(0)
    }
  })

  it('maximum is less than 24 hours + 1 s', () => {
    for (let h = 0; h < 24; h++) {
      const now = Date.UTC(2024, 11, 20, h, 0, 0)
      expect(msUntilVietnamMidnight(now)).toBeLessThanOrEqual(24 * 3_600_000)
    }
  })
})

// ── reconcileHeartRejection ───────────────────────────────────────────────────

const BASE = {
  heartedIds: new Set<string>(['x', 'y']),
  heartsLeft: 3,
  campaignOpen: true,
}

describe('reconcileHeartRejection — already_hearted', () => {
  it('adds publicId to heartedIds', () => {
    const result = reconcileHeartRejection('already_hearted', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.heartedIds.has('z')).toBe(true)
  })

  it('preserves existing hearted ids', () => {
    const result = reconcileHeartRejection('already_hearted', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.heartedIds.has('x')).toBe(true)
    expect(result.heartedIds.has('y')).toBe(true)
  })

  it('does not change heartsLeft', () => {
    const result = reconcileHeartRejection('already_hearted', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.heartsLeft).toBe(3)
  })

  it('needsRefreshMe = true', () => {
    const result = reconcileHeartRejection('already_hearted', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.needsRefreshMe).toBe(true)
  })

  it('handles publicId already in heartedIds (idempotent)', () => {
    const result = reconcileHeartRejection('already_hearted', 'x', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.heartedIds.has('x')).toBe(true)
    expect(result.heartedIds.size).toBe(2)
  })
})

describe('reconcileHeartRejection — hearts_exhausted', () => {
  it('sets heartsLeft to 0', () => {
    const result = reconcileHeartRejection('hearts_exhausted', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.heartsLeft).toBe(0)
  })

  it('does not change heartedIds', () => {
    const result = reconcileHeartRejection('hearts_exhausted', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.heartedIds).toBe(BASE.heartedIds) // same reference
  })

  it('needsRefreshMe = true', () => {
    const result = reconcileHeartRejection('hearts_exhausted', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.needsRefreshMe).toBe(true)
  })
})

describe('reconcileHeartRejection — campaign_closed', () => {
  it('sets campaignOpen to false', () => {
    const result = reconcileHeartRejection('campaign_closed', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.campaignOpen).toBe(false)
  })

  it('does not change heartsLeft', () => {
    const result = reconcileHeartRejection('campaign_closed', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.heartsLeft).toBe(3)
  })

  it('needsRefreshMe = true', () => {
    const result = reconcileHeartRejection('campaign_closed', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.needsRefreshMe).toBe(true)
  })
})

describe('reconcileHeartRejection — unknown codes', () => {
  it('needsRefreshMe = false for unknown code', () => {
    const result = reconcileHeartRejection('some_unknown_code', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.needsRefreshMe).toBe(false)
  })

  it('returns unchanged state for unknown code', () => {
    const result = reconcileHeartRejection('rate_limited', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.heartsLeft).toBe(3)
    expect(result.campaignOpen).toBe(true)
    expect(result.heartedIds).toBe(BASE.heartedIds)
  })

  it('handles empty string code gracefully', () => {
    const result = reconcileHeartRejection('', 'z', BASE.heartedIds, BASE.heartsLeft, BASE.campaignOpen)
    expect(result.needsRefreshMe).toBe(false)
  })
})
