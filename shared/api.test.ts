// Tests for shared/api.ts — formatFrom and constants.
import { describe, it, expect } from 'vitest'
import {
  formatFrom,
  MAX_MESSAGE, MAX_FROM_NAME, MAX_FROM_CLASS, MAX_NEWLINES,
  PENDING_CAP, PENDING_CAP_PER_TEACHER, PAGE_SIZE, MAX_REVIEW_IDS,
} from './api.ts'

// ---- formatFrom ----

describe('formatFrom — anonymous or empty name', () => {
  it('anonymous=true, name="", class="" → "Một bạn học sinh"', () => {
    expect(formatFrom({ fromName: '', fromClass: '', anonymous: true })).toBe('Một bạn học sinh')
  })

  it('anonymous=true, name="Nguyễn Văn A", class="" → "Một bạn học sinh" (name ignored)', () => {
    expect(formatFrom({ fromName: 'Nguyễn Văn A', fromClass: '', anonymous: true })).toBe('Một bạn học sinh')
  })

  it('anonymous=true, name="", class="12A1" → "Một bạn học sinh · 12A1"', () => {
    expect(formatFrom({ fromName: '', fromClass: '12A1', anonymous: true })).toBe('Một bạn học sinh · 12A1')
  })

  it('anonymous=true, name="Nguyễn Văn A", class="12A1" → "Một bạn học sinh · 12A1" (name ignored)', () => {
    expect(formatFrom({ fromName: 'Nguyễn Văn A', fromClass: '12A1', anonymous: true })).toBe('Một bạn học sinh · 12A1')
  })

  it('anonymous=false, fromName="" (blank), class="" → "Một bạn học sinh"', () => {
    expect(formatFrom({ fromName: '', fromClass: '', anonymous: false })).toBe('Một bạn học sinh')
  })

  it('anonymous=false, fromName="   " (whitespace only), class="" → "Một bạn học sinh" (trimmed to blank)', () => {
    expect(formatFrom({ fromName: '   ', fromClass: '', anonymous: false })).toBe('Một bạn học sinh')
  })

  it('anonymous=false, fromName="", class="11B2" → "Một bạn học sinh · 11B2"', () => {
    expect(formatFrom({ fromName: '', fromClass: '11B2', anonymous: false })).toBe('Một bạn học sinh · 11B2')
  })
})

describe('formatFrom — named (non-anonymous, non-empty name)', () => {
  it('named, no class → "{name}"', () => {
    expect(formatFrom({ fromName: 'Nguyễn Văn A', fromClass: '', anonymous: false })).toBe('Nguyễn Văn A')
  })

  it('named, with class → "{name} · {class}"', () => {
    expect(formatFrom({ fromName: 'Trần Thị B', fromClass: '12A1', anonymous: false })).toBe('Trần Thị B · 12A1')
  })

  it('name is trimmed before display', () => {
    expect(formatFrom({ fromName: '  Lê Văn C  ', fromClass: '', anonymous: false })).toBe('Lê Văn C')
  })

  it('class is trimmed before display', () => {
    expect(formatFrom({ fromName: 'Lê Văn C', fromClass: '  12A2  ', anonymous: false })).toBe('Lê Văn C · 12A2')
  })

  it('separator is ` · ` (space-middledot-space)', () => {
    const result = formatFrom({ fromName: 'A', fromClass: 'B', anonymous: false })
    expect(result).toContain(' · ')
    // U+00B7 middle dot
    expect(result).toBe('A · B')
  })
})

// ---- Constants ----

describe('API constants', () => {
  it('MAX_MESSAGE = 300', () => expect(MAX_MESSAGE).toBe(300))
  it('MAX_FROM_NAME = 40', () => expect(MAX_FROM_NAME).toBe(40))
  it('MAX_FROM_CLASS = 10', () => expect(MAX_FROM_CLASS).toBe(10))
  it('MAX_NEWLINES = 5', () => expect(MAX_NEWLINES).toBe(5))
  it('PENDING_CAP = 2000', () => expect(PENDING_CAP).toBe(2000))
  it('PENDING_CAP_PER_TEACHER = 200', () => expect(PENDING_CAP_PER_TEACHER).toBe(200))
  it('PAGE_SIZE = 200', () => expect(PAGE_SIZE).toBe(200))
  it('MAX_REVIEW_IDS = 200', () => expect(MAX_REVIEW_IDS).toBe(200))
})
