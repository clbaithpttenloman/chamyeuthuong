// @vitest-environment node
// vi.mock is hoisted before imports; it replaces ./token.ts so we can control token values in tests.
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./token.ts', () => ({
  newToken: vi.fn(() => 'generatedtoken1234'),
  isToken: (t: string) => /^[a-z0-9]{16}$/.test(t),
}))

import { handleAdmin } from './admin.ts'
import worker from './index.ts'
import { newToken } from './token.ts'
import { testDb, type D1 } from './testDb.ts'
import { TEST_EMAIL } from './testAuth.ts'

type TeacherRow = {
  id: number; token: string; name: string; subject: string
  created_at: string; message: string; status: string
}

// ---- Shared auth fixture ----
// Admin requests carry X-Admin-Email header; no JWT or deps needed.

function makeEnv(db: D1, opts: { adminFailLimit?: boolean } = {}) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async (_: { key: string }) => ({ success: opts.adminFailLimit ?? true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined as string | undefined,
    ALLOW_FIRST_CLAIM: undefined as string | undefined,
  }
}

/**
 * Build an admin request with X-Admin-Email + CF-Connecting-IP headers.
 * X-Requested-With is added for non-GET (CSRF requirement).
 */
function adminReq(method: string, path: string, body?: unknown, ip = '1.2.3.4') {
  const headers: Record<string, string> = {
    'X-Admin-Email': TEST_EMAIL,
    'CF-Connecting-IP': ip,
  }
  // CSRF: every non-GET admin request must carry X-Requested-With: fetch
  if (method !== 'GET') headers['X-Requested-With'] = 'fetch'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

let db: D1
let tokenSeq = 0

beforeEach(async () => {
  ;({ db } = testDb())
  tokenSeq = 0
  vi.mocked(newToken).mockImplementation(() => `gn${String(tokenSeq++).padStart(14, '0')}`)
  // Seed the fixture email as admin so requireAdmin passes (once Group 2 is live).
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO admin (email, created_at, created_by) VALUES (?, ?, ?)')
    .bind(TEST_EMAIL, now, 'test-seed').run()
})

// ---- Teacher list ----

describe('GET /api/admin/teachers', () => {
  it('returns 200 with an empty array when no teachers exist', async () => {
    const r = await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('returns all teachers with card message and status joined', async () => {
    await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Teacher A', subject: 'Math' }), makeEnv(db))
    await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Teacher B', subject: 'Science' }), makeEnv(db))

    const r = await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))
    const list = await r.json() as TeacherRow[]
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ name: 'Teacher A', subject: 'Math', message: '', status: 'draft' })
    expect(list[0]).toHaveProperty('id')
    expect(list[0]).toHaveProperty('token')
    expect(list[0]).toHaveProperty('created_at')
  })
})

// ---- Create teacher ----

