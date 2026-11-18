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
import { testDb } from './testDb.ts'

const VALID_TOKEN = 'abc123def456gh78'

type Env = {
  DB: never
  ASSETS: { fetch(request: Request): Promise<Response> }
  PUBLIC_IP_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  SUBMIT_IP_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  CARD_IP_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  ADMIN_FAIL_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  IMAGE_IP_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  BOOTSTRAP_EMAIL?: string
  ALLOW_FIRST_CLAIM?: string
}

function makeEnv(): Env {
  return {
    DB: testDb().db as never, // real schema so routes hit real handlers (no error-swallowing)
    ASSETS: { fetch: async () => new Response('asset') },
    PUBLIC_IP_LIMIT: { limit: async () => ({ success: true }) },
    SUBMIT_IP_LIMIT: { limit: async () => ({ success: true }) },
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined,
    ALLOW_FIRST_CLAIM: undefined,
  }
}

// ---- Existing boundary test (keep) ----

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

// ---- /api/card/* route is REMOVED — failing until Group 2 ----

describe('worker.fetch — /api/card/* → 404 (route removed)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('GET /api/card/<valid-token> → 404 (route removed)', async () => {
    const { db } = testDb()
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind(VALID_TOKEN, 'Teacher', 'Math', now).run()
    const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(VALID_TOKEN).first<{ id: number }>())!.id
    void tid

    const r = await worker.fetch(
      new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      { ...makeEnv(), DB: db as never },
    )
    expect(r.status).toBe(404)
  })
})

// ---- New routes — failing until Group 2 ----

describe('worker.fetch — new public routes (failing until Group 2 adds them to index.ts)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('GET /api/wall → handled (not 404)', async () => {
    // After Group 2: routes to handlePublic → 200 or 429.
    const r = await worker.fetch(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv() as never,
    )
    expect(r.status).toBe(200)
  })

  it('POST /api/cards → handled (not 404)', async () => {
    const r = await worker.fetch(
      new Request('https://x/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
        body: JSON.stringify({ teacherId: 0, templateId: 1, message: 'y' }),
      }),
      makeEnv() as never,
    )
    // non-positive teacherId → 400
    expect(r.status).not.toBe(404)
  })

  it('GET /api/qr/<token> → handled (not 404 from catch-all)', async () => {
    const r = await worker.fetch(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv() as never,
    )
    // unknown token → 404 from qr handler (not from catch-all)
    expect(r.status).toBeLessThan(600)
  })

  it('GET /api/templates → handled (not 404)', async () => {
    const r = await worker.fetch(
      new Request('https://x/api/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv() as never,
    )
    // After Group 2: 200. Currently 404.
    expect(r.status).toBe(200)
  })

  it('GET /api/wishes → handled (not 404)', async () => {
    const r = await worker.fetch(
      new Request('https://x/api/wishes', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv() as never,
    )
    // After Group 2: 200. Currently 404.
    expect(r.status).toBe(200)
  })
})

// ---- OPTIONS on public routes → 405 without Access-Control-* headers (failing until Group 2) ----

describe('worker.fetch — OPTIONS on public routes → 405 without CORS headers (failing until Group 2)', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['/api/wall', '/api/templates', '/api/wishes'])(
    'OPTIONS %s → 405 without Access-Control-* headers (fails until Group 2)',
    async (path) => {
      const r = await worker.fetch(
        new Request(`https://x${path}`, { method: 'OPTIONS', headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
        makeEnv() as never,
      )
      // After Group 2: 405. Currently: 404 from catch-all.
      expect(r.status).toBe(405)
      expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull()
      expect(r.headers.get('Access-Control-Allow-Methods')).toBeNull()
      expect(r.headers.get('Access-Control-Allow-Headers')).toBeNull()
    },
  )

  it('OPTIONS /api/cards → 405 without CORS headers (failing until Group 2)', async () => {
    const r = await worker.fetch(
      new Request('https://x/api/cards', { method: 'OPTIONS', headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv() as never,
    )
    expect(r.status).toBe(405)
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Methods')).toBeNull()
  })
})

// ---- Existing boundary test via card path (kept for reference) ----

describe('worker.fetch — DDL failure returns 503', () => {
  afterEach(() => vi.restoreAllMocks())

  it('GET /api/image/<token> with schema:false + state.fail → 503 { error: "unavailable" }', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db, state, sqlite } = testDb({ schema: false })
    state.fail = true
    const env = { ...makeEnv(), DB: db as never }
    const r = await worker.fetch(
      new Request('https://x/api/image/imgabc1234567890', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      env as never,
    )
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'unavailable' })
    expect(spy).toHaveBeenCalledWith('api: unavailable')
    state.fail = false
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables).toHaveLength(0)
  })
})

// ===================================================================
// New for privacy-about plan — FAILING until Group 2 updates index.ts
// ===================================================================

describe('worker.fetch — /api/teachers/* removed', () => {
  afterEach(() => vi.restoreAllMocks())

  it('GET /api/teachers/<any-id> → 404 (route removed)', async () => {
    const { db } = testDb()
    const now = new Date().toISOString()
    const pubId = 'pub1234567890xyz'
    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind('tok1234567890xyz', 'T', '', now).run()
    const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind('tok1234567890xyz').first<{ id: number }>())!.id
    await db.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)').bind(tid, '', 1).run()

    const r = await worker.fetch(
      new Request(`https://x/api/teachers/${pubId}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      { ...makeEnv(), DB: db as never },
    )
    expect(r.status).toBe(404)
  })
})

describe('worker.fetch — /api/about routes', () => {
  afterEach(() => vi.restoreAllMocks())

  it('GET /api/about → 200', async () => {
    const r = await worker.fetch(
      new Request('https://x/api/about', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv() as never,
    )
    expect(r.status).toBe(200)
  })

  it('GET /api/admin/about → 503 from mock (route is registered, not catch-all 404)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await worker.fetch(
      new Request('https://x/api/admin/about', {
        headers: {
          'CF-Connecting-IP': '1.2.3.4',
          'X-Admin-Email': 'admin@test.com',
          'X-Requested-With': 'fetch',
        },
      }),
      makeEnv() as never,
    )
    // handleAdmin is mocked to throw → 503. If it were 404, the route is not registered.
    expect(r.status).toBe(503)
    spy.mockRestore()
  })
})
