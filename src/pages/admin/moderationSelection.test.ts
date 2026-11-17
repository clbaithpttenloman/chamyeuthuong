/**
 * Tests for moderationSelection.ts — pure selection helpers for ModerationSection.
 *
 * toggleAll: when fewer than MAX_REVIEW_IDS are selected, select the first ≤ MAX_REVIEW_IDS.
 *            When any are already selected, clear the selection.
 * toggleOne: adds id if below cap, refuses if already at MAX_REVIEW_IDS.
 */
import { describe, it, expect } from 'vitest'
// These imports fail until moderationSelection.ts is created → all tests fail.
import { toggleAll, toggleOne } from './moderationSelection.ts'
import { MAX_REVIEW_IDS } from '../../../shared/api.ts'

const IDS = Array.from({ length: 10 }, (_, i) => i + 1)

describe('toggleAll', () => {
  it('empty selection → selects all ids', () => {
    const result = toggleAll(IDS, new Set())
    expect(result.selected).toEqual(new Set(IDS))
    expect(result.capNotice).toBeNull()
  })

  it('any existing selection → clears all', () => {
    const result = toggleAll(IDS, new Set([1, 2]))
    expect(result.selected).toEqual(new Set())
    expect(result.capNotice).toBeNull()
  })

  it('ids exceed MAX_REVIEW_IDS → selects first MAX_REVIEW_IDS and sets notice', () => {
    const bigIds = Array.from({ length: MAX_REVIEW_IDS + 5 }, (_, i) => i + 1)
    const result = toggleAll(bigIds, new Set())
    expect(result.selected.size).toBe(MAX_REVIEW_IDS)
    expect([...result.selected]).toEqual(bigIds.slice(0, MAX_REVIEW_IDS))
    expect(result.capNotice).toContain(String(MAX_REVIEW_IDS))
  })

  it('ids exactly MAX_REVIEW_IDS → selects all, no notice', () => {
    const exactIds = Array.from({ length: MAX_REVIEW_IDS }, (_, i) => i + 1)
    const result = toggleAll(exactIds, new Set())
    expect(result.selected.size).toBe(MAX_REVIEW_IDS)
    expect(result.capNotice).toBeNull()
  })
})

describe('toggleOne', () => {
  it('adds id when not selected and under cap', () => {
    const result = toggleOne(5, new Set([1, 2]))
    expect(result.selected).toEqual(new Set([1, 2, 5]))
    expect(result.notice).toBeNull()
  })

  it('removes id when already selected', () => {
    const result = toggleOne(2, new Set([1, 2, 3]))
    expect(result.selected).toEqual(new Set([1, 3]))
    expect(result.notice).toBeNull()
  })

  it('refuses to add beyond MAX_REVIEW_IDS and reports notice', () => {
    const full = new Set(Array.from({ length: MAX_REVIEW_IDS }, (_, i) => i + 1))
    const newId = MAX_REVIEW_IDS + 1
    const result = toggleOne(newId, full)
    // Selection unchanged
    expect(result.selected).toBe(full)
    // Notice provided
    expect(result.notice).toContain(String(MAX_REVIEW_IDS))
  })

  it('allows removing from a full set', () => {
    const full = new Set(Array.from({ length: MAX_REVIEW_IDS }, (_, i) => i + 1))
    const result = toggleOne(1, full)
    expect(result.selected.size).toBe(MAX_REVIEW_IDS - 1)
    expect(result.notice).toBeNull()
  })
})
