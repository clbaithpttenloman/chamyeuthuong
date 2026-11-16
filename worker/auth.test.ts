// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { requireAdmin } from './auth.ts'
import { adminEnv, makeReq, seedAdmin, TEST_EMAIL } from './testAuth.ts'
import { testDb } from './testDb.ts'
import type { D1 } from './testDb.ts'

// ============================================================
// Header handling — X-Admin-Email: missing or invalid
// ============================================================

describe('requireAdmin — header: missing or invalid', () => {
  it('no X-Admin-Email header → 401 with zero DB prepares', async () => {
    const { db, state } = testDb()
    const r = await requireAdmin(makeReq(null), adminEnv({ db }))
    expect((r as Response).status).toBe(401)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('empty string X-Admin-Email → 401', async () => {
    const r = await requireAdmin(makeReq(''), adminEnv())
    expect((r as Response).status).toBe(401)
  })

  it('whitespace-only X-Admin-Email → 401', async () => {
    const r = await requireAdmin(makeReq('   '), adminEnv())
    expect((r as Response).status).toBe(401)
  })

  it('X-Admin-Email > 254 chars → 401 with zero DB prepares', async () => {
    const longEmail = 'a'.repeat(246) + '@example.com'  // 258 chars
    const { db, state } = testDb()
    const r = await requireAdmin(makeReq(longEmail), adminEnv({ db }))
    expect((r as Response).status).toBe(401)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('non-ASCII email (ñ) → 401 with zero DB prepares', async () => {
    const { db, state } = testDb()
    const r = await requireAdmin(makeReq('admiñ@example.com'), adminEnv({ db }))
    expect((r as Response).status).toBe(401)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('malformed address (no @) → 401', async () => {
    const r = await requireAdmin(makeReq('notanemail'), adminEnv())
    expect((r as Response).status).toBe(401)
  })

  it('malformed address (no dot in domain: admin@localhost) → 401', async () => {
    const r = await requireAdmin(makeReq('admin@localhost'), adminEnv())
    expect((r as Response).status).toBe(401)
  })

  it('malformed address (multiple @) → 401', async () => {
    const r = await requireAdmin(makeReq('a@b@example.com'), adminEnv())
    expect((r as Response).status).toBe(401)
  })

  it('duplicated X-Admin-Email header → 401 (Headers.get joins with ", ", which fails validation)', async () => {
    // Headers.get() on a duplicated header returns the comma-joined value: "a@b.com, a@b.com".
    // normalizeEmail rejects this (multiple '@', comma, whitespace inside) → 401.
    const headers = new Headers([
      ['X-Admin-Email', TEST_EMAIL],
      ['X-Admin-Email', TEST_EMAIL],
      ['CF-Connecting-IP', '1.2.3.4'],
    ])
    const r = await requireAdmin(new Request('https://x/api/admin/teachers', { headers }), adminEnv())
    expect((r as Response).status).toBe(401)
  })
})

// ============================================================
// Header handling — normalization and DB lookup
// ============================================================

describe('requireAdmin — header: normalization and lookup', () => {
  let db: D1

  beforeEach(async () => {
    ;({ db } = testDb())
    await seedAdmin(db, TEST_EMAIL)  // stored as lowercase
  })

  it('email normalized (uppercase) matches stored row → returns { email }', async () => {
    const r = await requireAdmin(makeReq(TEST_EMAIL.toUpperCase()), adminEnv({ db }))
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('email normalized (leading/trailing whitespace) matches stored row → returns { email }', async () => {
    const r = await requireAdmin(makeReq('  ' + TEST_EMAIL + '  '), adminEnv({ db }))
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('known email → returns { email }', async () => {
    const r = await requireAdmin(makeReq(TEST_EMAIL), adminEnv({ db }))
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('unknown email on populated table → 401, no insert', async () => {
    const r = await requireAdmin(makeReq('stranger@example.com'), adminEnv({ db }))
    expect((r as Response).status).toBe(401)
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })
})

// ============================================================
// Rate limiting — checked first, before email
// ============================================================

describe('requireAdmin — rate limiting', () => {
  it('exhausted ADMIN_FAIL_LIMIT → 429', async () => {
    const r = await requireAdmin(makeReq(TEST_EMAIL), adminEnv({ failLimit: false }))
    expect((r as Response).status).toBe(429)
  })

  it('no X-Admin-Email + rate limit exhausted → 429 (rate limit checked before email)', async () => {
    const r = await requireAdmin(makeReq(null), adminEnv({ failLimit: false }))
    expect((r as Response).status).toBe(429)
  })

  it('rate limit exhausted → zero DB prepares (DB never touched)', async () => {
    const { db, state } = testDb()
    await requireAdmin(makeReq(TEST_EMAIL), adminEnv({ failLimit: false, db }))
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })
})

// ============================================================
// CSRF: Sec-Fetch-Site and X-Requested-With
// ============================================================

describe('requireAdmin — CSRF checks', () => {
  let db: D1

  beforeEach(async () => {
    ;({ db } = testDb())
    await seedAdmin(db, TEST_EMAIL)
  })

  it('POST with valid admin email but no X-Requested-With → 403 forbidden', async () => {
    const r = await requireAdmin(makeReq(TEST_EMAIL, { method: 'POST', noXrw: true }), adminEnv({ db }))
    expect((r as Response).status).toBe(403)
  })

  it('PUT with valid admin email but no X-Requested-With → 403 forbidden', async () => {
    const r = await requireAdmin(makeReq(TEST_EMAIL, { method: 'PUT', noXrw: true }), adminEnv({ db }))
    expect((r as Response).status).toBe(403)
  })

  it('DELETE with valid admin email but no X-Requested-With → 403 forbidden', async () => {
    const r = await requireAdmin(makeReq(TEST_EMAIL, { method: 'DELETE', noXrw: true }), adminEnv({ db }))
    expect((r as Response).status).toBe(403)
  })

  it('HEAD with valid admin email but no X-Requested-With → 403 forbidden', async () => {
    const r = await requireAdmin(makeReq(TEST_EMAIL, { method: 'HEAD', noXrw: true }), adminEnv({ db }))
    expect((r as Response).status).toBe(403)
  })

  it('POST with valid admin email AND X-Requested-With: fetch → returns { email }', async () => {
    const r = await requireAdmin(makeReq(TEST_EMAIL, { method: 'POST' }), adminEnv({ db }))
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('GET with valid admin email and no X-Requested-With → returns { email } (GET exempt from CSRF)', async () => {
    const r = await requireAdmin(makeReq(TEST_EMAIL), adminEnv({ db }))
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('GET with Sec-Fetch-Site: cross-site → 403 forbidden', async () => {
    const r = await requireAdmin(makeReq(TEST_EMAIL, { secFetchSite: 'cross-site' }), adminEnv({ db }))
    expect((r as Response).status).toBe(403)
  })

  it('POST with Sec-Fetch-Site: cross-site and X-Requested-With → 403 (Sec-Fetch-Site wins)', async () => {
    const r = await requireAdmin(
      makeReq(TEST_EMAIL, { method: 'POST', secFetchSite: 'cross-site' }),
      adminEnv({ db }),
    )
    expect((r as Response).status).toBe(403)
  })

  it('valid admin email with Sec-Fetch-Site: cross-site → 403 and zero DB statements', async () => {
    // CSRF fires before the DB lookup; the DB must never be touched.
    const { db: freshDb, state } = testDb()
    await seedAdmin(freshDb, TEST_EMAIL)
    state.prepares = 0  // seeding used prepare(); count only what requireAdmin does
    const r = await requireAdmin(
      makeReq(TEST_EMAIL, { secFetchSite: 'cross-site' }),
      adminEnv({ db: freshDb }),
    )
    expect((r as Response).status).toBe(403)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('POST without X-Requested-With → zero DB prepares (CSRF checked before DB)', async () => {
    const { db: freshDb, state } = testDb()
    await seedAdmin(freshDb, TEST_EMAIL)
    state.prepares = 0
    await requireAdmin(makeReq(TEST_EMAIL, { method: 'POST', noXrw: true }), adminEnv({ db: freshDb }))
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('cross-site POST → zero DDL (CSRF checked before ensureSchema)', async () => {
    const { db: freshDb, state } = testDb()
    await seedAdmin(freshDb, TEST_EMAIL)
    state.prepares = 0
    await requireAdmin(
      makeReq(TEST_EMAIL, { method: 'POST', secFetchSite: 'cross-site' }),
      adminEnv({ db: freshDb }),
    )
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  // Email check comes BEFORE CSRF: OPTIONS without header gets 401, not 403
  it('OPTIONS without X-Admin-Email → 401 and no Access-Control-* headers', async () => {
    const r = await requireAdmin(makeReq(null, { method: 'OPTIONS', noXrw: true }), adminEnv({ db }))
    expect((r as Response).status).toBe(401)
    // OPTIONS must never return CORS headers on /api/admin/*
    expect((r as Response).headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect((r as Response).headers.get('Access-Control-Allow-Methods')).toBeNull()
    expect((r as Response).headers.get('Access-Control-Allow-Headers')).toBeNull()
  })

  it('OPTIONS with valid admin email but no X-Requested-With → 403 (no CORS headers emitted)', async () => {
    const r = await requireAdmin(makeReq(TEST_EMAIL, { method: 'OPTIONS', noXrw: true }), adminEnv({ db }))
    expect((r as Response).status).toBe(403)
    expect((r as Response).headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect((r as Response).headers.get('Access-Control-Allow-Methods')).toBeNull()
    expect((r as Response).headers.get('Access-Control-Allow-Headers')).toBeNull()
  })
})

// ============================================================
// Error response shape
// ============================================================

describe('requireAdmin — error response shape', () => {
  it('error responses carry Cache-Control, X-Content-Type-Options, X-Robots-Tag', async () => {
    const r = await requireAdmin(makeReq(null), adminEnv())
    expect((r as Response).headers.get('Cache-Control')).toBe('no-store')
    expect((r as Response).headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect((r as Response).headers.get('X-Robots-Tag')).toBe('noindex')
  })

  it('error response body is JSON with { error } field', async () => {
    const r = await requireAdmin(makeReq(null), adminEnv())
    const body = await (r as Response).json() as { error?: string }
    expect(typeof body?.error).toBe('string')
  })

  it('403 response body has error: forbidden', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const r = await requireAdmin(makeReq(TEST_EMAIL, { method: 'POST', noXrw: true }), adminEnv({ db }))
    const body = await (r as Response).json() as { error?: string }
    expect(body?.error).toBe('forbidden')
  })
})

// ============================================================
// Logging discipline — email never in logs or 401 bodies
// ============================================================

describe('requireAdmin — logging discipline', () => {
  afterEach(() => vi.restoreAllMocks())

  it('console.error/warn never contain the admin email', async () => {
    const errorCalls: unknown[][] = []
    const warnCalls: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => { errorCalls.push(args) })
    vi.spyOn(console, 'warn').mockImplementation((...args) => { warnCalls.push(args) })

    // Trigger several code paths
    await requireAdmin(makeReq('garbage@@@'), adminEnv())                           // invalid format
    const { db } = testDb()
    await seedAdmin(db, 'other@example.com')
    await requireAdmin(makeReq(TEST_EMAIL), adminEnv({ db }))                       // unknown email
    await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ allowFirstClaim: '1' })) // bootstrap

    for (const call of [...errorCalls, ...warnCalls]) {
      const msg = call.map(String).join(' ')
      expect(msg, 'must not log admin email').not.toContain(TEST_EMAIL)
    }
  })

  it('401 response body does not contain the email', async () => {
    // Unknown email on a populated table
    const { db } = testDb()
    await seedAdmin(db, 'other@example.com')
    const r = await requireAdmin(makeReq(TEST_EMAIL), adminEnv({ db }))
    const body = await (r as Response).text()
    expect(body).not.toContain(TEST_EMAIL)
  })
})

// ============================================================
// Bootstrap flow — ALLOW_FIRST_CLAIM
// ============================================================

describe('requireAdmin — bootstrap: ALLOW_FIRST_CLAIM', () => {
  afterEach(() => vi.restoreAllMocks())

  it('ALLOW_FIRST_CLAIM=1, empty table, GET + X-Requested-With → returns { email }, row has created_by=bootstrap', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const r = await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '1' }))
    expect(r).toEqual({ email: TEST_EMAIL })
    // Row inserted with created_by = 'bootstrap'
    const row = await db.prepare('SELECT created_by FROM admin WHERE email = ?').bind(TEST_EMAIL).first<{ created_by: string }>()
    expect(row?.created_by).toBe('bootstrap')
    // admin: bootstrap logged exactly once
    expect(spy).toHaveBeenCalledWith('admin: bootstrap')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('admin: bootstrap log never contains the email', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '1' }))
    for (const call of spy.mock.calls) {
      expect(call.map(String).join(' ')).not.toContain(TEST_EMAIL)
    }
  })

  it('second different user after bootstrap → 401, no extra row', async () => {
    const { db } = testDb()
    // First user claims bootstrap
    await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '1' }))
    // Second user (different email) → 401
    const r2 = await requireAdmin(makeReq('stranger@example.com', { xrw: true }), adminEnv({ db, allowFirstClaim: '1' }))
    expect((r2 as Response).status).toBe(401)
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('same user twice → both succeed, exactly one admin row', async () => {
    const { db } = testDb()
    const r1 = await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '1' }))
    const r2 = await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '1' }))
    expect(r1).toEqual({ email: TEST_EMAIL })
    expect(r2).toEqual({ email: TEST_EMAIL })
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('Promise.all two different first users → exactly one 200 and one 401, one row', async () => {
    const { db } = testDb()
    const env = adminEnv({ db, allowFirstClaim: '1' })
    const [r1, r2] = await Promise.all([
      requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), env),
      requireAdmin(makeReq('other@example.com', { xrw: true }), env),
    ])
    const statuses = [r1, r2]
      .map((r) => (r instanceof Response ? r.status : 200))
      .sort()
    expect(statuses).toEqual([200, 401])
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('Promise.all two same-user first requests → both succeed', async () => {
    const { db } = testDb()
    const env = adminEnv({ db, allowFirstClaim: '1' })
    const [r1, r2] = await Promise.all([
      requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), env),
      requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), env),
    ])
    expect(r1).toEqual({ email: TEST_EMAIL })
    expect(r2).toEqual({ email: TEST_EMAIL })
  })

  it('neither BOOTSTRAP_EMAIL nor ALLOW_FIRST_CLAIM → 401 and logs admin: misconfigured', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const r = await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db }))
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
  })

  it('admin: misconfigured NOT logged when non-admin calls on populated table', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    await seedAdmin(db, 'other@example.com')
    await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db }))
    const misconfiguredCalls = spy.mock.calls.filter((c) => c[0] === 'admin: misconfigured')
    expect(misconfiguredCalls).toHaveLength(0)
  })

  it('leftover ALLOW_FIRST_CLAIM is inert for existing admin (no extra row)', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const r = await requireAdmin(makeReq(TEST_EMAIL), adminEnv({ db, allowFirstClaim: '1' }))
    expect(r).toEqual({ email: TEST_EMAIL })
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('leftover ALLOW_FIRST_CLAIM is inert when table non-empty (non-admin → 401, no insert)', async () => {
    const { db } = testDb()
    await seedAdmin(db, 'other@example.com')
    const r = await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '1' }))
    expect((r as Response).status).toBe(401)
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('bootstrap GET without X-Requested-With → 403 (required for bootstrap write)', async () => {
    const { db } = testDb()
    // GET is exempt from CSRF, but bootstrap write has its own X-Requested-With check.
    const r = await requireAdmin(makeReq(TEST_EMAIL), adminEnv({ db, allowFirstClaim: '1' }))
    expect((r as Response).status).toBe(403)
  })

  it('exactly two prepare() calls for the bootstrap write (1 SELECT + 1 INSERT)', async () => {
    const { db, state } = testDb()
    const r = await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '1' }))
    expect(r).toEqual({ email: TEST_EMAIL })
    // 1 SELECT (email/count check) + 1 INSERT (bootstrap write) = 2 prepare() calls
    expect(state.prepares).toBe(2)
  })

  it('DB error during bootstrap → requireAdmin rejects, no row inserted', async () => {
    const { db, state } = testDb()
    state.fail = true
    await expect(
      requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '1' }))
    ).rejects.toThrow()
    state.fail = false
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })
})

