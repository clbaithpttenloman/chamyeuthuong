// @vitest-environment node
/**
 * Tests for shared/gift.ts — validateGiftText().
 * RED phase: will fail until shared/gift.ts is created.
 */
import { describe, it, expect } from 'vitest'
import {
  validateGiftText,
  MAX_GIFT_MESSAGE,
  MAX_GIFT_NICKNAME,
  MAX_GIFT_CLASSNAME,
} from './gift.ts'

function valid(overrides: Partial<{ message: string; nickname: string; className: string }> = {}) {
  return {
    message: 'Chúc mừng Giáng sinh!',
    nickname: 'Học sinh',
    className: '11A',
    ...overrides,
  }
}

describe('validateGiftText — exports', () => {
  it('exports MAX_GIFT_MESSAGE = 300', () => { expect(MAX_GIFT_MESSAGE).toBe(300) })
  it('exports MAX_GIFT_NICKNAME = 30', () => { expect(MAX_GIFT_NICKNAME).toBe(30) })
  it('exports MAX_GIFT_CLASSNAME = 10', () => { expect(MAX_GIFT_CLASSNAME).toBe(10) })
})

describe('validateGiftText — valid input', () => {
  it('valid input → { ok: true, value }', () => {
    const r = validateGiftText(valid())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.message).toBe('Chúc mừng Giáng sinh!')
      expect(r.value.nickname).toBe('Học sinh')
      expect(r.value.className).toBe('11A')
    }
  })

  it('empty className is valid (optional field)', () => {
    const r = validateGiftText(valid({ className: '' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.className).toBe('')
  })

  it('NFC normalises message', () => {
    // Compose precomposed "é" from "e" + combining accent (NFD form)
    const nfd = '\u0065\u0301' // e + combining acute accent → é (NFC)
    const r = validateGiftText(valid({ message: nfd }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.message).toBe('\u00E9') // NFC é
  })

  it('trims leading/trailing whitespace from message', () => {
    const r = validateGiftText(valid({ message: '  Hello  ' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.message).toBe('Hello')
  })

  it('trims leading/trailing whitespace from nickname', () => {
    const r = validateGiftText(valid({ nickname: '  Nick  ' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.nickname).toBe('Nick')
  })

  it('trims leading/trailing whitespace from className', () => {
    const r = validateGiftText(valid({ className: '  11A  ' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.className).toBe('11A')
  })

  it('message with \\n is valid (multiline allowed)', () => {
    const r = validateGiftText(valid({ message: 'Line 1\nLine 2' }))
    expect(r.ok).toBe(true)
  })

  it('exactly MAX_GIFT_MESSAGE code points → valid', () => {
    const r = validateGiftText(valid({ message: 'a'.repeat(MAX_GIFT_MESSAGE) }))
    expect(r.ok).toBe(true)
  })

  it('exactly MAX_GIFT_NICKNAME code points → valid', () => {
    const r = validateGiftText(valid({ nickname: 'n'.repeat(MAX_GIFT_NICKNAME) }))
    expect(r.ok).toBe(true)
  })

  it('exactly MAX_GIFT_CLASSNAME code points → valid', () => {
    const r = validateGiftText(valid({ className: 'c'.repeat(MAX_GIFT_CLASSNAME) }))
    expect(r.ok).toBe(true)
  })
})

describe('validateGiftText — message failures', () => {
  it('empty message → { ok: false, field: message }', () => {
    const r = validateGiftText(valid({ message: '' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('message')
  })

  it('whitespace-only message → { ok: false, field: message } (trimmed to empty)', () => {
    const r = validateGiftText(valid({ message: '   ' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('message')
  })

  it('message > MAX_GIFT_MESSAGE code points → { ok: false, field: message }', () => {
    const r = validateGiftText(valid({ message: 'a'.repeat(MAX_GIFT_MESSAGE + 1) }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('message')
  })

  it('code-point length (not UTF-16): 300 emoji chars (each 2 UTF-16) → valid', () => {
    // 🎄 is U+1F384 = 2 UTF-16 code units but 1 code point
    const msg = '🎄'.repeat(MAX_GIFT_MESSAGE)  // 300 code points, 600 UTF-16 units
    const r = validateGiftText(valid({ message: msg }))
    expect(r.ok).toBe(true)
  })

  it('301 emoji chars → { ok: false, field: message }', () => {
    const msg = '🎄'.repeat(MAX_GIFT_MESSAGE + 1)  // 301 code points
    const r = validateGiftText(valid({ message: msg }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('message')
  })

  it('message with bidi-override (U+202E) → { ok: false, field: message }', () => {
    const r = validateGiftText(valid({ message: 'Hello\u202Eworld' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('message')
  })

  it('message with zero-width space (U+200B) → { ok: false, field: message }', () => {
    const r = validateGiftText(valid({ message: 'Hello\u200Bworld' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('message')
  })

  it('message with control char U+0001 → { ok: false, field: message }', () => {
    const r = validateGiftText(valid({ message: 'Hello\x01world' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('message')
  })

  it('message with lone surrogate → { ok: false, field: message }', () => {
    const r = validateGiftText(valid({ message: 'Hello\uD800world' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('message')
  })
})

describe('validateGiftText — nickname failures', () => {
  it('empty nickname → { ok: false, field: nickname }', () => {
    const r = validateGiftText(valid({ nickname: '' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('nickname')
  })

  it('whitespace-only nickname → { ok: false, field: nickname }', () => {
    const r = validateGiftText(valid({ nickname: '   ' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('nickname')
  })

  it('nickname > MAX_GIFT_NICKNAME code points → { ok: false, field: nickname }', () => {
    const r = validateGiftText(valid({ nickname: 'n'.repeat(MAX_GIFT_NICKNAME + 1) }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('nickname')
  })

  it('code-point counting: 30 emoji → valid, 31 → fail', () => {
    expect(validateGiftText(valid({ nickname: '😀'.repeat(30) })).ok).toBe(true)
    const r = validateGiftText(valid({ nickname: '😀'.repeat(31) }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('nickname')
  })

  it('nickname with \\n (newline is a control char in single-line) → { ok: false, field: nickname }', () => {
    const r = validateGiftText(valid({ nickname: 'Nick\nname' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('nickname')
  })

  it('nickname with bidi char → { ok: false, field: nickname }', () => {
    const r = validateGiftText(valid({ nickname: 'Nick\u200Fname' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('nickname')
  })
})

describe('validateGiftText — className failures', () => {
  it('className > MAX_GIFT_CLASSNAME code points → { ok: false, field: className }', () => {
    const r = validateGiftText(valid({ className: 'c'.repeat(MAX_GIFT_CLASSNAME + 1) }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('className')
  })

  it('className with control char → { ok: false, field: className }', () => {
    const r = validateGiftText(valid({ className: '11\x01A' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('className')
  })

  it('whitespace-only className trims to empty and is valid', () => {
    // Whitespace-only className trims to '' which is valid (optional field)
    const r = validateGiftText(valid({ className: '   ' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.className).toBe('')
  })
})

// ── Fix: non-string fields must return { ok: false, field } ──────────────────
// Review Cycle 2 Warning [worker/gifts.ts:166]:
// Non-string values (null, number, object) for any field must return { ok: false, field }
// rather than throwing a TypeError (which would surface as a 500 in the worker).

describe('validateGiftText — non-string inputs return { ok: false, field } (cycle-2 fix)', () => {
  it('message: null → { ok: false, field: message }', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = validateGiftText({ message: null as any, nickname: 'Nick', className: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('message')
  })

  it('nickname: 5 → { ok: false, field: nickname }', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = validateGiftText({ message: 'Hello', nickname: 5 as any, className: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('nickname')
  })

  it('className: null → { ok: false, field: className }', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = validateGiftText({ message: 'Hello', nickname: 'Nick', className: null as any })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('className')
  })

  it('className: 123 → { ok: false, field: className }', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = validateGiftText({ message: 'Hello', nickname: 'Nick', className: 123 as any })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('className')
  })

  it('className: {} → { ok: false, field: className }', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = validateGiftText({ message: 'Hello', nickname: 'Nick', className: {} as any })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('className')
  })
})
