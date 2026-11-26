// @vitest-environment node
/**
 * Theme slot specs and upload validation (Phase 3, FR-14..FR-17, AC-7): every slot, stills,
 * animated loops, sprite sheets, and the fps declaration.
 */
import { describe, it, expect } from 'vitest'
import { THEME_SLOTS, getSlotSpec, validateThemeImage, spriteCells, type ThemeImageInfo } from './themeSlots.ts'

const base: ThemeImageInfo = {
  mime: 'image/png',
  size: 100_000,
  width: 256,
  height: 256,
  hasAlpha: true,
  animated: false,
}

describe('THEME_SLOTS', () => {
  it('lists every gift-tree slot: stills, loops and sprite sheets', () => {
    const names = THEME_SLOTS.map((s) => s.slot)
    expect(names).toEqual(expect.arrayContaining([
      'sky_portrait', 'sky_landscape', 'layer_far', 'layer_ground', 'tree', 'star', 'overlay_loop',
      'ornament_1', 'ornament_6', 'box_1_closed', 'box_6_closed', 'box_1_open', 'box_6_open',
    ]))
    expect(THEME_SLOTS).toHaveLength(25)
  })

  it('animation kinds: star and overlay loop, box_N_open is a sprite, the rest are stills', () => {
    expect(getSlotSpec('star')?.animation).toBe('loop')
    expect(getSlotSpec('overlay_loop')?.animation).toBe('loop')
    expect(getSlotSpec('box_3_open')?.animation).toBe('sprite')
    expect(getSlotSpec('box_3_open')?.fps).toEqual({ min: 12, max: 30 })
    expect(getSlotSpec('tree')?.animation).toBe('none')
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

  it('a valid 256×256 transparent PNG is accepted, one frame, no fps', () => {
    expect(validateThemeImage(getSlotSpec('ornament_1')!, base)).toEqual({ ok: true, frames: 1, fps: null })
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

  it('formats outside the slot list are refused (SVG is never accepted)', () => {
    const r = validateThemeImage(getSlotSpec('tree')!, { ...base, mime: 'image/svg+xml', width: 1200, height: 1600 })
    expect(r.ok).toBe(false)
  })

  it('APNG is refused in every slot', () => {
    const r = validateThemeImage(getSlotSpec('star')!, { ...base, animated: true, frames: 5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/APNG chưa được hỗ trợ/)
  })
})

describe('validateThemeImage — loops', () => {
  const gif = { ...base, mime: 'image/gif', hasAlpha: true, animated: true }

  it('star accepts an animated GIF of up to 24 frames', () => {
    expect(validateThemeImage(getSlotSpec('star')!, { ...gif, frames: 24 })).toEqual({ ok: true, frames: 24, fps: null })
  })

  it('star refuses 25 frames and names the limit and the actual count', () => {
    const r = validateThemeImage(getSlotSpec('star')!, { ...gif, frames: 25 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toContain('Ảnh động có 25 khung hình, cần từ 1 đến 24 khung')
  })

  it('overlay accepts 30 frames at 540×960 (decoded size inside the 64 MB cap)', () => {
    const spec = getSlotSpec('overlay_loop')!
    expect(validateThemeImage(spec, { ...gif, mime: 'image/webp', width: 540, height: 960, frames: 30, size: 700_000 }).ok).toBe(true)
  })

  it('a still slot refuses animation', () => {
    const r = validateThemeImage(getSlotSpec('tree')!, { ...base, mime: 'image/webp', width: 1200, height: 1600, animated: true, frames: 3 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/Ảnh động chưa được hỗ trợ cho ô này/)
  })
})

describe('validateThemeImage — sprite sheets (box_N_open)', () => {
  const spec = getSlotSpec('box_1_open')!
  const sheet = { ...base, mime: 'image/webp', width: 1024, height: 1536, hasAlpha: true }

  it('spriteCells maps pixel size to cells and rejects non-multiples and sizes over 2048', () => {
    expect(spriteCells(1024, 1536)).toEqual({ cols: 2, rows: 3 })
    expect(spriteCells(1000, 1000)).toBeNull()
    expect(spriteCells(2560, 512)).toBeNull()
  })

  it('a 2×3 sheet with fps 24 → 6 frames at 24 fps', () => {
    expect(validateThemeImage(spec, sheet, 24)).toEqual({ ok: true, frames: 6, fps: 24 })
  })

  it('a 4×4 sheet (16 frames, the maximum) is accepted', () => {
    expect(validateThemeImage(spec, { ...sheet, width: 2048, height: 2048 }, 12).ok).toBe(true)
  })

  it('too few cells (2×2 = 4 frames) is refused and names the actual grid', () => {
    const r = validateThemeImage(spec, { ...sheet, width: 1024, height: 1024 }, 24)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toContain('Lưới phải có 2–4 ô mỗi cạnh và 6–16 khung hình (ảnh của bạn 2×2 ô = 4 khung)')
  })

  it('a size that is not a multiple of 512 is refused with the actual size', () => {
    const r = validateThemeImage(spec, { ...sheet, width: 1000, height: 1536 }, 24)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toContain('bội số 512 px, tối đa 2048×2048 (ảnh của bạn 1000×1536)')
  })

  it('missing fps or fps out of 12–30 is refused', () => {
    for (const fps of [null, 11, 31, 24.5]) {
      const r = validateThemeImage(spec, sheet, fps)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.join(' ')).toContain('Khai báo tốc độ từ 12 đến 30 khung hình/giây (fps)')
    }
  })

  it('an animated file is not a sprite sheet', () => {
    const r = validateThemeImage(spec, { ...sheet, animated: true, frames: 3 }, 24)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toContain('Lưới khung hình phải là ảnh tĩnh')
  })
})
