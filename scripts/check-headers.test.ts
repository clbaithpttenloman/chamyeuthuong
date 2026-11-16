/**
 * scripts/check-headers.test.ts — unit tests for the check-headers validator.
 *
 * Key focus: the strict CSP (no Google origins), the rejection of any
 * accounts.google.com occurrence, and wildcard rejection in key directives.
 */
import { describe, expect, it } from 'vitest'
import { checkHeaders } from './check-headers.ts'

// ── Valid baseline (strict CSP — no Google origins) ───────────────────────────

const VALID = `/*
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY

/admin
  X-Robots-Tag: noindex

/t/*
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
})