describe('POST /api/admin/teachers', () => {
  it('creates a teacher with draft card and returns the record including token', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Nguyen Van A', subject: 'Vietnamese' }), makeEnv(db))
    expect(r.status).toBe(200)
    const body = await r.json() as TeacherRow
    expect(body.name).toBe('Nguyen Van A')
    expect(body.subject).toBe('Vietnamese')
    expect(body.message).toBe('')
    expect(body.status).toBe('draft')
    expect(typeof body.token).toBe('string')
    expect(body.token).toMatch(/^[a-z0-9]{16}$/)
    expect(typeof body.id).toBe('number')
  })

  it('subject is optional and defaults to empty string', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'No Subject' }), makeEnv(db))
    expect(r.status).toBe(200)
    expect((await r.json() as TeacherRow).subject).toBe('')
  })

  it('name is required → 400 when absent', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { subject: 'Math' }), makeEnv(db))
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('name is required → 400 when empty after trim', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: '   ' }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('name > 80 chars → 400', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'A'.repeat(81) }), makeEnv(db))
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('subject > 80 chars → 400', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Valid', subject: 'S'.repeat(81) }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('null body → 400 bad_request', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', null), makeEnv(db))
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_request' })
  })

  it('array body → 400 bad_request', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', []), makeEnv(db))
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_request' })
  })

  it('body > 4 KB without Content-Length is rejected with 413', async () => {
    // Stream 5 KB so there is no Content-Length header
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(1024).fill(0x20))
        c.close()
      },
    })
    const req = new Request('https://x/api/admin/teachers', {
      method: 'POST',
      headers: {
        'X-Admin-Email': TEST_EMAIL,
        'CF-Connecting-IP': '1.2.3.4',
        'Content-Type': 'application/json',
        'X-Requested-With': 'fetch',
      },
      body: stream,
      duplex: 'half',
    } as RequestInit)
    const r = await handleAdmin(req, makeEnv(db))
    expect(r.status).toBe(413)
    expect((await r.json() as { error: string }).error).toBe('too_long')
  })

  it('token UNIQUE collision retries — succeeds on second attempt', async () => {
    // Seed a teacher occupying the first token
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind('gn00000000000000', 'Existing', '', now).run()
    await db.prepare('INSERT INTO card (teacher_id, message, status, updated_at) VALUES (?, ?, ?, ?)')
      .bind(1, '', 'draft', now).run()

    // Reset mock: collision on first try, unique on second
    vi.mocked(newToken)
      .mockReturnValueOnce('gn00000000000000')  // collides
      .mockReturnValueOnce('gn00000000000001')  // succeeds

    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'New Teacher' }), makeEnv(db))
    expect(r.status).toBe(200)
    expect((await r.json() as TeacherRow).token).toBe('gn00000000000001')
  })

  it('token collision exhaust (3 collisions) → 503 unavailable', async () => {
    const now = new Date().toISOString()
    for (let i = 0; i < 3; i++) {
      const tok = `aaaa${String(i).padStart(12, '0')}`
      await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
        .bind(tok, `Teacher ${i}`, '', now).run()
      await db.prepare('INSERT INTO card (teacher_id, message, status, updated_at) VALUES (?, ?, ?, ?)')
        .bind(i + 1, '', 'draft', now).run()
    }

    vi.mocked(newToken)
      .mockReturnValueOnce('aaaa000000000000')
      .mockReturnValueOnce('aaaa000000000001')
      .mockReturnValueOnce('aaaa000000000002')

    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Unlucky' }), makeEnv(db))
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'unavailable' })
  })
})

// ---- Update teacher ----

