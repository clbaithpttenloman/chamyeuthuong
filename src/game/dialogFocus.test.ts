// @vitest-environment node
/**
 * Tests for the pure parts of dialogFocus.ts
 * No DOM / React / JSDOM required — uses fake element-like objects.
 */
import { describe, it, expect } from 'vitest'
import { tabNext } from './dialogFocus.ts'

// Minimal fake element: only identity matters for tabNext
const el = (id: string) => ({ id } as unknown as Element)

// ── tabNext ───────────────────────────────────────────────────────────────────

describe('tabNext — forward Tab wrapping', () => {
  it('returns null when list is empty', () => {
    const container = el('container')
    expect(tabNext([], null, false, container)).toBeNull()
  })

  it('wraps from last to first on Tab', () => {
    const a = el('a')
    const b = el('b')
    const c = el('c')
    const container = el('container')
    expect(tabNext([a, b, c], c, false, container)).toBe(a)
  })

  it('returns null for Tab from non-last element (normal browser Tab)', () => {
    const a = el('a')
    const b = el('b')
    const c = el('c')
    const container = el('container')
    expect(tabNext([a, b, c], a, false, container)).toBeNull()
    expect(tabNext([a, b, c], b, false, container)).toBeNull()
  })

  it('returns null for Tab when active is not in the list', () => {
    const a = el('a')
    const b = el('b')
    const other = el('other')
    const container = el('container')
    expect(tabNext([a, b], other, false, container)).toBeNull()
  })

  it('wraps from last to first for a single-element list', () => {
    const a = el('a')
    const container = el('container')
    expect(tabNext([a], a, false, container)).toBe(a)
  })
})

describe('tabNext — backward Shift+Tab wrapping', () => {
  it('wraps from first to last on Shift+Tab', () => {
    const a = el('a')
    const b = el('b')
    const c = el('c')
    const container = el('container')
    expect(tabNext([a, b, c], a, true, container)).toBe(c)
  })

  it('wraps from container to last on Shift+Tab', () => {
    const a = el('a')
    const b = el('b')
    const container = el('container')
    expect(tabNext([a, b], container, true, container)).toBe(b)
  })

  it('returns null for Shift+Tab from non-first element', () => {
    const a = el('a')
    const b = el('b')
    const c = el('c')
    const container = el('container')
    expect(tabNext([a, b, c], b, true, container)).toBeNull()
    expect(tabNext([a, b, c], c, true, container)).toBeNull()
  })

  it('wraps from first to last for a single-element list', () => {
    const a = el('a')
    const container = el('container')
    expect(tabNext([a], a, true, container)).toBe(a)
  })
})

describe('tabNext — active is null', () => {
  it('returns null for forward Tab when active is null', () => {
    const a = el('a')
    const container = el('container')
    expect(tabNext([a], null, false, container)).toBeNull()
  })

  it('returns null for Shift+Tab when active is null', () => {
    const a = el('a')
    const container = el('container')
    expect(tabNext([a], null, true, container)).toBeNull()
  })
})

// ── Semantic invariants ───────────────────────────────────────────────────────

describe('tabNext — invariants', () => {
  it('return value is always first or last (or null)', () => {
    const a = el('a')
    const b = el('b')
    const c = el('c')
    const container = el('container')
    const inputs = [
      { active: a, shiftKey: false },
      { active: b, shiftKey: false },
      { active: c, shiftKey: false },
      { active: a, shiftKey: true },
      { active: b, shiftKey: true },
      { active: c, shiftKey: true },
      { active: container, shiftKey: false },
      { active: container, shiftKey: true },
      { active: null, shiftKey: false },
      { active: null, shiftKey: true },
    ]
    for (const { active, shiftKey } of inputs) {
      const result = tabNext([a, b, c], active, shiftKey, container)
      if (result !== null) {
        expect([a, c]).toContain(result)
      }
    }
  })
})
