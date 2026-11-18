// @vitest-environment node
/**
 * Tests for worker/public.ts
 *
 * Contract:
 *   handlePublic(request: Request, env: Env): Promise<Response>
 *   — handles GET /api/wall, GET /api/templates, GET /api/wishes
 *   — GET /api/teachers/* is REMOVED → 404
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { handlePublic } from './public.ts'
import { testDb, type D1 } from './testDb.ts'
import { TEST_EMAIL } from './testAuth.ts'

function makeEnv(db: D1, opts: { publicIpLimit?: boolean } = {}) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    PUBLIC_IP_LIMIT: { limit: async (_: { key: string }) => ({ success: opts.publicIpLimit ?? true }) },
    SUBMIT_IP_LIMIT: { limit: async () => ({ success: true }) },
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined as string | undefined,
    ALLOW_FIRST_CLAIM: undefined as string | undefined,
  }
}

/** Seed a full teacher record (teacher + title + profile). No public_id column. */
async function seedTeacher(
  db: D1,
  opts: { token?: string; title?: 'Thầy' | 'Cô'; showOnHome?: 0 | 1; name?: string; role?: string } = {},
) {
  const now = new Date().toISOString()
  const token = opts.token ?? 'tok1234567890abc'
  await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
    .bind(token, opts.name ?? 'Nguyễn Văn A', 'Toán', now).run()
  const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(token).first<{ id: number }>())!.id
  if (opts.title) {
    await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, opts.title).run()
  }
  await db.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)')
    .bind(tid, 'Khoa học', opts.showOnHome ?? 1).run()
  if (opts.role) await db.prepare('UPDATE teacher_profile SET role = ? WHERE teacher_id = ?').bind(opts.role, tid).run()
  return { tid, token }
}

/** Seed a template. */
async function seedTemplate(db: D1, opts: { active?: 0 | 1 } = {}) {
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
    .bind('Default', 'classic', opts.active ?? 1, now, TEST_EMAIL).run()
  return (await db.prepare('SELECT id FROM template WHERE name=?').bind('Default').first<{ id: number }>())!.id
}

/** Seed an approved card for a teacher. */
async function seedApprovedCard(db: D1, tid: number, tmplId: number, pid?: string) {
  const now = new Date().toISOString()
  const cardId = pid ?? `crd${now.replace(/\D/g, '').slice(0, 13)}`
  await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(cardId, tid, tmplId, 'Chúc mừng!', '', '', 0, 'approved', now).run()
}

/** Seed a pending card for a teacher. */
async function seedPendingCard(db: D1, tid: number, tmplId: number, pid?: string) {
  const now = new Date().toISOString()
  const cardId = pid ?? `pnd${now.replace(/\D/g, '').slice(0, 13)}`
  await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(cardId, tid, tmplId, 'Pending!', '', '', 0, 'pending', now).run()
}

let db: D1

beforeEach(() => {
  ;({ db } = testDb())
})

// ---- GET /api/wall ----

