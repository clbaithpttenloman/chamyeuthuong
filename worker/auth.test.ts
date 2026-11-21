// @vitest-environment node
/**
 * Tests for worker/auth.ts — Phase 2b: requireAdmin on admin_role.
 *
 * Phase 2b behaviour: session cookie → user → admin_role (not banned, not must_change)
 * → returns { userId, actor: 'user:<username>' }.
 * X-Admin-Email, ADMIN_LEGACY_LOGIN, BOOTSTRAP_EMAIL, ALLOW_FIRST_CLAIM are all gone.
 *
 * RED cases: tests that assert Phase 2b-specific results (admin_role success, actor shape,
 * password_change_required) fail because auth.ts still runs Phase 1 logic (google_sub /
 * admin-email path). They are intentionally red — implementation is Group 3.
 *
 * GREEN cases: behaviour unchanged between Phase 1 and 2b (rate limit, CSRF, error shape,
 * 401 for no session) stay green because those code paths are identical.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { requireAdmin } from './auth.ts'
import { testDb, type D1 } from './testDb.ts'
import type { DatabaseSync } from 'node:sqlite'

// ── Inline Phase 2b fixture ───────────────────────────────────────────────────
// Not importing testAccounts.ts here: that module imports worker/password.ts which
// does not exist yet, and importing it at file level would cascade all tests to
// import-error red. Rate-limit/CSRF/error-shape tests would then fail for the wrong
// reason ("missing module"). We seed Phase 2b tables with raw SQL instead.

function addPhase2bTables(sqlite: DatabaseSync): void {
  // user_identity, password_credential, admin_role, admin_audit.
  // app_user and session already exist from testDb()'s ensureSchema run.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS user_identity (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    provider     TEXT    NOT NULL CHECK (provider IN ('password','google')),
    subject      TEXT    NOT NULL,
    ip_hash      TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL,
    last_used_at TEXT    NOT NULL,
    UNIQUE (provider, subject)
  )`)
  sqlite.exec(`CREATE TABLE IF NOT EXISTS password_credential (
    user_id         INTEGER PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    hash            TEXT    NOT NULL,
    salt            TEXT    NOT NULL,
    iterations      INTEGER NOT NULL CHECK (iterations BETWEEN 10000 AND 100000),
    must_change     INTEGER NOT NULL DEFAULT 0 CHECK (must_change IN (0,1)),
    temp_expires_at TEXT,
    failed_count    INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    updated_at      TEXT    NOT NULL
  )`)
  sqlite.exec(`CREATE TABLE IF NOT EXISTS admin_role (
    user_id    INTEGER PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    granted_at TEXT    NOT NULL,
    granted_by TEXT    NOT NULL
  )`)
  sqlite.exec(`CREATE TABLE IF NOT EXISTS admin_audit (
    id             INTEGER PRIMARY KEY,
    actor_user_id  INTEGER,
    action         TEXT    NOT NULL,
    target_user_id INTEGER,
    at             TEXT    NOT NULL
  )`)
}

function makeRawToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function sha256Hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Seed a Phase 2b user with a password identity.
 * Uses the existing Phase 1 app_user schema (google_sub etc. are blank / null-ish).
 * admin_role and must_change are optional.
 */
