// @vitest-environment node
/**
 * Tests for shared/username.ts — normalizeUsername()
 * RED phase: will fail until shared/username.ts is created.
 *
 * Contract (contracts.md):
 *   RESERVED_USERNAMES: ReadonlySet<string>  // admin, quantri, root, system, clbai, giamthi, support
 *   UsernameResult = { ok: true; value: string } | { ok: false; code: 'username_invalid' | 'username_reserved' }
 *   normalizeUsername(raw: unknown): UsernameResult
 *     — non-string or raw length > 64 → username_invalid
 *     — trim + lowercase
 *     — ^[a-z0-9_]{3,20}$ after normalisation
 */
import { describe, it, expect } from 'vitest'
import { normalizeUsername, RESERVED_USERNAMES } from './username.ts'

// ── Valid input ──────────────────────────────────────────────────────────────

describe('normalizeUsername — valid input', () => {
  it('Thien_01 → thien_01 (trim + lowercase)', () => {
    const r = normalizeUsername('Thien_01')
    expect(r).toEqual({ ok: true, value: 'thien_01' })
  })

  it('  Thien_01  → thien_01 (trims surrounding spaces)', () => {
    const r = normalizeUsername('  Thien_01  ')
    expect(r).toEqual({ ok: true, value: 'thien_01' })
  })

  it('exactly 3 chars → valid (minimum length)', () => {
    const r = normalizeUsername('abc')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('abc')
  })

  it('exactly 20 chars → valid (maximum length)', () => {
    const r = normalizeUsername('a'.repeat(20))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('a'.repeat(20))
  })

  it('digits and underscores mix → valid', () => {
    const r = normalizeUsername('a1_b2_c3')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('a1_b2_c3')
  })
})

// ── Invalid input ────────────────────────────────────────────────────────────

describe('normalizeUsername — invalid input', () => {
  it('2 chars → username_invalid (below minimum)', () => {
    expect(normalizeUsername('ab')).toEqual({ ok: false, code: 'username_invalid' })
  })

  it('21 chars → username_invalid (above maximum after normalise)', () => {
    expect(normalizeUsername('a'.repeat(21))).toEqual({ ok: false, code: 'username_invalid' })
  })

  it('contains hyphen → username_invalid (not in [a-z0-9_])', () => {
    expect(normalizeUsername('thien-01')).toEqual({ ok: false, code: 'username_invalid' })
  })

  it('contains internal space → username_invalid (space not in [a-z0-9_])', () => {
    expect(normalizeUsername('thien 01')).toEqual({ ok: false, code: 'username_invalid' })
  })

  it('contains Vietnamese letter (ê) → username_invalid', () => {
    expect(normalizeUsername('nguyên')).toEqual({ ok: false, code: 'username_invalid' })
  })

  it('non-string (number) → username_invalid', () => {
    expect(normalizeUsername(42)).toEqual({ ok: false, code: 'username_invalid' })
  })

  it('non-string (null) → username_invalid', () => {
    expect(normalizeUsername(null)).toEqual({ ok: false, code: 'username_invalid' })
  })

  it('raw length > 64 UTF-16 units → username_invalid (checked before normalising)', () => {
    // 65 'a' chars = 65 UTF-16 units > RAW_LIMITS.username (64)
    expect(normalizeUsername('a'.repeat(65))).toEqual({ ok: false, code: 'username_invalid' })
  })
})

// ── Reserved usernames ───────────────────────────────────────────────────────

describe('normalizeUsername — reserved usernames', () => {
  it('"admin" → username_reserved', () => {
    expect(normalizeUsername('admin')).toEqual({ ok: false, code: 'username_reserved' })
  })

  it('"ADMIN" → username_reserved (reserved check on lowercased form)', () => {
    expect(normalizeUsername('ADMIN')).toEqual({ ok: false, code: 'username_reserved' })
  })

  it('"quantri" → username_reserved', () => {
    expect(normalizeUsername('quantri')).toEqual({ ok: false, code: 'username_reserved' })
  })

  it('"root" → username_reserved', () => {
    expect(normalizeUsername('root')).toEqual({ ok: false, code: 'username_reserved' })
  })

  it('"system" → username_reserved', () => {
    expect(normalizeUsername('system')).toEqual({ ok: false, code: 'username_reserved' })
  })

  it('"clbai" → username_reserved', () => {
    expect(normalizeUsername('clbai')).toEqual({ ok: false, code: 'username_reserved' })
  })

  it('"giamthi" → username_reserved', () => {
    expect(normalizeUsername('giamthi')).toEqual({ ok: false, code: 'username_reserved' })
  })

  it('"support" → username_reserved', () => {
    expect(normalizeUsername('support')).toEqual({ ok: false, code: 'username_reserved' })
  })

  it('RESERVED_USERNAMES contains all required words', () => {
    for (const name of ['admin', 'quantri', 'root', 'system', 'clbai', 'giamthi', 'support']) {
      expect(RESERVED_USERNAMES.has(name), `expected "${name}" in RESERVED_USERNAMES`).toBe(true)
    }
  })
})