describe('PUT /api/admin/teachers/:id', () => {
  it('updates name, subject, message and status, returns updated record', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Original' }), makeEnv(db))).json() as TeacherRow
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'Updated', subject: 'Art', message: 'Great teacher!', status: 'published' }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as TeacherRow
    expect(body.name).toBe('Updated')
    expect(body.subject).toBe('Art')
    expect(body.message).toBe('Great teacher!')
    expect(body.status).toBe('published')
  })

  it('token is not updated even if sent in body (mass assignment ignored)', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))).json() as TeacherRow
    await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', message: 'msg', status: 'draft', token: 'malicious0000001' }),
      makeEnv(db),
    )
    const list = await (await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))).json() as TeacherRow[]
    expect(list[0].token).toBe(created.token)
  })

  it('id is not updated even if sent in body (mass assignment ignored)', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))).json() as TeacherRow
    await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', message: 'msg', status: 'draft', id: 999 }),
      makeEnv(db),
    )
    const list = await (await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))).json() as TeacherRow[]
    expect(list[0].id).toBe(created.id)
  })

  it('created_at is not updated even if sent in body (mass assignment ignored)', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))).json() as TeacherRow
    await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', message: 'msg', status: 'draft', created_at: '1970-01-01T00:00:00.000Z' }),
      makeEnv(db),
    )
    const list = await (await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))).json() as TeacherRow[]
    expect(list[0].created_at).toBe(created.created_at)
  })

  it('message > 600 chars → 400', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))).json() as TeacherRow
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', message: 'M'.repeat(601), status: 'draft' }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('invalid status → 400', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))).json() as TeacherRow
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', message: 'msg', status: 'active' }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('unknown teacher id → 404', async () => {
    const r = await handleAdmin(adminReq('PUT', '/api/admin/teachers/999', { name: 'T', subject: '', message: 'msg', status: 'draft' }), makeEnv(db))
    expect(r.status).toBe(404)
  })

  it(':id not matching ^\\d{1,9}$ → 400', async () => {
    for (const bad of ['abc', '0', '1000000000', '-1', '1.5']) {
      const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${bad}`, { name: 'T', subject: '', message: 'msg', status: 'draft' }), makeEnv(db))
      expect(r.status, `expected 400 for id="${bad}"`).toBe(400)
    }
  })

  it('null body → 400 bad_request', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))).json() as TeacherRow
    const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${created.id}`, null), makeEnv(db))
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_request' })
  })

  it('array body → 400 bad_request', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))).json() as TeacherRow
    const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${created.id}`, []), makeEnv(db))
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_request' })
  })

  it('publish with empty (trimmed) message → 400 bad_request', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))).json() as TeacherRow
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', message: '   ', status: 'published' }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_request' })
  })
})

// ---- Rotate token ----

describe('POST /api/admin/teachers/:id/rotate', () => {
  it('replaces token; old token no longer exists in DB', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Rotate Me' }), makeEnv(db))).json() as TeacherRow
    // Publish so the card is accessible
    await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'Rotate Me', subject: '', message: 'msg', status: 'published' }),
      makeEnv(db),
    )

    const r = await handleAdmin(adminReq('POST', `/api/admin/teachers/${created.id}/rotate`), makeEnv(db))
    expect(r.status).toBe(200)
    const body = await r.json() as { token: string }
    expect(body.token).not.toBe(created.token)
    expect(body.token).toMatch(/^[a-z0-9]{16}$/)

    // Old token no longer in DB
    const oldRow = await db.prepare('SELECT id FROM teacher WHERE token = ?').bind(created.token).first()
    expect(oldRow).toBeNull()
  })

  it('unknown teacher id → 404', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers/999/rotate'), makeEnv(db))
    expect(r.status).toBe(404)
  })
})

// ---- Delete teacher ----

describe('DELETE /api/admin/teachers/:id', () => {
  it('deletes teacher and cascades to card', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Del Me' }), makeEnv(db))).json() as TeacherRow

    const r = await handleAdmin(adminReq('DELETE', `/api/admin/teachers/${created.id}`), makeEnv(db))
    expect(r.status).toBe(200)

    // Both teacher and card rows are gone
    expect(await db.prepare('SELECT id FROM teacher WHERE id = ?').bind(created.id).first()).toBeNull()
    expect(await db.prepare('SELECT teacher_id FROM card WHERE teacher_id = ?').bind(created.id).first()).toBeNull()
  })

  it('unknown teacher id → 404', async () => {
    const r = await handleAdmin(adminReq('DELETE', '/api/admin/teachers/999'), makeEnv(db))
    expect(r.status).toBe(404)
  })
})

// ---- Auth guard via handleAdmin ----

describe('admin auth (via handleAdmin)', () => {
  it('no X-Admin-Email header → 401', async () => {
    const req = new Request('https://x/api/admin/teachers', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    expect((await handleAdmin(req, makeEnv(db))).status).toBe(401)
  })

  it('invalid email format in X-Admin-Email → 401', async () => {
    const req = new Request('https://x/api/admin/teachers', {
      headers: { 'X-Admin-Email': 'not-valid', 'CF-Connecting-IP': '1.2.3.4' },
    })
    expect((await handleAdmin(req, makeEnv(db))).status).toBe(401)
  })

  it('ADMIN_FAIL_LIMIT exhausted → 429', async () => {
    expect((await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db, { adminFailLimit: false }))).status).toBe(429)
  })
})

// ---- CSRF guard via handleAdmin ----

describe('CSRF guard (via handleAdmin)', () => {
  it('POST without X-Requested-With: fetch → 403', async () => {
    const req = new Request('https://x/api/admin/teachers', {
      method: 'POST',
      headers: {
        'X-Admin-Email': TEST_EMAIL,
        'CF-Connecting-IP': '1.2.3.4',
        'Content-Type': 'application/json',
        // No X-Requested-With
      },
      body: JSON.stringify({ name: 'T' }),
    })
    expect((await handleAdmin(req, makeEnv(db))).status).toBe(403)
  })

  it('OPTIONS /api/admin/teachers has no Access-Control-* headers and returns 401 (email missing)', async () => {
    // Email check comes before CSRF; without X-Admin-Email → 401, not 403.
    const req = new Request('https://x/api/admin/teachers', {
      method: 'OPTIONS',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        // No X-Admin-Email, No X-Requested-With
      },
    })
    const r = await handleAdmin(req, makeEnv(db))
    expect(r.status).toBe(401)
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Methods')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Headers')).toBeNull()
  })

  it('OPTIONS with valid X-Admin-Email but no X-Requested-With → 403 (no CORS headers emitted)', async () => {
    const req = new Request('https://x/api/admin/teachers', {
      method: 'OPTIONS',
      headers: {
        'X-Admin-Email': TEST_EMAIL,
        'CF-Connecting-IP': '1.2.3.4',
        // No X-Requested-With → CSRF check → 403
      },
    })
    const r = await handleAdmin(req, makeEnv(db))
    expect(r.status).toBe(403)
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Methods')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Headers')).toBeNull()
  })

  it('OPTIONS with X-Admin-Email and X-Requested-With: fetch → 405 (past CSRF, rejected by method guard)', async () => {
    const req = new Request('https://x/api/admin/teachers', {
      method: 'OPTIONS',
      headers: {
        'X-Admin-Email': TEST_EMAIL,
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
      },
    })
    const r = await handleAdmin(req, makeEnv(db))
    expect(r.status).toBe(405)
    expect((await r.json() as { error: string }).error).toBe('method')
  })
})

// ---- Method guard ----

describe('method guard', () => {
  it('PATCH /api/admin/teachers → 405', async () => {
    const req = new Request('https://x/api/admin/teachers', {
      method: 'PATCH',
      headers: {
        'X-Admin-Email': TEST_EMAIL,
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
      },
    })
    const r = await handleAdmin(req, makeEnv(db))
    expect(r.status).toBe(405)
    expect((await r.json() as { error: string }).error).toBe('method')
  })
})

// ---- Security headers on all /api/admin/* responses ----

describe('security headers', () => {
  it.each([
    ['200 list', async () => {
      return handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))
    }],
    ['401 unauthorized', async () => {
      return handleAdmin(new Request('https://x/api/admin/teachers', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    }],
    ['429 rate limited', async () => {
      return handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db, { adminFailLimit: false }))
    }],
    ['405 method', async () => {
      const req = new Request('https://x/api/admin/teachers', {
        method: 'PATCH',
        headers: {
          'X-Admin-Email': TEST_EMAIL,
          'CF-Connecting-IP': '1.2.3.4',
          'X-Requested-With': 'fetch',
        },
      })
      return handleAdmin(req, makeEnv(db))
    }],
  ])('%s has Cache-Control, X-Content-Type-Options, X-Robots-Tag', async (_, makeReqFn) => {
    const r = await makeReqFn()
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex')
  })
})

// ---- Worker routing (via worker/index.ts default export) ----

describe('worker routing', () => {
  it('routes /api/card/:token to the card handler', async () => {
    // No teacher → 404 (not found)
    const r = await worker.fetch(new Request('https://x/api/card/unknowntoken1234', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    expect(r.status).toBe(404)
    expect(r.headers.get('Content-Type')).toContain('application/json')
  })

  it('routes /api/admin/* to the admin handler', async () => {
    const r = await worker.fetch(new Request('https://x/api/admin/teachers', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    expect(r.status).toBe(401)  // no X-Admin-Email header → 401
  })

  it('other /api/* paths return 404 JSON', async () => {
    const r = await worker.fetch(new Request('https://x/api/unknown'), makeEnv(db))
    expect(r.status).toBe(404)
    expect(r.headers.get('Content-Type')).toContain('application/json')
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })

  it('non-/api/* paths fall through to ASSETS', async () => {
    const r = await worker.fetch(new Request('https://x/about'), makeEnv(db))
    expect(await r.text()).toBe('asset')
  })

  it('unexpected exception returns 503 JSON with safe headers', async () => {
    const broken = {
      ...makeEnv(db),
      ADMIN_FAIL_LIMIT: { limit: async () => { throw new Error('binding down') } },
    }
    const req = new Request('https://x/api/admin/teachers', {
      headers: { 'X-Admin-Email': TEST_EMAIL, 'CF-Connecting-IP': '1.2.3.4' },
    })
    const r = await worker.fetch(req, broken)
    expect(r.status).toBe(503)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(await r.json()).toEqual({ error: 'unavailable' })
  })
})

// ---- Admins API routing (unauthenticated → 401) ----

describe('admin admins routing — auth required (via handleAdmin)', () => {
  it('GET /api/admin/admins without X-Admin-Email header → 401', async () => {
    const r = await handleAdmin(
      new Request('https://x/api/admin/admins', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(401)
  })

  it('POST /api/admin/admins without X-Admin-Email header → 401', async () => {
    const r = await handleAdmin(
      new Request('https://x/api/admin/admins', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'x@x.com' }),
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(401)
  })

  it('DELETE /api/admin/admins/1 without X-Admin-Email header → 401', async () => {
    const r = await handleAdmin(
      new Request('https://x/api/admin/admins/1', {
        method: 'DELETE',
        headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Requested-With': 'fetch' },
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(401)
  })
})

// ---- Fix Group 1: W2 — handler-level 503 for DB failures (via handleAdmin + safety wrapper) ----

/** Replicates the index.ts error boundary: propagated throws become 503 {error:'unavailable'}. */
async function safeHandleAdmin(req: Request, env: ReturnType<typeof makeEnv>): Promise<Response> {
  try {
    return await handleAdmin(req, env)
  } catch {
    return new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }
}

describe('handler-level DB failure → 503 (handleAdmin + safety wrapper mirrors index.ts)', () => {
  it('DB state.fail on first request → 503 unavailable, no row inserted, no grant', async () => {
    const { db, state } = testDb()
    state.fail = true
    const env = { ...makeEnv(db), ALLOW_FIRST_CLAIM: '1' as string | undefined }
    const req = new Request('https://x/api/admin/teachers', {
      headers: { 'X-Admin-Email': TEST_EMAIL, 'CF-Connecting-IP': '1.2.3.4' },
    })
    const r = await safeHandleAdmin(req, env)
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'unavailable' })
    state.fail = false
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })

  it('DDL failure (schema:false, state.fail=true) → 503, no tables created, no admin row', async () => {
    const { db, state, sqlite } = testDb({ schema: false })
    state.fail = true
    const env = { ...makeEnv(db), ALLOW_FIRST_CLAIM: '1' as string | undefined }
    const req = new Request('https://x/api/admin/teachers', {
      headers: { 'X-Admin-Email': TEST_EMAIL, 'CF-Connecting-IP': '1.2.3.4', 'X-Requested-With': 'fetch' },
    })
    const r = await safeHandleAdmin(req, env)
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'unavailable' })
    state.fail = false
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables).toHaveLength(0)
  })
})

// ---- Fix Group 1: W4 — router-level /api/admin/admins* (authenticated) ----

describe('admin admins routing — authenticated (via handleAdmin)', () => {
  it('GET /api/admin/admins → 200 JSON array (lists admins after auth)', async () => {
    const r = await handleAdmin(adminReq('GET', '/api/admin/admins'), makeEnv(db))
    expect(r.status).toBe(200)
    const body = await r.json() as unknown[]
    // db has TEST_EMAIL seeded in beforeEach
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
  })

  it('POST /api/admin/admins without X-Requested-With → 403 (CSRF guard)', async () => {
    const req = new Request('https://x/api/admin/admins', {
      method: 'POST',
      headers: {
        'X-Admin-Email': TEST_EMAIL,
        'CF-Connecting-IP': '1.2.3.4',
        'Content-Type': 'application/json',
        // No X-Requested-With
      },
      body: JSON.stringify({ email: 'x@test.com' }),
    })
    const r = await handleAdmin(req, makeEnv(db))
    expect(r.status).toBe(403)
  })

  it('POST /api/admin/admins (authenticated) → 200 with created_by = TEST_EMAIL', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/admins', { email: 'second@example.com' }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { email: string; created_by: string }
    expect(body.email).toBe('second@example.com')
    expect(body.created_by).toBe(TEST_EMAIL)
  })

  it('/api/admin/admins/1/x → 404 not_found (unknown sub-path)', async () => {
    const r = await handleAdmin(adminReq('GET', '/api/admin/admins/1/x'), makeEnv(db))
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })
})

// ===================================================================
// New teacher fields: layout, images, status (failing until Group 2)
// ===================================================================

describe('POST /api/admin/teachers — layout and status (failing until Group 2)', () => {
  it('creates teacher with explicit layout and returns it', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers', { name: 'T', layout: 'lotus' }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { layout: string }).layout).toBe('lotus')
  })

  it('creates teacher with status: published and non-empty message → 200', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers', {
        name: 'T',
        message: 'Chúc mừng ngày Nhà giáo!',
        status: 'published',
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { status: string }).status).toBe('published')
  })

  it('creates teacher with status: published but empty message → 400', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers', { name: 'T', message: '', status: 'published' }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('invalid layout → 400', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers', { name: 'T', layout: 'nonexistent' }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('missing layout defaults to classic', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers', { name: 'T' }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { layout: string }).layout).toBe('classic')
  })

  it('response includes images object (empty when no images set)', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers', { name: 'T' }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { images: Record<string, unknown> }
    expect(typeof body.images).toBe('object')
    expect(Object.keys(body.images)).toHaveLength(0)
  })
})

describe('PUT /api/admin/teachers/:id — layout and images (failing until Group 2)', () => {
  it('updates layout', async () => {
    const created = await (
      await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))
    ).json() as TeacherRow
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, {
        name: 'T', subject: '', message: '', status: 'draft', layout: 'night',
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { layout: string }).layout).toBe('night')
  })

  it('invalid layout on PUT → 400', async () => {
    const created = await (
      await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))
    ).json() as TeacherRow
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, {
        name: 'T', subject: '', message: '', status: 'draft', layout: 'nope',
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('setting an image slot with a valid image id → 200', async () => {
    const created = await (
      await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))
    ).json() as TeacherRow
    // Seed an image
    const now = new Date().toISOString()
    await db
      .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
      .bind('imgabc1234567890', 'x.jpg', 'image/jpeg', 100, 'data', now, TEST_EMAIL)
      .run()
    const imgId = (await db.prepare('SELECT id FROM image WHERE token=?').bind('imgabc1234567890').first<{ id: number }>())!.id

    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, {
        name: 'T', subject: '', message: '', status: 'draft',
        images: { banner: imgId },
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { images: Record<string, { id: number; token: string }> }
    expect(body.images['banner']?.token).toBe('imgabc1234567890')
  })

  it('setting an image slot with unknown image id → 400', async () => {
    const created = await (
      await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))
    ).json() as TeacherRow
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, {
        name: 'T', subject: '', message: '', status: 'draft',
        images: { banner: 9999 },
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('setting images with an unknown slot name → 400', async () => {
    const created = await (
      await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))
    ).json() as TeacherRow
    const now = new Date().toISOString()
    await db
      .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
      .bind('imgabc1234567890', 'x.jpg', 'image/jpeg', 100, 'data', now, TEST_EMAIL)
      .run()
    const imgId = (await db.prepare('SELECT id FROM image WHERE token=?').bind('imgabc1234567890').first<{ id: number }>())!.id
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, {
        name: 'T', subject: '', message: '', status: 'draft',
        images: { badslot: imgId },
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('setting an image slot to null removes it', async () => {
    const created = await (
      await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T' }), makeEnv(db))
    ).json() as TeacherRow
    const now = new Date().toISOString()
    await db
      .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
      .bind('imgabc1234567890', 'x.jpg', 'image/jpeg', 100, 'data', now, TEST_EMAIL)
      .run()
    const imgId = (await db.prepare('SELECT id FROM image WHERE token=?').bind('imgabc1234567890').first<{ id: number }>())!.id
    // Set banner
    await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, {
        name: 'T', subject: '', message: '', status: 'draft', images: { banner: imgId },
      }),
      makeEnv(db),
    )
    // Remove banner by setting to null
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, {
        name: 'T', subject: '', message: '', status: 'draft', images: { banner: null },
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { images: Record<string, unknown> }
    expect(body.images).not.toHaveProperty('banner')
  })
})

// ===================================================================
// Bulk create (failing until Group 2)
// ===================================================================

describe('POST /api/admin/teachers/bulk (failing until Group 2)', () => {
  it('creates 3 teachers in one batch → 200 { created: [...] }', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', {
        items: [{ name: 'T1', subject: 'S1' }, { name: 'T2' }, { name: 'T3', subject: 'S3' }],
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { created: unknown[] }
    expect(Array.isArray(body.created)).toBe(true)
    expect(body.created).toHaveLength(3)
  })

  it('0 items → 400', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', { items: [] }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('101 items → 400', async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ name: `T${i}` }))
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', { items }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('1 item → 200', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', { items: [{ name: 'Solo' }] }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
  })

  it('100 items → 200', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ name: `T${i}` }))
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', { items }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
  })

  it('all-or-nothing: a bad row in the batch → no teachers inserted', async () => {
    const countBefore = (
      await db.prepare('SELECT COUNT(*) as c FROM teacher').first<{ c: number }>()
    )!.c

    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', {
        items: [
          { name: 'Good' },
          { name: '' },  // empty name → validation error triggers rollback
        ],
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)

    const countAfter = (
      await db.prepare('SELECT COUNT(*) as c FROM teacher').first<{ c: number }>()
    )!.c
    expect(countAfter).toBe(countBefore)  // nothing was inserted
  })

  it('body > 64 KB → 413 too_long', async () => {
    const bigStream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 65; i++) c.enqueue(new Uint8Array(1024).fill(0x20))
        c.close()
      },
    })
    const req = new Request('https://x/api/admin/teachers/bulk', {
      method: 'POST',
      headers: {
        'X-Admin-Email': TEST_EMAIL,
        'CF-Connecting-IP': '1.2.3.4',
        'Content-Type': 'application/json',
        'X-Requested-With': 'fetch',
      },
      body: bigStream,
      duplex: 'half',
    } as RequestInit)
    const r = await handleAdmin(req, makeEnv(db))
    expect(r.status).toBe(413)
  })

  it('shared layout applied to every teacher in bulk', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', {
        items: [{ name: 'T1' }, { name: 'T2' }],
        layout: 'spring',
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { created: Array<{ layout: string }> }
    for (const row of body.created) {
      expect(row.layout).toBe('spring')
    }
  })

  it('shared image applied to every teacher in bulk', async () => {
    const now = new Date().toISOString()
    await db
      .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
      .bind('imgabc1234567890', 'x.jpg', 'image/jpeg', 100, 'data', now, TEST_EMAIL)
      .run()
    const imgId = (await db.prepare('SELECT id FROM image WHERE token=?').bind('imgabc1234567890').first<{ id: number }>())!.id

    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', {
        items: [{ name: 'T1' }, { name: 'T2' }],
        images: { banner: imgId },
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { created: Array<{ images: Record<string, { token: string }> }> }
    for (const row of body.created) {
      expect(row.images['banner']?.token).toBe('imgabc1234567890')
    }
  })

  it('unique tokens for every teacher in bulk', async () => {
    // Tokens must be distinct across all created teachers
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', {
        items: [{ name: 'T1' }, { name: 'T2' }, { name: 'T3' }],
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { created: Array<{ token: string }> }
    const tokens = body.created.map((row) => row.token)
    expect(new Set(tokens).size).toBe(tokens.length)
  })
})

// ===================================================================
// Worker routing — /api/image/:token (failing until Group 2)
// ===================================================================

describe('worker routing — /api/image/:token (failing until Group 2)', () => {
  it('routes /api/image/:token to the public image handler (unknown → 404)', async () => {
    const r = await worker.fetch(
      new Request('https://x/api/image/imgabc1234567890', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(404)
    expect(r.headers.get('Content-Type')).toContain('application/json')
  })
})
