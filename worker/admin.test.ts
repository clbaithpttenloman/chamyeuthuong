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

// New teacher model (plan § Decision: Admin API)
type AdminTeacher = {
  id: number
  token: string
  title: 'Thầy' | 'Cô' | null
  name: string
  subject: string
  department: string
  role: string
  showOnHome: 0 | 1
  cardCounts: { pending: number; approved: number; hidden: number }
  created_at: string
}

function makeEnv(db: D1, opts: { adminFailLimit?: boolean } = {}) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    PUBLIC_IP_LIMIT: { limit: async () => ({ success: true }) },
    SUBMIT_IP_LIMIT: { limit: async () => ({ success: true }) },
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async (_: { key: string }) => ({ success: opts.adminFailLimit ?? true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined as string | undefined,
    ALLOW_FIRST_CLAIM: undefined as string | undefined,
  }
}

function adminReq(method: string, path: string, body?: unknown, ip = '1.2.3.4') {
  const headers: Record<string, string> = {
    'X-Admin-Email': TEST_EMAIL,
    'CF-Connecting-IP': ip,
  }
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
  vi.mocked(newToken).mockReset()  // clear any leftover one-time values between tests
  vi.mocked(newToken).mockImplementation(() => `gn${String(tokenSeq++).padStart(14, '0')}`)
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

  it('returns all teachers in the new model shape (token, department, showOnHome, cardCounts)', async () => {
    await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Teacher A', subject: 'Math', title: 'Thầy' }), makeEnv(db))
    const r = await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))
    expect(r.status).toBe(200)
    const list = await r.json() as AdminTeacher[]
    expect(list).toHaveLength(1)
    expect(list[0]).toHaveProperty('department')
    expect(list[0]).toHaveProperty('showOnHome')
    expect(list[0]).toHaveProperty('cardCounts')
    expect(list[0]).toHaveProperty('id')
    expect(list[0]).toHaveProperty('token')
    expect(list[0]).toHaveProperty('created_at')
    expect(list[0]).not.toHaveProperty('publicId')
  })
})

// ---- Create teacher ----

describe('POST /api/admin/teachers', () => {
  it('creates a teacher and returns AdminTeacher shape (token, cardCounts, department, showOnHome)', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Nguyen Van A', subject: 'Vietnamese', title: 'Thầy' }), makeEnv(db))
    expect(r.status).toBe(200)
    const body = await r.json() as AdminTeacher
    expect(body.name).toBe('Nguyen Van A')
    expect(body.subject).toBe('Vietnamese')
    expect(typeof body.token).toBe('string')
    expect(body.token).toMatch(/^[a-z0-9]{16}$/)
    expect(typeof body.id).toBe('number')
    // No publicId in response
    expect((body as Record<string, unknown>)).not.toHaveProperty('publicId')
    expect(body.department).toBe('')
    expect(body.showOnHome).toBe(1)
    expect(body.cardCounts).toEqual({ pending: 0, approved: 0, hidden: 0 })
  })

  it('subject is optional and defaults to empty string', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'No Subject', title: 'Cô' }), makeEnv(db))
    expect(r.status).toBe(200)
    expect((await r.json() as AdminTeacher).subject).toBe('')
  })

  it('department can be set on create', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy', department: 'Khoa học' }), makeEnv(db))
    expect(r.status).toBe(200)
    expect((await r.json() as AdminTeacher).department).toBe('Khoa học')
  })

  it('showOnHome can be set on create (0 → hidden from wall)', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy', showOnHome: 0 }), makeEnv(db))
    expect(r.status).toBe(200)
    expect((await r.json() as AdminTeacher).showOnHome).toBe(0)
  })

  it('name is required → 400 when absent', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { subject: 'Math', title: 'Thầy' }), makeEnv(db))
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('name is required → 400 when empty after trim', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: '   ', title: 'Thầy' }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('name > 80 chars → 400', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'A'.repeat(81), title: 'Thầy' }), makeEnv(db))
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('subject > 80 chars → 400', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Valid', subject: 'S'.repeat(81), title: 'Thầy' }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('department > 80 chars → 400', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Valid', title: 'Thầy', department: 'D'.repeat(81) }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('showOnHome: 2 → 400 (strict 0|1 only)', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy', showOnHome: 2 }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('showOnHome: true → 400 (strict 0|1 only)', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy', showOnHome: true }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('showOnHome: "0" → 400 (strict 0|1 only)', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy', showOnHome: '0' }), makeEnv(db))
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
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind('gn00000000000000', 'Existing', '', now).run()

    vi.mocked(newToken)
      .mockReturnValueOnce('gn00000000000000')  // collides on token
      .mockReturnValueOnce('gn00000000000001')  // token succeeds

    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'New Teacher', title: 'Thầy' }), makeEnv(db))
    expect(r.status).toBe(200)
    expect((await r.json() as AdminTeacher).token).toBe('gn00000000000001')
  })

  it('token collision exhaust (3 collisions) → 503 unavailable', async () => {
    const now = new Date().toISOString()
    for (let i = 0; i < 3; i++) {
      const tok = `aaaa${String(i).padStart(12, '0')}`
      await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
        .bind(tok, `Teacher ${i}`, '', now).run()
    }

    vi.mocked(newToken)
      .mockReturnValueOnce('aaaa000000000000')
      .mockReturnValueOnce('aaaa000000000001')
      .mockReturnValueOnce('aaaa000000000002')

    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Unlucky', title: 'Thầy' }), makeEnv(db))
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'unavailable' })
  })
})

