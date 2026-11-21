// @vitest-environment node
/**
 * Tests for the pure parts of dialogFocus.ts
 * No DOM / React / JSDOM required — uses fake element-like objects.
 */
import { describe, it, expect } from 'vitest'
import { tabNext, dialogStackPush, dialogStackPop, dialogStackTop } from './dialogFocus.ts'

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

// ── dialogStackPush ───────────────────────────────────────────────────────────

describe('dialogStackPush', () => {
  const a = Symbol('a')
  const b = Symbol('b')

  it('appends to empty stack', () => {
    expect(dialogStackPush([], a)).toEqual([a])
  })

  it('appends to non-empty stack', () => {
    expect(dialogStackPush([a], b)).toEqual([a, b])
  })

  it('original array is unchanged', () => {
    const orig: symbol[] = []
    dialogStackPush(orig, a)
    expect(orig).toHaveLength(0)
  })

  it('top of returned stack is the pushed entry', () => {
    const result = dialogStackPush([a], b)
    expect(result[result.length - 1]).toBe(b)
  })
})

// ── dialogStackPop ────────────────────────────────────────────────────────────

describe('dialogStackPop', () => {
  const a = Symbol('a')
  const b = Symbol('b')
  const c = Symbol('c')

  it('removes the entry', () => {
    expect(dialogStackPop([a, b], b)).toEqual([a])
  })

  it('returns same reference when entry not found', () => {
    const stack: readonly symbol[] = [a]
    expect(dialogStackPop(stack, b)).toBe(stack)
  })

  it('removes only the last occurrence', () => {
    const result = dialogStackPop([a, b, a], a)
    expect(result).toEqual([a, b])
  })

  it('removes from single-element stack', () => {
    expect(dialogStackPop([a], a)).toEqual([])
  })

  it('no-op on empty stack', () => {
    const stack: symbol[] = []
    expect(dialogStackPop(stack, a)).toBe(stack)
  })

  it('original array is unchanged', () => {
    const orig = [a, b, c]
    dialogStackPop(orig, b)
    expect(orig).toHaveLength(3)
  })
})

// ── dialogStackTop ────────────────────────────────────────────────────────────

describe('dialogStackTop', () => {
  const a = Symbol('a')
  const b = Symbol('b')

  it('returns undefined for empty stack', () => {
    expect(dialogStackTop([])).toBeUndefined()
  })

  it('returns the last entry', () => {
    expect(dialogStackTop([a, b])).toBe(b)
  })

  it('returns the only entry for single-element stack', () => {
    expect(dialogStackTop([a])).toBe(a)
  })
})

// ── push/pop/top round-trip ───────────────────────────────────────────────────

describe('dialogStack round-trip', () => {
  const a = Symbol('a')
  const b = Symbol('b')
  const c = Symbol('c')

  it('push, push, top → last pushed', () => {
    let s: readonly symbol[] = []
    s = dialogStackPush(s, a)
    s = dialogStackPush(s, b)
    expect(dialogStackTop(s)).toBe(b)
  })

  it('push, push, pop last → top is first', () => {
    let s: readonly symbol[] = []
    s = dialogStackPush(s, a)
    s = dialogStackPush(s, b)
    s = dialogStackPop(s, b)
    expect(dialogStackTop(s)).toBe(a)
  })

  it('pop the topmost dialog (remove-on-unmount) leaves the one beneath', () => {
    let s: readonly symbol[] = []
    s = dialogStackPush(s, a)   // base dialog
    s = dialogStackPush(s, b)   // sign-in dialog on top
    s = dialogStackPush(s, c)   // another layer
    s = dialogStackPop(s, c)    // c closes
    s = dialogStackPop(s, b)    // b closes
    expect(dialogStackTop(s)).toBe(a)
    expect(s).toHaveLength(1)
  })
})
