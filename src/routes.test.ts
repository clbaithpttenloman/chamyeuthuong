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
