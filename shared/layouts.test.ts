// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { SLOTS, LAYOUTS, DEFAULT_LAYOUT, LEGACY_LAYOUTS, isLayout, isSlot, resolveLayout } from './layouts.ts'

describe('SLOTS', () => {
  it('has only the background slot (banner and photo removed)', () => {
    expect(SLOTS).toEqual(['background'])
  })
})

describe('isSlot', () => {
  it('accepts background only', () => {
    expect(isSlot('background')).toBe(true)
    for (const s of ['banner', 'photo', 'Background', '', '__proto__', 'constructor']) expect(isSlot(s)).toBe(false)
  })
})

describe('LAYOUTS', () => {
  it('has the six physical-card layouts in order', () => {
    expect(LAYOUTS.map((l) => l.id)).toEqual(['doc-giua', 'doc-duoi', 'doc-tren', 'ngang-giua', 'ngang-phai', 'ngang-trai'])
  })

  it('Vietnamese names', () => {
    expect(LAYOUTS.map((l) => l.name)).toEqual([
      'Dọc – giữa', 'Dọc – nửa dưới', 'Dọc – nửa trên', 'Ngang – giữa', 'Ngang – nửa phải', 'Ngang – nửa trái',
    ])
  })

  it('"doc" layouts are portrait (3:4), "ngang" layouts are landscape (4:3)', () => {
    for (const l of LAYOUTS) expect(l.ratio).toBe(l.id.startsWith('doc') ? 'portrait' : 'landscape')
  })

  it('every writing zone lies inside the card and is not tiny', () => {
    for (const { zone: z } of LAYOUTS) {
      expect(z.x).toBeGreaterThanOrEqual(0)
      expect(z.y).toBeGreaterThanOrEqual(0)
      expect(z.x + z.w).toBeLessThanOrEqual(100)
      expect(z.y + z.h).toBeLessThanOrEqual(100)
      expect(z.w).toBeGreaterThanOrEqual(40)
      expect(z.h).toBeGreaterThanOrEqual(40)
    }
  })
})

describe('DEFAULT_LAYOUT', () => {
  it('is doc-giua and valid', () => {
    expect(DEFAULT_LAYOUT).toBe('doc-giua')
    expect(isLayout(DEFAULT_LAYOUT)).toBe(true)
  })
})

describe('isLayout (write validation — new ids only)', () => {
  it('accepts the six ids', () => { for (const l of LAYOUTS) expect(isLayout(l.id)).toBe(true) })
  it('rejects legacy ids, unknown strings and prototype keys', () => {
    for (const s of ['classic', 'lotus', 'spring', 'night', 'minimal', '', 'DOC-GIUA', '__proto__', 'constructor', 'toString']) {
      expect(isLayout(s)).toBe(false)
    }
  })
})

describe('resolveLayout (read — legacy ids mapped, unknown → default)', () => {
  it('new ids resolve to themselves', () => { for (const l of LAYOUTS) expect(resolveLayout(l.id).id).toBe(l.id) })
  it('legacy portrait themes → doc-giua; night → ngang-giua', () => {
    for (const id of ['classic', 'lotus', 'spring', 'minimal']) expect(resolveLayout(id).id).toBe('doc-giua')
    expect(resolveLayout('night').id).toBe('ngang-giua')
    expect(Object.keys(LEGACY_LAYOUTS).sort()).toEqual(['classic', 'lotus', 'minimal', 'night', 'spring'])
  })
  it('unknown, empty, non-string and prototype keys → default layout object', () => {
    for (const v of ['x', '', null, undefined, 3, '__proto__', 'constructor']) expect(resolveLayout(v).id).toBe('doc-giua')
  })
})
