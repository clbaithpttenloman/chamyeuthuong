/**
 * scripts/check-headers.test.ts — unit tests for the check-headers validator.
 *
 * Key focus: the CSP must include the Google GSI origins (script/frame/connect/style),
 * accounts.google.com WITHOUT /gsi/ is still forbidden, and wildcards are still rejected.
 * Also enforces the site-wide X-Robots-Tag: noindex on /* (plan § Amendments).
 */
import { describe, expect, it } from 'vitest'
import { checkHeaders } from './check-headers.ts'

// ── Valid baseline (CSP with Google GSI origins, X-Robots-Tag on /*) ─────────

const VALID = `/*
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; script-src 'self' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  X-Robots-Tag: noindex
`

describe('checkHeaders', () => {
  it('passes with the full valid headers (including Google GSI origins)', () => {
    expect(checkHeaders(VALID)).toEqual([])
  })

  // ── Missing required lines ────────────────────────────────────────────────

  it('reports missing CSP line', () => {
    const content = VALID.replace(/Content-Security-Policy:.*\n/, '\n')
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.startsWith('missing:'))).toBe(true)
  })

  it('reports missing Referrer-Policy', () => {
    const content = VALID.replace('Referrer-Policy: strict-origin-when-cross-origin\n', '')
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('Referrer-Policy'))).toBe(true)
  })

  it('reports no-referrer (breaks Google sign-in) and a second Referrer-Policy line', () => {
    const only = VALID.replace('Referrer-Policy: strict-origin-when-cross-origin', 'Referrer-Policy: no-referrer')
    expect(checkHeaders(only).some((e) => e.startsWith('missing:') && e.includes('Referrer-Policy'))).toBe(true)
    const both = VALID.replace(
      'Referrer-Policy: strict-origin-when-cross-origin\n',
      'Referrer-Policy: strict-origin-when-cross-origin\n  Referrer-Policy: no-referrer\n',
    )
    expect(checkHeaders(both).some((e) => e.includes('Referrer-Policy appears more than once'))).toBe(true)
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

  it('reports missing Google GSI origins in CSP (old strict CSP without GSI)', () => {
    // The old CSP (without GSI origins) must fail — the new required CSP line is different.
    const oldCsp = "Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'"
    const content = VALID.replace(/Content-Security-Policy:.*/, oldCsp)
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.startsWith('missing:'))).toBe(true)
  })

  // ── accounts.google.com WITHOUT /gsi/ is forbidden ────────────────────────

  it('rejects bare accounts.google.com (no /gsi/ path)', () => {
    // Adding bare accounts.google.com without /gsi/ path to an otherwise valid file
    const content = VALID + '  connect-src https://accounts.google.com\n'
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('accounts.google.com'))).toBe(true)
  })

  it('rejects accounts.google.com with non-gsi path', () => {
    const content = VALID + '  script-src https://accounts.google.com/oauth2/\n'
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('accounts.google.com'))).toBe(true)
  })

  it('allows accounts.google.com/gsi/ origins (they are part of the required CSP)', () => {
    // The VALID baseline already includes GSI paths — it must pass with no error
    expect(checkHeaders(VALID)).toEqual([])
  })

  // ── Wildcard rejection ────────────────────────────────────────────────────

  it('rejects wildcard * in style-src', () => {
    const content = VALID.replace(
      "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
      'style-src *',
    )
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('wildcard'))).toBe(true)
  })

  it('rejects wildcard * in an injected script-src directive', () => {
    const content = VALID.replace(
      "script-src 'self' https://accounts.google.com/gsi/client",
      'script-src *',
    )
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('wildcard'))).toBe(true)
  })

  // ── Duplicate X-Robots-Tag rejection ─────────────────────────────────────

  it('rejects duplicate X-Robots-Tag: noindex lines', () => {
    const content = VALID + '  X-Robots-Tag: noindex\n'
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('X-Robots-Tag'))).toBe(true)
  })

  it('rejects extra X-Robots-Tag line with a different value (e.g. index)', () => {
    const content = VALID + '  X-Robots-Tag: index\n'
    const errors = checkHeaders(content)
    expect(errors.some((e) => e.includes('X-Robots-Tag'))).toBe(true)
  })
})

// ---- Verify actual public/_headers file has required security rules ----

describe('public/_headers — actual file verification', () => {
  it('public/_headers passes checkHeaders validation (no errors)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const content = readFileSync(resolve(process.cwd(), 'public/_headers'), 'utf-8')
    const errors = checkHeaders(content)
    expect(errors).toEqual([])
  })

  it('public/_headers /* rule includes Referrer-Policy: strict-origin-when-cross-origin (GSI needs the origin)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const content = readFileSync(resolve(process.cwd(), 'public/_headers'), 'utf-8')
    expect(content).toContain('Referrer-Policy: strict-origin-when-cross-origin')
  })

  it('public/_headers /* rule includes X-Robots-Tag: noindex', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const content = readFileSync(resolve(process.cwd(), 'public/_headers'), 'utf-8')
    expect(content).toContain('X-Robots-Tag: noindex')
  })

  it('public/_headers /* rule includes a Content-Security-Policy', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const content = readFileSync(resolve(process.cwd(), 'public/_headers'), 'utf-8')
    expect(content).toContain('Content-Security-Policy:')
  })

  it('public/_headers applies rules to /* wildcard (site-wide)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const content = readFileSync(resolve(process.cwd(), 'public/_headers'), 'utf-8')
    expect(content.trim()).toMatch(/^\/*/)
  })

  it('public/_headers includes Google GSI origins in CSP', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const content = readFileSync(resolve(process.cwd(), 'public/_headers'), 'utf-8')
    expect(content).toContain('https://accounts.google.com/gsi/client')
    expect(content).toContain('https://accounts.google.com/gsi/')
  })
})
