// @vitest-environment node
/**
 * Tests for worker/wishes.ts
 * Failing until Group 2 creates worker/wishes.ts.
 *
 * Contract:
 *   handleWishes(request, env, email): Promise<Response>
 *     GET  /api/admin/wishes         → list (seeds + user wishes)
 *     POST /api/admin/wishes         → create
 *     PUT  /api/admin/wishes/:id     → update
 *     DELETE /api/admin/wishes/:id   → delete
 */

// This import fails until wishes.ts is created → all tests in this file fail
import { handleWishes } from './wishes.ts'
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, type D1 } from './testDb.ts'
import { TEST_EMAIL } from './testAuth.ts'

type WishRow = {
  id: number
  title: string
  body: string
  created_at: string
  created_by: string
}

function makeEnv(db: D1) {
  return { DB: db }
}

function wishReq(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = {
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

let db: D1

beforeEach(() => {
  ;({ db } = testDb())
})

// ===================================================================
// Seeds visible in GET
// ===================================================================

describe('GET /api/admin/wishes — seeds', () => {
  it('returns at least 12 seeded wishes', async () => {
    const r = await handleWishes(wishReq('GET', '/api/admin/wishes'), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(200)
    const list = await r.json() as WishRow[]
    expect(list.length).toBeGreaterThanOrEqual(12)
  })

  it('seeded wishes have non-empty title and body', async () => {
    const r = await handleWishes(wishReq('GET', '/api/admin/wishes'), makeEnv(db), TEST_EMAIL)
    const list = await r.json() as WishRow[]
    for (const w of list) {
      expect(w.title.length).toBeGreaterThan(0)
      expect(w.body.length).toBeGreaterThan(0)
    }
  })
})

// ===================================================================
// CREATE
// ===================================================================

describe('POST /api/admin/wishes', () => {
  it('creates a wish and returns it with correct fields', async () => {
    const r = await handleWishes(
      wishReq('POST', '/api/admin/wishes', { title: 'Tiêu đề', body: 'Nội dung lời chúc.' }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as WishRow
    expect(body.title).toBe('Tiêu đề')
    expect(body.body).toBe('Nội dung lời chúc.')
    expect(body.created_by).toBe(TEST_EMAIL)
    expect(typeof body.id).toBe('number')
  })

  it('title > 80 chars → 400', async () => {
    const r = await handleWishes(
      wishReq('POST', '/api/admin/wishes', { title: 'T'.repeat(81), body: 'body' }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('body > 600 chars → 400', async () => {
    const r = await handleWishes(
      wishReq('POST', '/api/admin/wishes', { title: 'title', body: 'B'.repeat(601) }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('empty title → 400', async () => {
    const r = await handleWishes(
      wishReq('POST', '/api/admin/wishes', { title: '', body: 'body' }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('empty body → 400', async () => {
    const r = await handleWishes(
      wishReq('POST', '/api/admin/wishes', { title: 'title', body: '' }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('missing title → 400', async () => {
    const r = await handleWishes(
      wishReq('POST', '/api/admin/wishes', { body: 'body only' }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('title = 80 chars exactly → 200', async () => {
    const r = await handleWishes(
      wishReq('POST', '/api/admin/wishes', { title: 'T'.repeat(80), body: 'body' }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
  })

  it('body = 600 chars exactly → 200', async () => {
    const r = await handleWishes(
      wishReq('POST', '/api/admin/wishes', { title: 'title', body: 'B'.repeat(600) }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
  })
})

// ===================================================================
// UPDATE
// ===================================================================

describe('PUT /api/admin/wishes/:id', () => {
  it('updates title and body of an existing wish', async () => {
    const created = await (
      await handleWishes(
        wishReq('POST', '/api/admin/wishes', { title: 'Old title', body: 'Old body' }),
        makeEnv(db),
        TEST_EMAIL,
      )
    ).json() as WishRow

    const r = await handleWishes(
      wishReq('PUT', `/api/admin/wishes/${created.id}`, { title: 'New title', body: 'New body' }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const updated = await r.json() as WishRow
    expect(updated.title).toBe('New title')
    expect(updated.body).toBe('New body')
  })

  it('unknown id → 404', async () => {
    const r = await handleWishes(
      wishReq('PUT', '/api/admin/wishes/9999', { title: 't', body: 'b' }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(404)
  })

  it('title > 80 chars on update → 400', async () => {
    const created = await (
      await handleWishes(wishReq('POST', '/api/admin/wishes', { title: 't', body: 'b' }), makeEnv(db), TEST_EMAIL)
    ).json() as WishRow
    const r = await handleWishes(
      wishReq('PUT', `/api/admin/wishes/${created.id}`, { title: 'T'.repeat(81), body: 'b' }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })
})

// ===================================================================
// DELETE
// ===================================================================

describe('DELETE /api/admin/wishes/:id', () => {
  it('deletes a wish → 200', async () => {
    const created = await (
      await handleWishes(wishReq('POST', '/api/admin/wishes', { title: 't', body: 'b' }), makeEnv(db), TEST_EMAIL)
    ).json() as WishRow

    const r = await handleWishes(
      wishReq('DELETE', `/api/admin/wishes/${created.id}`),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    expect(await db.prepare('SELECT id FROM wish WHERE id=?').bind(created.id).first()).toBeNull()
  })

  it('delete always allowed (no "in-use" block) → 200', async () => {
    const created = await (
      await handleWishes(wishReq('POST', '/api/admin/wishes', { title: 't', body: 'b' }), makeEnv(db), TEST_EMAIL)
    ).json() as WishRow
    const r = await handleWishes(
      wishReq('DELETE', `/api/admin/wishes/${created.id}`),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
  })

  it('unknown id → 404', async () => {
    const r = await handleWishes(
      wishReq('DELETE', '/api/admin/wishes/9999'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(404)
  })
})

// ===================================================================
// 200-wish cap
// ===================================================================

describe('wishes cap — max 200', () => {
  it('creating a 201st wish → 409 conflict', async () => {
    // Seed 200 wishes directly
    for (let i = 0; i < 200; i++) {
      await db
        .prepare('INSERT INTO wish (title,body,created_at,created_by) VALUES (?,?,?,?)')
        .bind(`t${i}`, `b${i}`, new Date().toISOString(), TEST_EMAIL)
        .run()
    }
    const r = await handleWishes(
      wishReq('POST', '/api/admin/wishes', { title: 'extra', body: 'body' }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('conflict')
  })
})

// ===================================================================
// Fix Group 1 — new tests (must fail before fixes)
// ===================================================================

describe('wishes — RETURNING and atomic cap (Fix Group 1)', () => {
  it('created wish returns the inserted row (title/body trimmed, correct created_by)', async () => {
    const r = await handleWishes(
      wishReq('POST', '/api/admin/wishes', { title: '  Tiêu đề  ', body: '  Nội dung  ' }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { title: string; body: string; created_by: string }
    // After fix: title and body are trimmed.
    expect(body.title).toBe('Tiêu đề')
    expect(body.body).toBe('Nội dung')
    expect(body.created_by).toBe(TEST_EMAIL)
  })

  it('concurrent creates at 199 wishes → exactly one succeeds, one gets 409 (atomic cap)', async () => {
    // Seed 199 wishes (the seeded ones from schema count toward the cap).
    // Clear the seeded wishes first, then seed exactly 199.
    await db.prepare('DELETE FROM wish').run()
    for (let i = 0; i < 199; i++) {
      await db
        .prepare('INSERT INTO wish (title, body, created_at, created_by) VALUES (?, ?, ?, ?)')
        .bind(`t${i}`, `b${i}`, new Date().toISOString(), TEST_EMAIL)
        .run()
    }

    // Two concurrent creates: both see count=199 without atomic fix → both insert → [200,200].
    // With atomic INSERT…SELECT…WHERE COUNT < 200: one inserts, one gets no row → 409 → [200,409].
    const [r1, r2] = await Promise.all([
      handleWishes(wishReq('POST', '/api/admin/wishes', { title: 'Wish A', body: 'Body A' }), makeEnv(db), TEST_EMAIL),
      handleWishes(wishReq('POST', '/api/admin/wishes', { title: 'Wish B', body: 'Body B' }), makeEnv(db), TEST_EMAIL),
    ])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 409])
  })
})