describe('GET /api/wall', () => {
  it('empty DB → { teachers: [], totals: { teachers: 0, cards: 0 } } (no latest field)', async () => {
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    expect(body.teachers).toEqual([])
    expect(body).not.toHaveProperty('latest')
    expect((body.totals as Record<string, unknown>)).toMatchObject({ teachers: 0, cards: 0 })
  })

  it('only teachers with show_on_home=1 appear in teachers list', async () => {
    await seedTeacher(db, { token: 'tok1234567890abc', showOnHome: 1, title: 'Thầy' })
    await seedTeacher(db, { token: 'tok9876543210abc', showOnHome: 0, title: 'Cô' })
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { teachers: Array<Record<string, unknown>> }
    expect(body.teachers).toHaveLength(1)
  })

  it('wall teacher has numeric id, title, name, subject, department, cardCount (no publicId, no latest)', async () => {
    await seedTeacher(db, { token: 'tok1234567890abc', title: 'Thầy', showOnHome: 1 })
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { teachers: Array<Record<string, unknown>> }
    const t = body.teachers[0]
    expect(t).toHaveProperty('id')
    expect(typeof t['id']).toBe('number')
    expect(t).toHaveProperty('title', 'Thầy')
    expect(t).toHaveProperty('name')
    expect(t).toHaveProperty('subject')
    expect(t).toHaveProperty('department')
    expect(t).toHaveProperty('cardCount', 0)
    expect(t).not.toHaveProperty('publicId')
    expect(t).not.toHaveProperty('token')
    expect(body).not.toHaveProperty('latest')
  })

  it('cardCount reflects approved cards only (not pending or hidden)', async () => {
    const { tid } = await seedTeacher(db, { token: 'tok1234567890abc', title: 'Thầy', showOnHome: 1 })
    const tmplId = await seedTemplate(db)
    await seedApprovedCard(db, tid, tmplId, 'crd1234567890abc')
    await seedApprovedCard(db, tid, tmplId, 'crd2345678901ab')
    await seedPendingCard(db, tid, tmplId, 'pnd1234567890abc')
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { teachers: Array<{ cardCount: number }> }
    expect(body.teachers[0].cardCount).toBe(2)
  })

  it('totals.teachers counts only show_on_home=1', async () => {
    await seedTeacher(db, { token: 'tok1234567890abc', showOnHome: 1, title: 'Thầy' })
    await seedTeacher(db, { token: 'tok9876543210abc', showOnHome: 0, title: 'Cô' })
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { totals: { teachers: number; cards: number } }
    expect(body.totals.teachers).toBe(1)
  })

  it('totals.cards counts approved cards from show_on_home=1 teachers only', async () => {
    const { tid: t1 } = await seedTeacher(db, { token: 'tok1234567890abc', showOnHome: 1, title: 'Thầy' })
    const { tid: t2 } = await seedTeacher(db, { token: 'tok9876543210abc', showOnHome: 0, title: 'Cô' })
    const tmplId = await seedTemplate(db)
    await seedApprovedCard(db, t1, tmplId, 'crd1234567890abc')
    await seedApprovedCard(db, t2, tmplId, 'crd2345678901ab')
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { totals: { teachers: number; cards: number } }
    expect(body.totals.cards).toBe(1)
  })

  it('marker scan: approved card message does NOT appear in wall response', async () => {
    const MARKER = 'UNIQUE_MARKER_WALL_XYZ_42'
    const { tid } = await seedTeacher(db, { token: 'tok1234567890abc', showOnHome: 1, title: 'Thầy' })
    const tmplId = await seedTemplate(db)
    await db.prepare(
      'INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind('crdmarker1234567', tid, tmplId, MARKER, '', '', 0, 'approved', new Date().toISOString()).run()

    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(await r.text()).not.toContain(MARKER)
  })

  it('marker scan: from_name and from_class of approved card do NOT appear in wall response', async () => {
    const FROM_MARKER = 'UNIQUE_FROM_MARKER_XYZ_43'
    const CLASS_MARKER = 'CLS44X4321'  // ≤ 10 chars (from_class column CHECK constraint)
    const { tid } = await seedTeacher(db, { token: 'tok1234567890abc', showOnHome: 1, title: 'Thầy' })
    const tmplId = await seedTemplate(db)
    await db.prepare(
      'INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind('crdmarker7654321', tid, tmplId, 'msg', FROM_MARKER, CLASS_MARKER, 0, 'approved', new Date().toISOString()).run()

    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.text()
    expect(body).not.toContain(FROM_MARKER)
    expect(body).not.toContain(CLASS_MARKER)
  })

  it('marker scan: approved card markers do NOT appear in /api/templates response', async () => {
    const MSG_MARKER = 'UNIQUE_MSG_MARKER_TPLS_45'
    const FROM_MARKER = 'UNIQUE_FROM_MARKER_TPLS_46'
    const { tid } = await seedTeacher(db, { token: 'tok1234567890abc', showOnHome: 1, title: 'Thầy' })
    const tmplId = await seedTemplate(db)
    await db.prepare(
      'INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind('crdmrkrtpl123456', tid, tmplId, MSG_MARKER, FROM_MARKER, '12A1', 0, 'approved', new Date().toISOString()).run()

    const r = await handlePublic(
      new Request('https://x/api/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.text()
    expect(body).not.toContain(MSG_MARKER)
    expect(body).not.toContain(FROM_MARKER)
  })

  it('marker scan: approved card markers do NOT appear in /api/wishes response', async () => {
    const MSG_MARKER = 'UNIQUE_MSG_MARKER_WISH_47'
    const FROM_MARKER = 'UNIQUE_FROM_MARKER_WISH_48'
    const { tid } = await seedTeacher(db, { token: 'tok1234567890abc', showOnHome: 1, title: 'Thầy' })
    const tmplId = await seedTemplate(db)
    await db.prepare(
      'INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind('crdmrkrwsh123456', tid, tmplId, MSG_MARKER, FROM_MARKER, '12A1', 0, 'approved', new Date().toISOString()).run()

    const r = await handlePublic(
      new Request('https://x/api/wishes', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.text()
    expect(body).not.toContain(MSG_MARKER)
    expect(body).not.toContain(FROM_MARKER)
  })
})

// ---- GET /api/teachers/* → 404 (route removed) ----

describe('GET /api/teachers/* → 404 (route removed)', () => {
  it('GET /api/teachers/<any-id> → 404', async () => {
    const r = await handlePublic(
      new Request('https://x/api/teachers/tok1234567890abc', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(404)
  })
})

// ---- GET /api/templates ----

describe('GET /api/templates', () => {
  it('empty → []', async () => {
    const r = await handlePublic(
      new Request('https://x/api/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('active templates only (inactive excluded)', async () => {
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .bind('Active', 'classic', 1, now, TEST_EMAIL).run()
    await db.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .bind('Inactive', 'lotus', 0, now, TEST_EMAIL).run()
    const r = await handlePublic(
      new Request('https://x/api/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const list = await r.json() as Array<{ name: string }>
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Active')
  })

  it('template response shape: { id, name, layout, images } — no created_by, no active', async () => {
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .bind('Test', 'classic', 1, now, TEST_EMAIL).run()
    const r = await handlePublic(
      new Request('https://x/api/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const list = await r.json() as Array<Record<string, unknown>>
    expect(list[0]).toHaveProperty('id')
    expect(list[0]).toHaveProperty('name')
    expect(list[0]).toHaveProperty('layout')
    expect(list[0]).toHaveProperty('images')
    expect(typeof list[0].images).toBe('object')
    expect(list[0]).not.toHaveProperty('created_by')
    expect(list[0]).not.toHaveProperty('active')
  })
})

// ---- GET /api/wishes ----

describe('GET /api/wishes', () => {
  it('returns seeded wishes without created_by', async () => {
    const r = await handlePublic(
      new Request('https://x/api/wishes', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const list = await r.json() as Array<Record<string, unknown>>
    expect(list.length).toBeGreaterThan(0)
    for (const item of list) {
      expect(item).toHaveProperty('id')
      expect(item).toHaveProperty('title')
      expect(item).toHaveProperty('body')
      expect(item).not.toHaveProperty('created_by')
      expect(item).not.toHaveProperty('created_at')
    }
  })
})

// ---- Rate limit — checked first ----

describe('GET /api/wall — rate limit first', () => {
  it('exhausted PUBLIC_IP_LIMIT → 429, zero DB statements including DDL', async () => {
    const { db: freshDb, state } = testDb()
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(freshDb, { publicIpLimit: false }),
    )
    expect(r.status).toBe(429)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })
})

// ---- Moderation invariant: no token leaks ----

describe('Moderation invariant — no private QR token in any public response', () => {
  it('wall response never contains teacher.token value', async () => {
    const TOKEN_A = 'tokleak00000001a'
    const TOKEN_B = 'tokleak00000002b'
    const now = new Date().toISOString()

    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind(TOKEN_A, 'Teacher A', 'Math', now).run()
    const tA = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(TOKEN_A).first<{ id: number }>())!.id
    await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tA, 'Thầy').run()
    await db.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)')
      .bind(tA, '', 1).run()

    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind(TOKEN_B, 'Teacher B', 'Physics', now).run()
    const tB = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(TOKEN_B).first<{ id: number }>())!.id
    await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tB, 'Cô').run()
    await db.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)')
      .bind(tB, '', 1).run()

    const tmplId = await seedTemplate(db)
    await seedApprovedCard(db, tA, tmplId, 'crd1234567890abc')
    await seedApprovedCard(db, tB, tmplId, 'crd2345678901bc')

    const wallRes = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const wallJson = await wallRes.text()
    expect(wallJson).not.toContain(TOKEN_A)
    expect(wallJson).not.toContain(TOKEN_B)
  })

  it('GET /api/teachers/* returns 404 (route removed) — token never exposed via this route', async () => {
    const TOKEN = 'tokleak00000003c'
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind(TOKEN, 'Teacher C', 'Chemistry', now).run()
    const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(TOKEN).first<{ id: number }>())!.id
    await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, 'Cô').run()
    await db.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)')
      .bind(tid, '', 1).run()

    const res = await handlePublic(
      new Request(`https://x/api/teachers/${TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    // Route removed → 404; body {"error":"not_found"} never contains the token
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(TOKEN)
  })
})

// ---- Method guard ----

describe('public routes — OPTIONS returns 405 without Access-Control-* headers', () => {
  it.each(['/api/wall', '/api/templates', '/api/wishes'])(
    'OPTIONS %s → 405 without CORS headers',
    async (path) => {
      const r = await handlePublic(
        new Request(`https://x${path}`, { method: 'OPTIONS', headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
        makeEnv(db),
      )
      expect(r.status).toBe(405)
      expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull()
      expect(r.headers.get('Access-Control-Allow-Methods')).toBeNull()
      expect(r.headers.get('Access-Control-Allow-Headers')).toBeNull()
    },
  )
})

describe('GET /api/wall — role', () => {
  it('each teacher carries role (default Giáo viên, stored value otherwise)', async () => {
    const { db } = testDb()
    await seedTeacher(db, { token: 'tok1234567890abc', title: 'Thầy' })
    await seedTeacher(db, { token: 'tok2234567890abc', title: 'Cô', role: 'Hiệu trưởng' })
    const r = await handlePublic(new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    const body = (await r.json()) as { teachers: { role: string }[] }
    expect(body.teachers.map((t) => t.role)).toEqual(['Giáo viên', 'Hiệu trưởng'])
  })
})

describe('GET /api/templates — card v3', () => {
  it('returns the resolved layout id and only the background image', async () => {
    const { db } = testDb()
    await db.prepare("INSERT INTO image (id, token, name, mime, size, data, created_at, created_by) VALUES (1, 'img0000000000001', 'bg', 'image/png', 1, 'AA==', 'x', 'a')").run()
    await db.prepare("INSERT INTO template (id, name, layout, active, created_at, created_by) VALUES (1, 'Cũ', 'spring', 1, 'x', 'a'), (2, 'Mới', 'ngang-trai', 1, 'x', 'a')").run()
    await db.prepare("INSERT INTO template_image (template_id, slot, image_id) VALUES (1, 'background', 1)").run()
    const r = await handlePublic(new Request('https://x/api/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    const list = (await r.json()) as { id: number; layout: string; images: Record<string, string> }[]
    expect(list.map((t) => [t.id, t.layout])).toEqual([[1, 'doc-giua'], [2, 'ngang-trai']])
    expect(list[0].images).toEqual({ background: 'img0000000000001' })
  })
})
