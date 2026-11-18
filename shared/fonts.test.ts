// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { FONTS, DEFAULT_FONT, isFont, resolveFont, INKS, DEFAULT_INK, isInkInput, normalizeInk, resolveInk } from './fonts.ts'

describe('FONTS', () => {
  it('has the seven supported fonts, Bút bi first (default)', () => {
    expect(FONTS.map((f) => f.id)).toEqual(['patrick-hand', 'pangolin', 'itim', 'mali', 'charm', 'be-vietnam-pro', 'lora'])
    expect(FONTS.map((f) => f.label)).toEqual(['Bút bi', 'Bút dạ', 'Chữ tròn', 'Nét mảnh', 'Thư pháp', 'Chữ in', 'Có chân'])
    expect(DEFAULT_FONT).toBe('patrick-hand')
  })
  it('each id maps to a fixed CSS stack that starts with its own family and ends generic', () => {
    for (const f of FONTS) {
      expect(f.stack.startsWith(`'${f.family}'`)).toBe(true)
      expect(f.stack).toMatch(/, (sans-serif|serif)$/)
    }
  })
  it('ids fit the DB length CHECK (≤ 32)', () => { for (const f of FONTS) expect(f.id.length).toBeLessThanOrEqual(32) })
  it('Dancing Script is not offered (hook above renders like grave)', () => {
    expect(FONTS.some((f) => /dancing/i.test(f.id))).toBe(false)
  })
})

describe('isFont', () => {
  it('accepts each id exactly', () => { for (const f of FONTS) expect(isFont(f.id)).toBe(true) })
  it('rejects everything else', () => {
    for (const v of ['Patrick Hand', 'PATRICK-HAND', ' patrick-hand', 'dancing-script', '', null, undefined, 1, {}, [], '__proto__', 'constructor', 'toString']) {
      expect(isFont(v)).toBe(false)
    }
  })
})

describe('resolveFont (read fallback)', () => {
  it('known id → that font; anything else → default', () => {
    expect(resolveFont('lora').id).toBe('lora')
    for (const v of ['x', null, undefined, '__proto__', "Arial; color: red"]) expect(resolveFont(v).id).toBe('patrick-hand')
  })
})

describe('INKS', () => {
  it('Xanh (default), Đen, Tím presets', () => {
    expect(INKS).toEqual([
      { value: '#1d3fa6', label: 'Xanh' },
      { value: '#1c1917', label: 'Đen' },
      { value: '#6b21a8', label: 'Tím' },
    ])
    expect(DEFAULT_INK).toBe('#1d3fa6')
  })
})

describe('isInkInput (submit validation on the raw string)', () => {
  it('accepts #rrggbb in either case', () => {
    for (const v of ['#1d3fa6', '#ABCDEF', '#000000', '#ffffff', '#aBc123']) expect(isInkInput(v)).toBe(true)
  })
  it('rejects CSS injection, other formats, whitespace, trailing newline and non-strings', () => {
    for (const v of ['red', '#fff', '#12345', '#1234567', '1d3fa6', '#gggggg', '#aabbcc\n', ' #aabbcc', '#aabbcc ',
      'red;background:url(x)', '#aabbcc;x:y', 'rgb(0,0,0)', '#\u212Aabbcc'.slice(0, 7), '', null, undefined, 0x1d3fa6, ['#aabbcc'], {}]) {
      expect(isInkInput(v)).toBe(false)
    }
  })
})

describe('normalizeInk', () => {
  it('lowercases a valid input', () => expect(normalizeInk('#ABCDEF')).toBe('#abcdef'))
})

describe('resolveInk (read fallback; only lowercase #rrggbb reaches a style)', () => {
  it('stored lowercase value → itself', () => expect(resolveInk('#6b21a8')).toBe('#6b21a8'))
  it('anything else → default ink', () => {
    for (const v of ['#ABCDEF', 'red', 'red;x:y', '', null, undefined, '#aabbcc\n']) expect(resolveInk(v)).toBe('#1d3fa6')
  })
})
