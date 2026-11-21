/**
 * Tests for src/game/createGiftValidation.ts
 * Pure logic — no DOM, no React, no network.
 */
import { describe, it, expect } from 'vitest'
import {
  validateBox,
  validateOrnament,
  validateCard,
  validateName,
} from './createGiftValidation.ts'

// ── validateBox ───────────────────────────────────────────────────────────────

describe('validateBox', () => {
  it('returns null for all valid styles 1–6', () => {
    for (let i = 1; i <= 6; i++) {
      expect(validateBox(i)).toBeNull()
    }
  })
  it('returns error for null', () => expect(validateBox(null)).not.toBeNull())
  it('returns error for undefined', () => expect(validateBox(undefined)).not.toBeNull())
  it('returns error for 0', () => expect(validateBox(0)).not.toBeNull())
  it('returns error for 7', () => expect(validateBox(7)).not.toBeNull())
  it('returns error for a float', () => expect(validateBox(1.5)).not.toBeNull())
  it('returns error for a string "1"', () => expect(validateBox('1')).not.toBeNull())
})

// ── validateOrnament ──────────────────────────────────────────────────────────

describe('validateOrnament', () => {
  it('returns null for all valid styles 1–6', () => {
    for (let i = 1; i <= 6; i++) {
      expect(validateOrnament(i)).toBeNull()
    }
  })
  it('returns error for null', () => expect(validateOrnament(null)).not.toBeNull())
  it('returns error for 0', () => expect(validateOrnament(0)).not.toBeNull())
  it('returns error for 7', () => expect(validateOrnament(7)).not.toBeNull())
})

// ── validateCard ──────────────────────────────────────────────────────────────

const VALID_CARD = {
  layout: 'doc-giua',
  backgroundTemplateId: 1,
  font: 'patrick-hand',
  ink: '#1d3fa6',
  message: 'Chúc mừng Giáng sinh!',
}

describe('validateCard', () => {
  it('returns null for a fully valid card', () => {
    expect(validateCard(VALID_CARD)).toBeNull()
  })

  it('accepts 300-character message', () => {
    expect(validateCard({ ...VALID_CARD, message: 'a'.repeat(300) })).toBeNull()
  })

  it('returns error for null layout', () => {
    expect(validateCard({ ...VALID_CARD, layout: null })).not.toBeNull()
  })

  it('returns error for unknown layout', () => {
    expect(validateCard({ ...VALID_CARD, layout: 'unknown-layout' })).not.toBeNull()
  })

  it('returns error for null backgroundTemplateId', () => {
    expect(validateCard({ ...VALID_CARD, backgroundTemplateId: null })).not.toBeNull()
  })

  it('returns error for null font', () => {
    expect(validateCard({ ...VALID_CARD, font: null })).not.toBeNull()
  })

  it('returns error for unknown font', () => {
    expect(validateCard({ ...VALID_CARD, font: 'comic-sans' })).not.toBeNull()
  })

  it('returns error for null ink', () => {
    expect(validateCard({ ...VALID_CARD, ink: null })).not.toBeNull()
  })

  it('returns error for invalid ink format', () => {
    expect(validateCard({ ...VALID_CARD, ink: 'blue' })).not.toBeNull()
  })

  it('accepts uppercase hex ink (#AABBCC)', () => {
    // isInkInput allows uppercase
    expect(validateCard({ ...VALID_CARD, ink: '#AABBCC' })).toBeNull()
  })

  it('returns error for empty message', () => {
    expect(validateCard({ ...VALID_CARD, message: '' })).not.toBeNull()
  })

  it('returns error for 301-character message', () => {
    expect(validateCard({ ...VALID_CARD, message: 'a'.repeat(301) })).not.toBeNull()
  })
})

// ── validateName ──────────────────────────────────────────────────────────────

