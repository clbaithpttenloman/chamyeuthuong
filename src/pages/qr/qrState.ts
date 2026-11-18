/**
 * src/pages/qr/qrState.ts — pure helpers for the QR page local state.
 */
import type { PublicCard } from '../../../shared/api.ts'

/**
 * Pick a random card from the list, optionally excluding one by card id.
 *
 * Rules:
 *   - Returns null if cards is empty.
 *   - Returns the only card if length === 1 (even if it matches excludeId).
 *   - Excludes the matching card when alternatives exist.
 */
export function pickRandom(cards: PublicCard[], excludeId?: string | null): PublicCard | null {
  if (cards.length === 0) return null
  if (cards.length === 1) return cards[0]

  const eligible = excludeId
    ? cards.filter((c) => c.publicId !== excludeId)
    : cards

  // Fallback: all alternatives were excluded (shouldn't happen with length > 1 + single excludeId)
  const pool = eligible.length > 0 ? eligible : cards

  return pool[Math.floor(Math.random() * pool.length)]
}
