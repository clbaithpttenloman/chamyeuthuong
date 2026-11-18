// @vitest-environment node
/**
 * Tests for worker/qr.ts
 *
 * Contract:
 *   handleQr(request: Request, env: Env): Promise<Response>
 *   — handles GET /api/qr/:token
 *   — returns { teacher: { id, title, name, subject, department }, cards: PublicCard[], total }
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { handleQr } from './qr.ts'
import { testDb, type D1 } from './testDb.ts'
import { TEST_EMAIL } from './testAuth.ts'

const VALID_TOKEN = 'tok1234567890abc'

function makeEnv(db: D1, opts: { cardIpLimit?: boolean } = {}) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    PUBLIC_IP_LIMIT: { limit: async () => ({ success: true }) },
    SUBMIT_IP_LIMIT: { limit: async () => ({ success: true }) },
    CARD_IP_LIMIT: { limit: async (_: { key: string }) => ({ success: opts.cardIpLimit ?? true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined as string | undefined,
    ALLOW_FIRST_CLAIM: undefined as string | undefined,
  }
}

async function seedTeacher(db: D1, opts: { token?: string } = {}) {
  const now = new Date().toISOString()
  const tok = opts.token ?? VALID_TOKEN
  await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
    .bind(tok, 'Teacher', 'Math', now).run()
  const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(tok).first<{ id: number }>())!.id
  await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, 'Thầy').run()
  await db.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)')
    .bind(tid, '', 1).run()
  return { tid }
}

async function seedTemplate(db: D1) {
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
    .bind('Default', 'classic', 1, now, TEST_EMAIL).run()
  return (await db.prepare('SELECT id FROM template WHERE name=?').bind('Default').first<{ id: number }>())!.id
}

let db: D1

beforeEach(() => {
  ;({ db } = testDb())
})

// ---- Happy path ----

describe('GET /api/qr/:token — happy path', () => {
  it('valid token with approved cards → 200 { teacher: {id,...}, cards: [...], total }', async () => {
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('crd1234567890abc', tid, tmplId, 'Chúc mừng!', '', '', 0, 'approved', now).run()

    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { teacher: Record<string, unknown>; cards: unknown[]; total: number }
    expect(body.teacher).toHaveProperty('id')
    expect(typeof body.teacher['id']).toBe('number')
    expect(body.teacher).toHaveProperty('title', 'Thầy')
    expect(body.teacher).toHaveProperty('name')
    expect(body.teacher).not.toHaveProperty('token')
    expect(body.teacher).not.toHaveProperty('publicId')
    expect(Array.isArray(body.cards)).toBe(true)
    expect(body.cards).toHaveLength(1)
    expect(body.total).toBe(1)
  })

  it('no approved cards → { teacher, cards: [], total: 0 }', async () => {
    await seedTeacher(db)
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { cards: unknown[]; total: number }
    expect(Array.isArray(body.cards)).toBe(true)
    expect(body.cards).toHaveLength(0)
    expect(body.total).toBe(0)
  })

  it('total reflects all approved cards', async () => {
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    for (let i = 0; i < 5; i++) {
      await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(`crd${String(i).padStart(13, '0')}`, tid, tmplId, `msg${i}`, '', '', 0, 'approved', now).run()
    }
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { total: number }
    expect(body.total).toBe(5)
  })
})

// ---- All approved cards newest first, capped at 200 ----

describe('GET /api/qr/:token — cards array, newest first, 200 cap', () => {
  it('response has "cards" array (not single "card")', async () => {
    await seedTeacher(db)
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as Record<string, unknown>
    expect(Array.isArray(body['cards'])).toBe(true)
    expect(body).not.toHaveProperty('card')
  })

  it('cards are ordered newest first', async () => {
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    const times = ['2024-01-01T10:00:00.000Z', '2024-01-01T11:00:00.000Z', '2024-01-01T12:00:00.000Z']
    for (let i = 0; i < 3; i++) {
      await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(`crdtime${String(i).padStart(9, '0')}`, tid, tmplId, `msg${i}`, '', '', 0, 'approved', times[i]).run()
    }
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { cards: Array<{ createdAt: string }> }
    expect(body.cards.length).toBe(3)
    expect(body.cards[0].createdAt).toBe('2024-01-01T12:00:00.000Z')
    expect(body.cards[2].createdAt).toBe('2024-01-01T10:00:00.000Z')
  })

  it('with 201 approved cards, cards.length = 200 and total = 201', async () => {
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    for (let i = 0; i < 201; i++) {
      const pid = `c${String(i).padStart(15, '0')}`
      await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(pid, tid, tmplId, `msg${i}`, '', '', 0, 'approved', now).run()
    }
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { cards: unknown[]; total: number }
    expect(body.cards.length).toBe(200)
    expect(body.total).toBe(201)
  })
})

// ---- Moderation invariant: hidden/pending never in cards array ----

describe('GET /api/qr/:token — hidden/pending cards never in cards array', () => {
  it('pending card is never in the cards array', async () => {
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('pnd1234567890abc', tid, tmplId, 'Pending!', '', '', 0, 'pending', now).run()
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { cards: unknown[]; total: number }
    expect(Array.isArray(body.cards)).toBe(true)
    expect(body.cards).toHaveLength(0)
    expect(body.total).toBe(0)
  })

  it('hidden card is never in the cards array', async () => {
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('hid1234567890abc', tid, tmplId, 'Hidden!', '', '', 0, 'hidden', now).run()
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { cards: unknown[]; total: number }
    expect(Array.isArray(body.cards)).toBe(true)
    expect(body.cards).toHaveLength(0)
    expect(body.total).toBe(0)
  })

  it('pending/hidden text not echoed in cards array body', async () => {
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('pndmarker1234567', tid, tmplId, 'PENDING_MSG', '', '', 0, 'pending', now).run()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('hidmarker1234567', tid, tmplId, 'HIDDEN_MSG', '', '', 0, 'hidden', now).run()

    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const bodyStr = JSON.stringify(await r.json())
    expect(bodyStr).not.toContain('PENDING_MSG')
    expect(bodyStr).not.toContain('HIDDEN_MSG')
  })
})

// ---- Not found cases ----

describe('GET /api/qr/:token — not found', () => {
  it('unknown valid token → 404 { error: "not_found" }', async () => {
    const r = await handleQr(
      new Request('https://x/api/qr/unknowntoken1234', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })

  it('malformed token → 404 with zero DB statements', async () => {
    const { db: freshDb, state } = testDb()
    const r = await handleQr(
      new Request('https://x/api/qr/BAD!!', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(freshDb),
    )
    expect(r.status).toBe(404)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('malformed and unknown token return identical 404 body (no info leak)', async () => {
    const badRes = await handleQr(
      new Request('https://x/api/qr/BAD!!', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const unknownRes = await handleQr(
      new Request('https://x/api/qr/unknowntoken1234', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(await badRes.text()).toBe(await unknownRes.text())
  })
})

// ---- Rate limit — checked first ----

describe('GET /api/qr/:token — rate limit first', () => {
  it('exhausted CARD_IP_LIMIT → 429, zero DB statements including DDL', async () => {
    const { db: freshDb, state } = testDb()
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(freshDb, { cardIpLimit: false }),
    )
    expect(r.status).toBe(429)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('rate limit is checked BEFORE token validation — malformed token still 429 when limited', async () => {
    const r = await handleQr(
      new Request('https://x/api/qr/BAD!!', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db, { cardIpLimit: false }),
    )
    expect(r.status).toBe(429)
  })
})

// ---- Method guard ----

describe('GET /api/qr/:token — method guard', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('%s → 405', async (method) => {
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { method, headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(405)
  })

  it('OPTIONS → 405 without Access-Control-* headers', async () => {
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { method: 'OPTIONS', headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(405)
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Methods')).toBeNull()
  })
})

// ---- Security headers ----

describe('GET /api/qr/:token — security headers', () => {
  it('every response has Cache-Control: no-store, X-Content-Type-Options, X-Robots-Tag', async () => {
    const r = await handleQr(
      new Request('https://x/api/qr/unknowntoken1234', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex')
  })
})

// ---- Token never in response body ----

describe('GET /api/qr/:token — token never in response body', () => {
  it('response body never contains the teacher QR token value', async () => {
    const { tid } = await seedTeacher(db, { token: VALID_TOKEN })
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('crd1234567890abc', tid, tmplId, 'Chúc mừng!', '', '', 0, 'approved', now).run()

    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const bodyStr = await r.text()
    expect(bodyStr).not.toContain(VALID_TOKEN)
  })
})

// ---- Hidden teacher can access via token ----

describe('GET /api/qr/:token — hidden teacher', () => {
  it('hidden teacher (show_on_home=0) can still access their cards via token', async () => {
    const { db: freshDb } = testDb()
    const now = new Date().toISOString()
    await freshDb.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind(VALID_TOKEN, 'Hidden Teacher', 'Art', now).run()
    const tid = (await freshDb.prepare('SELECT id FROM teacher WHERE token=?').bind(VALID_TOKEN).first<{ id: number }>())!.id
    await freshDb.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, 'Thầy').run()
    // show_on_home = 0 (hidden from wall, but reachable via token)
    await freshDb.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)').bind(tid, '', 0).run()

    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(freshDb),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { teacher: { name: string }; total: number }
    expect(body.teacher.name).toBe('Hidden Teacher')
    expect(body.total).toBe(0)
  })
})

// ---- No public_id (snake_case) in response ----

describe('GET /api/qr/:token — card shape uses camelCase publicId', () => {
  it('cards use publicId (camelCase), not public_id (snake_case DB column)', async () => {
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('crd1234567890abc', tid, tmplId, 'Chúc mừng!', '', '', 0, 'approved', now).run()

    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { cards: Array<Record<string, unknown>> }
    expect(body.cards).toHaveLength(1)
    expect(body.cards[0]).toHaveProperty('publicId')
    expect(body.cards[0]).not.toHaveProperty('public_id')
  })
})

describe('GET /api/qr/:token — role', () => {
  it('teacher carries role (default Giáo viên; stored value after update)', async () => {
    const { db } = testDb()
    const { tid } = await seedTeacher(db)
    const get = async () => ((await (await handleQr(new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))).json()) as { teacher: { role: string } }).teacher.role
    expect(await get()).toBe('Giáo viên')
    await db.prepare("UPDATE teacher_profile SET role = 'Phó hiệu trưởng' WHERE teacher_id = ?").bind(tid).run()
    expect(await get()).toBe('Phó hiệu trưởng')
  })
})

describe('GET /api/qr/:token — teacher without a teacher_profile row', () => {
  it('role falls back to Giáo viên', async () => {
    const { db } = testDb()
    await db.prepare("INSERT INTO teacher (token, name, subject, created_at) VALUES (?, 'T', '', '2026-11-18')").bind(VALID_TOKEN).run()
    const r = await handleQr(new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    expect(r.status).toBe(200)
    expect(((await r.json()) as { teacher: { role: string } }).teacher.role).toBe('Giáo viên')
  })
})

// ---- Card v3: font, ink, resolved layout, background only ----

describe('GET /api/qr/:token — card v3 fields', () => {
  it('each card carries font, ink and the resolved layout; only the background image', async () => {
    const { db } = testDb()
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db) // legacy layout 'classic'
    await db.prepare("INSERT INTO image (id, token, name, mime, size, data, created_at, created_by) VALUES (1, 'img0000000000001', 'bg', 'image/png', 1, 'AA==', 'x', 'a')").run()
    await db.prepare("INSERT INTO template_image (template_id, slot, image_id) VALUES (?, 'background', 1)").bind(tmplId).run()
    await db.prepare("INSERT INTO student_card (public_id,teacher_id,template_id,message,status,created_at,font,ink) VALUES ('crd0000000000001',?,?,'a','approved','2026-11-18T01:00:00Z','lora','#6b21a8')").bind(tid, tmplId).run()
    await db.prepare("INSERT INTO student_card (public_id,teacher_id,template_id,message,status,created_at) VALUES ('crd0000000000002',?,?,'b','approved','2026-11-18T00:00:00Z')").bind(tid, tmplId).run()
    const r = await handleQr(new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    const { cards } = (await r.json()) as { cards: { font: string; ink: string; layout: string; images: Record<string, string> }[] }
    expect(cards.map((c) => [c.font, c.ink, c.layout])).toEqual([['lora', '#6b21a8', 'doc-giua'], ['patrick-hand', '#1d3fa6', 'doc-giua']])
    expect(cards[0].images).toEqual({ background: 'img0000000000001' })
  })

  it('a stored font or ink that is not valid any more is returned as the default', async () => {
    const { db } = testDb()
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    await db.prepare("INSERT INTO student_card (public_id,teacher_id,template_id,message,status,created_at,font) VALUES ('crd0000000000001',?,?,'a','approved','x','retired-font')").bind(tid, tmplId).run()
    const r = await handleQr(new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    const { cards } = (await r.json()) as { cards: { font: string; ink: string }[] }
    expect(cards[0]).toMatchObject({ font: 'patrick-hand', ink: '#1d3fa6' })
  })
})