// ---- Update teacher ----

describe('PUT /api/admin/teachers/:id', () => {
  it('updates name, subject, department, showOnHome; returns updated AdminTeacher', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Original', title: 'Thầy' }), makeEnv(db))).json() as AdminTeacher
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'Updated', subject: 'Art', department: 'Khoa học', showOnHome: 0 }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as AdminTeacher
    expect(body.name).toBe('Updated')
    expect(body.subject).toBe('Art')
    expect(body.department).toBe('Khoa học')
    expect(body.showOnHome).toBe(0)
  })

  it('token is not updated even if sent in body (mass assignment ignored)', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy' }), makeEnv(db))).json() as AdminTeacher
    await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', token: 'malicious0000001' }),
      makeEnv(db),
    )
    const list = await (await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))).json() as AdminTeacher[]
    expect(list[0].token).toBe(created.token)
  })

  it('id is not updated even if sent in body (mass assignment ignored)', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy' }), makeEnv(db))).json() as AdminTeacher
    await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', id: 999 }),
      makeEnv(db),
    )
    const list = await (await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))).json() as AdminTeacher[]
    expect(list[0].id).toBe(created.id)
  })

  it('created_at is not updated even if sent in body (mass assignment ignored)', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy' }), makeEnv(db))).json() as AdminTeacher
    await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', created_at: '1970-01-01T00:00:00.000Z' }),
      makeEnv(db),
    )
    const list = await (await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))).json() as AdminTeacher[]
    expect(list[0].created_at).toBe(created.created_at)
  })

  it('unknown teacher id → 404', async () => {
    const r = await handleAdmin(adminReq('PUT', '/api/admin/teachers/999', { name: 'T', subject: '' }), makeEnv(db))
    expect(r.status).toBe(404)
  })

  it(':id not matching ^\\d{1,9}$ → 400', async () => {
    for (const bad of ['abc', '0', '1000000000', '-1', '1.5']) {
      const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${bad}`, { name: 'T', subject: '' }), makeEnv(db))
      expect(r.status, `expected 400 for id="${bad}"`).toBe(400)
    }
  })

  it('null body → 400 bad_request', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy' }), makeEnv(db))).json() as AdminTeacher
    const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${created.id}`, null), makeEnv(db))
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_request' })
  })

  it('array body → 400 bad_request', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy' }), makeEnv(db))).json() as AdminTeacher
    const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${created.id}`, []), makeEnv(db))
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_request' })
  })

  it('department > 80 chars in PUT → 400', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy' }), makeEnv(db))).json() as AdminTeacher
    const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', department: 'D'.repeat(81) }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('PUT without showOnHome keeps existing showOnHome value', async () => {
    // Create with showOnHome=0
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy', showOnHome: 0 }), makeEnv(db))).json() as AdminTeacher
    expect(created.showOnHome).toBe(0)
    // PUT without showOnHome — existing 0 should be preserved
    const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T2', subject: '' }), makeEnv(db))
    expect(r.status).toBe(200)
    expect((await r.json() as AdminTeacher).showOnHome).toBe(0)
  })

  it('PUT without department keeps existing department value', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy', department: 'Khoa học' }), makeEnv(db))).json() as AdminTeacher
    expect(created.department).toBe('Khoa học')
    // PUT without department — existing value should be preserved
    const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T2', subject: '' }), makeEnv(db))
    expect(r.status).toBe(200)
    expect((await r.json() as AdminTeacher).department).toBe('Khoa học')
  })

  it('PUT without subject keeps existing subject value', async () => {
    // Create with a non-empty subject
    const created = await (
      await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy', subject: 'Toán' }), makeEnv(db))
    ).json() as AdminTeacher
    expect(created.subject).toBe('Toán')

    // PUT omitting subject — 'Toán' must be preserved
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T2' }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    // Before fix: finalSubject falls back to '' → subject reset. After fix: 'Toán' kept.
    expect((await r.json() as AdminTeacher).subject).toBe('Toán')
  })

  it('PUT showOnHome: 2 → 400 (strict 0|1 only)', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy' }), makeEnv(db))).json() as AdminTeacher
    const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', showOnHome: 2 }), makeEnv(db))
    expect(r.status).toBe(400)
  })
})

// ---- Rotate token ----

describe('POST /api/admin/teachers/:id/rotate', () => {
  it('replaces token; old token no longer in DB', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Rotate Me', title: 'Thầy' }), makeEnv(db))).json() as AdminTeacher
    const r = await handleAdmin(adminReq('POST', `/api/admin/teachers/${created.id}/rotate`), makeEnv(db))
    expect(r.status).toBe(200)
    const body = await r.json() as { token: string }
    // token CHANGES
    expect(body.token).not.toBe(created.token)
    expect(body.token).toMatch(/^[a-z0-9]{16}$/)
    // No publicId in rotate response (column removed)
    expect((body as Record<string, unknown>)).not.toHaveProperty('publicId')
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
  it('deletes teacher and cascades to teacher_profile, teacher_title, student_card', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'Del Me', title: 'Thầy' }), makeEnv(db))).json() as AdminTeacher
    const r = await handleAdmin(adminReq('DELETE', `/api/admin/teachers/${created.id}`), makeEnv(db))
    expect(r.status).toBe(200)
    // Teacher row is gone
    expect(await db.prepare('SELECT id FROM teacher WHERE id = ?').bind(created.id).first()).toBeNull()
    const profile = await db.prepare('SELECT teacher_id FROM teacher_profile WHERE teacher_id = ?').bind(created.id).first()
    expect(profile).toBeNull()
    // teacher_title is gone (CASCADE)
    const title = await db.prepare('SELECT teacher_id FROM teacher_title WHERE teacher_id = ?').bind(created.id).first()
    expect(title).toBeNull()
  })

  it('unknown teacher id → 404', async () => {
    const r = await handleAdmin(adminReq('DELETE', '/api/admin/teachers/999'), makeEnv(db))
    expect(r.status).toBe(404)
  })
})

// ---- Title field tests ----

describe('POST /api/admin/teachers — title field', () => {
  it('title missing → 400 bad_request', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers', { name: 'Nguyễn Văn A', subject: 'Toán' }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('title invalid (not Thầy/Cô) → 400 bad_request', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers', { name: 'Nguyễn Văn A', title: 'giáo viên' }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('title=Thầy → 200, response includes title=Thầy', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers', { name: 'Nguyễn Văn A', title: 'Thầy' }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as AdminTeacher).title).toBe('Thầy')
  })

  it('title=Cô → 200, response includes title=Cô', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers', { name: 'Trần Thị B', title: 'Cô' }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as AdminTeacher).title).toBe('Cô')
  })
})

describe('GET /api/admin/teachers — title field in list', () => {
  it('list includes title field for each teacher', async () => {
    await handleAdmin(
      adminReq('POST', '/api/admin/teachers', { name: 'T1', title: 'Thầy' }),
      makeEnv(db),
    )
    const r = await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))
    expect(r.status).toBe(200)
    const list = await r.json() as AdminTeacher[]
    expect(list).toHaveLength(1)
    expect(list[0]).toHaveProperty('title')
    expect(list[0].title).toBe('Thầy')
  })

  it('teacher without title row has title=null in list', async () => {
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind('notitletoken001', 'No Title', '', now).run()
    // No profile/title rows: the admin list must still show this teacher (LEFT JOINs).
    const r = await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))
    const list = await r.json() as AdminTeacher[]
    const t = list.find((x) => x.token === 'notitletoken001')
    expect(t).toBeDefined()
    expect(t!.title).toBeNull()
  })
})

describe('PUT /api/admin/teachers/:id — title field', () => {
  it('PUT with title=Thầy updates title, response includes title=Thầy', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy' }), makeEnv(db))).json() as AdminTeacher
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', title: 'Cô' }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as AdminTeacher).title).toBe('Cô')
  })

  it('PUT without title field leaves title unchanged', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Cô' }), makeEnv(db))).json() as AdminTeacher
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '' }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as AdminTeacher).title).toBe('Cô')
  })

  it('PUT with invalid title → 400', async () => {
    const created = await (await handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'T', title: 'Thầy' }), makeEnv(db))).json() as AdminTeacher
    const r = await handleAdmin(
      adminReq('PUT', `/api/admin/teachers/${created.id}`, { name: 'T', subject: '', title: 'invalid' }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })
})

// ---- Bulk create (new structured items format) ----

describe('POST /api/admin/teachers/bulk — structured items format', () => {
  // Format: { items: [{ title, name, subject?, department? }] }

  it('creates 3 teachers in one batch → 200 { created: [...] }', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', {
        items: [
          { title: 'Thầy', name: 'Nguyễn Văn A', subject: 'Toán', department: 'Tổ Toán' },
          { title: 'Cô', name: 'Trần Thị B', subject: 'Lý' },
          { title: 'Thầy', name: 'Lê Văn C', subject: 'Hóa', department: 'Tổ Hóa-Sinh' },
        ],
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { created: AdminTeacher[] }
    expect(Array.isArray(body.created)).toBe(true)
    expect(body.created).toHaveLength(3)
  })

  it('0 items → 400', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers/bulk', { items: [] }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('101 items → 400', async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      title: i % 2 === 0 ? 'Thầy' : 'Cô',
      name: `Teacher${i}`,
      subject: `Môn${i}`,
    }))
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers/bulk', { items }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('1 item → 200', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers/bulk', {
      items: [{ title: 'Cô', name: 'Trần Thị B', subject: 'Văn' }],
    }), makeEnv(db))
    expect(r.status).toBe(200)
    const body = await r.json() as { created: AdminTeacher[] }
    expect(body.created).toHaveLength(1)
    expect(body.created[0].title).toBe('Cô')
  })

  it('100 items → 200', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      title: i % 2 === 0 ? 'Thầy' : 'Cô',
      name: `Teacher${i}`,
      subject: `Môn${i}`,
    }))
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers/bulk', { items }), makeEnv(db))
    expect(r.status).toBe(200)
    const body = await r.json() as { created: AdminTeacher[] }
    expect(body.created).toHaveLength(100)
  })

  it('invalid title in item → 400, nothing inserted (all-or-nothing)', async () => {
    const countBefore = (await db.prepare('SELECT COUNT(*) as c FROM teacher').first<{ c: number }>())!.c
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', {
        items: [
          { title: 'Thầy', name: 'Valid Teacher', subject: 'Toán' },
          { title: 'invalid', name: 'Other', subject: 'Môn' },
        ],
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
    const countAfter = (await db.prepare('SELECT COUNT(*) as c FROM teacher').first<{ c: number }>())!.c
    expect(countAfter).toBe(countBefore)
  })

  it('unique tokens for every teacher in bulk', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', {
        items: [
          { title: 'Thầy', name: 'T1', subject: 'Toán' },
          { title: 'Cô', name: 'T2', subject: 'Lý' },
          { title: 'Thầy', name: 'T3', subject: 'Hóa' },
        ],
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { created: AdminTeacher[] }
    const tokens = body.created.map((row) => row.token)
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  it('department is set from items when present', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', {
        items: [{ title: 'Thầy', name: 'Nguyễn Văn A', subject: 'Toán', department: 'Tổ Toán-Lý' }],
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { created: AdminTeacher[] }
    expect(body.created[0].department).toBe('Tổ Toán-Lý')
  })

  it('body > 64 KB → 413 too_long', async () => {
    const bigStream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 65; i++) c.enqueue(new Uint8Array(1024).fill(0x20))
        c.close()
      },
    })
    const req2 = new Request('https://x/api/admin/teachers/bulk', {
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
    const r = await handleAdmin(req2, makeEnv(db))
    expect(r.status).toBe(413)
  })

  it('token UNIQUE collision on first attempt → retry succeeds → 200', async () => {
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind('collision00000001', 'Existing', '', now).run()

    vi.mocked(newToken)
      .mockReturnValueOnce('collision00000001')  // token: collision
      .mockReturnValueOnce('newtoken000000001')  // token: success

    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', { items: [{ title: 'Cô', name: 'Retry', subject: 'Văn' }] }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { created: AdminTeacher[] }
    expect(body.created[0].token).toBe('newtoken000000001')
  })

  it('name > 80 chars in bulk item → 400', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', {
        items: [{ title: 'Thầy', name: 'A'.repeat(81), subject: 'Toán' }],
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('subject > 80 chars in bulk item → 400', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', {
        items: [{ title: 'Thầy', name: 'Valid', subject: 'S'.repeat(81) }],
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('department > 80 chars in bulk item → 400', async () => {
    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', {
        items: [{ title: 'Thầy', name: 'Valid', subject: 'Toán', department: 'D'.repeat(81) }],
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
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

  it('PUT /api/admin/about without X-Admin-Email → 401', async () => {
    const req = new Request('https://x/api/admin/about', {
      method: 'PUT',
      headers: { 'CF-Connecting-IP': '1.2.3.4', 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: '{}',
    })
    expect((await handleAdmin(req, makeEnv(db))).status).toBe(401)
  })

  it('ADMIN_FAIL_LIMIT exhausted → 429', async () => {
    expect((await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db, { adminFailLimit: false }))).status).toBe(429)
  })
})

// ---- CSRF guard via handleAdmin ----

describe('CSRF guard (via handleAdmin)', () => {
  it('PUT /api/admin/about without X-Requested-With: fetch → 403', async () => {
    const req = new Request('https://x/api/admin/about', {
      method: 'PUT',
      headers: { 'X-Admin-Email': TEST_EMAIL, 'CF-Connecting-IP': '1.2.3.4', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect((await handleAdmin(req, makeEnv(db))).status).toBe(403)
  })

  it('POST without X-Requested-With: fetch → 403', async () => {
    const req = new Request('https://x/api/admin/teachers', {
      method: 'POST',
      headers: {
        'X-Admin-Email': TEST_EMAIL,
        'CF-Connecting-IP': '1.2.3.4',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'T' }),
    })
    expect((await handleAdmin(req, makeEnv(db))).status).toBe(403)
  })

  it('OPTIONS /api/admin/teachers has no Access-Control-* headers and returns 401 (email missing)', async () => {
    const req = new Request('https://x/api/admin/teachers', {
      method: 'OPTIONS',
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
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
      headers: { 'X-Admin-Email': TEST_EMAIL, 'CF-Connecting-IP': '1.2.3.4' },
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
      headers: { 'X-Admin-Email': TEST_EMAIL, 'CF-Connecting-IP': '1.2.3.4', 'X-Requested-With': 'fetch' },
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
      headers: { 'X-Admin-Email': TEST_EMAIL, 'CF-Connecting-IP': '1.2.3.4', 'X-Requested-With': 'fetch' },
    })
    const r = await handleAdmin(req, makeEnv(db))
    expect(r.status).toBe(405)
    expect((await r.json() as { error: string }).error).toBe('method')
  })
})

// ---- Security headers on all /api/admin/* responses ----

describe('security headers', () => {
  it.each([
    ['200 list', async () => handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))],
    ['401 unauthorized', async () => handleAdmin(new Request('https://x/api/admin/teachers', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))],
    ['429 rate limited', async () => handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db, { adminFailLimit: false }))],
    ['405 method', async () => {
      const req = new Request('https://x/api/admin/teachers', {
        method: 'PATCH',
        headers: { 'X-Admin-Email': TEST_EMAIL, 'CF-Connecting-IP': '1.2.3.4', 'X-Requested-With': 'fetch' },
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
  it('routes /api/admin/* to the admin handler', async () => {
    const r = await worker.fetch(new Request('https://x/api/admin/teachers', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    expect(r.status).toBe(401)  // no X-Admin-Email header → 401
  })

  it('/api/card/* → 404 (endpoint removed)', async () => {
    // We seed a teacher+card to prove the difference.
    const { db: freshDb } = testDb()
    const now = new Date().toISOString()
    await freshDb.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind('tok1234567890abc', 'T', '', now).run()
    const tid = (await freshDb.prepare('SELECT id FROM teacher WHERE token=?').bind('tok1234567890abc').first<{ id: number }>())!.id
    void tid // a known teacher token must not resurrect the removed /api/card route
    const r = await worker.fetch(
      new Request('https://x/api/card/tok1234567890ab', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      { ...makeEnv(freshDb), DB: freshDb as never },
    )
    expect(r.status).toBe(404)
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

// ---- DB failure → 503 ----

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
  it('DB state.fail on first request → 503 unavailable', async () => {
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

  it('DDL failure (schema:false, state.fail=true) → 503, no tables created', async () => {
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

// ---- Admins API — authenticated ----

describe('admin admins routing — authenticated (via handleAdmin)', () => {
  it('GET /api/admin/admins → 200 JSON array (lists admins after auth)', async () => {
    const r = await handleAdmin(adminReq('GET', '/api/admin/admins'), makeEnv(db))
    expect(r.status).toBe(200)
    const body = await r.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
  })

  it('POST /api/admin/admins without X-Requested-With → 403 (CSRF guard)', async () => {
    const req = new Request('https://x/api/admin/admins', {
      method: 'POST',
      headers: { 'X-Admin-Email': TEST_EMAIL, 'CF-Connecting-IP': '1.2.3.4', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@test.com' }),
    })
    const r = await handleAdmin(req, makeEnv(db))
    expect(r.status).toBe(403)
  })

  it('POST /api/admin/admins (authenticated) → 200 with created_by = TEST_EMAIL', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/admins', { email: 'second@example.com' }), makeEnv(db))
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

// ---- Worker routing — /api/image/:token ----

describe('worker routing — /api/image/:token', () => {
  it('routes /api/image/:token to the public image handler (unknown → 404)', async () => {
    const r = await worker.fetch(
      new Request('https://x/api/image/imgabc1234567890', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(404)
    expect(r.headers.get('Content-Type')).toContain('application/json')
  })
})

// ---- Chức vụ (role) ----

describe('teacher role (chức vụ)', () => {
  const create = async (body: Record<string, unknown>) =>
    handleAdmin(adminReq('POST', '/api/admin/teachers', { name: 'A', title: 'Thầy', ...body }), makeEnv(db))

  it('create without role → Giáo viên', async () => {
    const r = await create({})
    expect(r.status).toBe(200)
    expect(((await r.json()) as AdminTeacher).role).toBe('Giáo viên')
  })

  it('create with each valid role → stored and returned', async () => {
    for (const role of ['Giáo viên', 'Hiệu trưởng', 'Phó hiệu trưởng']) {
      const r = await create({ role })
      expect(r.status).toBe(200)
      expect(((await r.json()) as AdminTeacher).role).toBe(role)
    }
  })

  it('create with an invalid role → 400 (null, other strings, NFD form, non-strings)', async () => {
    for (const role of [null, '', 'Hieu truong', 'hiệu trưởng', ' Hiệu trưởng', 'Hie\u0323\u0302u trưởng', 1, ['Hiệu trưởng'], {}]) {
      expect((await create({ role })).status).toBe(400)
    }
  })

  it('update sets the role', async () => {
    const t = (await (await create({})).json()) as AdminTeacher
    const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${t.id}`, { name: 'A', role: 'Hiệu trưởng' }), makeEnv(db))
    expect(r.status).toBe(200)
    expect(((await r.json()) as AdminTeacher).role).toBe('Hiệu trưởng')
  })

  it('update without role keeps the existing role', async () => {
    const t = (await (await create({ role: 'Phó hiệu trưởng' })).json()) as AdminTeacher
    const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${t.id}`, { name: 'B', department: 'Tổ Văn' }), makeEnv(db))
    expect(((await r.json()) as AdminTeacher).role).toBe('Phó hiệu trưởng')
  })

  it('update with an invalid role → 400 and role unchanged', async () => {
    const t = (await (await create({ role: 'Hiệu trưởng' })).json()) as AdminTeacher
    for (const role of [null, 'x', 2]) {
      const r = await handleAdmin(adminReq('PUT', `/api/admin/teachers/${t.id}`, { name: 'A', role }), makeEnv(db))
      expect(r.status).toBe(400)
    }
    const list = (await (await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))).json()) as AdminTeacher[]
    expect(list[0].role).toBe('Hiệu trưởng')
  })

  it('teacher with no teacher_profile row → listed as Giáo viên; update without role inserts the default', async () => {
    await db.prepare("INSERT INTO teacher (id, token, name, subject, created_at) VALUES (50, 'tok5034567890abc', 'Old', '', '2026-11-01')").run()
    const list = (await (await handleAdmin(adminReq('GET', '/api/admin/teachers'), makeEnv(db))).json()) as AdminTeacher[]
    expect(list.find((t) => t.id === 50)!.role).toBe('Giáo viên')
    const r = await handleAdmin(adminReq('PUT', '/api/admin/teachers/50', { name: 'Old' }), makeEnv(db))
    expect(((await r.json()) as AdminTeacher).role).toBe('Giáo viên')
  })

  it('bulk create → every item Giáo viên; a per-item role is ignored', async () => {
    const r = await handleAdmin(adminReq('POST', '/api/admin/teachers/bulk', {
      items: [{ title: 'Thầy', name: 'X' }, { title: 'Cô', name: 'Y', role: 'Hiệu trưởng' }],
    }), makeEnv(db))
    expect(r.status).toBe(200)
    const { created } = (await r.json()) as { created: AdminTeacher[] }
    expect(created.map((t) => t.role)).toEqual(['Giáo viên', 'Giáo viên'])
  })

  it('update with a role on a teacher with no teacher_profile row → inserted with that role', async () => {
    await db.prepare("INSERT INTO teacher (id, token, name, subject, created_at) VALUES (51, 'tok5134567890abc', 'Old', '', '2026-11-01')").run()
    const r = await handleAdmin(adminReq('PUT', '/api/admin/teachers/51', { name: 'Old', role: 'Phó hiệu trưởng' }), makeEnv(db))
    expect(r.status).toBe(200)
    expect(((await r.json()) as AdminTeacher).role).toBe('Phó hiệu trưởng')
  })
})

// ============================================================
// Phase 1 — Admin route scoping: Google session vs legacy path
// ============================================================
// These tests are RED: handleAdmin does not yet pass opts.legacy to requireAdmin,
// nor does it support campaigns routes or Google session auth.
//
// Legacy = X-Admin-Email header (typed email, legacy R1 risk)
// Google session = __Host-cyt_s cookie from /api/auth/google
//
// Route policy (ADR-3):
//   Legacy ALLOWED (with ADMIN_LEGACY_LOGIN=1):
//     teachers, templates, images, wishes, cards, about, GET admins
//   Legacy NOT ALLOWED:
//     POST/DELETE /api/admin/admins, /api/admin/campaigns*
//   Google session: works for all admin routes

import { vi as vi2 } from 'vitest'
import {
  createNewTables,
  seedAdminEmail,
  seedUser,
  seedSession,
  makeRawToken,
  SESSION_COOKIE_NAME,
  TEST_EMAIL as GOOGLE_ADMIN_EMAIL,
  TEST_SUB as GOOGLE_ADMIN_SUB,
} from './testGoogle.ts'
import { testDb as testDb2 } from './testDb.ts'

/** Build an env with ADMIN_LEGACY_LOGIN toggled. */
function makeEnvWithFlag(db: ReturnType<typeof testDb2>['db'], legacyOn: boolean) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    PUBLIC_IP_LIMIT: { limit: async () => ({ success: true }) },
    SUBMIT_IP_LIMIT: { limit: async () => ({ success: true }) },
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async (_: { key: string }) => ({ success: true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined as string | undefined,
    ALLOW_FIRST_CLAIM: undefined as string | undefined,
    ADMIN_LEGACY_LOGIN: legacyOn ? '1' : undefined,
  }
}

/**
 * Build a request with X-Admin-Email (legacy) header.
 * Uses TEST_EMAIL ('admin@example.com') which is seeded by the outer beforeEach,
 * so the email IS in the admin table and requireAdmin reaches the route policy check.
 */
function legacyReq(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = {
    // Use TEST_EMAIL (from testAuth.ts) = 'admin@example.com', which is seeded by the outer beforeEach.
    'X-Admin-Email': TEST_EMAIL,
    'CF-Connecting-IP': '1.2.3.4',
  }
  if (method !== 'GET') headers['X-Requested-With'] = 'fetch'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

/** Build a request with a session cookie. */
function sessionReq(sessionToken: string, method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = {
    'CF-Connecting-IP': '1.2.3.4',
    Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
  }
  if (method !== 'GET') {
    headers['X-Requested-With'] = 'fetch'
    headers['Content-Type'] = 'application/json'
  }
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

// ── Google session admin works on all existing routes ─────────────────────────

describe('admin route scoping — Google session admin: all routes accessible', () => {
  let sessionToken: string

  beforeEach(async () => {
    const { db: freshDb, sqlite } = testDb2()
    createNewTables(sqlite)
    db = freshDb  // reuse the outer db variable

    await seedAdminEmail(freshDb, GOOGLE_ADMIN_EMAIL)
    const userId = await seedUser(freshDb, { email: GOOGLE_ADMIN_EMAIL, sub: GOOGLE_ADMIN_SUB })
    sessionToken = makeRawToken()
    await seedSession(freshDb, userId, sessionToken)

    // Also seed an admin row (required by legacy tests below)
    // already done by seedAdminEmail
  })

  it('Google session: GET /api/admin/teachers → 200', async () => {
    const r = await handleAdmin(sessionReq(sessionToken, 'GET', '/api/admin/teachers'), makeEnvWithFlag(db, true))
    expect(r.status).toBe(200)
  })

  it('Google session: GET /api/admin/admins → 200', async () => {
    const r = await handleAdmin(sessionReq(sessionToken, 'GET', '/api/admin/admins'), makeEnvWithFlag(db, true))
    expect(r.status).toBe(200)
  })

  it('Google session: POST /api/admin/admins → not 401 (Google session allowed)', async () => {
    const r = await handleAdmin(
      sessionReq(sessionToken, 'POST', '/api/admin/admins', { email: 'new@gmail.com' }),
      makeEnvWithFlag(db, true),
    )
    // Should not be 401 — could be 200 or 409 (conflict), but NOT 401
    expect(r.status).not.toBe(401)
  })
})

// ── Legacy flag ON: 20/11 routes → 200 + log line ────────────────────────────

describe('admin route scoping — ADMIN_LEGACY_LOGIN=1: 20/11 routes work + log line', () => {
  it('GET /api/admin/teachers with legacy email + flag ON → 200 and logs "admin: legacy login used"', async () => {
    const errorCalls: unknown[][] = []
    vi2.spyOn(console, 'error').mockImplementation((...a) => { errorCalls.push(a) })

    const r = await handleAdmin(legacyReq('GET', '/api/admin/teachers'), makeEnvWithFlag(db, true))
    expect(r.status).toBe(200)

    const legacyLogs = errorCalls.filter((c) => c[0] === 'admin: legacy login used')
    expect(legacyLogs.length).toBeGreaterThan(0)

    vi2.restoreAllMocks()
  })

  it('GET /api/admin/admins with legacy email + flag ON → 200 (read-only admins allowed)', async () => {
    const r = await handleAdmin(legacyReq('GET', '/api/admin/admins'), makeEnvWithFlag(db, true))
    expect(r.status).toBe(200)
  })
})

// ── Legacy flag ON: sensitive routes → 401 ───────────────────────────────────

describe('admin route scoping — ADMIN_LEGACY_LOGIN=1: POST/DELETE /api/admin/admins → 401', () => {
  it('POST /api/admin/admins with legacy email → 401 (changing admin list requires Google session)', async () => {
    const r = await handleAdmin(
      legacyReq('POST', '/api/admin/admins', { email: 'new@gmail.com' }),
      makeEnvWithFlag(db, true),
    )
    expect(r.status).toBe(401)
  })

  it('DELETE /api/admin/admins/1 with legacy email → 401', async () => {
    const r = await handleAdmin(
      legacyReq('DELETE', '/api/admin/admins/1'),
      makeEnvWithFlag(db, true),
    )
    expect(r.status).toBe(401)
  })
})

describe('admin route scoping — ADMIN_LEGACY_LOGIN=1: /api/admin/campaigns* → 401 with legacy', () => {
  it('GET /api/admin/campaigns with legacy email → 401 (new endpoints require Google session)', async () => {
    const r = await handleAdmin(legacyReq('GET', '/api/admin/campaigns'), makeEnvWithFlag(db, true))
    expect(r.status).toBe(401)
  })

  it('POST /api/admin/campaigns with legacy email → 401', async () => {
    const r = await handleAdmin(
      legacyReq('POST', '/api/admin/campaigns', { slug: 'test', kind: 'gift_tree', name: 'T' }),
      makeEnvWithFlag(db, true),
    )
    expect(r.status).toBe(401)
  })
})

// ── Legacy flag OFF: ALL legacy attempts → 401 ───────────────────────────────

describe('admin route scoping — ADMIN_LEGACY_LOGIN not set: legacy email → 401 everywhere', () => {
  it('GET /api/admin/teachers with legacy email, NO flag → 401', async () => {
    const r = await handleAdmin(legacyReq('GET', '/api/admin/teachers'), makeEnvWithFlag(db, false))
    expect(r.status).toBe(401)
  })

  it('GET /api/admin/admins with legacy email, NO flag → 401', async () => {
    const r = await handleAdmin(legacyReq('GET', '/api/admin/admins'), makeEnvWithFlag(db, false))
    expect(r.status).toBe(401)
  })
})
