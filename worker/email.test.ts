// @vitest-environment node
/**
 * Unit tests for normalizeEmail (worker/email.ts).
 * This file imports from ./email.ts which does not exist in Group 1 → all tests fail with an
 * import error.  They pass once Group 2 creates the file.
 */
import { describe, it, expect } from 'vitest'
import { normalizeEmail } from './email.ts'

// ---- null / empty inputs ----

describe('normalizeEmail — null/empty inputs', () => {
  it('null → null', () => {
    expect(normalizeEmail(null)).toBeNull()
  })

  it('undefined → null', () => {
    expect(normalizeEmail(undefined)).toBeNull()
  })

  it('empty string → null', () => {
    expect(normalizeEmail('')).toBeNull()
  })

  it('whitespace only → null', () => {
    expect(normalizeEmail('   ')).toBeNull()
  })
})

// ---- length ----

describe('normalizeEmail — length', () => {
  it('length > 254 after trim+lower → null', () => {
    // 246 × 'a' + '@example.com' (12) = 258 chars; > 254 → null
    const raw = 'a'.repeat(246) + '@example.com'
    expect(raw.length).toBeGreaterThan(254)
    expect(normalizeEmail(raw)).toBeNull()
  })

  it('length exactly 254 with valid structure → valid string', () => {
    // 249 × 'a' + '@' + 'e.co' = 254; valid format
    const email = 'a'.repeat(249) + '@e.co'
    expect(email.length).toBe(254)
    expect(normalizeEmail(email)).toBe(email)
  })
})

// ---- ASCII-only ----

describe('normalizeEmail — ASCII only', () => {
  it('email with ñ (non-ASCII) → null', () => {
    expect(normalizeEmail('admiñ@example.com')).toBeNull()
  })

  it('email with emoji → null', () => {
    expect(normalizeEmail('admin🙂@example.com')).toBeNull()
  })
})

// ---- structure ----

describe('normalizeEmail — structure', () => {
  it('no @ symbol → null', () => {
    expect(normalizeEmail('nodomain.com')).toBeNull()
  })

  it('multiple @ symbols → null', () => {
    expect(normalizeEmail('a@b@example.com')).toBeNull()
  })

  it('no dot in domain (x@localhost) → null', () => {
    expect(normalizeEmail('admin@localhost')).toBeNull()
  })

  it('empty local part (@example.com) → null', () => {
    expect(normalizeEmail('@example.com')).toBeNull()
  })

  it('empty domain (admin@) → null', () => {
    expect(normalizeEmail('admin@')).toBeNull()
  })

  it('internal whitespace (space before @) → null', () => {
    expect(normalizeEmail('admin @example.com')).toBeNull()
  })

  it('internal tab → null', () => {
    expect(normalizeEmail('admin\t@example.com')).toBeNull()
  })
})

// ---- normalization ----

describe('normalizeEmail — normalization', () => {
  it('trims leading whitespace', () => {
    expect(normalizeEmail('  admin@example.com')).toBe('admin@example.com')
  })

  it('trims trailing whitespace', () => {
    expect(normalizeEmail('admin@example.com  ')).toBe('admin@example.com')
  })

  it('lowercases the email', () => {
    expect(normalizeEmail('Admin@Example.COM')).toBe('admin@example.com')
  })

  it('trim + lowercase together', () => {
    expect(normalizeEmail('  ADMIN@EXAMPLE.COM  ')).toBe('admin@example.com')
  })
})

// ---- valid cases ----

describe('normalizeEmail — valid emails', () => {
  it('simple valid email → returns lowercase string', () => {
    expect(normalizeEmail('admin@example.com')).toBe('admin@example.com')
  })

  it('subdomain → valid', () => {
    expect(normalizeEmail('user@sub.example.com')).toBe('user@sub.example.com')
  })

  it('already-normalized email is returned unchanged', () => {
    const e = 'user@example.org'
    expect(normalizeEmail(e)).toBe(e)
  })
})
