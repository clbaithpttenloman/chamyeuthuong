/**
 * Tests for src/pages/qr/qrState.ts
 *
 *
 * Contract expected:
 *   pickRandom(cards: PublicCard[], excludeId?: string | null): PublicCard | null
 *     - Returns null if cards is empty
 *     - Returns the only card if length === 1 (even if it matches excludeId)
 *     - Excludes the card with publicId === excludeId when alternatives exist
 *     - Statistically returns different cards across multiple calls (randomness)
 */
import { describe, it, expect } from 'vitest'

import { pickRandom } from './qrState.ts'
import type { PublicCard } from '../../../shared/api.ts'

function makeCard(id: string): PublicCard {
  return {
    publicId: id,
    layout: 'doc-giua',
    images: {},
    font: 'patrick-hand',
    ink: '#1d3fa6',
    message: `msg-${id}`,
    from: 'Test',
    createdAt: '2024-01-01T00:00:00.000Z',
  }
}

const cards = Array.from({ length: 5 }, (_, i) => makeCard(`card${String(i).padStart(11, '0')}`))

describe('pickRandom — empty list', () => {
  it('returns null for empty array', () => {
    expect(pickRandom([])).toBeNull()
  })

  it('returns null for empty array with excludeId', () => {
    expect(pickRandom([], 'some-id')).toBeNull()
  })
})

describe('pickRandom — single card', () => {
  it('returns the only card even if it matches excludeId', () => {
    const c = makeCard('only-card-id-01')
    expect(pickRandom([c], 'only-card-id-01')).toEqual(c)
  })

  it('returns the only card when no excludeId', () => {
    const c = makeCard('only-card-id-01')
    expect(pickRandom([c])).toEqual(c)
  })
})

describe('pickRandom — multiple cards, excluding current', () => {
  it('never returns the excluded card when alternatives exist', () => {
    const excluded = cards[0]
    for (let i = 0; i < 50; i++) {
      const result = pickRandom(cards, excluded.publicId)
      expect(result).not.toBeNull()
      expect(result!.publicId).not.toBe(excluded.publicId)
    }
  })

  it('returns the excluded card when it is the only one left (all others excluded)', () => {
    // Edge case: exclude by id, but only 1 card in list
    const c = makeCard('single-card-123')
    const result = pickRandom([c], c.publicId)
    expect(result).toEqual(c)
  })

  it('returns a card from the list (not null) when excludeId matches one of them', () => {
    const result = pickRandom(cards, cards[2].publicId)
    expect(result).not.toBeNull()
    expect(cards.map((c) => c.publicId)).toContain(result!.publicId)
  })
})

describe('pickRandom — randomness', () => {
  it('returns different cards across multiple calls (statistical)', () => {
    // With 5 cards and 30 calls, we expect at least 2 distinct results
    const seen = new Set<string>()
    for (let i = 0; i < 30; i++) {
      const r = pickRandom(cards)
      if (r) seen.add(r.publicId)
    }
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('pickRandom — no excludeId', () => {
  it('returns a card from the list when excludeId is undefined', () => {
    const result = pickRandom(cards)
    expect(result).not.toBeNull()
    expect(cards.map((c) => c.publicId)).toContain(result!.publicId)
  })

  it('returns a card from the list when excludeId is null', () => {
    const result = pickRandom(cards, null)
    expect(result).not.toBeNull()
  })
})
