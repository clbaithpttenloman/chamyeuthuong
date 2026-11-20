/**
 * Tests for src/routes.ts
 *
 *
 * Contract expected:
 *   ROUTES: Array<{ path: string; element: unknown }>
 *     — the React Router route definitions array.
 *     - Has no route with path matching /thay-co (teacher page via publicId removed)
 *     - Has /t/:token (private QR page)
 *     - Has / (home), /gui-thiep (send), /ve-clb-ai (about), /admin
 */
import { describe, it, expect } from 'vitest'

import { ROUTES } from './routes.ts'

describe('ROUTES — /thay-co removed', () => {
  it('has no route with path /thay-co/:publicId', () => {
    const paths = ROUTES.map((r: { path: string }) => r.path)
    expect(paths).not.toContain('/thay-co/:publicId')
    expect(paths.some((p: string) => p.startsWith('/thay-co'))).toBe(false)
  })

  it('has /t/:token route (private QR page)', () => {
    const paths = ROUTES.map((r: { path: string }) => r.path)
    expect(paths).toContain('/t/:token')
  })

  it('has / route (home page)', () => {
    const paths = ROUTES.map((r: { path: string }) => r.path)
    expect(paths).toContain('/')
  })

  it('has /gui-thiep route (send flow)', () => {
    const paths = ROUTES.map((r: { path: string }) => r.path)
    expect(paths).toContain('/gui-thiep')
  })

  it('has /ve-clb-ai route (about page)', () => {
    const paths = ROUTES.map((r: { path: string }) => r.path)
    expect(paths).toContain('/ve-clb-ai')
  })

  it('ROUTES is a non-empty array', () => {
    expect(Array.isArray(ROUTES)).toBe(true)
    expect(ROUTES.length).toBeGreaterThan(0)
  })

  it('every route has a string path and an element', () => {
    for (const route of ROUTES) {
      expect(typeof route.path).toBe('string')
      expect(route.element).toBeDefined()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: campaign /:slug route + matchCampaignSlug helper (red phase)
//
// These tests fail until `/:slug` is added to ROUTES and `matchCampaignSlug`
// is exported from routes.ts.  Pre-existing tests above remain green.
//
// FR-3, FR-4, AC-6 (routing side); plan.md § Frontend; requirements.md AC-6.
// ─────────────────────────────────────────────────────────────────────────────

// Lazily retrieve matchCampaignSlug without changing the existing static import.
// Until the export exists, `matchCampaignSlug` will be `undefined` and every
// assertion that calls it will fail — that is the intended red-phase state.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { matchCampaignSlug } = (await import('./routes.ts')) as {
  matchCampaignSlug?: (pathname: string) => string | null
}

describe('ROUTES — /:slug campaign route (Phase 1)', () => {
  it('has /:slug route for campaign home', () => {
    const paths = ROUTES.map((r: { path: string }) => r.path)
    expect(paths).toContain('/:slug')
  })

  it('/:slug sits after all existing named routes in the array (must not shadow them)', () => {
    const paths = ROUTES.map((r: { path: string }) => r.path)
    const slugIdx = paths.indexOf('/:slug')
    expect(slugIdx).toBeGreaterThanOrEqual(0) // route must exist
    expect(slugIdx).toBeGreaterThan(paths.indexOf('/'))
    expect(slugIdx).toBeGreaterThan(paths.indexOf('/admin'))
  })

  // Regression guards — these pass today and confirm existing routes are unchanged
  it('still has / route (home)', () => {
    expect(ROUTES.map((r: { path: string }) => r.path)).toContain('/')
  })
  it('still has /gui-thiep route (send flow)', () => {
    expect(ROUTES.map((r: { path: string }) => r.path)).toContain('/gui-thiep')
  })
  it('still has /t/:token route (private QR)', () => {
    expect(ROUTES.map((r: { path: string }) => r.path)).toContain('/t/:token')
  })
  it('still has /ve-clb-ai route (about)', () => {
    expect(ROUTES.map((r: { path: string }) => r.path)).toContain('/ve-clb-ai')
  })
  it('still has /admin route', () => {
    expect(ROUTES.map((r: { path: string }) => r.path)).toContain('/admin')
  })
})

describe('matchCampaignSlug — valid slugs', () => {
  it('returns "noel" for /noel', () => {
    expect(matchCampaignSlug?.('/noel')).toBe('noel')
  })

  it('returns "20-11" for /20-11', () => {
    expect(matchCampaignSlug?.('/20-11')).toBe('20-11')
  })

  it('returns "noel" for /noel/ (trailing slash accepted)', () => {
    expect(matchCampaignSlug?.('/noel/')).toBe('noel')
  })

  it('returns "ab" for /ab (minimum 2-char slug)', () => {
    expect(matchCampaignSlug?.('/ab')).toBe('ab')
  })

  it('returns a 32-char slug unchanged (maximum length)', () => {
    const slug = 'a'.repeat(32)
    expect(matchCampaignSlug?.(`/${slug}`)).toBe(slug)
  })
})

describe('matchCampaignSlug — reserved slugs → null', () => {
  it.each([
    ['/admin', 'reserved path and React Router route'],
    ['/t', 'reserved route prefix'],
    ['/gui-thiep', 'send-card route'],
    ['/ve-clb-ai', 'about route'],
    ['/api', 'API path prefix'],
    ['/theme', 'theme asset path'],
    ['/assets', 'static asset path'],
  ])('%s returns null (%s)', (pathname, _reason) => {
    expect(matchCampaignSlug?.(pathname)).toBeNull()
  })
})

describe('matchCampaignSlug — invalid slugs → null', () => {
  it('returns null for /Noel (uppercase letters)', () => {
    expect(matchCampaignSlug?.('/Noel')).toBeNull()
  })

  it('returns null for /a (1 char, below 2-char minimum)', () => {
    expect(matchCampaignSlug?.('/a')).toBeNull()
  })

  it('returns null for / (root path, no slug segment)', () => {
    expect(matchCampaignSlug?.('/')).toBeNull()
  })

  it('returns null for /noel/extra (extra path segment, not a slug-only path)', () => {
    expect(matchCampaignSlug?.('/noel/extra')).toBeNull()
  })

  it('returns null for 33-char slug path (exceeds 32-char maximum)', () => {
    expect(matchCampaignSlug?.(`/${'a'.repeat(33)}`)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(matchCampaignSlug?.('')).toBeNull()
  })
})
