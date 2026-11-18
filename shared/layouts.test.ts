// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { SLOTS, LAYOUTS, DEFAULT_LAYOUT, isLayout, isSlot } from './layouts.ts'

describe('SLOTS', () => {
  it('has exactly 2 entries', () => {
    expect(SLOTS).toHaveLength(2)
  })

  it('contains background and banner', () => {
    expect(SLOTS).toContain('background')
    expect(SLOTS).toContain('banner')
  })

  it('does NOT contain photo (slot removed)', () => {
    expect(SLOTS).not.toContain('photo')
  })

  it('entries are strings', () => {
    for (const s of SLOTS) expect(typeof s).toBe('string')
  })
})

describe('LAYOUTS', () => {
  it('has exactly 5 entries', () => {
    expect(LAYOUTS).toHaveLength(5)
  })

  it('contains the five required layout ids', () => {
    const ids = LAYOUTS.map((l) => l.id)
    expect(ids).toContain('classic')
    expect(ids).toContain('lotus')
    expect(ids).toContain('spring')
    expect(ids).toContain('night')
    expect(ids).toContain('minimal')
  })

  it('assigns correct Vietnamese names', () => {
    const byId = Object.fromEntries(LAYOUTS.map((l) => [l.id, l.name]))
    expect(byId['classic']).toBe('Cổ điển')
    expect(byId['lotus']).toBe('Hoa sen')
    expect(byId['spring']).toBe('Mùa xuân')
    expect(byId['night']).toBe('Đêm sao')
    expect(byId['minimal']).toBe('Tối giản')
  })

  it('every entry has non-empty id and name', () => {
    for (const l of LAYOUTS) {
      expect(l.id.length).toBeGreaterThan(0)
      expect(l.name.length).toBeGreaterThan(0)
    }
  })
})

describe('DEFAULT_LAYOUT', () => {
  it('is "classic"', () => {
    expect(DEFAULT_LAYOUT).toBe('classic')
  })

  it('is a valid layout id', () => {
    expect(isLayout(DEFAULT_LAYOUT)).toBe(true)
  })
})

describe('isLayout', () => {
  it('returns true for each known layout id', () => {
    for (const l of LAYOUTS) {
      expect(isLayout(l.id)).toBe(true)
    }
  })

  it.each([
    ['empty string', ''],
    ['unknown string', 'unknown'],
    ['uppercase classic', 'CLASSIC'],
    ['a slot name', 'background'],
    ['partial match', 'classi'],
  ])('returns false for %s', (_, v) => {
    expect(isLayout(v)).toBe(false)
  })
})

describe('isSlot', () => {
  it('returns true for each known slot', () => {
    for (const s of SLOTS) {
      expect(isSlot(s)).toBe(true)
    }
  })

  it.each([
    ['empty string', ''],
    ['unknown string', 'unknown'],
    ['uppercase BACKGROUND', 'BACKGROUND'],
    ['a layout id', 'classic'],
    ['partial match', 'back'],
    ['photo (removed slot)', 'photo'],
  ])('returns false for %s', (_, v) => {
    expect(isSlot(v)).toBe(false)
  })
})
