// @vitest-environment node
/**
 * Tests for src/auth/nextPath.ts — nextPath()
 * RED phase: will fail until src/auth/nextPath.ts is created.
 *
 * Contract (contracts.md):
 *   nextPath(raw: string | null | undefined, origin: string): string
 *   — AC-32; fallback '/'
 *
 * AC-32: nextPath() returns '/' for paths with control characters, protocol-relative
 * or absolute URLs to other origins, over 200 characters, and nullish/empty input;
 * returns valid same-origin paths unchanged.
 */
import { describe, it, expect } from 'vitest'
import { nextPath } from './nextPath.ts'

const ORIGIN = 'https://cyt.example'

// ── Open-redirect / injection attacks → '/' ──────────────────────────────────

describe('nextPath — open-redirect and injection attacks → "/"', () => {
  it('/\\t/x (tab in path) → "/"', () => {
    expect(nextPath('/\t/x', ORIGIN)).toBe('/')
  })

  it('/\\n/x (newline in path) → "/"', () => {
    expect(nextPath('/\n/x', ORIGIN)).toBe('/')
  })

  it('/\\r/x (carriage return in path) → "/"', () => {
    expect(nextPath('/\r/x', ORIGIN)).toBe('/')
  })

  it('//x (double-slash, protocol-relative) → "/"', () => {
    expect(nextPath('//x', ORIGIN)).toBe('/')
  })

  it('/\\\\x (backslash) → "/"', () => {
    expect(nextPath('/\\x', ORIGIN)).toBe('/')
  })

  it('https://evil.example (absolute URL to other origin) → "/"', () => {
    expect(nextPath('https://evil.example', ORIGIN)).toBe('/')
  })

  it('javascript:alert(1) → "/"', () => {
    expect(nextPath('javascript:alert(1)', ORIGIN)).toBe('/')
  })

  it('" /x" (leading space) → "/"', () => {
    expect(nextPath(' /x', ORIGIN)).toBe('/')
  })

  it('201-char path → "/" (exceeds 200-char limit)', () => {
    const path = '/' + 'a'.repeat(200) // length 201
    expect(nextPath(path, ORIGIN)).toBe('/')
  })
})

// ── Percent-encoded path separators ─────────────────────────────────────────
// These decode to '/' or '\', which could create a double-slash or backslash.
// The implementation may return '/' (conservative) or the encoded path (safe).
// Either way, the result must start with '/' and not '//'.

describe('nextPath — percent-encoded separators', () => {
  it('/%2f/x — result starts with "/" but not "//"', () => {
    const r = nextPath('/%2f/x', ORIGIN)
    expect(r.startsWith('/')).toBe(true)
    expect(r.startsWith('//')).toBe(false)
  })

  it('/%5c/x — result starts with "/" but not "//"', () => {
    const r = nextPath('/%5c/x', ORIGIN)
    expect(r.startsWith('/')).toBe(true)
    expect(r.startsWith('//')).toBe(false)
  })
})

// ── Nullish / empty → '/' ────────────────────────────────────────────────────

describe('nextPath — nullish and empty input → "/"', () => {
  it('null → "/"', () => {
    expect(nextPath(null, ORIGIN)).toBe('/')
  })

  it('undefined → "/"', () => {
    expect(nextPath(undefined, ORIGIN)).toBe('/')
  })

  it('"" (empty string) → "/"', () => {
    expect(nextPath('', ORIGIN)).toBe('/')
  })
})

// ── Valid same-origin paths returned unchanged ───────────────────────────────

describe('nextPath — valid same-origin paths returned unchanged', () => {
  it('/noel-2026/g/abc?x=1#h → returned unchanged', () => {
    expect(nextPath('/noel-2026/g/abc?x=1#h', ORIGIN)).toBe('/noel-2026/g/abc?x=1#h')
  })

  it('/admin → returned unchanged', () => {
    expect(nextPath('/admin', ORIGIN)).toBe('/admin')
  })
})
