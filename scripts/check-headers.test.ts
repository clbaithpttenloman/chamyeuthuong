/**
 * scripts/check-headers.test.ts — unit tests for the check-headers validator.
 *
 * Key focus: the strict CSP (no Google origins), the rejection of any
 * accounts.google.com occurrence, and wildcard rejection in key directives.
 * Also enforces the site-wide X-Robots-Tag: noindex on /* (plan § Amendments).
 */
import { describe, expect, it } from 'vitest'
import { checkHeaders } from './check-headers.ts'

// ── Valid baseline (strict CSP — no Google origins, X-Robots-Tag on /*) ──────

const VALID = `/*
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  X-Robots-Tag: noindex
`

describe('checkHeaders', () => {
  it('passes with the full strict valid headers', () => {
    expect(checkHeaders(VALID)).toEqual([])
  })

  // ── Missing required lines ────────────────────────────────────────────────

  it('reports missing CSP line', () => {
    const content = VALID.replace(/Content-Security-Policy:.*\n/, '\n')
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.startsWith('missing:'))).toBe(true)
  })

  it('reports missing Referrer-Policy', () => {
    const content = VALID.replace('Referrer-Policy: no-referrer\n', '')
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('Referrer-Policy'))).toBe(true)
  })

  it('reports missing X-Content-Type-Options', () => {
    const content = VALID.replace('X-Content-Type-Options: nosniff\n', '')
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('X-Content-Type-Options'))).toBe(true)
  })

  it('reports missing X-Frame-Options', () => {
    const content = VALID.replace('X-Frame-Options: DENY\n', '')
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('X-Frame-Options'))).toBe(true)
  })

  it('reports missing X-Robots-Tag: noindex', () => {
    const content = VALID.replace('  X-Robots-Tag: noindex\n', '')
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('X-Robots-Tag'))).toBe(true)
  })

  // ── accounts.google.com rejection ────────────────────────────────────────

  it('rejects bare accounts.google.com', () => {
    const content = VALID + '  script-src https://accounts.google.com\n'
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('accounts.google.com'))).toBe(true)
  })

  it('rejects accounts.google.com with gsi path', () => {
    const content = VALID + '  script-src https://accounts.google.com/gsi/client\n'
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('accounts.google.com'))).toBe(true)
  })

  it('rejects accounts.google.com in frame-src', () => {
    const content = VALID + '  frame-src https://accounts.google.com/gsi/\n'
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('accounts.google.com'))).toBe(true)
  })

  // ── Wildcard rejection ────────────────────────────────────────────────────

  it('rejects wildcard * in style-src', () => {
    const content = VALID.replace(
      "style-src 'self' 'unsafe-inline'",
      'style-src *',
    )
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('wildcard'))).toBe(true)
  })

  it('rejects wildcard * in an injected script-src directive', () => {
    const content = VALID.replace(
      "default-src 'self'",
      "default-src 'self'; script-src *",
    )
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('wildcard'))).toBe(true)
  })

  // ── Duplicate X-Robots-Tag rejection ─────────────────────────────────────

  it('rejects duplicate X-Robots-Tag: noindex lines', () => {
    // Duplicate should be an error — only one noindex line is allowed on /*
    const content = VALID + '  X-Robots-Tag: noindex\n'
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('X-Robots-Tag'))).toBe(true)
  })

  it('rejects extra X-Robots-Tag line with a different value (e.g. index)', () => {
    // Adding X-Robots-Tag: index on top of the required noindex is also invalid —
    // only ONE X-Robots-Tag line (noindex) is allowed, any other value included.
    // Before fix: checkHeaders only counts the exact "X-Robots-Tag: noindex" string
    // so the extra "X-Robots-Tag: index" line goes undetected → no error reported.
    const content = VALID + '  X-Robots-Tag: index\n'
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('X-Robots-Tag'))).toBe(true)
  })
})