async function seedUser2b(
  db: D1,
  sqlite: DatabaseSync,
  opts: {
    username?: string
    banned?: boolean
    admin?: boolean
    mustChange?: boolean
  } = {},
): Promise<{ userId: number; token: string; username: string }> {
  const now = new Date().toISOString()
  const username = opts.username ?? `user_${Date.now()}`

  // Insert into Phase 1 app_user (google_sub required NOT NULL; use a placeholder)
  sqlite.prepare(
    "INSERT INTO app_user (google_sub, email, nickname, class_name, banned, created_at, last_seen_at) VALUES (?, ?, ?, '', ?, ?, ?)",
  ).run(`_placeholder_${username}`, '', 'TestUser', opts.banned ? 1 : 0, now, now)

  const userId = (sqlite.prepare('SELECT MAX(id) AS id FROM app_user').get() as { id: number }).id

  sqlite.prepare(
    "INSERT INTO user_identity (user_id, provider, subject, ip_hash, created_at, last_used_at) VALUES (?, 'password', ?, '', ?, ?)",
  ).run(userId, username, now, now)

  sqlite.prepare(
    'INSERT INTO password_credential (user_id, hash, salt, iterations, must_change, failed_count, updated_at) VALUES (?, ?, ?, 10000, ?, 0, ?)',
  ).run(userId, 'fakehash', 'fakesalt', opts.mustChange ? 1 : 0, now)

  if (opts.admin) {
    sqlite.prepare("INSERT INTO admin_role (user_id, granted_at, granted_by) VALUES (?, ?, 'test')").run(userId, now)
  }

  // Create a valid (far-future) session
  const rawToken = makeRawToken()
  const hash = await sha256Hex(rawToken)
  await db
    .prepare('INSERT INTO session (token_hash, user_id, expires_at, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)')
    .bind(hash, userId, '9999-12-31T23:59:59Z', now, '')
    .run()

  return { userId, token: rawToken, username }
}

/** Build a request to /api/admin/teachers. */
function makeReq(
  token: string | null,
  opts: {
    method?: string
    secFetchSite?: string
    adminEmail?: string
    noXrw?: boolean
  } = {},
): Request {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = { 'CF-Connecting-IP': '1.2.3.4' }
  if (token) headers['Cookie'] = `__Host-cyt_s=${token}`
  if (opts.adminEmail) headers['X-Admin-Email'] = opts.adminEmail
  if (method !== 'GET' && !opts.noXrw) headers['X-Requested-With'] = 'fetch'
  if (opts.secFetchSite) headers['Sec-Fetch-Site'] = opts.secFetchSite
  return new Request('https://x/api/admin/teachers', { method, headers })
}

function makeEnv(db: D1, opts: { failLimit?: boolean } = {}) {
  return {
    DB: db,
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: !opts.failLimit }) },
  } as Parameters<typeof requireAdmin>[1]
}

// ── Phase 2b happy path (RED — auth.ts still runs Phase 1 logic) ──────────────

describe('requireAdmin — Phase 2b: session + admin_role (RED: returns wrong shape in Phase 1)', () => {
  let db: D1
  let sqlite: DatabaseSync

  beforeEach(() => {
    ;({ db, sqlite } = testDb())
    addPhase2bTables(sqlite)
  })

  it('valid session + admin_role → returns { userId, actor: "user:<username>" }', async () => {
    // RED: Phase 1 auth.ts checks google_sub / admin.email, not admin_role.
    // With Phase 1 app_user (placeholder google_sub, empty email), the Google path
    // fails to find admin.email → returns 403 forbidden, not { userId, actor }.
    const { userId, token, username } = await seedUser2b(db, sqlite, { admin: true })
    const r = await requireAdmin(makeReq(token), makeEnv(db))
    expect(r).toEqual({ userId, actor: `user:${username}` })
  })

  it('actor field is "user:<username>" — the password identity subject', async () => {
    // RED: same reason — Phase 1 returns Response, not the new shape.
    const { userId, token, username } = await seedUser2b(db, sqlite, { admin: true, username: 'aliceadmin' })
    const r = await requireAdmin(makeReq(token), makeEnv(db))
    expect(r).toMatchObject({ userId, actor: 'user:aliceadmin' })
  })

  it('valid session + admin_role + POST → returns { userId, actor } (CSRF passes)', async () => {
    // RED: same — Phase 1 does not support admin_role-based sessions.
    const { userId, token, username } = await seedUser2b(db, sqlite, { admin: true })
    const r = await requireAdmin(makeReq(token, { method: 'POST' }), makeEnv(db))
    expect(r).toEqual({ userId, actor: `user:${username}` })
  })
})

// ── Phase 2b rejection cases ──────────────────────────────────────────────────

