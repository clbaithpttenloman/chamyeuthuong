// @vitest-environment node
/**
 * Tests the real index.ts default export (the Worker entry-point).
 * vi.mock('./admin.ts') replaces handleAdmin with a function that always throws,
 * so the try/catch in index.ts is the only thing between the throw and the caller.
 * Removing that try/catch makes this test fail — which is the whole point.
 */
import { vi, describe, it, expect, afterEach } from 'vitest'

vi.mock('./admin.ts', () => ({
  handleAdmin: vi.fn(() => Promise.reject(new Error('D1_ERROR: index-test'))),
}))

import worker from './index.ts'
import { TEST_TEAM_DOMAIN, TEST_AUD } from './testAccess.ts'

type Env = {
  DB: never
  ASSETS: { fetch(request: Request): Promise<Response> }
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  ACCESS_DEV_MODE?: string
  CARD_IP_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  ADMIN_FAIL_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  BOOTSTRAP_EMAIL?: string
  ALLOW_FIRST_CLAIM?: string
}

function makeEnv(): Env {
  return {
    DB: {} as never,
    ASSETS: { fetch: async () => new Response('asset') },
    ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
    ACCESS_AUD: TEST_AUD,
    ACCESS_DEV_MODE: undefined,
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined,
    ALLOW_FIRST_CLAIM: undefined,
  }
}

describe('worker index — catch boundary (real index.ts)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('handleAdmin throws → 503 { error: "unavailable" }, logs "api: unavailable"', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const req = new Request('https://x/api/admin/teachers', {
      method: 'GET',
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    })
    const r = await worker.fetch(req, makeEnv() as never)
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'unavailable' })
    expect(spy).toHaveBeenCalledWith('api: unavailable')
  })
})
