// @vitest-environment node
/**
 * Tests for worker/public.ts
 * All tests fail until Group 2 creates worker/public.ts.
 *
 * Contract expected:
 *   handlePublic(request: Request, env: Env): Promise<Response>
 *   — handles GET /api/wall, GET /api/teachers/:publicId,
 *     GET /api/templates, GET /api/wishes
 */
import { describe, it, expect, beforeEach } from 'vitest'

// This import fails until Group 2 creates the module → all tests fail
import { handlePublic } from './public.ts'
import { testDb, type D1 } from './testDb.ts'
import { TEST_EMAIL } from './testAuth.ts'

const VALID_PUBLIC_ID = 'pub1234567890abc'

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

/** Seed a full teacher record (teacher + title + profile). */
async function seedTeacher(
  db: D1,
  opts: { publicId?: string; title?: 'Thầy' | 'Cô'; showOnHome?: 0 | 1; name?: string } = {},
) {
  const now = new Date().toISOString()
  const publicId = opts.publicId ?? VALID_PUBLIC_ID
  // Distinct private token per public id (reversed), so two seeded teachers never collide.
  const token = [...publicId].reverse().join('')
  await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
    .bind(token, opts.name ?? 'Nguyễn Văn A', 'Toán', now).run()
  const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(token).first<{ id: number }>())!.id
  if (opts.title) {
    await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, opts.title).run()
  }
  await db.prepare('INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES (?, ?, ?, ?)')
    .bind(tid, publicId, 'Khoa học', opts.showOnHome ?? 1).run()
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
async function seedApprovedCard(db: D1, tid: number, tmplId: number, publicId?: string) {
  const now = new Date().toISOString()
  const pid = publicId ?? `crd${now.replace(/\D/g, '').slice(0, 13)}`
  await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(pid, tid, tmplId, 'Chúc mừng!', '', '', 0, 'approved', now).run()
}

/** Seed a pending card for a teacher. */
async function seedPendingCard(db: D1, tid: number, tmplId: number, publicId?: string) {
  const now = new Date().toISOString()
  const pid = publicId ?? `pnd${now.replace(/\D/g, '').slice(0, 13)}`
  await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(pid, tid, tmplId, 'Pending!', '', '', 0, 'pending', now).run()
}

let db: D1

beforeEach(() => {
  ;({ db } = testDb())
})

// ---- GET /api/wall ----

describe('GET /api/wall', () => {
  it('empty DB → { teachers: [], latest: [], totals: { teachers: 0, cards: 0 } }', async () => {
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { teachers: unknown[]; latest: unknown[]; totals: unknown }
    expect(body.teachers).toEqual([])
    expect(body.latest).toEqual([])
    expect(body.totals).toMatchObject({ teachers: 0, cards: 0 })
  })

  it('only teachers with show_on_home=1 appear in teachers list', async () => {
    await seedTeacher(db, { publicId: VALID_PUBLIC_ID, showOnHome: 1, title: 'Thầy' })
    await seedTeacher(db, { publicId: 'hid1234567890abc', showOnHome: 0, title: 'Cô' })
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { teachers: Array<{ publicId: string }> }
    expect(body.teachers).toHaveLength(1)
    expect(body.teachers[0].publicId).toBe(VALID_PUBLIC_ID)
  })

  it('wall teacher includes { publicId, title, name, subject, department, cardCount }', async () => {
    await seedTeacher(db, { publicId: VALID_PUBLIC_ID, title: 'Thầy', showOnHome: 1 })
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { teachers: Array<Record<string, unknown>> }
    const t = body.teachers[0]
    expect(t).toHaveProperty('publicId')
    expect(t).toHaveProperty('title')
    expect(t).toHaveProperty('name')
    expect(t).toHaveProperty('subject')
    expect(t).toHaveProperty('department')
    expect(t).toHaveProperty('cardCount')
    expect(t.cardCount).toBe(0)
  })

  it('cardCount reflects approved cards only (not pending or hidden)', async () => {
    const { tid } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, title: 'Thầy', showOnHome: 1 })
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

  it('latest: at most one card per teacher, newest first, max 6 total', async () => {
    // Create 7 teachers with approved cards
    for (let i = 0; i < 7; i++) {
      const pubId = `pub${String(i).padStart(13, '0')}`
      const { tid } = await seedTeacher(db, { publicId: pubId, title: 'Thầy', showOnHome: 1 })
      const tmplId = await seedTemplate(db)
      await seedApprovedCard(db, tid, tmplId, `crd${String(i).padStart(13, '0')}`)
    }
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { latest: unknown[] }
    expect(body.latest.length).toBeLessThanOrEqual(6)
  })

  it('latest items include teacher ref { publicId, title, name }', async () => {
    const { tid } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, title: 'Thầy', showOnHome: 1 })
    const tmplId = await seedTemplate(db)
    await seedApprovedCard(db, tid, tmplId, 'crd1234567890abc')
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { latest: Array<{ teacher: Record<string, unknown> }> }
    expect(body.latest).toHaveLength(1)
    const teacher = body.latest[0].teacher
    expect(teacher).toHaveProperty('publicId')
    expect(teacher).toHaveProperty('title')
    expect(teacher).toHaveProperty('name')
    // The private token must NEVER appear in latest teacher ref
    expect(teacher).not.toHaveProperty('token')
  })

  it('latest: hidden teacher (show_on_home=0) cards do NOT appear', async () => {
    const { tid } = await seedTeacher(db, { publicId: 'hid1234567890abc', showOnHome: 0, title: 'Cô' })
    const tmplId = await seedTemplate(db)
    await seedApprovedCard(db, tid, tmplId, 'crd1234567890abc')
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { latest: unknown[] }
    expect(body.latest).toHaveLength(0)
  })

  it('latest: pending cards do NOT appear', async () => {
    const { tid } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, showOnHome: 1, title: 'Thầy' })
    const tmplId = await seedTemplate(db)
    await seedPendingCard(db, tid, tmplId, 'pnd1234567890abc')
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { latest: unknown[] }
    expect(body.latest).toHaveLength(0)
  })

  it('totals.teachers counts only show_on_home=1', async () => {
    await seedTeacher(db, { publicId: VALID_PUBLIC_ID, showOnHome: 1, title: 'Thầy' })
    await seedTeacher(db, { publicId: 'hid1234567890abc', showOnHome: 0, title: 'Cô' })
    const r = await handlePublic(
      new Request('https://x/api/wall', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { totals: { teachers: number; cards: number } }
    expect(body.totals.teachers).toBe(1)
  })

  it('totals.cards counts approved cards from show_on_home=1 teachers only', async () => {
    const { tid: t1 } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, showOnHome: 1, title: 'Thầy' })
    const { tid: t2 } = await seedTeacher(db, { publicId: 'hid1234567890abc', showOnHome: 0, title: 'Cô' })
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
})

