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

const VALID_TOKEN = 'tok1234567890ab'

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
  const pubId = opts.publicId ?? 'pub1234567890ab'
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
      .bind('crd1234567890ab', tid, tmplId, 'Chúc mừng!', '', '', 0, 'approved', now).run()

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
      .bind('pnd1234567890ab', tid, tmplId, 'Pending!', '', '', 0, 'pending', now).run()
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
      .bind('hid1234567890ab', tid, tmplId, 'Hidden!', '', '', 0, 'hidden', now).run()
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
