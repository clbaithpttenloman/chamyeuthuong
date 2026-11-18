// Tests for shared/text.ts
import { describe, it, expect } from 'vitest'
import {
  hasControlCharsMultiline,
  hasControlCharsSingleLine,
  hasLoneSurrogate,
} from './text.ts'

// ---- hasControlCharsMultiline ----

describe('hasControlCharsMultiline — allowed characters', () => {
  it('plain ASCII text → false', () => {
    expect(hasControlCharsMultiline('Hello world')).toBe(false)
  })

  it('Vietnamese text → false', () => {
    expect(hasControlCharsMultiline('Chúc mừng ngày Nhà giáo!')).toBe(false)
  })

  it('newline \\n is allowed → false', () => {
    expect(hasControlCharsMultiline('line1\nline2')).toBe(false)
  })

  it('emoji with ZWJ allowed → false', () => {
    // 👩‍🏫 uses zero-width joiner (U+200D)
    expect(hasControlCharsMultiline('👩‍🏫')).toBe(false)
  })

  it('emoji with variation selector allowed → false', () => {
    // ❤️ uses variation selector U+FE0F
    expect(hasControlCharsMultiline('❤️')).toBe(false)
  })
})

describe('hasControlCharsMultiline — rejected characters', () => {
  it('null byte \\x00 → true', () => {
    expect(hasControlCharsMultiline('\x00')).toBe(true)
  })

  it('tab \\x09 → true', () => {
    expect(hasControlCharsMultiline('\x09')).toBe(true)
  })

  it('carriage return \\x0D → true', () => {
    expect(hasControlCharsMultiline('\x0D')).toBe(true)
  })

  it('escape \\x1B → true', () => {
    expect(hasControlCharsMultiline('\x1B')).toBe(true)
  })

  it('delete \\x7F → true', () => {
    expect(hasControlCharsMultiline('\x7F')).toBe(true)
  })

  it('soft hyphen U+00AD → true', () => {
    expect(hasControlCharsMultiline('\u00AD')).toBe(true)
  })

  it('zero-width space U+200B → true', () => {
    expect(hasControlCharsMultiline('\u200B')).toBe(true)
  })

  it('zero-width no-break space U+FEFF (BOM) → true', () => {
    expect(hasControlCharsMultiline('\uFEFF')).toBe(true)
  })

  it('left-to-right override U+202D → true', () => {
    expect(hasControlCharsMultiline('\u202D')).toBe(true)
  })

  it('paragraph separator U+2029 → true', () => {
    expect(hasControlCharsMultiline('\u2029')).toBe(true)
  })
})

// ---- hasControlCharsSingleLine ----

describe('hasControlCharsSingleLine — allowed characters', () => {
  it('plain ASCII text → false', () => {
    expect(hasControlCharsSingleLine('Nguyễn Văn A')).toBe(false)
  })

  it('Vietnamese text → false', () => {
    expect(hasControlCharsSingleLine('CLB AI - THPT Ten Lơ Man')).toBe(false)
  })
})

describe('hasControlCharsSingleLine — rejected characters', () => {
  it('newline \\n is REJECTED → true', () => {
    expect(hasControlCharsSingleLine('line1\nline2')).toBe(true)
  })

  it('tab \\x09 → true', () => {
    expect(hasControlCharsSingleLine('\x09')).toBe(true)
  })

  it('carriage return \\r → true', () => {
    expect(hasControlCharsSingleLine('\r')).toBe(true)
  })

  it('null byte → true', () => {
    expect(hasControlCharsSingleLine('\x00')).toBe(true)
  })

  it('soft hyphen U+00AD → true', () => {
    expect(hasControlCharsSingleLine('\u00AD')).toBe(true)
  })

  it('zero-width space U+200B → true', () => {
    expect(hasControlCharsSingleLine('\u200B')).toBe(true)
  })

  it('BOM U+FEFF → true', () => {
    expect(hasControlCharsSingleLine('\uFEFF')).toBe(true)
  })
})

// ---- hasLoneSurrogate ----

describe('hasLoneSurrogate', () => {
  it('plain text → false', () => {
    expect(hasLoneSurrogate('Hello')).toBe(false)
  })

  it('Vietnamese text → false', () => {
    expect(hasLoneSurrogate('Vũ Ngọc Diệp')).toBe(false)
  })

  it('valid surrogate pair (emoji) → false', () => {
    expect(hasLoneSurrogate('😀')).toBe(false)
  })

  it('lone high surrogate → true', () => {
    expect(hasLoneSurrogate('\uD800')).toBe(true)
  })

  it('lone low surrogate → true', () => {
    expect(hasLoneSurrogate('\uDC00')).toBe(true)
  })

  it('valid pair followed by lone high surrogate → true', () => {
    expect(hasLoneSurrogate('😀\uD800')).toBe(true)
  })
})
