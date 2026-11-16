// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { fillWish } from './wish.ts'

describe('fillWish — basic substitution', () => {
  it('replaces {tên} with name', () => {
    expect(fillWish('Kính gửi {tên}', { name: 'Nguyễn Văn A' })).toBe('Kính gửi Nguyễn Văn A')
  })

  it('replaces {môn} with subject', () => {
    expect(fillWish('Thầy dạy {môn} giỏi', { name: 'T', subject: 'Toán' })).toBe('Thầy dạy Toán giỏi')
  })

  it('replaces all occurrences of {tên}', () => {
    expect(fillWish('{tên} - {tên} - {tên}', { name: 'A' })).toBe('A - A - A')
  })

  it('replaces all occurrences of {môn}', () => {
    expect(fillWish('{môn} và {môn}', { name: 'A', subject: 'Lý' })).toBe('Lý và Lý')
  })

  it('replaces both placeholders in one call', () => {
    expect(
      fillWish('Thầy {tên} dạy {môn} rất giỏi!', { name: 'Nam', subject: 'Hóa' }),
    ).toBe('Thầy Nam dạy Hóa rất giỏi!')
  })

  it('no placeholders: body returned unchanged', () => {
    expect(fillWish('Chúc mừng ngày Nhà giáo!', { name: 'A', subject: 'B' })).toBe(
      'Chúc mừng ngày Nhà giáo!',
    )
  })
})

describe('fillWish — case-insensitive matching', () => {
  it('{TÊN} matches', () => {
    expect(fillWish('{TÊN}', { name: 'B' })).toBe('B')
  })

  it('{Tên} matches', () => {
    expect(fillWish('{Tên}', { name: 'B' })).toBe('B')
  })

  it('mixed case {tÊn} matches', () => {
    expect(fillWish('{tÊn}', { name: 'B' })).toBe('B')
  })

  it('{MÔN} matches', () => {
    expect(fillWish('{MÔN}', { name: 'A', subject: 'Hóa' })).toBe('Hóa')
  })

  it('{Môn} matches', () => {
    expect(fillWish('{Môn}', { name: 'A', subject: 'Hóa' })).toBe('Hóa')
  })

  it('all three case variants together', () => {
    expect(fillWish('{TÊN} {Tên} {tên}', { name: 'C' })).toBe('C C C')
    expect(fillWish('{MÔN} {Môn} {môn}', { name: 'A', subject: 'Lý' })).toBe('Lý Lý Lý')
  })
})

describe('fillWish — missing subject collapses spaces', () => {
  it('missing subject → empty string, double space collapses', () => {
    // "Thầy  giỏi" becomes "Thầy giỏi"
    expect(fillWish('Thầy {môn} giỏi', { name: 'A' })).toBe('Thầy giỏi')
  })

  it('subject at start collapses leading space (double-space at start)', () => {
    // " giỏi" → " giỏi" — single space at start, not double, so no collapse needed
    expect(fillWish('{môn} giỏi', { name: 'A' })).toBe(' giỏi')
  })

  it('subject at end leaves a single trailing space (single space is not collapsed)', () => {
    // Double-space collapse only triggers when {môn} had a space on both sides.
    // "Cô {môn}" → "Cô " — one trailing space remains after empty substitution.
    expect(fillWish('Cô {môn}', { name: 'A' })).toBe('Cô ')
  })

  it('double space around empty subject in the middle collapses', () => {
    // "Cô  dạy" ← "Cô {môn} dạy" with empty subject
    expect(fillWish('Cô {môn} dạy', { name: 'A' })).toBe('Cô dạy')
  })

  it('explicit empty subject behaves same as missing', () => {
    expect(fillWish('Thầy {môn} giỏi', { name: 'A', subject: '' })).toBe('Thầy giỏi')
  })

  it('non-empty subject: no collapse', () => {
    expect(fillWish('Thầy {môn} giỏi', { name: 'A', subject: 'Lý' })).toBe('Thầy Lý giỏi')
  })
})

describe('fillWish — special characters in replacements (no regex injection)', () => {
  it('$ in name is treated literally', () => {
    expect(fillWish('{tên}', { name: '$1' })).toBe('$1')
  })

  it('$& in name is treated literally', () => {
    expect(fillWish('{tên}', { name: '$&' })).toBe('$&')
  })

  it('$$ in name is treated literally', () => {
    expect(fillWish('{tên}', { name: '$$' })).toBe('$$')
  })

  it('$ in subject is treated literally', () => {
    expect(fillWish('{môn}', { name: 'A', subject: '$2' })).toBe('$2')
  })

  it('empty name inserts empty string', () => {
    expect(fillWish('Chào {tên}!', { name: '' })).toBe('Chào !')
  })

  it('name with braces does not create extra placeholders', () => {
    expect(fillWish('{tên}', { name: '{tên}' })).toBe('{tên}')
  })
})
