// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { requireAdmin } from './auth.ts'
import type { D1 } from './testDb.ts'

/** ADMIN_TOKEN must be ≥ 32 chars (plan: shorter → 401 misconfigured). */
const VALID_TOKEN = 'this-is-a-valid-32-char-admin-to'

function makeEnv(opts: { adminToken?: string; adminFailLimit?: boolean } = {}) {
  return {
    DB: {} as D1,
    ASSETS: { fetch: async () => new Response('asset') },
    ADMIN_TOKEN: opts.adminToken ?? VALID_TOKEN,
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async (_: { key: string }) => ({ success: opts.adminFailLimit ?? true }) },
  }
}

function req(authHeader?: string, ip = '1.2.3.4') {
  const headers: Record<string, string> = { 'CF-Connecting-IP': ip }
  if (authHeader !== undefined) headers['Authorization'] = authHeader
  return new Request('https://x/api/admin/teachers', { headers })
}

describe('requireAdmin', () => {
  it('returns undefined (passes) when token is correct and rate limit allows', async () => {
    expect(await requireAdmin(req(`Bearer ${VALID_TOKEN}`), makeEnv())).toBeUndefined()
  })

  it('returns 401 when ADMIN_TOKEN env var is missing (empty string)', async () => {
    const r = await requireAdmin(req(`Bearer ${VALID_TOKEN}`), makeEnv({ adminToken: '' }))
    expect(r?.status).toBe(401)
  })

  it('returns 401 when ADMIN_TOKEN is shorter than 32 chars (misconfigured)', async () => {
    const r = await requireAdmin(req('Bearer short'), makeEnv({ adminToken: 'too-short' }))
    expect(r?.status).toBe(401)
  })

  it('returns 401 when Authorization header is absent', async () => {
    const r = await requireAdmin(req(undefined), makeEnv())
    expect(r?.status).toBe(401)
  })

  it('returns 401 when Authorization header has wrong token', async () => {
    const r = await requireAdmin(req('Bearer wrong-token-value-not-valid'), makeEnv())
    expect(r?.status).toBe(401)
  })

  it('returns 401 when Authorization header is not Bearer scheme', async () => {
    const r = await requireAdmin(req(`Basic ${VALID_TOKEN}`), makeEnv())
    expect(r?.status).toBe(401)
  })

  it('returns 429 when ADMIN_FAIL_LIMIT is exhausted, even with a correct token', async () => {
    const r = await requireAdmin(req(`Bearer ${VALID_TOKEN}`), makeEnv({ adminFailLimit: false }))
    expect(r?.status).toBe(429)
  })

  it('error responses carry Cache-Control, X-Content-Type-Options, X-Robots-Tag', async () => {
    const r = await requireAdmin(req(undefined), makeEnv())
    expect(r?.headers.get('Cache-Control')).toBe('no-store')
    expect(r?.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r?.headers.get('X-Robots-Tag')).toBe('noindex')
  })

  it('error response body is JSON with { error } field', async () => {
    const r = await requireAdmin(req(undefined), makeEnv())
    const body = await r?.json() as { error?: string }
    expect(typeof body?.error).toBe('string')
  })
})
