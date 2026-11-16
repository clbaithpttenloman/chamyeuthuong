// @vitest-environment node
/**
 * Tests for handleAdmins — the admin list/add/remove handler.
 * Contract: handleAdmins(request, env, callerEmail): Promise<Response>
 * Routes:   GET  /api/admin/admins          → list
 *           POST /api/admin/admins           → add
 *           DELETE /api/admin/admins/:id     → remove
 * Auth is handled upstream by requireAdmin; callerEmail is the verified caller.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { handleAdmins } from './admins.ts'
import { testDb, type D1 } from './testDb.ts'
import { TEST_EMAIL, TEST_CLIENT_ID } from './testGoogle.ts'

type AdminRow = {
  id: number
  email: string
  created_at: string
  created_by: string
}

const CALLER = TEST_EMAIL

function makeEnv(db: D1) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    AUTH_DEV_MODE: undefined as string | undefined,
    AUTH_DEV_JWKS_URL: undefined as string | undefined,
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined as string | undefined,
    ALLOW_FIRST_CLAIM: undefined as string | undefined,
  }
}

/** Build a request to the admins API. Adds X-Requested-With for non-GET. */
function req(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = {}
  if (method !== 'GET') headers['X-Requested-With'] = 'fetch'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

/** Seed an admin row directly for test setup. */
async function seedAdmin(db: D1, email: string, createdBy = 'bootstrap'): Promise<number> {
  const now = new Date().toISOString()
  await db
    .prepare('INSERT INTO admin (email, created_at, created_by) VALUES (?, ?, ?)')
    .bind(email.toLowerCase().trim(), now, createdBy)
    .run()
  const row = await db.prepare('SELECT id FROM admin WHERE email = ?').bind(email.toLowerCase().trim()).first<{ id: number }>()
  return row!.id
}

let db: D1

beforeEach(() => {
  ;({ db } = testDb())
})

// ---- GET /api/admin/admins — list ----

describe('GET /api/admin/admins', () => {
  it('returns 200 with empty array when no admins', async () => {
    const r = await handleAdmins(req('GET', '/api/admin/admins'), makeEnv(db), CALLER)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('returns all admins with id, email, created_at, created_by', async () => {
    await seedAdmin(db, CALLER, 'bootstrap')

    const r = await handleAdmins(req('GET', '/api/admin/admins'), makeEnv(db), CALLER)
    expect(r.status).toBe(200)
    const list = await r.json() as AdminRow[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ email: CALLER, created_by: 'bootstrap' })
    expect(list[0]).toHaveProperty('id')
    expect(list[0]).toHaveProperty('created_at')
  })

  it('returns multiple admins', async () => {
    await seedAdmin(db, CALLER)
    await seedAdmin(db, 'second@example.com', CALLER)

    const r = await handleAdmins(req('GET', '/api/admin/admins'), makeEnv(db), CALLER)
    const list = await r.json() as AdminRow[]
    expect(list).toHaveLength(2)
  })
})

// ---- POST /api/admin/admins — add ----

describe('POST /api/admin/admins', () => {
  it('adds admin, normalizes to lowercase, sets created_by to callerEmail', async () => {
    const r = await handleAdmins(req('POST', '/api/admin/admins', { email: 'New@Example.COM' }), makeEnv(db), CALLER)
    expect(r.status).toBe(200)
    const body = await r.json() as AdminRow
    expect(body.email).toBe('new@example.com')
    expect(body.created_by).toBe(CALLER)
    expect(body).toHaveProperty('id')
    expect(body).toHaveProperty('created_at')
  })

  it('trims whitespace from email', async () => {
    const r = await handleAdmins(req('POST', '/api/admin/admins', { email: '  user@example.com  ' }), makeEnv(db), CALLER)
    expect(r.status).toBe(200)
    expect((await r.json() as AdminRow).email).toBe('user@example.com')
  })

  it('duplicate email → 409 conflict', async () => {
    await handleAdmins(req('POST', '/api/admin/admins', { email: 'dup@example.com' }), makeEnv(db), CALLER)
    const r = await handleAdmins(req('POST', '/api/admin/admins', { email: 'dup@example.com' }), makeEnv(db), CALLER)
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('conflict')
  })

  it('duplicate email case-insensitive → 409 conflict', async () => {
    await handleAdmins(req('POST', '/api/admin/admins', { email: 'dup@example.com' }), makeEnv(db), CALLER)
    const r = await handleAdmins(req('POST', '/api/admin/admins', { email: 'DUP@EXAMPLE.COM' }), makeEnv(db), CALLER)
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('conflict')
  })

  it('invalid email format (no @) → 400 bad_request', async () => {
    const r = await handleAdmins(req('POST', '/api/admin/admins', { email: 'not-an-email' }), makeEnv(db), CALLER)
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('invalid email format (no TLD) → 400', async () => {
    const r = await handleAdmins(req('POST', '/api/admin/admins', { email: 'a@b' }), makeEnv(db), CALLER)
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('email > 254 chars → 400 bad_request', async () => {
    const longEmail = 'a'.repeat(246) + '@example.com'  // 258 chars
    const r = await handleAdmins(req('POST', '/api/admin/admins', { email: longEmail }), makeEnv(db), CALLER)
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('non-object body (null) → 400 bad_request', async () => {
    const r = await handleAdmins(req('POST', '/api/admin/admins', null), makeEnv(db), CALLER)
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('array body → 400 bad_request', async () => {
    const r = await handleAdmins(req('POST', '/api/admin/admins', []), makeEnv(db), CALLER)
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('extra body fields (id, created_by) are ignored', async () => {
    const r = await handleAdmins(
      req('POST', '/api/admin/admins', { email: 'new@test.com', id: 999, created_by: 'evil' }),
      makeEnv(db),
      CALLER,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as AdminRow
    expect(body.email).toBe('new@test.com')
    expect(body.created_by).toBe(CALLER)
    expect(body.id).not.toBe(999)
  })
})

// ---- DELETE /api/admin/admins/:id — remove ----

describe('DELETE /api/admin/admins/:id', () => {
  it('deletes admin when two exist', async () => {
    await seedAdmin(db, CALLER)
    const otherId = await seedAdmin(db, 'other@example.com', CALLER)

    const r = await handleAdmins(req('DELETE', `/api/admin/admins/${otherId}`), makeEnv(db), CALLER)
    expect(r.status).toBe(200)

    const check = await db.prepare('SELECT id FROM admin WHERE email = ?').bind('other@example.com').first()
    expect(check).toBeNull()
  })

  it('delete last admin → 409 conflict', async () => {
    const id = await seedAdmin(db, CALLER)

    const r = await handleAdmins(req('DELETE', `/api/admin/admins/${id}`), makeEnv(db), CALLER)
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('conflict')
  })

  it('table still has 1 row after failed last-admin delete', async () => {
    const id = await seedAdmin(db, CALLER)
    await handleAdmins(req('DELETE', `/api/admin/admins/${id}`), makeEnv(db), CALLER)
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('unknown id → 404 not_found', async () => {
    const r = await handleAdmins(req('DELETE', '/api/admin/admins/999'), makeEnv(db), CALLER)
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })

  it('self-removal allowed when two admins exist', async () => {
    const myId = await seedAdmin(db, CALLER)
    await seedAdmin(db, 'other@example.com', CALLER)

    const r = await handleAdmins(req('DELETE', `/api/admin/admins/${myId}`), makeEnv(db), CALLER)
    expect(r.status).toBe(200)
    const check = await db.prepare('SELECT id FROM admin WHERE email = ?').bind(CALLER).first()
    expect(check).toBeNull()
  })

  it(':id not matching ^\\d{1,9}$ → 400', async () => {
    for (const bad of ['abc', '0', '1000000000', '-1', '1.5']) {
      const r = await handleAdmins(req('DELETE', `/api/admin/admins/${bad}`), makeEnv(db), CALLER)
      expect(r.status, `expected 400 for id="${bad}"`).toBe(400)
      expect((await r.json() as { error: string }).error).toBe('bad_request')
    }
  })

  it('concurrent deletes of the only two admins — one wins (200) and one gets 409', async () => {
    await seedAdmin(db, CALLER)
    await seedAdmin(db, 'other@example.com', CALLER)
    const row1 = await db.prepare('SELECT id FROM admin WHERE email = ?').bind(CALLER).first<{ id: number }>()
    const row2 = await db.prepare('SELECT id FROM admin WHERE email = ?').bind('other@example.com').first<{ id: number }>()

    const env = makeEnv(db)
    const [r1, r2] = await Promise.all([
      handleAdmins(req('DELETE', `/api/admin/admins/${row1!.id}`), env, CALLER),
      handleAdmins(req('DELETE', `/api/admin/admins/${row2!.id}`), env, 'other@example.com'),
    ])

    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 409])

    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })
})

// ---- Method guard ----

describe('handleAdmins — method guard', () => {
  it('PUT /api/admin/admins → 405 method', async () => {
    const r = await handleAdmins(
      new Request('https://x/api/admin/admins', { method: 'PUT', headers: { 'X-Requested-With': 'fetch' } }),
      makeEnv(db),
      CALLER,
    )
    expect(r.status).toBe(405)
    expect((await r.json() as { error: string }).error).toBe('method')
  })

  it('PATCH /api/admin/admins/:id → 405 method', async () => {
    const r = await handleAdmins(
      new Request('https://x/api/admin/admins/1', { method: 'PATCH', headers: { 'X-Requested-With': 'fetch' } }),
      makeEnv(db),
      CALLER,
    )
    expect(r.status).toBe(405)
    expect((await r.json() as { error: string }).error).toBe('method')
  })

  it('GET /api/admin/admins/:id → 405 method (no single-item GET)', async () => {
    const id = await seedAdmin(db, CALLER)
    const r = await handleAdmins(req('GET', `/api/admin/admins/${id}`), makeEnv(db), CALLER)
    expect(r.status).toBe(405)
  })
})

// ---- Security headers ----

describe('handleAdmins — security headers on all responses', () => {
  it.each([
    ['200 list', async () => handleAdmins(req('GET', '/api/admin/admins'), makeEnv(db), CALLER)],
    ['400 bad_request', async () => handleAdmins(req('POST', '/api/admin/admins', null), makeEnv(db), CALLER)],
    ['405 method', async () => handleAdmins(
      new Request('https://x/api/admin/admins', { method: 'PUT', headers: { 'X-Requested-With': 'fetch' } }),
      makeEnv(db), CALLER,
    )],
  ])('%s has Cache-Control, X-Content-Type-Options, X-Robots-Tag', async (_, makeReqFn) => {
    const r = await makeReqFn()
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex')
  })
})
