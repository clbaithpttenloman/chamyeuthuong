// @vitest-environment node
/**
 * Tests for worker/qr.ts
 * All tests fail until Group 2 creates worker/qr.ts.
 *
 * Contract expected:
 *   handleQr(request: Request, env: Env): Promise<Response>
 *   — handles GET /api/qr/:token (private QR token → random approved card)
 */
import { describe, it, expect, beforeEach } from 'vitest'

// This import fails until Group 2 creates the module → all tests fail
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

async function seedTeacher(db: D1, opts: { token?: string; publicId?: string } = {}) {
  const now = new Date().toISOString()
  const tok = opts.token ?? VALID_TOKEN
  const pubId = opts.publicId ?? 'pub1234567890abc'
  await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
    .bind(tok, 'Teacher', 'Math', now).run()
  const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(tok).first<{ id: number }>())!.id
  await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, 'Thầy').run()
  await db.prepare('INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES (?, ?, ?, ?)')
    .bind(tid, pubId, '', 1).run()
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
  it('valid token with one approved card → 200 { teacher, card, total }', async () => {
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
    const body = await r.json() as { teacher: Record<string, unknown>; card: Record<string, unknown> | null; total: number }
    expect(body.teacher).toHaveProperty('publicId')
    expect(body.teacher).toHaveProperty('title')
    expect(body.teacher).toHaveProperty('name')
    expect(body.teacher).not.toHaveProperty('token')
    expect(body.card).not.toBeNull()
    expect(body.total).toBe(1)
  })

  it('no approved cards → { teacher, card: null, total: 0 }', async () => {
    await seedTeacher(db)
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { card: unknown; total: number }
    expect(body.card).toBeNull()
    expect(body.total).toBe(0)
  })

  it('with several approved cards, different calls may return different cards (random)', async () => {
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    // Insert 5 approved cards
    for (let i = 0; i < 5; i++) {
      await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(`crd${String(i).padStart(13, '0')}`, tid, tmplId, `msg${i}`, '', '', 0, 'approved', now).run()
    }
    const publicIds = new Set<string>()
    for (let n = 0; n < 20; n++) {
      const r = await handleQr(
        new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
        makeEnv(db),
      )
      const body = await r.json() as { card: { publicId: string } | null }
      if (body.card) publicIds.add(body.card.publicId)
    }
    // With 5 cards and 20 calls, we expect at least 2 different cards (statistically near-certain)
    expect(publicIds.size).toBeGreaterThan(1)
  })

  it('total reflects all approved cards (not just the one returned)', async () => {
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

// ---- Moderation invariant: hidden/pending never chosen ----

describe('GET /api/qr/:token — hidden/pending cards never chosen', () => {
  it('pending card is never returned as the random card', async () => {
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('pnd1234567890abc', tid, tmplId, 'Pending!', '', '', 0, 'pending', now).run()
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { card: unknown; total: number }
    expect(body.card).toBeNull()
    expect(body.total).toBe(0)
  })

  it('hidden card is never returned as the random card', async () => {
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('hid1234567890abc', tid, tmplId, 'Hidden!', '', '', 0, 'hidden', now).run()
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as { card: unknown; total: number }
    expect(body.card).toBeNull()
    expect(body.total).toBe(0)
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

// ===================================================================
// New for privacy-about plan — FAILING until Group 2 updates qr.ts
// ===================================================================

describe('GET /api/qr/:token — cards array, newest first, 200 cap (failing until Group 2)', () => {
  it('response has "cards" array (not single "card") — FAILS until Group 2', async () => {
    // After Group 2: { teacher, cards: [], total }. Before Group 2: { teacher, card: null, total }.
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as Record<string, unknown>
    // After Group 2: has 'cards' array, no 'card'. Before Group 2: has 'card' → FAIL.
    expect(Array.isArray(body['cards'])).toBe(true)
    expect(body).not.toHaveProperty('card')
  })

  it('cards are ordered newest first — FAILS until Group 2 returns all cards', async () => {
    const { tid } = await seedTeacher(db)
    const tmplId = await seedTemplate(db)
    // Insert 3 cards with distinct timestamps
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
    expect(Array.isArray(body.cards)).toBe(true)
    // After Group 2: newest (2024-01-01T12:...) is first. Before Group 2: returns single random card → FAIL.
    expect(body.cards.length).toBe(3)
    expect(body.cards[0].createdAt).toBe('2024-01-01T12:00:00.000Z')
    expect(body.cards[2].createdAt).toBe('2024-01-01T10:00:00.000Z')
  })

  it('with 201 approved cards, cards.length = 200 and total = 201 — FAILS until Group 2', async () => {
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
    // After Group 2: cards.length = 200, total = 201. Before Group 2: returns single card → FAIL.
    expect(Array.isArray(body.cards)).toBe(true)
    expect(body.cards.length).toBe(200)
    expect(body.total).toBe(201)
  })

  it('response never contains "token" string in body — FAILS until Group 2 fixes teacher shape', async () => {
    // The teacher object in QrResponse must not contain the private QR token.
    // After Group 2: teacher has {id, title, name, subject, department} — no token field.
    // Before Group 2: teacher has publicId (not token), but no 'token' field either — this may already pass.
    // The important check: teacher.id exists, teacher has no publicId.
    await seedTeacher(db, { token: VALID_TOKEN, publicId: 'pub1234567890abc' })
    const r = await handleQr(
      new Request(`https://x/api/qr/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as Record<string, unknown>
    const teacher = body['teacher'] as Record<string, unknown>
    // After Group 2: teacher has id (number), no publicId. Before Group 2: teacher has publicId → FAIL.
    expect(teacher).toHaveProperty('id')
    expect(typeof teacher['id']).toBe('number')
    expect(teacher).not.toHaveProperty('publicId')
    expect(teacher).not.toHaveProperty('token')
  })

  it('pending/hidden cards not in cards array — reuses existing invariant on new shape', async () => {
    // This test verifies the invariant also holds for the new cards-array shape.
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
    const body = await r.json() as { cards?: unknown[]; total: number }
    // After Group 2: cards array is empty. Before Group 2: card: null, total: 0 → FAIL on Array.isArray.
    expect(Array.isArray(body.cards)).toBe(true)
    expect(body.cards!.length).toBe(0)
    expect(body.total).toBe(0)
    const bodyStr = JSON.stringify(body)
    expect(bodyStr).not.toContain('PENDING_MSG')
    expect(bodyStr).not.toContain('HIDDEN_MSG')
  })
})