// ---- GET /api/teachers/:publicId ----

describe('GET /api/teachers/:publicId', () => {
  it('unknown publicId → 404 { error: "not_found" }', async () => {
    const r = await handlePublic(
      new Request('https://x/api/teachers/unknownpublic01a', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })

  it('malformed publicId → 404 with zero DB statements', async () => {
    const { db: freshDb, state } = testDb()
    const r = await handlePublic(
      new Request('https://x/api/teachers/BAD!!', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(freshDb),
    )
    expect(r.status).toBe(404)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('valid teacher → { teacher: {...}, cards: [...], total }', async () => {
    const { tid } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, title: 'Thầy', showOnHome: 1 })
    const tmplId = await seedTemplate(db)
    await seedApprovedCard(db, tid, tmplId, 'crd1234567890abc')
    const r = await handlePublic(
      new Request(`https://x/api/teachers/${VALID_PUBLIC_ID}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { teacher: Record<string, unknown>; cards: unknown[]; total: number }
    expect(body.teacher).toHaveProperty('publicId', VALID_PUBLIC_ID)
    expect(body.teacher).toHaveProperty('title', 'Thầy')
    expect(body.teacher).toHaveProperty('name')
    expect(body.teacher).toHaveProperty('subject')
    expect(body.teacher).toHaveProperty('department')
    expect(body.teacher).not.toHaveProperty('token')
    expect(body.cards).toHaveLength(1)
    expect(body.total).toBe(1)
  })

  it('teacher with show_on_home=0 is still reachable by publicId', async () => {
    const { tid } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, showOnHome: 0, title: 'Thầy' })
    const tmplId = await seedTemplate(db)
    await seedApprovedCard(db, tid, tmplId, 'crd1234567890abc')
    const r = await handlePublic(
      new Request(`https://x/api/teachers/${VALID_PUBLIC_ID}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
  })

  it('pending cards are not included (approved only)', async () => {
    const { tid } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, title: 'Thầy', showOnHome: 1 })
    const tmplId = await seedTemplate(db)
    await seedPendingCard(db, tid, tmplId, 'pnd1234567890abc')
    const r = await handlePublic(
      new Request(`https://x/api/teachers/${VALID_PUBLIC_ID}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { cards: unknown[]; total: number }
    expect(body.cards).toHaveLength(0)
    expect(body.total).toBe(0)
  })

  it('cards are newest first, capped at 200', async () => {
    const { tid } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, title: 'Cô', showOnHome: 1 })
    const tmplId = await seedTemplate(db)
    // Insert 201 approved cards
    for (let i = 0; i < 201; i++) {
      const pid = `crd${String(i).padStart(13, '0')}`
      const now = new Date(Date.now() + i * 1000).toISOString()
      await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(pid, tid, tmplId, 'msg', '', '', 0, 'approved', now).run()
    }
    const r = await handlePublic(
      new Request(`https://x/api/teachers/${VALID_PUBLIC_ID}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { cards: Array<{ publicId: string }>; total: number }
    expect(body.cards).toHaveLength(200)
    expect(body.total).toBe(201)
    // Newest first: last inserted (i=200) should be first
    expect(body.cards[0].publicId).toBe(`crd${String(200).padStart(13, '0')}`)
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

  it('template response shape: { id, name, layout, images }', async () => {
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
    // created_by must NOT appear
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

// ---- `from` construction ----

describe('PublicCard.from construction', () => {
  it('anonymous card → "Một bạn học sinh"', async () => {
    const { tid } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, title: 'Thầy', showOnHome: 1 })
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('crd1234567890abc', tid, tmplId, 'msg', '', '', 1, 'approved', now).run()
    const r = await handlePublic(
      new Request(`https://x/api/teachers/${VALID_PUBLIC_ID}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { cards: Array<{ from: string }> }
    expect(body.cards[0].from).toBe('Một bạn học sinh')
  })

  it('anonymous with class → "Một bạn học sinh · {class}"', async () => {
    const { tid } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, title: 'Thầy', showOnHome: 1 })
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('crd1234567890abc', tid, tmplId, 'msg', '', '12A1', 1, 'approved', now).run()
    const r = await handlePublic(
      new Request(`https://x/api/teachers/${VALID_PUBLIC_ID}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { cards: Array<{ from: string }> }
    expect(body.cards[0].from).toBe('Một bạn học sinh · 12A1')
  })

  it('named with class → "{name} · {class}"', async () => {
    const { tid } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, title: 'Thầy', showOnHome: 1 })
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('crd1234567890abc', tid, tmplId, 'msg', 'Học sinh A', '12A1', 0, 'approved', now).run()
    const r = await handlePublic(
      new Request(`https://x/api/teachers/${VALID_PUBLIC_ID}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { cards: Array<{ from: string }> }
    expect(body.cards[0].from).toBe('Học sinh A · 12A1')
  })

  it('named without class → "{name}"', async () => {
    const { tid } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, title: 'Thầy', showOnHome: 1 })
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('crd1234567890abc', tid, tmplId, 'msg', 'Học sinh A', '', 0, 'approved', now).run()
    const r = await handlePublic(
      new Request(`https://x/api/teachers/${VALID_PUBLIC_ID}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { cards: Array<{ from: string }> }
    expect(body.cards[0].from).toBe('Học sinh A')
  })

  it('PublicCard response does NOT include fromName, fromClass, anonymous fields', async () => {
    const { tid } = await seedTeacher(db, { publicId: VALID_PUBLIC_ID, title: 'Thầy', showOnHome: 1 })
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('crd1234567890abc', tid, tmplId, 'msg', 'Hidden', '12B2', 0, 'approved', now).run()
    const r = await handlePublic(
      new Request(`https://x/api/teachers/${VALID_PUBLIC_ID}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { cards: Array<Record<string, unknown>> }
    const card = body.cards[0]
    expect(card).not.toHaveProperty('fromName')
    expect(card).not.toHaveProperty('fromClass')
    expect(card).not.toHaveProperty('from_name')
    expect(card).not.toHaveProperty('from_class')
    expect(card).not.toHaveProperty('anonymous')
  })
})

// ---- Moderation invariant: no token leaks ----

describe('Moderation invariant — no private QR token in any public response', () => {
  it('wall response never contains teacher.token value', async () => {
    // Seed two teachers with known QR tokens
    const TOKEN_A = 'tokleak00000001a'
    const TOKEN_B = 'tokleak00000002b'
    const now = new Date().toISOString()

    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind(TOKEN_A, 'Teacher A', 'Math', now).run()
    const tA = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(TOKEN_A).first<{ id: number }>())!.id
    await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tA, 'Thầy').run()
    await db.prepare('INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES (?, ?, ?, ?)')
      .bind(tA, 'leakpub000000001', '', 1).run()

    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind(TOKEN_B, 'Teacher B', 'Physics', now).run()
    const tB = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(TOKEN_B).first<{ id: number }>())!.id
    await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tB, 'Cô').run()
    await db.prepare('INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES (?, ?, ?, ?)')
      .bind(tB, 'leakpub000000002', '', 1).run()

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

  it('teacher page response never contains teacher.token value', async () => {
    const TOKEN = 'tokleak00000003c'
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind(TOKEN, 'Teacher C', 'Chemistry', now).run()
    const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(TOKEN).first<{ id: number }>())!.id
    await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, 'Cô').run()
    await db.prepare('INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES (?, ?, ?, ?)')
      .bind(tid, 'leakpub000000003', '', 1).run()
    const tmplId = await seedTemplate(db)
    await seedApprovedCard(db, tid, tmplId, 'crd1234567890abc')

    const res = await handlePublic(
      new Request('https://x/api/teachers/leakpub000000003', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await res.text()
    expect(body).not.toContain(TOKEN)
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
