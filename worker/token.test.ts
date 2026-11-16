// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { newToken, isToken } from './token.ts'

describe('newToken', () => {
  it('returns exactly 16 characters', () => {
    expect(newToken()).toHaveLength(16)
  })

  it('uses only [a-z0-9] characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(newToken()).toMatch(/^[a-z0-9]{16}$/)
    }
  })

  it('two successive calls return different values', () => {
    // Passes statistically; collision probability is 1 / 36^16 ≈ 0
    expect(newToken()).not.toBe(newToken())
  })

  it('50 consecutive calls are all unique', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newToken()))
    expect(tokens.size).toBe(50)
  })
})

describe('isToken', () => {
  it('accepts a valid 16-char lowercase-alphanumeric string', () => {
    expect(isToken('abc123def456gh78')).toBe(true)
    expect(isToken('0000000000000000')).toBe(true)
    expect(isToken('zzzzzzzzzzzzzzzz')).toBe(true)
  })

  it.each([
    ['too short',      'abc123def456gh7'],
    ['too long',       'abc123def456gh789'],
    ['uppercase',      'ABC123DEF456GH78'],
    ['special chars',  'abc123def456gh7!'],
    ['empty string',   ''],
    ['spaces',         'abc123def456gh 8'],
    ['dots',           'abc123def456.h78'],
  ])('rejects %s', (_, value) => {
    expect(isToken(value)).toBe(false)
  })
})
