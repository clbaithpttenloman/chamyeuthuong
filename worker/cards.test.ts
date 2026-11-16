// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { handleCard } from './cards.ts'
import { testDb, type D1 } from './testDb.ts'

const VALID_TOKEN = 'abc123def456gh78'

function makeEnv(db: D1, opts: { cardIpLimit?: boolean } = {}) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    CARD_IP_LIMIT: { limit: async (_: { key: string }) => ({ success: opts.cardIpLimit ?? true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) },
  }
}

/** Seed one teacher + card row directly into the DB for test setup. */
async function seedTeacher(db: D1, opts: { token?: string; name?: string; subject?: string; message?: string; status?: 'draft' | 'published' } = {}) {
  const token = opts.token ?? VALID_TOKEN
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
    .bind(token, opts.name ?? 'Nguyen Van A', opts.subject ?? 'Math', now).run()
  const row = await db.prepare('SELECT id FROM teacher WHERE token = ?').bind(token).first<{ id: number }>()
  const id = row!.id
  await db.prepare('INSERT INTO card (teacher_id, message, status, updated_at) VALUES (?, ?, ?, ?)')
    .bind(id, opts.message ?? 'Happy Teachers Day!', opts.status ?? 'published', now).run()
  return { id, token }
}

let db: D1

beforeEach(() => {
  ({ db } = testDb())
})

