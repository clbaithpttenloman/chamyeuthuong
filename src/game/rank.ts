/** Gift rank and place assignment for the gift tree scene. */

/** Where a gift is displayed. */
export type Place = 'tree' | 'ground' | 'list'

/** A gift with its metadata. */
export interface Gift {
  id: number
  hearts: number
  createdAt: string // ISO 8601, sortable lexicographically
}

/** A gift with its assigned rank and display place. */
export interface RankedGift extends Gift {
  rank: number
  place: Place
}

/**
 * Sorts gifts and assigns rank + place.
 * Order: hearts DESC, createdAt ASC, id ASC.
 * Ranks 1..treeSlots → 'tree';
 * treeSlots+1..treeSlots+groundSlots → 'ground';
 * beyond → 'list'.
 * Returns all gifts in rank order.
 */
export function assignPlaces(
  gifts: Gift[],
  treeSlots: number,
  groundSlots: number,
): RankedGift[] {
  const sorted = [...gifts].sort((a, b) => {
    if (b.hearts !== a.hearts) return b.hearts - a.hearts
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
    return a.id - b.id
  })
  return sorted.map((gift, i) => {
    const rank = i + 1
    const place: Place =
      rank <= treeSlots ? 'tree'
      : rank <= treeSlots + groundSlots ? 'ground'
      : 'list'
    return { ...gift, rank, place }
  })
}