// ============================================================
// Bootstrap flow — BOOTSTRAP_EMAIL
// ============================================================

describe('requireAdmin — bootstrap: BOOTSTRAP_EMAIL', () => {
  afterEach(() => vi.restoreAllMocks())

  it('BOOTSTRAP_EMAIL matches caller → allowed, row inserted with created_by=bootstrap', async () => {
    const { db } = testDb()
    const r = await requireAdmin(
      makeReq(TEST_EMAIL, { xrw: true }),
      adminEnv({ db, bootstrapEmail: TEST_EMAIL }),
    )
    expect(r).toEqual({ email: TEST_EMAIL })
    const row = await db.prepare('SELECT created_by FROM admin WHERE email = ?').bind(TEST_EMAIL).first<{ created_by: string }>()
    expect(row?.created_by).toBe('bootstrap')
  })

  it('BOOTSTRAP_EMAIL mismatch → 401, no row inserted', async () => {
    const { db } = testDb()
    const r = await requireAdmin(
      makeReq(TEST_EMAIL, { xrw: true }),
      adminEnv({ db, bootstrapEmail: 'different@example.com' }),
    )
    expect((r as Response).status).toBe(401)
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })

  it('BOOTSTRAP_EMAIL set but empty string → 401 (empty value is treated as mismatch)', async () => {
    const { db } = testDb()
    const r = await requireAdmin(
      makeReq(TEST_EMAIL, { xrw: true }),
      adminEnv({ db, bootstrapEmail: '' }),
    )
    expect((r as Response).status).toBe(401)
  })

  it('BOOTSTRAP_EMAIL present, ALLOW_FIRST_CLAIM=1, non-matching caller → 401 (BOOTSTRAP_EMAIL takes precedence)', async () => {
    const { db } = testDb()
    const r = await requireAdmin(
      makeReq(TEST_EMAIL, { xrw: true }),
      adminEnv({ db, bootstrapEmail: 'specific@example.com', allowFirstClaim: '1' }),
    )
    expect((r as Response).status).toBe(401)
  })

  it('BOOTSTRAP_EMAIL matches case-insensitively (stored trimmed lower)', async () => {
    const { db } = testDb()
    const r = await requireAdmin(
      makeReq(TEST_EMAIL, { xrw: true }),
      adminEnv({ db, bootstrapEmail: TEST_EMAIL.toUpperCase() }),
    )
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('leftover BOOTSTRAP_EMAIL inert for existing admin (no second row)', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const r = await requireAdmin(
      makeReq(TEST_EMAIL),
      adminEnv({ db, bootstrapEmail: TEST_EMAIL }),
    )
    expect(r).toEqual({ email: TEST_EMAIL })
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('zero DB prepares when email is bad (DB never reached)', async () => {
    const { db, state } = testDb()
    await requireAdmin(makeReq('garbage@@@'), adminEnv({ db, bootstrapEmail: TEST_EMAIL }))
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })
})

// ============================================================
// Bootstrap — ALLOW_FIRST_CLAIM exact '1' gate
// ============================================================

describe('requireAdmin — ALLOW_FIRST_CLAIM non-"1" values → 401 + misconfigured', () => {
  afterEach(() => vi.restoreAllMocks())

  it('ALLOW_FIRST_CLAIM="0" → 401, admin: misconfigured, no row inserted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const r = await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '0' }))
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })

  it('ALLOW_FIRST_CLAIM="true" → 401, admin: misconfigured, no row inserted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const r = await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: 'true' }))
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })

  it('ALLOW_FIRST_CLAIM="" → 401, admin: misconfigured, no row inserted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const r = await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '' }))
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })
})