describe('requireAdmin — Phase 2b: rejection cases', () => {
  let db: D1
  let sqlite: DatabaseSync

  beforeEach(() => {
    ;({ db, sqlite } = testDb())
    addPhase2bTables(sqlite)
  })

  it('no session cookie → 401 unauthorized', async () => {
    // GREEN: Phase 1 also returns 401 when there is no session and no email header.
    const r = await requireAdmin(makeReq(null), makeEnv(db))
    expect((r as Response).status).toBe(401)
  })

  it('valid session but no admin_role → 403 forbidden', async () => {
    // GREEN: Phase 1 also returns 403 when the user's email is not in admin table.
    const { token } = await seedUser2b(db, sqlite, { admin: false })
    const r = await requireAdmin(makeReq(token), makeEnv(db))
    expect((r as Response).status).toBe(403)
  })

  it('valid session + admin_role + banned → 403 forbidden', async () => {
    // GREEN: Phase 1 also returns 403 (email not in admin table, since google_sub placeholder
    // means the email lookup fails). Ban status has no effect in Phase 1 path, but the user
    // fails the admin check anyway, so 403 matches.
    const { token } = await seedUser2b(db, sqlite, { admin: true, banned: true })
    const r = await requireAdmin(makeReq(token), makeEnv(db))
    expect((r as Response).status).toBe(403)
  })

  it('valid session + admin_role + must_change=1 → 403 password_change_required', async () => {
    // RED: Phase 1 does not check must_change; it returns 403 "forbidden" (email check fails).
    // Phase 2b must return 403 with error code "password_change_required".
    const { token } = await seedUser2b(db, sqlite, { admin: true, mustChange: true })
    const r = await requireAdmin(makeReq(token), makeEnv(db))
    expect((r as Response).status).toBe(403)
    const body = await (r as Response).json() as { error: string }
    expect(body.error).toBe('password_change_required')
  })
})

// ── X-Admin-Email header: always 401, no env flag can enable it ───────────────

describe('requireAdmin — X-Admin-Email: always 401 regardless of env (Phase 2b removes all legacy paths)', () => {
  it('X-Admin-Email with valid admin row in legacy admin table → 401 (no session)', async () => {
    // GREEN: Phase 1 also returns 401 when opts.legacy is not passed and there is no session.
    // Phase 2b: removes the email path entirely.
    const { db, sqlite } = testDb()
    sqlite.prepare("INSERT INTO admin (email, created_at, created_by) VALUES ('admin@example.com', datetime('now'), 'test')").run()
    const r = await requireAdmin(makeReq(null, { adminEmail: 'admin@example.com' }), makeEnv(db))
    expect((r as Response).status).toBe(401)
  })

  it('X-Admin-Email + session for a non-admin user → still 401/403, not { email }', async () => {
    // Email headers are ignored; only the session matters.
    // GREEN: Phase 1 uses the session path when a session cookie is present.
    const { db, sqlite } = testDb()
    addPhase2bTables(sqlite)
    sqlite.prepare("INSERT INTO admin (email, created_at, created_by) VALUES ('admin@example.com', datetime('now'), 'test')").run()
    const { token } = await seedUser2b(db, sqlite, { admin: false })
    const r = await requireAdmin(makeReq(token, { adminEmail: 'admin@example.com' }), makeEnv(db))
    // Should NOT return { email } or { userId, actor }
    expect(r).toBeInstanceOf(Response)
    expect((r as Response).status).not.toBe(200)
  })

  it('no session + X-Admin-Email + ADMIN_LEGACY_LOGIN env → 401 (flag removed in Phase 2b)', async () => {
    // GREEN: Phase 1 without opts.legacy=true also returns 401 for email path.
    // Phase 2b: ADMIN_LEGACY_LOGIN is not in the env type at all.
    const { db, sqlite } = testDb()
    sqlite.prepare("INSERT INTO admin (email, created_at, created_by) VALUES ('admin@example.com', datetime('now'), 'test')").run()
    const env = { ...makeEnv(db), ADMIN_LEGACY_LOGIN: '1' } as Parameters<typeof requireAdmin>[1]
    const r = await requireAdmin(makeReq(null, { adminEmail: 'admin@example.com' }), env)
    expect((r as Response).status).toBe(401)
  })

  it('empty admin_role table + X-Admin-Email → 401 (no bootstrap path)', async () => {
    // GREEN: Phase 1 without ALLOW_FIRST_CLAIM or BOOTSTRAP_EMAIL also returns 401.
    // Phase 2b: no bootstrap path at all.
    const { db, sqlite } = testDb()
    addPhase2bTables(sqlite)
    // admin_role is empty; X-Admin-Email should not bootstrap anything
    const r = await requireAdmin(makeReq(null, { adminEmail: 'newadmin@example.com' }), makeEnv(db))
    expect((r as Response).status).toBe(401)
    // No admin_role row was inserted
    const count = (sqlite.prepare('SELECT COUNT(*) AS c FROM admin_role').get() as { c: number }).c
    expect(count).toBe(0)
  })
})

