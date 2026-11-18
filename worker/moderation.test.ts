// @vitest-environment node
/**
 * Tests for worker/moderation.ts (admin card moderation).
 *
 * Contract expected:
 *   handleModeration(request: Request, env: Env, email: string): Promise<Response>
 *   — handles GET /api/admin/cards, PUT /api/admin/cards/:id,
 *     POST /api/admin/cards/review, DELETE /api/admin/cards/:id
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { handleModeration } from './moderation.ts'
import { testDb, type D1 } from './testDb.ts'
import { TEST_EMAIL } from './testAuth.ts'
import { MAX_REVIEW_IDS } from '../shared/api.ts'

function makeEnv(db: D1) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    PUBLIC_IP_LIMIT: { limit: async () => ({ success: true }) },
    SUBMIT_IP_LIMIT: { limit: async () => ({ success: true }) },
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined as string | undefined,
    ALLOW_FIRST_CLAIM: undefined as string | undefined,
  }
}

function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    'CF-Connecting-IP': '1.2.3.4',
    'X-Admin-Email': TEST_EMAIL,
  }
  if (method !== 'GET') headers['X-Requested-With'] = 'fetch'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

type CardRow = {
  id: number
  publicId: string
  status: string
  createdAt: string
}

let db: D1
let tid: number
let tmplId: number

beforeEach(async () => {
  ;({ db } = testDb())
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO admin (email, created_at, created_by) VALUES (?, ?, ?)').bind(TEST_EMAIL, now, 'seed').run()

  // Seed teacher + profile + template
  await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind('tok1234567890abc', 'Teacher', 'Math', now).run()
  tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind('tok1234567890abc').first<{ id: number }>())!.id
  await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, 'Thầy').run()
  await db.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)').bind(tid, '', 1).run()
  await db.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)').bind('T', 'classic', 1, now, TEST_EMAIL).run()
  tmplId = (await db.prepare('SELECT id FROM template WHERE name=?').bind('T').first<{ id: number }>())!.id
})

async function seedCard(opts: { status?: 'pending' | 'approved' | 'hidden'; publicId?: string; message?: string; at?: string } = {}) {
  const now = opts.at ?? new Date().toISOString()
  const pid = opts.publicId ?? `crd${now.replace(/\D/g, '').slice(0, 13)}`
  await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(pid, tid, tmplId, opts.message ?? 'msg', '', '', 0, opts.status ?? 'pending', now).run()
  return (await db.prepare('SELECT id FROM student_card WHERE public_id=?').bind(pid).first<{ id: number }>())!.id
}

// ---- GET /api/admin/cards ----

describe('GET /api/admin/cards', () => {
  it('?status=pending → list pending cards, oldest first', async () => {
    const id1 = await seedCard({ status: 'pending', publicId: 'pnd0000000000001', at: '2024-01-01T00:00:00.000Z' })
    const id2 = await seedCard({ status: 'pending', publicId: 'pnd0000000000002', at: '2024-01-02T00:00:00.000Z' })
    const r = await handleModeration(req('GET', '/api/admin/cards?status=pending'), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(200)
    const list = await r.json() as CardRow[]
    expect(list[0].id).toBe(id1)  // oldest first
    expect(list[1].id).toBe(id2)
  })

  it('?status=approved → list approved cards, newest first', async () => {
    const id1 = await seedCard({ status: 'approved', publicId: 'apr0000000000001', at: '2024-01-01T00:00:00.000Z' })
    const id2 = await seedCard({ status: 'approved', publicId: 'apr0000000000002', at: '2024-01-02T00:00:00.000Z' })
    const r = await handleModeration(req('GET', '/api/admin/cards?status=approved'), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(200)
    const list = await r.json() as CardRow[]
    expect(list[0].id).toBe(id2)  // newest first
    expect(list[1].id).toBe(id1)
  })

  it('?status=hidden → list hidden cards, newest first', async () => {
    const id1 = await seedCard({ status: 'hidden', publicId: 'hid0000000000001', at: '2024-01-01T00:00:00.000Z' })
    const id2 = await seedCard({ status: 'hidden', publicId: 'hid0000000000002', at: '2024-01-02T00:00:00.000Z' })
    const r = await handleModeration(req('GET', '/api/admin/cards?status=hidden'), makeEnv(db), TEST_EMAIL)
    const list = await r.json() as CardRow[]
    expect(list[0].id).toBe(id2)  // newest first
    expect(list[1].id).toBe(id1)
  })

  it('response includes raw fromName, fromClass, anonymous, teacher, template', async () => {
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('crd1234567890abc', tid, tmplId, 'Secret msg', 'Học sinh A', '12A1', 0, 'pending', new Date().toISOString()).run()
    const r = await handleModeration(req('GET', '/api/admin/cards?status=pending'), makeEnv(db), TEST_EMAIL)
    const list = await r.json() as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    const card = list[0]
    expect(card).toHaveProperty('fromName', 'Học sinh A')
    expect(card).toHaveProperty('fromClass', '12A1')
    expect(card).toHaveProperty('anonymous', false)
    expect(card).toHaveProperty('teacher')
    expect(card).toHaveProperty('template')
    expect((card.teacher as Record<string, unknown>)).toHaveProperty('id')
    expect((card.teacher as Record<string, unknown>)).not.toHaveProperty('publicId')
    expect((card.template as Record<string, unknown>)).toHaveProperty('layout')
  })

  it('?teacher=<id> filters by teacher id', async () => {
    // Seed a second teacher with a card
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind('tok9876543210ab', 'Other', 'Physics', now).run()
    const tid2 = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind('tok9876543210ab').first<{ id: number }>())!.id
    await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid2, 'Cô').run()
    await db.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)').bind(tid2, '', 1).run()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('crd9876543210ab', tid2, tmplId, 'Other msg', '', '', 0, 'pending', now).run()
    await seedCard({ status: 'pending', publicId: 'crd1234567890abc' })

    const r = await handleModeration(req('GET', `/api/admin/cards?status=pending&teacher=${tid}`), makeEnv(db), TEST_EMAIL)
    const list = await r.json() as Array<{ id: number }>
    for (const card of list) {
      const row = await db.prepare('SELECT teacher_id FROM student_card WHERE id=?').bind(card.id).first<{ teacher_id: number }>()
      expect(row?.teacher_id).toBe(tid)
    }
  })

  it('capped at 200 results', async () => {
    for (let i = 0; i < 201; i++) {
      const pid = `pnd${String(i).padStart(13, '0')}`
      await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(pid, tid, tmplId, 'msg', '', '', 0, 'pending', new Date(Date.now() + i).toISOString()).run()
    }
    const r = await handleModeration(req('GET', '/api/admin/cards?status=pending'), makeEnv(db), TEST_EMAIL)
    const list = await r.json() as unknown[]
    expect(list).toHaveLength(200)
  })
})

// ---- Paging cursors ----

describe('GET /api/admin/cards — paging cursors', () => {
  it('?status=pending&after=<id> returns cards with id > N (oldest first)', async () => {
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(await seedCard({ status: 'pending', publicId: `pnd${String(i).padStart(13, '0')}`, at: `2024-01-0${i + 1}T00:00:00.000Z` }))
    }
    const afterId = ids[1]  // cursor after the 2nd oldest
    const r = await handleModeration(req('GET', `/api/admin/cards?status=pending&after=${afterId}`), makeEnv(db), TEST_EMAIL)
    const list = await r.json() as Array<{ id: number }>
    for (const card of list) {
      expect(card.id).toBeGreaterThan(afterId)
    }
    expect(list[0].id).toBe(ids[2])  // oldest first
  })

  it('?status=approved&before=<id> returns cards with id < N (newest first)', async () => {
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(await seedCard({ status: 'approved', publicId: `apr${String(i).padStart(13, '0')}`, at: `2024-01-0${i + 1}T00:00:00.000Z` }))
    }
    const beforeId = ids[3]  // cursor before the 4th (0-indexed)
    const r = await handleModeration(req('GET', `/api/admin/cards?status=approved&before=${beforeId}`), makeEnv(db), TEST_EMAIL)
    const list = await r.json() as Array<{ id: number }>
    for (const card of list) {
      expect(card.id).toBeLessThan(beforeId)
    }
    // Newest first within the page
    if (list.length >= 2) expect(list[0].id).toBeGreaterThan(list[1].id)
  })

  it('?status=approved&after=<id> → 400 (wrong cursor type for status)', async () => {
    const id = await seedCard({ status: 'approved', publicId: 'apr0000000000001' })
    const r = await handleModeration(req('GET', `/api/admin/cards?status=approved&after=${id}`), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(400)
  })

  it('?status=hidden&after=<id> → 400 (wrong cursor type for status)', async () => {
    const id = await seedCard({ status: 'hidden', publicId: 'hid0000000000001' })
    const r = await handleModeration(req('GET', `/api/admin/cards?status=hidden&after=${id}`), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(400)
  })

  it('?status=pending&before=<id> → 400 (wrong cursor type for status)', async () => {
    const id = await seedCard({ status: 'pending', publicId: 'pnd0000000000001' })
    const r = await handleModeration(req('GET', `/api/admin/cards?status=pending&before=${id}`), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(400)
  })
})

// ---- PUT /api/admin/cards/:id — single review ----

describe('PUT /api/admin/cards/:id', () => {
  it('approve a pending card → status=approved, reviewedAt set, reviewedBy set', async () => {
    const id = await seedCard({ status: 'pending', publicId: 'crd1234567890abc' })
    const r = await handleModeration(req('PUT', `/api/admin/cards/${id}`, { status: 'approved' }), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(200)
    const row = await db.prepare('SELECT status, reviewed_at, reviewed_by FROM student_card WHERE id=?').bind(id).first<{ status: string; reviewed_at: string; reviewed_by: string }>()
    expect(row?.status).toBe('approved')
    expect(row?.reviewed_at).not.toBeNull()
    expect(row?.reviewed_by).toBe(TEST_EMAIL)
  })

  it('hide a card → status=hidden', async () => {
    const id = await seedCard({ status: 'pending', publicId: 'crd1234567890abc' })
    const r = await handleModeration(req('PUT', `/api/admin/cards/${id}`, { status: 'hidden' }), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(200)
    const row = await db.prepare('SELECT status FROM student_card WHERE id=?').bind(id).first<{ status: string }>()
    expect(row?.status).toBe('hidden')
  })

  it('invalid status → 400', async () => {
    const id = await seedCard({ status: 'pending', publicId: 'crd1234567890abc' })
    const r = await handleModeration(req('PUT', `/api/admin/cards/${id}`, { status: 'published' }), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(400)
  })

  it('unknown card id → 404', async () => {
    const r = await handleModeration(req('PUT', '/api/admin/cards/9999', { status: 'approved' }), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(404)
  })
})

// ---- POST /api/admin/cards/review — bulk review ----

describe('POST /api/admin/cards/review — bulk (json_each, max 200 ids)', () => {
  it('bulk approve 3 cards at once', async () => {
    const ids = await Promise.all([
      seedCard({ status: 'pending', publicId: 'crd1234567890abc' }),
      seedCard({ status: 'pending', publicId: 'crd2345678901bc' }),
      seedCard({ status: 'pending', publicId: 'crd3456789012cd' }),
    ])
    const r = await handleModeration(
      req('POST', '/api/admin/cards/review', { ids, status: 'approved' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    for (const id of ids) {
      const row = await db.prepare('SELECT status, reviewed_at, reviewed_by FROM student_card WHERE id=?').bind(id).first<{ status: string; reviewed_at: string; reviewed_by: string }>()
      expect(row?.status).toBe('approved')
      expect(row?.reviewed_at).not.toBeNull()
      expect(row?.reviewed_by).toBe(TEST_EMAIL)
    }
  })

  it('bulk hide 3 cards at once', async () => {
    const ids = await Promise.all([
      seedCard({ status: 'pending', publicId: 'crd1234567890abc' }),
      seedCard({ status: 'pending', publicId: 'crd2345678901bc' }),
      seedCard({ status: 'pending', publicId: 'crd3456789012cd' }),
    ])
    const r = await handleModeration(
      req('POST', '/api/admin/cards/review', { ids, status: 'hidden' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    for (const id of ids) {
      const row = await db.prepare('SELECT status FROM student_card WHERE id=?').bind(id).first<{ status: string }>()
      expect(row?.status).toBe('hidden')
    }
  })

  it(`${MAX_REVIEW_IDS} ids (max) → 200, uses json_each (stays within 100-param guard)`, async () => {
    // The bulk review must bind only 4 params: status, reviewed_at, reviewed_by, json(ids)
    // This verifies the implementation uses json_each instead of IN (?,?,?,...) which would
    // hit the 100-param guard. The 100-param guard would throw for 200 IN-list parameters.
    const ids: number[] = []
    for (let i = 0; i < MAX_REVIEW_IDS; i++) {
      const pid = `blk${String(i).padStart(13, '0')}`
      ids.push(await seedCard({ status: 'pending', publicId: pid }))
    }
    // This call must NOT throw "too many SQL variables"
    const r = await handleModeration(
      req('POST', '/api/admin/cards/review', { ids, status: 'approved' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(200)
  })

  it('ids must be unique positive integers — duplicate ids → 400', async () => {
    const id = await seedCard({ status: 'pending', publicId: 'crd1234567890abc' })
    const r = await handleModeration(
      req('POST', '/api/admin/cards/review', { ids: [id, id], status: 'approved' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('ids with non-positive integer → 400', async () => {
    const r = await handleModeration(
      req('POST', '/api/admin/cards/review', { ids: [0, -1], status: 'approved' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('ids exceeding 200 → 400', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => i + 1)
    const r = await handleModeration(
      req('POST', '/api/admin/cards/review', { ids, status: 'approved' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('empty ids array → 400', async () => {
    const r = await handleModeration(
      req('POST', '/api/admin/cards/review', { ids: [], status: 'approved' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('invalid status → 400', async () => {
    const id = await seedCard({ status: 'pending', publicId: 'crd1234567890abc' })
    const r = await handleModeration(
      req('POST', '/api/admin/cards/review', { ids: [id], status: 'pending' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })
})

// ---- DELETE /api/admin/cards/:id ----

describe('DELETE /api/admin/cards/:id', () => {
  it('deletes a card → 200, row gone', async () => {
    const id = await seedCard({ status: 'pending', publicId: 'crd1234567890abc' })
    const r = await handleModeration(req('DELETE', `/api/admin/cards/${id}`), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(200)
    const row = await db.prepare('SELECT id FROM student_card WHERE id=?').bind(id).first()
    expect(row).toBeNull()
  })

  it('unknown card id → 404', async () => {
    const r = await handleModeration(req('DELETE', '/api/admin/cards/9999'), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(404)
  })
})

// ---- Card v3: font, ink, resolved layout in admin cards ----

describe('GET /api/admin/cards — card v3 fields', () => {
  it('returns font, ink and the resolved template layout', async () => {
    const id = await seedCard({ status: 'pending', publicId: 'pnd0000000000009' })
    await db.prepare("UPDATE student_card SET font = 'mali', ink = '#1c1917' WHERE id = ?").bind(id).run()
    const r = await handleModeration(req('GET', '/api/admin/cards?status=pending'), makeEnv(db), TEST_EMAIL)
    const list = (await r.json()) as { id: number; font: string; ink: string; template: { layout: string } }[]
    const card = list.find((c) => c.id === id)!
    expect(card).toMatchObject({ font: 'mali', ink: '#1c1917' })
    expect(card.template.layout).toBe('doc-giua') // template seeded with legacy 'classic'
  })
})
