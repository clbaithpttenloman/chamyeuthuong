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

/** Must be ≥ 32 chars (plan: shorter → 401). */
const ADMIN_TOKEN = 'this-is-a-valid-32-char-admin-to'

type TeacherRow = {
  id: number; token: string; name: string; subject: string
  created_at: string; message: string; status: string
}

function makeEnv(db: D1, opts: { adminToken?: string; adminFailLimit?: boolean } = {}) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    ADMIN_TOKEN: opts.adminToken ?? ADMIN_TOKEN,
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async (_: { key: string }) => ({ success: opts.adminFailLimit ?? true }) },
  }
}

function adminReq(method: string, path: string, body?: unknown, ip = '1.2.3.4') {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    'CF-Connecting-IP': ip,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

let db: D1
let tokenSeq = 0

beforeEach(() => {
  ;({ db } = testDb())
  tokenSeq = 0
  vi.mocked(newToken).mockImplementation(() => `gn${String(tokenSeq++).padStart(14, '0')}`)
})

// ---- Teacher list ----

describe('GET /api/admin/teachers', () => {
  it('returns 200 with an empty array when no teachers exist', async () => {
    const r = await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('returns all teachers with card message and status joined', async () => {
    // Create two teachers
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
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'CF-Connecting-IP': '1.2.3.4', 'Content-Type': 'application/json' },
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
  it('missing Authorization header → 401', async () => {
    const req = new Request('https://x/api/admin/teachers', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    expect((await handleAdmin(req, makeEnv(db))).status).toBe(401)
  })

  it('wrong token → 401', async () => {
    const req = new Request('https://x/api/admin/teachers', {
      headers: { Authorization: 'Bearer wrong-token-value-not-valid', 'CF-Connecting-IP': '1.2.3.4' },
    })
    expect((await handleAdmin(req, makeEnv(db))).status).toBe(401)
  })

  it('ADMIN_FAIL_LIMIT exhausted with valid token → 429', async () => {
    expect((await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db, { adminFailLimit: false }))).status).toBe(429)
  })
})

// ---- Method guard ----

describe('method guard', () => {
  it('PATCH /api/admin/teachers → 405', async () => {
    const r = await handleAdmin(adminReq('PATCH', '/api/admin/teachers'), makeEnv(db))
    expect(r.status).toBe(405)
    expect((await r.json() as { error: string }).error).toBe('method')
  })
})

// ---- Security headers on all /api/admin/* responses ----

describe('security headers', () => {
  it.each([
    ['200 list',          () => handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))],
    ['401 unauthorized',  () => handleAdmin(new Request('https://x/api/admin/teachers', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))],
    ['429 rate limited',  () => handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db, { adminFailLimit: false }))],
    ['405 method',        () => handleAdmin(adminReq('PATCH', '/api/admin/teachers'), makeEnv(db))],
  ])('%s has Cache-Control, X-Content-Type-Options, X-Robots-Tag', async (_, makeReq) => {
    const r = await makeReq()
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
    expect(r.status).toBe(401)  // no auth header → 401
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
    const r = await worker.fetch(adminReq('GET', '/api/admin/teachers'), broken)
    expect(r.status).toBe(503)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(await r.json()).toEqual({ error: 'unavailable' })
  })
})
