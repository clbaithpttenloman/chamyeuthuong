import { describe, expect, it } from 'vitest'
import { cards, findCard } from './cards'

describe('cards.json', () => {
  it('has unique ids that are URL-safe and at least 8 characters', () => {
    const ids = cards.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8,}$/)
  })
  it('has non-empty name and message on every card', () => {
    for (const c of cards) {
      expect(c.name.trim()).not.toBe('')
      expect(c.message.trim()).not.toBe('')
    }
  })
  it('findCard returns undefined for an unknown id', () => {
    expect(findCard('nope')).toBeUndefined()
    expect(findCard(cards[0].id)).toBe(cards[0])
  })
})