// ============================================================
// BOOTSTRAP_EMAIL padding
// ============================================================

describe('requireAdmin — BOOTSTRAP_EMAIL padding', () => {
  it('BOOTSTRAP_EMAIL padded with spaces is trimmed and matches caller email', async () => {
    const { db } = testDb()
    const r = await requireAdmin(
      makeReq(TEST_EMAIL, { xrw: true }),
      adminEnv({ db, bootstrapEmail: `  ${TEST_EMAIL}  ` }),
    )
    expect(r).toEqual({ email: TEST_EMAIL })
    const row = await db.prepare('SELECT created_by FROM admin WHERE email = ?').bind(TEST_EMAIL).first<{ created_by: string }>()
    expect(row?.created_by).toBe('bootstrap')
  })

  it('BOOTSTRAP_EMAIL padded uppercase + spaces matches caller (trim + lowercase)', async () => {
    const { db } = testDb()
    const r = await requireAdmin(
      makeReq(TEST_EMAIL, { xrw: true }),
      adminEnv({ db, bootstrapEmail: `  ${TEST_EMAIL.toUpperCase()}  ` }),
    )
    expect(r).toEqual({ email: TEST_EMAIL })
  })
})

// ============================================================
// ensureSchema integration (empty DB)
// ============================================================

describe('requireAdmin — empty DB: admin bootstrap (ensureSchema integration)', () => {
  it('ALLOW_FIRST_CLAIM=1 on a table-less DB bootstraps successfully (ensureSchema creates tables first)', async () => {
    const { db, state } = testDb({ schema: false })
    const r = await requireAdmin(
      makeReq(TEST_EMAIL, { xrw: true }),
      adminEnv({ db, allowFirstClaim: '1' }),
    )
    expect(r).toEqual({ email: TEST_EMAIL })
    expect(state.ddl).toBeGreaterThan(0)
  })

  it('second admin request on the same DB issues no DDL (WeakMap cache hit)', async () => {
    const { db, state } = testDb({ schema: false })
    await requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '1' }))
    const ddlAfterFirst = state.ddl
    await requireAdmin(makeReq(TEST_EMAIL), adminEnv({ db }))
    expect(state.ddl).toBe(ddlAfterFirst)
  })

  it('two concurrent first-claim requests on empty DB → exactly one admin row', async () => {
    const { db } = testDb({ schema: false })
    const env = adminEnv({ db, allowFirstClaim: '1' })
    const [r1, r2] = await Promise.all([
      requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), env),
      requireAdmin(makeReq('other@example.com', { xrw: true }), env),
    ])
    const statuses = [r1, r2]
      .map((r) => (r instanceof Response ? r.status : 200))
      .sort()
    expect(statuses).toEqual([200, 401])
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })
})

describe('requireAdmin — DDL failure (ensureSchema integration)', () => {
  it('DDL failure → requireAdmin rejects (503 path), no admin row inserted, no grant', async () => {
    const { db, state, sqlite } = testDb({ schema: false })
    state.fail = true
    await expect(
      requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '1' }))
    ).rejects.toThrow()
    state.fail = false
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables).toHaveLength(0)
  })

  it('DDL failure issues DDL prepares but zero non-DDL prepares', async () => {
    const { db, state } = testDb({ schema: false })
    state.fail = true
    await expect(
      requireAdmin(makeReq(TEST_EMAIL, { xrw: true }), adminEnv({ db, allowFirstClaim: '1' }))
    ).rejects.toThrow()
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBeGreaterThan(0)
  })
})