// ── Rate limiting (GREEN — checked before any auth in both Phase 1 and 2b) ───

describe('requireAdmin — rate limiting', () => {
  it('exhausted ADMIN_FAIL_LIMIT → 429 rate_limited', async () => {
    const { db } = testDb()
    const r = await requireAdmin(makeReq(null), makeEnv(db, { failLimit: true }))
    expect((r as Response).status).toBe(429)
    expect(((await (r as Response).json()) as { error: string }).error).toBe('rate_limited')
  })

  it('rate limit exhausted → DB never touched (checked before ensureSchema)', async () => {
    const { db, state } = testDb({ schema: false })
    await requireAdmin(makeReq(null), makeEnv(db, { failLimit: true }))
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })
})

// ── CSRF checks (GREEN — Sec-Fetch-Site and X-Requested-With still enforced) ──

describe('requireAdmin — CSRF checks', () => {
  it('Sec-Fetch-Site: cross-site → 403 forbidden (before auth)', async () => {
    const { db } = testDb()
    const r = await requireAdmin(makeReq(null, { secFetchSite: 'cross-site' }), makeEnv(db))
    expect((r as Response).status).toBe(403)
  })

  it('POST without X-Requested-With → 403 forbidden', async () => {
    const { db } = testDb()
    const r = await requireAdmin(makeReq(null, { method: 'POST', noXrw: true }), makeEnv(db))
    expect((r as Response).status).toBe(403)
  })

  it('Sec-Fetch-Site: same-origin → passes CSRF check (proceeds to auth)', async () => {
    const { db } = testDb()
    const r = await requireAdmin(makeReq(null, { secFetchSite: 'same-origin' }), makeEnv(db))
    // No session → 401 (not 403 forbidden)
    expect((r as Response).status).toBe(401)
  })
})

// ── Error response shape (GREEN — no-store etc. unchanged) ───────────────────

describe('requireAdmin — error response shape', () => {
  it('error response has Cache-Control: no-store', async () => {
    const { db } = testDb()
    const r = await requireAdmin(makeReq(null), makeEnv(db))
    expect((r as Response).headers.get('Cache-Control')).toBe('no-store')
  })

  it('error response has X-Content-Type-Options: nosniff', async () => {
    const { db } = testDb()
    const r = await requireAdmin(makeReq(null), makeEnv(db))
    expect((r as Response).headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('error response body is JSON with { error } field', async () => {
    const { db } = testDb()
    const r = await requireAdmin(makeReq(null), makeEnv(db))
    const body = await (r as Response).json() as { error?: string }
    expect(typeof body?.error).toBe('string')
  })

  it('no Access-Control-Allow-* headers on error responses', async () => {
    const { db } = testDb()
    const r = await requireAdmin(makeReq(null), makeEnv(db))
    expect((r as Response).headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect((r as Response).headers.get('Access-Control-Allow-Methods')).toBeNull()
  })
})