describe('GET /api/card/:token — published card', () => {
  it('returns 200 with { name, subject, message }', async () => {
    await seedTeacher(db, { name: 'Le Thi B', subject: 'Physics', message: 'Thank you!', status: 'published' })
    const r = await handleCard(new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    expect(r.status).toBe(200)
    const body = await r.json() as { name?: string; subject?: string; message?: string }
    expect(body.name).toBe('Le Thi B')
    expect(body.subject).toBe('Physics')
    expect(body.message).toBe('Thank you!')
  })

  it('response does NOT include token, id, created_at or status', async () => {
    await seedTeacher(db)
    const r = await handleCard(new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    const body = await r.json() as Record<string, unknown>
    expect(body).not.toHaveProperty('token')
    expect(body).not.toHaveProperty('id')
    expect(body).not.toHaveProperty('created_at')
    expect(body).not.toHaveProperty('status')
  })
})

describe('GET /api/card/:token — not found cases (all return identical 404)', () => {
  it('draft card returns 404 { error: "not_found" }', async () => {
    await seedTeacher(db, { status: 'draft' })
    const r = await handleCard(new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })

  it('unknown token returns 404 { error: "not_found" }', async () => {
    const r = await handleCard(new Request('https://x/api/card/unknowntoken1234', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })

  it('malformed token returns 404 same body (not 400)', async () => {
    for (const bad of ['tooshort', 'TOO-LONG-AND-UPPERCASE!!', '']) {
      const r = await handleCard(new Request(`https://x/api/card/${bad}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
      expect(r.status).toBe(404)
      expect((await r.json() as { error: string }).error).toBe('not_found')
    }
  })

  it('draft and unknown token have the same response body (no info leak)', async () => {
    await seedTeacher(db, { status: 'draft' })
    const draft = await (await handleCard(new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))).text()
    const missing = await (await handleCard(new Request('https://x/api/card/unknowntoken1234', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))).text()
    expect(draft).toBe(missing)
  })
})

describe('rate limiting', () => {
  it('exhausted CARD_IP_LIMIT returns 429 { error: "rate_limited" }', async () => {
    const r = await handleCard(new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db, { cardIpLimit: false }))
    expect(r.status).toBe(429)
    expect((await r.json() as { error: string }).error).toBe('rate_limited')
  })

  it('rate limit is checked BEFORE token validation — malformed token still returns 429 when limited', async () => {
    const r = await handleCard(new Request('https://x/api/card/BAD!!', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db, { cardIpLimit: false }))
    expect(r.status).toBe(429)
  })
})

describe('method guard', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('%s returns 405 { error: "method" }', async (method) => {
    const r = await handleCard(new Request(`https://x/api/card/${VALID_TOKEN}`, { method, headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))
    expect(r.status).toBe(405)
    expect((await r.json() as { error: string }).error).toBe('method')
  })
})

describe('security headers', () => {
  it.each([
    ['200 published', async () => { await seedTeacher(db); return handleCard(new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db)) }],
    ['404 unknown',   async () => handleCard(new Request('https://x/api/card/unknowntoken1234', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))],
    ['429 rate limit', async () => handleCard(new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db, { cardIpLimit: false }))],
    ['405 wrong method', async () => handleCard(new Request(`https://x/api/card/${VALID_TOKEN}`, { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' } }), makeEnv(db))],
  ])('%s has Cache-Control, X-Content-Type-Options, X-Robots-Tag', async (_, makeReq) => {
    const r = await makeReq()
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex')
  })
})

// ---- New: empty database (ensureSchema integration) ----

describe('empty database (no tables) — ensureSchema integration', () => {
  it('well-formed unknown token on a table-less DB returns 404 (not 503)', async () => {
    // handleCard must call ensureSchema before the SELECT so that a fresh DB returns
    // 404 (card not found) rather than propagating a "no such table" error.
    const { db } = testDb({ schema: false })
    const r = await handleCard(
      new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(404)
  })
})

// ---- New: zero DB statements (prepares + DDL) for early exits ----

describe('zero DB statements including DDL for early exits', () => {
  it('rate-limited request issues zero prepares and zero DDL', async () => {
    const { db, state } = testDb()
    const r = await handleCard(
      new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db, { cardIpLimit: false }),
    )
    expect(r.status).toBe(429)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('malformed token issues zero prepares and zero DDL', async () => {
    const { db, state } = testDb()
    const r = await handleCard(
      new Request('https://x/api/card/BAD!!', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(404)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('wrong method issues zero prepares and zero DDL', async () => {
    const { db, state } = testDb()
    const r = await handleCard(
      new Request(`https://x/api/card/${VALID_TOKEN}`, { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(405)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })
})

// ===================================================================
// New: layout and images in public card JSON (failing until Group 2)
// ===================================================================

describe('GET /api/card/:token — layout and images (failing until Group 2)', () => {
  it('published card returns layout (default "classic" when no card_style row)', async () => {
    await seedTeacher(db, { status: 'published' })
    const r = await handleCard(
      new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { layout?: string }
    expect(body.layout).toBe('classic')
  })

  it('published card returns custom layout when card_style row exists', async () => {
    const { id } = await seedTeacher(db, { status: 'published' })
    // Insert a card_style row for the teacher
    await db.prepare('INSERT INTO card_style (teacher_id, layout) VALUES (?, ?)').bind(id, 'lotus').run()
    const r = await handleCard(
      new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { layout?: string }
    expect(body.layout).toBe('lotus')
  })

  it('published card returns images as { [slot]: token } (empty when no images)', async () => {
    await seedTeacher(db, { status: 'published' })
    const r = await handleCard(
      new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { images?: Record<string, string> }
    expect(typeof body.images).toBe('object')
    expect(Object.keys(body.images ?? {})).toHaveLength(0)
  })

  it('published card returns image tokens for each attached slot', async () => {
    const { id } = await seedTeacher(db, { status: 'published' })
    // Seed an image row
    const imgToken = 'imgabc1234567890'
    const now = new Date().toISOString()
    await db
      .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
      .bind(imgToken, 'x.jpg', 'image/jpeg', 100, 'data', now, 'admin@example.com')
      .run()
    const imgId = (await db.prepare('SELECT id FROM image WHERE token=?').bind(imgToken).first<{ id: number }>())!.id
    await db.prepare('INSERT INTO card_image (teacher_id, slot, image_id) VALUES (?, ?, ?)').bind(id, 'banner', imgId).run()

    const r = await handleCard(
      new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { images?: Record<string, string> }
    expect(body.images?.['banner']).toBe(imgToken)
    expect(body.images).not.toHaveProperty('background')
    expect(body.images).not.toHaveProperty('photo')
  })

  it('response does NOT include unknown slots', async () => {
    await seedTeacher(db, { status: 'published' })
    const r = await handleCard(
      new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    const body = await r.json() as Record<string, unknown>
    // Only 'background', 'banner', 'photo' are valid slot keys
    const images = body['images'] as Record<string, unknown>
    for (const key of Object.keys(images ?? {})) {
      expect(['background', 'banner', 'photo']).toContain(key)
    }
  })

  it('draft card still returns 404 regardless of layout/images', async () => {
    const { id } = await seedTeacher(db, { status: 'draft' })
    await db.prepare('INSERT INTO card_style (teacher_id, layout) VALUES (?, ?)').bind(id, 'night').run()
    const r = await handleCard(
      new Request(`https://x/api/card/${VALID_TOKEN}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(404)
  })
})