describe('validateName', () => {
  it('returns null for a valid name', () => {
    expect(validateName({ nickname: 'Lan', className: '12A' })).toBeNull()
  })

  it('returns null for empty class (optional field)', () => {
    expect(validateName({ nickname: 'Lan', className: '' })).toBeNull()
  })

  it('accepts a 30-codepoint nickname', () => {
    expect(validateName({ nickname: 'a'.repeat(30), className: '' })).toBeNull()
  })

  it('accepts a 10-codepoint class', () => {
    expect(validateName({ nickname: 'Lan', className: 'a'.repeat(10) })).toBeNull()
  })

  it('returns error for empty nickname', () => {
    expect(validateName({ nickname: '', className: '' })).not.toBeNull()
  })

  it('returns error for whitespace-only nickname', () => {
    expect(validateName({ nickname: '   ', className: '' })).not.toBeNull()
  })

  it('returns error for 31-codepoint nickname', () => {
    expect(validateName({ nickname: 'a'.repeat(31), className: '' })).not.toBeNull()
  })

  it('returns error for 11-codepoint class', () => {
    expect(validateName({ nickname: 'Lan', className: 'a'.repeat(11) })).not.toBeNull()
  })

  it('handles multibyte Unicode codepoints in nickname', () => {
    // 15 emoji = 15 codepoints but 30 UTF-16 chars — must still be ≤ 30 codepoints
    const thirtyEmoji = '😊'.repeat(30)
    expect(validateName({ nickname: thirtyEmoji, className: '' })).toBeNull()
    const thirtyOneEmoji = '😊'.repeat(31)
    expect(validateName({ nickname: thirtyOneEmoji, className: '' })).not.toBeNull()
  })
})

// ── New tests: shared/gift.ts rules applied (code points, whitespace-only, control chars) ──

describe('validateCard — shared/gift.ts rules for message', () => {
  it('rejects whitespace-only message', () => {
    expect(validateCard({ ...VALID_CARD, message: '   ' })).not.toBeNull()
  })

  it('accepts 300-codepoint message (emoji) — counts code points not UTF-16', () => {
    // 300 emoji = 300 code points but 600 UTF-16 code units
    expect(validateCard({ ...VALID_CARD, message: '😊'.repeat(300) })).toBeNull()
  })

  it('rejects 301-codepoint message (emoji)', () => {
    expect(validateCard({ ...VALID_CARD, message: '😊'.repeat(301) })).not.toBeNull()
  })

  it('rejects message with control character (\\x01)', () => {
    expect(validateCard({ ...VALID_CARD, message: 'hello\x01world' })).not.toBeNull()
  })

  it('allows newlines in message (multiline allowed)', () => {
    expect(validateCard({ ...VALID_CARD, message: 'line1\nline2' })).toBeNull()
  })
})

describe('validateCard — availableTemplateIds check', () => {
  it('passes when backgroundTemplateId is in availableTemplateIds', () => {
    expect(validateCard({ ...VALID_CARD, availableTemplateIds: [1, 2, 3] })).toBeNull()
  })

  it('fails when backgroundTemplateId is NOT in availableTemplateIds', () => {
    expect(validateCard({ ...VALID_CARD, backgroundTemplateId: 99, availableTemplateIds: [1, 2, 3] })).not.toBeNull()
  })

  it('passes when availableTemplateIds is empty (no list to validate against)', () => {
    expect(validateCard({ ...VALID_CARD, availableTemplateIds: [] })).toBeNull()
  })

  it('passes when availableTemplateIds is undefined (no list provided)', () => {
    expect(validateCard({ ...VALID_CARD, availableTemplateIds: undefined })).toBeNull()
  })
})

describe('validateName — shared/gift.ts rules (NFC + trim, control chars)', () => {
  it('rejects nickname with control character', () => {
    expect(validateName({ nickname: 'Lan\x01', className: '' })).not.toBeNull()
  })

  it('accepts 30-codepoint emoji nickname', () => {
    expect(validateName({ nickname: '😊'.repeat(30), className: '' })).toBeNull()
  })

  it('rejects 31-codepoint emoji nickname', () => {
    expect(validateName({ nickname: '😊'.repeat(31), className: '' })).not.toBeNull()
  })

  it('rejects className with control character', () => {
    expect(validateName({ nickname: 'Lan', className: '12A\x01' })).not.toBeNull()
  })

  it('accepts 10-codepoint emoji className', () => {
    expect(validateName({ nickname: 'Lan', className: '😊'.repeat(10) })).toBeNull()
  })

  it('rejects 11-codepoint emoji className', () => {
    expect(validateName({ nickname: 'Lan', className: '😊'.repeat(11) })).not.toBeNull()
  })
})
