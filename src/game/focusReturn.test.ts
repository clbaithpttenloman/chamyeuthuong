import { describe, it, expect } from 'vitest'
import { focusGiftButton } from './focusReturn.ts'

type El = { focused: boolean; focus(): void }
const el = (): El => ({ focused: false, focus() { this.focused = true } })

describe('focusGiftButton — return focus after the gift sheet closes', () => {
  it('focuses the button of the gift that was shown last', () => {
    const btn = el()
    const root = { querySelector: (sel: string) => (sel === '[data-public-id="abcdefgh12345678"]' ? btn : null) }
    expect(focusGiftButton(root, 'abcdefgh12345678', null)).toBe(true)
    expect(btn.focused).toBe(true)
  })

  it('falls back when that gift is not on the tree (opened from a list)', () => {
    const fallback = el()
    const root = { querySelector: () => null }
    expect(focusGiftButton(root, 'abcdefgh12345678', fallback)).toBe(false)
    expect(fallback.focused).toBe(true)
  })

  it('ignores ids that are not public-id shaped (no selector injection)', () => {
    const seen: string[] = []
    const root = { querySelector: (sel: string) => { seen.push(sel); return null } }
    focusGiftButton(root, 'x"] , body [a="', null)
    expect(seen).toEqual([])
  })
})
