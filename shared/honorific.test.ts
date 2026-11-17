// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { TITLES, isTitle } from './honorific.ts'

describe('TITLES', () => {
  it('is exactly [Thầy, Cô]', () => {
    expect(TITLES).toEqual(['Thầy', 'Cô'])
  })

  it('has exactly 2 entries', () => {
    expect(TITLES).toHaveLength(2)
  })
})

describe('isTitle', () => {
  it('Thầy → true', () => {
    expect(isTitle('Thầy')).toBe(true)
  })

  it('Cô → true', () => {
    expect(isTitle('Cô')).toBe(true)
  })

  it('lowercase thầy → false (case-sensitive)', () => {
    expect(isTitle('thầy')).toBe(false)
  })

  it('lowercase cô → false (case-sensitive)', () => {
    expect(isTitle('cô')).toBe(false)
  })

  it('all-caps THẦY → false', () => {
    expect(isTitle('THẦY')).toBe(false)
  })

  it('no-diacritic Thay → false', () => {
    expect(isTitle('Thay')).toBe(false)
  })

  it('no-diacritic Co → false', () => {
    expect(isTitle('Co')).toBe(false)
  })

  it('empty string → false', () => {
    expect(isTitle('')).toBe(false)
  })

  it('arbitrary string → false', () => {
    expect(isTitle('Giáo viên')).toBe(false)
  })

  it('Thầy with trailing space → false (exact match only)', () => {
    expect(isTitle('Thầy ')).toBe(false)
  })
})
