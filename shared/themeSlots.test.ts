// @vitest-environment node
/**
 * Theme slot specs and upload validation (Phase 3, FR-14..FR-17, AC-7).
 * Static-images cut: animated GIF/WebP, sprite grids and APNG are refused.
 */
import { describe, it, expect } from 'vitest'
import { THEME_SLOTS, getSlotSpec, validateThemeImage, type ThemeImageInfo } from './themeSlots.ts'

const base: ThemeImageInfo = {
  mime: 'image/png',
  size: 100_000,
  width: 256,
  height: 256,
  hasAlpha: true,
  animated: false,
}

describe('THEME_SLOTS', () => {
  it('lists the static slots of the gift tree (ornaments, boxes, sky, ground, tree, star)', () => {
    const names = THEME_SLOTS.map((s) => s.slot)
    expect(names).toEqual(expect.arrayContaining([
      'sky_portrait', 'sky_landscape', 'layer_ground', 'tree', 'star',
      'ornament_1', 'ornament_6', 'box_1_closed', 'box_6_closed',
    ]))
    expect(names).not.toContain('layer_far')
    expect(names.some((n) => n.endsWith('_open'))).toBe(false)
  })

  it('every slot max size is ≤ 1 MB and the sum of maxima is under the 15 MB campaign cap', () => {
    for (const s of THEME_SLOTS) expect(s.maxBytes).toBeLessThanOrEqual(1_048_576)
    const total = THEME_SLOTS.reduce((n, s) => n + s.maxBytes, 0)
    expect(total).toBeLessThan(15_728_640)
  })

  it('getSlotSpec returns undefined for an unknown slot', () => {
    expect(getSlotSpec('nope')).toBeUndefined()
    expect(getSlotSpec('tree')?.width).toBe(1200)
  })
})

describe('validateThemeImage — AC-7 ornament example', () => {
  it('300×280 JPEG for the 256×256 transparent ornament → both rules named with the actual values', () => {
    const r = validateThemeImage(getSlotSpec('ornament_1')!, {
      ...base, mime: 'image/jpeg', width: 300, height: 280, hasAlpha: false,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors).toContain('Kích thước phải 256×256 (ảnh của bạn 300×280)')
      expect(r.errors).toContain('Ảnh phải có nền trong suốt')
    }
  })

  it('a valid 256×256 transparent PNG is accepted', () => {
    expect(validateThemeImage(getSlotSpec('ornament_1')!, base)).toEqual({ ok: true })
  })
})

describe('validateThemeImage — other rules', () => {
  it('file over the slot maximum is refused and names the limit and the actual size', () => {
    const spec = getSlotSpec('ornament_1')!
    const r = validateThemeImage(spec, { ...base, size: spec.maxBytes + 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toContain(`${Math.round(spec.maxBytes / 1024)} KB`)
  })

  it('sky slots must not be transparent (JPEG never is)', () => {
    const r = validateThemeImage(getSlotSpec('sky_portrait')!, {
      ...base, mime: 'image/png', width: 1080, height: 1920, hasAlpha: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/không được có nền trong suốt/)
  })

  it('animated files are refused in the static cut', () => {
    const r = validateThemeImage(getSlotSpec('star')!, { ...base, mime: 'image/gif', animated: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/Ảnh động chưa được hỗ trợ/)
  })

  it('formats outside the slot list are refused (SVG is never accepted)', () => {
    const r = validateThemeImage(getSlotSpec('tree')!, { ...base, mime: 'image/svg+xml', width: 1200, height: 1600 })
    expect(r.ok).toBe(false)
  })
})
