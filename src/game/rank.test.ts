// @vitest-environment node
/**
 * Tests for src/game/rank.ts — gift rank and place assignment.
 *
 * API CONTRACT (implementer must match exactly):
 *
 *   type Place = 'tree' | 'ground' | 'list'
 *
 *   interface Gift {
 *     id: number          // unique identifier; lower id = created earlier when timestamps tie
 *     hearts: number      // heart_count
 *     createdAt: string   // ISO 8601 timestamp (sortable lexicographically)
 *   }
 *
 *   interface RankedGift extends Gift {
 *     rank: number        // 1-based; rank 1 = most hearts / earliest / lowest id
 *     place: Place        // 'tree' | 'ground' | 'list'
 *   }
 *
 *   // Sorts gifts and assigns rank + place:
 *   //   ORDER BY hearts DESC, createdAt ASC, id ASC
 *   //   ranks 1..treeSlots            → place = 'tree'
 *   //   ranks treeSlots+1..treeSlots+groundSlots → place = 'ground'
 *   //   ranks > treeSlots+groundSlots  → place = 'list'
 *   // Returns all gifts in rank order.
 *   export function assignPlaces(
 *     gifts: Gift[],
 *     treeSlots: number,
 *     groundSlots: number,
 *   ): RankedGift[]
 */

import { describe, it, expect } from 'vitest'
import { assignPlaces } from './rank.ts'

// Local type aliases matching the module contract — remove once rank.ts exists
type Place = 'tree' | 'ground' | 'list'
interface Gift { id: number; hearts: number; createdAt: string }
interface RankedGift extends Gift { rank: number; place: Place }

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Creates a gift with the given hearts and a deterministic timestamp. */
function g(id: number, hearts: number, createdAt = `2026-12-01T${String(id).padStart(2, '0')}:00:00Z`): Gift {
  return { id, hearts, createdAt }
}

/** Returns the RankedGift for a given id from the result array. */
function byId(result: RankedGift[], id: number): RankedGift {
  const r = result.find(x => x.id === id)
  if (!r) throw new Error(`id ${id} not found in result`)
  return r
}

/** Typed wrapper so callers get RankedGift[] instead of any[]. */
function places(gifts: Gift[], tree: number, ground: number): RankedGift[] {
  return assignPlaces(gifts, tree, ground) as unknown as RankedGift[]
}

// ─── AC-11: 30 gifts → ranks 1–15 tree, 16–25 ground, 26–30 list ──────────

describe('assignPlaces — AC-11: 30 gifts with default 15/10 slots', () => {
  // 30 gifts with distinct heart counts so rank order is unambiguous
  const gifts30: Gift[] = Array.from({ length: 30 }, (_, i) => g(i + 1, 30 - i))

  it('returns exactly 30 results', () => {
    const result = places(gifts30, 15, 10)
    expect(result).toHaveLength(30)
  })

  it('ranks 1–15 are placed on the tree', () => {
    const result = places(gifts30, 15, 10)
    for (const r of result) {
      if (r.rank >= 1 && r.rank <= 15) {
        expect(r.place).toBe('tree')
      }
    }
  })

  it('ranks 16–25 are placed on the ground', () => {
    const result = places(gifts30, 15, 10)
    for (const r of result) {
      if (r.rank >= 16 && r.rank <= 25) {
        expect(r.place).toBe('ground')
      }
    }
  })

  it('ranks 26–30 are in the list', () => {
    const result = places(gifts30, 15, 10)
    for (const r of result) {
      if (r.rank >= 26) {
        expect(r.place).toBe('list')
      }
    }
  })

  it('all ranks 1–30 are present exactly once', () => {
    const result = places(gifts30, 15, 10)
    const ranks = result.map(r => r.rank).sort((a, b) => a - b)
    expect(ranks).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
  })
})

// ─── Ranking: hearts DESC ─────────────────────────────────────────────────────

describe('assignPlaces — primary sort: hearts descending', () => {
  it('gift with most hearts gets rank 1', () => {
    const gifts = [g(1, 5), g(2, 20), g(3, 10)]
    const result = places(gifts, 15, 10)
    expect(byId(result, 2).rank).toBe(1)
  })

  it('gift with fewest hearts gets lowest rank', () => {
    const gifts = [g(1, 5), g(2, 20), g(3, 10)]
    const result = places(gifts, 15, 10)
    expect(byId(result, 1).rank).toBe(3)
  })

  it('rank order descends with hearts', () => {
    const gifts = [g(3, 10), g(1, 30), g(2, 20)]
    const result = places(gifts, 15, 10)
    expect(byId(result, 1).rank).toBe(1)
    expect(byId(result, 2).rank).toBe(2)
    expect(byId(result, 3).rank).toBe(3)
  })
})

// ─── Ranking: tie-break by createdAt ASC ──────────────────────────────────────

