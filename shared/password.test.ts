// @vitest-environment node
/**
 * Tests for shared/password.ts — checkPassword()
 * RED phase: will fail until shared/password.ts is created.
 *
 * Contract (contracts.md):
 *   RAW_LIMITS = { username: 64, password: 512, nickname: 128, className: 128 }
 *   PASSWORD_MIN = 8, PASSWORD_MAX = 128  (code points after NFC)
 *   PasswordCode = 'password_invalid' | 'password_too_short' | 'password_too_long'
 *                | 'password_contains_username' | 'password_common'
 *   PasswordResult = { ok: true; value: string (NFC) } | { ok: false; code: PasswordCode }
 *   checkPassword(raw: unknown, username: string, isCommon?: (lowerNfc: string) => boolean): PasswordResult
 *     — non-string or raw.length > 512 → password_invalid (no normalising)
 *     — isCommon receives the NFC value lower-cased
 */
import { describe, it, expect } from 'vitest'
import { checkPassword, RAW_LIMITS, PASSWORD_MIN, PASSWORD_MAX } from './password.ts'

// ── Exported constants ───────────────────────────────────────────────────────

describe('checkPassword — exported constants', () => {
  it('RAW_LIMITS.username = 64', () => { expect(RAW_LIMITS.username).toBe(64) })
  it('RAW_LIMITS.password = 512', () => { expect(RAW_LIMITS.password).toBe(512) })
  it('RAW_LIMITS.nickname = 128', () => { expect(RAW_LIMITS.nickname).toBe(128) })
  it('RAW_LIMITS.className = 128', () => { expect(RAW_LIMITS.className).toBe(128) })
  it('PASSWORD_MIN = 8', () => { expect(PASSWORD_MIN).toBe(8) })
  it('PASSWORD_MAX = 128', () => { expect(PASSWORD_MAX).toBe(128) })
})

// ── Code-point length (not UTF-16 units) ────────────────────────────────────

describe('checkPassword — length (code points, not UTF-16 units)', () => {
  it('7 emoji chars (7 code points, 14 UTF-16 units) → password_too_short', () => {
    // 🎄 = U+1F384, surrogate pair, 2 UTF-16 code units = 1 code point.
    // If the check used UTF-16 length, 7×🎄 = 14 ≥ 8 would incorrectly pass.
    const pw = '🎄'.repeat(7) // 7 code points, 14 UTF-16 units
    const r = checkPassword(pw, 'user')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('password_too_short')
  })

  it('8 emoji chars (8 code points, 16 UTF-16 units) → valid (proves code-point counting)', () => {
    const pw = '🎄'.repeat(8) // 8 code points ≥ PASSWORD_MIN
    const r = checkPassword(pw, 'user')
    expect(r.ok).toBe(true)
  })

  it('128 ASCII chars → valid (at PASSWORD_MAX)', () => {
    const r = checkPassword('a'.repeat(128), 'user')
    expect(r.ok).toBe(true)
  })

  it('129 ASCII chars → password_too_long (exceeds PASSWORD_MAX)', () => {
    const r = checkPassword('a'.repeat(129), 'user')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('password_too_long')
  })
})

// ── Raw-length guard (before normalisation) ──────────────────────────────────

describe('checkPassword — raw-length guard', () => {
  it('string of 600 ASCII chars → password_invalid (raw > RAW_LIMITS.password, no normalising)', () => {
    // 600 chars = 600 UTF-16 units > 512; must reject before NFC normalisation.
    const r = checkPassword('a'.repeat(600), 'user')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('password_invalid')
  })

  it('non-string (null) → password_invalid', () => {
    const r = checkPassword(null, 'user')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('password_invalid')
  })

  it('non-string (number 12345678) → password_invalid', () => {
    const r = checkPassword(12345678, 'user')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('password_invalid')
  })
})

// ── Contains username ────────────────────────────────────────────────────────

describe('checkPassword — contains username', () => {
  it('password equal to username → password_contains_username', () => {
    const r = checkPassword('alice123', 'alice123')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('password_contains_username')
  })

  it('password contains username as substring (case-insensitive) → password_contains_username', () => {
    // 'alice' (lowercase) is a substring of 'prefixAlicesuffix' after lowercasing
    const r = checkPassword('prefixAlicesuffix', 'alice')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('password_contains_username')
  })

  it('username appears in UPPER CASE inside password → password_contains_username', () => {
    const r = checkPassword('Alice123abc', 'alice')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('password_contains_username')
  })
})

// ── isCommon predicate ───────────────────────────────────────────────────────

describe('checkPassword — common-password predicate', () => {
  it('isCommon is called with the lower-cased NFC value', () => {
    let received: string | undefined
    const spy = (s: string) => { received = s; return false }
    // 'Password1!' does not contain username 'user', length OK
    checkPassword('Password1!', 'user', spy)
    expect(received).toBe('password1!')
  })

  it('isCommon returns true → password_common', () => {
    const r = checkPassword('Password1!', 'user', () => true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('password_common')
  })

  it('isCommon returns false → valid (not common)', () => {
    const r = checkPassword('Password1!', 'user', () => false)
    expect(r.ok).toBe(true)
  })
})

// ── NFC normalisation ────────────────────────────────────────────────────────

describe('checkPassword — NFC normalisation', () => {
  it('NFD input returns ok with NFC value', () => {
    // 'mật khẩu tốt 1' in NFD: each tonal/diacritical char decomposes to base + combining marks
    const nfd = 'mật khẩu tốt 1'.normalize('NFD')
    const nfc = 'mật khẩu tốt 1'.normalize('NFC')
    const r = checkPassword(nfd, 'user')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(nfc)
  })

  it('NFC input returns the same NFC value', () => {
    const nfc = 'mật khẩu tốt 1'
    const r = checkPassword(nfc, 'user')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(nfc.normalize('NFC'))
  })
})
