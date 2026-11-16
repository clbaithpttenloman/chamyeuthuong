/**
 * scripts/check-headers.test.ts — unit tests for the check-headers validator.
 *
 * Key focus: the rejection of bare https://accounts.google.com and wildcard
 * sources in GIS-related CSP directives.
 */
import { describe, expect, it } from 'vitest'
import { checkHeaders } from './check-headers.ts'

// ── Valid baseline ────────────────────────────────────────────────────────────

const VALID = `/*
  Content-Security-Policy: default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY

/admin
  X-Robots-Tag: noindex

/t/*
  X-Robots-Tag: noindex
`

describe('checkHeaders', () => {
  it('passes with the full valid headers', () => {
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

  // ── Bare https://accounts.google.com rejection ────────────────────────────

  it('rejects bare https://accounts.google.com in script-src', () => {
    // Replace the specific /gsi/client path with the bare domain
    const content = VALID.replace(
      'https://accounts.google.com/gsi/client',
      'https://accounts.google.com',
    )
    const errors = checkHeaders(content)
    // Must flag the forbidden bare domain
    expect(errors.some((e) => e.includes('bare'))).toBe(true)
  })

  it('rejects bare https://accounts.google.com in frame-src', () => {
    const content = VALID.replace(
      'frame-src https://accounts.google.com/gsi/',
      'frame-src https://accounts.google.com',
    )
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('bare'))).toBe(true)
  })

  it('rejects bare https://accounts.google.com in connect-src', () => {
    const content = VALID.replace(
      'connect-src \'self\' https://accounts.google.com/gsi/',
      'connect-src \'self\' https://accounts.google.com',
    )
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('bare'))).toBe(true)
  })

  it('still accepts https://accounts.google.com/gsi/client (path present)', () => {
    // The valid headers already have the full path; ensure no false positive
    expect(checkHeaders(VALID)).toEqual([])
  })

  // ── Wildcard rejection ────────────────────────────────────────────────────

  it('rejects wildcard * in script-src', () => {
    const content = VALID.replace(
      "script-src 'self' https://accounts.google.com/gsi/client",
      "script-src * https://accounts.google.com/gsi/client",
    )
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('wildcard'))).toBe(true)
  })

  it('rejects wildcard * in frame-src', () => {
    const content = VALID.replace(
      'frame-src https://accounts.google.com/gsi/',
      'frame-src *',
    )
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('wildcard'))).toBe(true)
  })

  it('rejects wildcard * in connect-src', () => {
    const content = VALID.replace(
      "connect-src 'self' https://accounts.google.com/gsi/",
      "connect-src *",
    )
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('wildcard'))).toBe(true)
  })

  it('rejects wildcard * in style-src', () => {
    const content = VALID.replace(
      "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
      "style-src *",
    )
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('wildcard'))).toBe(true)
  })
})
