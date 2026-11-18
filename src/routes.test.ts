/**
 * Tests for src/routes.ts
 *
 * ALL tests fail until Group 2 creates routes.ts.
 *
 * Contract expected:
 *   ROUTES: Array<{ path: string; element: unknown }>
 *     — the React Router route definitions array.
 *     - Has no route with path matching /thay-co (teacher page via publicId removed)
 *     - Has /t/:token (private QR page)
 *     - Has / (home), /gui-thiep (send), /ve-clb-ai (about), /admin
 */
import { describe, it, expect } from 'vitest'

// This import fails until Group 2 creates the module → all tests fail
import { ROUTES } from './routes.ts'

describe('ROUTES — /thay-co removed (failing until Group 2)', () => {
  it('has no route with path /thay-co/:publicId — FAILS until Group 2 removes TeacherPage', () => {
    const paths = ROUTES.map((r: { path: string }) => r.path)
    // After Group 2: /thay-co/:publicId route is removed.
    // Before Group 2: routes.ts doesn't exist → import fails → FAIL.
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