describe('assignPlaces — tie-break: earlier createdAt wins', () => {
  it('same hearts: earlier createdAt gets higher rank', () => {
    const gifts: Gift[] = [
      { id: 1, hearts: 10, createdAt: '2026-12-01T01:00:00Z' },
      { id: 2, hearts: 10, createdAt: '2026-12-01T00:00:00Z' },  // earlier
      { id: 3, hearts: 10, createdAt: '2026-12-01T02:00:00Z' },
    ]
    const result = places(gifts, 15, 10)
    expect(byId(result, 2).rank).toBe(1)
    expect(byId(result, 1).rank).toBe(2)
    expect(byId(result, 3).rank).toBe(3)
  })

  it('tie on createdAt: lower id wins', () => {
    const gifts: Gift[] = [
      { id: 3, hearts: 10, createdAt: '2026-12-01T00:00:00Z' },
      { id: 1, hearts: 10, createdAt: '2026-12-01T00:00:00Z' },
      { id: 2, hearts: 10, createdAt: '2026-12-01T00:00:00Z' },
    ]
    const result = places(gifts, 15, 10)
    expect(byId(result, 1).rank).toBe(1)
    expect(byId(result, 2).rank).toBe(2)
    expect(byId(result, 3).rank).toBe(3)
  })

  it('mixed hearts and timestamp ties', () => {
    const gifts: Gift[] = [
      { id: 1, hearts: 5, createdAt: '2026-12-01T00:00:00Z' },
      { id: 2, hearts: 10, createdAt: '2026-12-01T01:00:00Z' },
      { id: 3, hearts: 10, createdAt: '2026-12-01T00:30:00Z' },  // same hearts as 2 but earlier
    ]
    const result = places(gifts, 15, 10)
    expect(byId(result, 3).rank).toBe(1)
    expect(byId(result, 2).rank).toBe(2)
    expect(byId(result, 1).rank).toBe(3)
  })
})

// ─── Input order doesn't matter ──────────────────────────────────────────────

describe('assignPlaces — input order is irrelevant', () => {
  it('reverse input order yields same ranks', () => {
    const gifts: Gift[] = [g(1, 30), g(2, 20), g(3, 10), g(4, 5)]
    const reversed: Gift[] = [...gifts].reverse()
    const r1 = assignPlaces(gifts, 15, 10)
    const r2 = assignPlaces(reversed, 15, 10)
    for (const f of gifts) {
      expect(byId(r1, f.id).rank).toBe(byId(r2, f.id).rank)
      expect(byId(r1, f.id).place).toBe(byId(r2, f.id).place)
    }
  })
})

// ─── Place boundaries ─────────────────────────────────────────────────────────

describe('assignPlaces — place boundary conditions', () => {
  it('slot boundary: treeSlots-th gift is tree, (treeSlots+1)-th is ground', () => {
    const gifts = Array.from({ length: 20 }, (_, i) => g(i + 1, 20 - i))
    const result = places(gifts, 10, 5)
    expect(result.find(r => r.rank === 10)!.place).toBe('tree')
    expect(result.find(r => r.rank === 11)!.place).toBe('ground')
  })

  it('ground boundary: (treeSlots+groundSlots)-th is ground, next is list', () => {
    const gifts = Array.from({ length: 20 }, (_, i) => g(i + 1, 20 - i))
    const result = places(gifts, 10, 5)
    expect(result.find(r => r.rank === 15)!.place).toBe('ground')
    expect(result.find(r => r.rank === 16)!.place).toBe('list')
  })

  it('fewer gifts than treeSlots: all gifts are on the tree', () => {
    const gifts = [g(1, 10), g(2, 5)]
    const result = places(gifts, 15, 10)
    for (const r of result) {
      expect(r.place).toBe('tree')
    }
  })

  it('fewer gifts than treeSlots+groundSlots: no list gifts', () => {
    const gifts = Array.from({ length: 20 }, (_, i) => g(i + 1, 20 - i))
    const result = places(gifts, 15, 10)
    expect(result.every(r => r.place !== 'list')).toBe(true)
  })

  it('no gifts on the tree when treeSlots=0', () => {
    const gifts = [g(1, 10), g(2, 5), g(3, 3)]
    const result = places(gifts, 0, 2)
    expect(result.find(r => r.rank === 1)!.place).toBe('ground')
    expect(result.find(r => r.rank === 2)!.place).toBe('ground')
    expect(result.find(r => r.rank === 3)!.place).toBe('list')
  })
})

// ─── Empty and minimal inputs ─────────────────────────────────────────────────

describe('assignPlaces — edge cases', () => {
  it('empty gifts list returns empty array', () => {
    expect(assignPlaces([], 15, 10)).toHaveLength(0)
  })

  it('single gift gets rank 1 and place tree', () => {
    const result = places([g(1, 0)], 15, 10)
    expect(result).toHaveLength(1)
    expect(result[0].rank).toBe(1)
    expect(result[0].place).toBe('tree')
  })

  it('original gift data is preserved in result', () => {
    const gifts = [g(7, 42)]
    const result = places(gifts, 15, 10)
    expect(result[0].id).toBe(7)
    expect(result[0].hearts).toBe(42)
  })

  it('with 30 gifts, treeSlots=15, groundSlots=10: exactly 15 tree, 10 ground, 5 list', () => {
    const gifts30 = Array.from({ length: 30 }, (_, i) => g(i + 1, 30 - i))
    const result = places(gifts30, 15, 10)
    const treeCnt = result.filter(r => r.place === 'tree').length
    const groundCnt = result.filter(r => r.place === 'ground').length
    const listCnt = result.filter(r => r.place === 'list').length
    expect(treeCnt).toBe(15)
    expect(groundCnt).toBe(10)
    expect(listCnt).toBe(5)
  })
})
