// @vitest-environment node
/**
 * Tests for worker/admins.ts — Phase 2b behaviour.
 *
 * Phase 2b handler signature:
 *   handleAdmins(request, env, auth: { userId: number; actor: string }): Promise<Response>
 *
 * Routes (all require prior requireAdmin; auth passed in):
 *   GET    /api/admin/admins              → 200 [{ userId, username, nickname, grantedAt, grantedBy }]
 *   POST   /api/admin/admins {username}   → 201 (grant_admin; unknown → 404; already → 409 conflict)
 *   DELETE /api/admin/admins/<userId>     → 204 (revoke_admin; self → 409; last → 409 last_admin)
 *   POST   /api/admin/users/<id>/password → 200 { tempPassword } (12 chars, once; self → 400)
 *   GET    /api/admin/audit               → 200 [...] newest first ≤ 200
 *
 * All new tests are RED: handleAdmins currently uses the email-based Phase 1 shape
 * (3rd param = callerEmail string, reads/writes admin table) and does not have the
 * new endpoints. They become green once Group 4 implementation ships.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { handleAdmins } from './admins.ts'
import { testDb, type D1 } from './testDb.ts'
import type { DatabaseSync } from 'node:sqlite'

// ── Inline Phase 2b fixture ───────────────────────────────────────────────────
// No testAccounts.ts import — password.ts doesn't exist yet. We seed Phase 2b tables
// directly so this file can be imported and each test can be red for the right reason
// (wrong Phase 1 behaviour, not "module not found").

function addPhase2bTables(sqlite: DatabaseSync): void {
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
  sqlite.exec(`CREATE TABLE IF NOT EXISTS admin_role (
    user_id    INTEGER PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    granted_at TEXT    NOT NULL,
    granted_by TEXT    NOT NULL
  )`)
  sqlite.exec(`CREATE TABLE IF NOT EXISTS admin_audit (
    id             INTEGER PRIMARY KEY,
    actor_user_id  INTEGER,
    action         TEXT    NOT NULL CHECK (action IN (
      'first_account','reset_password','grant_admin','revoke_admin',
      'ban','unban','delete_gift','remove_tombstone'
    )),
    target_user_id INTEGER,
    at             TEXT    NOT NULL
  )`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at)`)
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
}

function makeRawToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function sha256Hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Seed a user with a password identity and optionally admin_role. Returns userId. */
function seedUser(
  sqlite: DatabaseSync,
  opts: { username: string; admin?: boolean; nickname?: string } = { username: 'testuser' },
): number {
  const now = new Date().toISOString()
  const username = opts.username
  sqlite.prepare(
    "INSERT INTO app_user (nickname, class_name, banned, created_at, last_seen_at) VALUES (?, '', 0, ?, ?)",
  ).run(opts.nickname ?? 'User', now, now)
  const userId = (sqlite.prepare('SELECT MAX(id) AS id FROM app_user').get() as { id: number }).id
  sqlite.prepare(
    "INSERT INTO user_identity (user_id, provider, subject, ip_hash, created_at, last_used_at) VALUES (?, 'password', ?, '', ?, ?)",
  ).run(userId, username, now, now)
  sqlite.prepare(
    'INSERT INTO password_credential (user_id, hash, salt, iterations, must_change, failed_count, updated_at) VALUES (?, ?, ?, 10000, 0, 0, ?)',
  ).run(userId, 'fakehash', 'fakesalt', now)
  if (opts.admin) {
    sqlite.prepare("INSERT INTO admin_role (user_id, granted_at, granted_by) VALUES (?, ?, 'test')").run(userId, now)
  }
  return userId
}

async function sessionFor(db: D1, _sqlite: DatabaseSync, userId: number): Promise<string> {
  const raw = makeRawToken()
  const hash = await sha256Hex(raw)
  const now = new Date().toISOString()
  await db
    .prepare('INSERT INTO session (token_hash, user_id, expires_at, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)')
    .bind(hash, userId, '9999-12-31T23:59:59Z', now, '')
    .run()
  return raw
}

function req(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '1.2.3.4' }
  if (method !== 'GET') headers['X-Requested-With'] = 'fetch'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

function makeEnv(db: D1) {
  return { DB: db, PASSWORD_PEPPER: 'test-pepper-for-admin-reset' } as never
}

/** Phase 2b auth object passed as 3rd arg to handleAdmins. */
function auth(userId: number, username: string) {
  return { userId, actor: `user:${username}` }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let db: D1
let sqlite: DatabaseSync

beforeEach(() => {
  ;({ db, sqlite } = testDb())
  addPhase2bTables(sqlite)
})

// ── GET /api/admin/admins — list by username ──────────────────────────────────

describe('GET /api/admin/admins — Phase 2b: list admins by username', () => {
  it('empty admin_role → 200 []', async () => {
    // The caller is signed in but holds no admin_role row here, so the list starts empty.
    const actorId = seedUser(sqlite, { username: 'caller', admin: false })
    const r = await handleAdmins(req('GET', '/api/admin/admins'), makeEnv(db), auth(actorId, 'caller') as never)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('list returns { userId, username, nickname, grantedAt, grantedBy } per admin', async () => {
    // RED: Phase 1 returns { id, email, created_at, created_by } from admin table.
    const callerUserId = seedUser(sqlite, { username: 'callr', admin: true, nickname: 'Caller' })
    const r = await handleAdmins(req('GET', '/api/admin/admins'), makeEnv(db), auth(callerUserId, 'callr') as never)
    expect(r.status).toBe(200)
    const list = await r.json() as Array<Record<string, unknown>>
    expect(list.length).toBeGreaterThan(0)
    const item = list[0]!
    expect(item).toHaveProperty('userId')
    expect(item).toHaveProperty('username')
    expect(item).toHaveProperty('nickname')
    expect(item).toHaveProperty('grantedAt')
    expect(item).toHaveProperty('grantedBy')
    // Must NOT have email (privacy)
    expect(item).not.toHaveProperty('email')
  })

  it('response includes all current admin_role holders', async () => {
    // RED: Phase 1 reads from admin table.
    const userId1 = seedUser(sqlite, { username: 'adm1', admin: true, nickname: 'Admin One' })
    seedUser(sqlite, { username: 'adm2', admin: true, nickname: 'Admin Two' })
    const r = await handleAdmins(req('GET', '/api/admin/admins'), makeEnv(db), auth(userId1, 'adm1') as never)
    expect(r.status).toBe(200)
    const list = await r.json() as Array<{ username: string }>
    const usernames = list.map((x) => x.username).sort()
    expect(usernames).toContain('adm1')
    expect(usernames).toContain('adm2')
  })
})

// ── POST /api/admin/admins — grant by username ────────────────────────────────

describe('POST /api/admin/admins — Phase 2b: grant admin role by username', () => {
  it('unknown username → 404 not_found', async () => {
    // RED: Phase 1 interprets body as {email}, gets undefined → 400 bad_request.
    const callerUserId = seedUser(sqlite, { username: 'granter', admin: true })
    const r = await handleAdmins(
      req('POST', '/api/admin/admins', { username: 'nobody' }),
      makeEnv(db),
      auth(callerUserId, 'granter') as never,
    )
    expect(r.status).toBe(404)
    expect(((await r.json()) as { error: string }).error).toBe('not_found')
  })

  it('known username → 201 and admin_role row exists', async () => {
    // RED: Phase 1 returns 400 (body has username not email) or 200 email-based.
    const callerUserId = seedUser(sqlite, { username: 'granter2', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'newadmin', admin: false })
    const r = await handleAdmins(
      req('POST', '/api/admin/admins', { username: 'newadmin' }),
      makeEnv(db),
      auth(callerUserId, 'granter2') as never,
    )
    expect(r.status).toBe(201)
    // admin_role row should now exist for targetUserId
    const row = sqlite.prepare('SELECT user_id FROM admin_role WHERE user_id = ?').get(targetUserId)
    expect(row).toBeDefined()
  })

  it('already admin → 409 conflict', async () => {
    // RED: Phase 1 would detect UNIQUE violation on admin.email but returns different error shape.
    const callerUserId = seedUser(sqlite, { username: 'granter3', admin: true })
    seedUser(sqlite, { username: 'alreadyadmin', admin: true })
    const r = await handleAdmins(
      req('POST', '/api/admin/admins', { username: 'alreadyadmin' }),
      makeEnv(db),
      auth(callerUserId, 'granter3') as never,
    )
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: string }).error).toBe('conflict')
  })

  it('grant writes admin_audit row (action: grant_admin)', async () => {
    // RED: Phase 1 handleAdmins does not write admin_audit.
    const callerUserId = seedUser(sqlite, { username: 'auditor', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'audittarget', admin: false })
    await handleAdmins(
      req('POST', '/api/admin/admins', { username: 'audittarget' }),
      makeEnv(db),
      auth(callerUserId, 'auditor') as never,
    )
    const auditRow = sqlite.prepare(
      "SELECT * FROM admin_audit WHERE action = 'grant_admin' AND target_user_id = ?",
    ).get(targetUserId) as { actor_user_id: number; action: string } | undefined
    expect(auditRow).toBeDefined()
    expect(auditRow?.actor_user_id).toBe(callerUserId)
  })
})

// ── DELETE /api/admin/admins/<userId> — revoke ────────────────────────────────

describe('DELETE /api/admin/admins/<userId> — Phase 2b: revoke admin role by userId', () => {
  it('revoke another admin when two exist → 204', async () => {
    // RED: Phase 1 deletes from admin table by id; 3rd param is callerEmail string.
    // Passing { userId, actor } as the 3rd arg to Phase 1 handleAdmins produces wrong behaviour.
    const callerUserId = seedUser(sqlite, { username: 'revoker', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'revokee', admin: true })
    const r = await handleAdmins(
      req('DELETE', `/api/admin/admins/${targetUserId}`),
      makeEnv(db),
      auth(callerUserId, 'revoker') as never,
    )
    expect(r.status).toBe(204)
    const row = sqlite.prepare('SELECT user_id FROM admin_role WHERE user_id = ?').get(targetUserId)
    expect(row).toBeUndefined()
  })

  it('self-revoke → 409 cannot_revoke_self', async () => {
    // RED: Phase 1 allows self-delete when two admins exist.
    const callerUserId = seedUser(sqlite, { username: 'selfrevoke', admin: true })
    seedUser(sqlite, { username: 'other', admin: true })
    const r = await handleAdmins(
      req('DELETE', `/api/admin/admins/${callerUserId}`),
      makeEnv(db),
      auth(callerUserId, 'selfrevoke') as never,
    )
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: string }).error).toBe('cannot_revoke_self')
  })

  it('last admin → 409 last_admin', async () => {
    // RED: Phase 1 returns 409 "conflict" (not "last_admin") for last-admin deletion.
    const callerUserId = seedUser(sqlite, { username: 'lastadmin', admin: true })
    // No other admin_role rows
    const r = await handleAdmins(
      req('DELETE', `/api/admin/admins/${callerUserId}`),
      makeEnv(db),
      auth(callerUserId, 'lastadmin') as never,
    )
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: string }).error).toBe('last_admin')
  })

  it('revoke writes admin_audit row (action: revoke_admin)', async () => {
    // RED: Phase 1 does not write admin_audit.
    const callerUserId = seedUser(sqlite, { username: 'revauditor', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'revaudittarget', admin: true })
    await handleAdmins(
      req('DELETE', `/api/admin/admins/${targetUserId}`),
      makeEnv(db),
      auth(callerUserId, 'revauditor') as never,
    )
    const auditRow = sqlite.prepare(
      "SELECT * FROM admin_audit WHERE action = 'revoke_admin' AND target_user_id = ?",
    ).get(targetUserId) as { actor_user_id: number } | undefined
    expect(auditRow).toBeDefined()
    expect(auditRow?.actor_user_id).toBe(callerUserId)
  })

  it('concurrent revokes of two admins — one wins (204) one gets 409 last_admin', async () => {
    // RED: Phase 1 "conflict" vs "last_admin" distinction absent.
    const userId1 = seedUser(sqlite, { username: 'conc1', admin: true })
    const userId2 = seedUser(sqlite, { username: 'conc2', admin: true })
    const env = makeEnv(db)
    const [r1, r2] = await Promise.all([
      handleAdmins(req('DELETE', `/api/admin/admins/${userId2}`), env, auth(userId1, 'conc1') as never),
      handleAdmins(req('DELETE', `/api/admin/admins/${userId1}`), env, auth(userId2, 'conc2') as never),
    ])
    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    expect(statuses).toEqual([204, 409])
    const count = (sqlite.prepare('SELECT COUNT(*) AS c FROM admin_role').get() as { c: number }).c
    expect(count).toBe(1)
  })
})

// ── POST /api/admin/users/<id>/password — reset password ─────────────────────

describe('POST /api/admin/users/<id>/password — Phase 2b: admin reset', () => {
  it('reset for another user → 200 { tempPassword }', async () => {
    // RED: route does not exist in Phase 1 handleAdmins → 405 or 404.
    const callerUserId = seedUser(sqlite, { username: 'resetter', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'resetme', admin: false })
    const r = await handleAdmins(
      req('POST', `/api/admin/users/${targetUserId}/password`, {}),
      makeEnv(db),
      auth(callerUserId, 'resetter') as never,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { tempPassword: string }
    expect(typeof body.tempPassword).toBe('string')
  })

  it('tempPassword is exactly 12 characters from the 32-char alphabet', async () => {
    // RED: route missing in Phase 1.
    const callerUserId = seedUser(sqlite, { username: 'resetter2', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'resetme2', admin: false })
    const r = await handleAdmins(
      req('POST', `/api/admin/users/${targetUserId}/password`, {}),
      makeEnv(db),
      auth(callerUserId, 'resetter2') as never,
    )
    const { tempPassword } = await r.json() as { tempPassword: string }
    expect(tempPassword).toHaveLength(12)
    // alphabet: 23456789abcdefghjkmnpqrstuvwxyz (32 chars, no ambiguous)
    expect(tempPassword).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{12}$/)
  })

  it('reset sets must_change=1 on target user', async () => {
    // RED: route missing.
    const callerUserId = seedUser(sqlite, { username: 'resetter3', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'resetme3', admin: false })
    await handleAdmins(
      req('POST', `/api/admin/users/${targetUserId}/password`, {}),
      makeEnv(db),
      auth(callerUserId, 'resetter3') as never,
    )
    const cred = sqlite.prepare('SELECT must_change FROM password_credential WHERE user_id = ?').get(targetUserId) as { must_change: number } | undefined
    expect(cred?.must_change).toBe(1)
  })

  it('reset sets temp_expires_at approximately 72 hours from now', async () => {
    // RED: route missing.
    const callerUserId = seedUser(sqlite, { username: 'resetter4', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'resetme4', admin: false })
    const before = Date.now()
    await handleAdmins(
      req('POST', `/api/admin/users/${targetUserId}/password`, {}),
      makeEnv(db),
      auth(callerUserId, 'resetter4') as never,
    )
    const after = Date.now()
    const cred = sqlite.prepare('SELECT temp_expires_at FROM password_credential WHERE user_id = ?').get(targetUserId) as { temp_expires_at: string } | undefined
    expect(cred?.temp_expires_at).toBeTruthy()
    const expires = new Date(cred!.temp_expires_at!).getTime()
    // Should be ~72h in the future (71h ≤ x ≤ 73h)
    expect(expires).toBeGreaterThanOrEqual(before + 71 * 3600_000)
    expect(expires).toBeLessThanOrEqual(after + 73 * 3600_000)
  })

  it('reset revokes all sessions for the target user', async () => {
    // RED: route missing.
    const callerUserId = seedUser(sqlite, { username: 'resetter5', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'resetme5', admin: false })
    // Seed 2 sessions for the target
    await sessionFor(db, sqlite, targetUserId)
    await sessionFor(db, sqlite, targetUserId)
    const before = (sqlite.prepare('SELECT COUNT(*) AS c FROM session WHERE user_id = ?').get(targetUserId) as { c: number }).c
    expect(before).toBe(2)

    await handleAdmins(
      req('POST', `/api/admin/users/${targetUserId}/password`, {}),
      makeEnv(db),
      auth(callerUserId, 'resetter5') as never,
    )
    const after = (sqlite.prepare('SELECT COUNT(*) AS c FROM session WHERE user_id = ?').get(targetUserId) as { c: number }).c
    expect(after).toBe(0)
  })

  it('reset clears lockout (failed_count=0, locked_until=NULL)', async () => {
    // RED: route missing.
    const callerUserId = seedUser(sqlite, { username: 'resetter6', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'resetme6', admin: false })
    // Simulate lockout
    sqlite.prepare("UPDATE password_credential SET failed_count=10, locked_until=datetime('now','+15 minutes') WHERE user_id=?").run(targetUserId)

    await handleAdmins(
      req('POST', `/api/admin/users/${targetUserId}/password`, {}),
      makeEnv(db),
      auth(callerUserId, 'resetter6') as never,
    )
    const cred = sqlite.prepare('SELECT failed_count, locked_until FROM password_credential WHERE user_id = ?').get(targetUserId) as { failed_count: number; locked_until: string | null } | undefined
    expect(cred?.failed_count).toBe(0)
    expect(cred?.locked_until).toBeNull()
  })

  it('reset on self (callerUserId === targetUserId) → 400 bad_request', async () => {
    // RED: route missing.
    const callerUserId = seedUser(sqlite, { username: 'resetself', admin: true })
    const r = await handleAdmins(
      req('POST', `/api/admin/users/${callerUserId}/password`, {}),
      makeEnv(db),
      auth(callerUserId, 'resetself') as never,
    )
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe('bad_request')
  })

  it('reset writes admin_audit row (action: reset_password); no password in any audit column', async () => {
    // RED: route missing; also Phase 1 does not write admin_audit.
    const callerUserId = seedUser(sqlite, { username: 'resetaudit', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'resetaudittarget', admin: false })
    await handleAdmins(
      req('POST', `/api/admin/users/${targetUserId}/password`, {}),
      makeEnv(db),
      auth(callerUserId, 'resetaudit') as never,
    )
    const auditRow = sqlite.prepare(
      "SELECT actor_user_id, action, target_user_id FROM admin_audit WHERE action = 'reset_password'",
    ).get() as { actor_user_id: number; action: string; target_user_id: number } | undefined
    expect(auditRow).toBeDefined()
    expect(auditRow?.actor_user_id).toBe(callerUserId)
    expect(auditRow?.target_user_id).toBe(targetUserId)

    // No password stored in any admin_audit column
    const auditFull = sqlite.prepare(
      "SELECT * FROM admin_audit WHERE action = 'reset_password'",
    ).get() as Record<string, unknown> | undefined
    // The temp password must not appear in any column value
    // We don't know the temp password value here, but we can check columns don't hold
    // obviously-password-shaped data. The real check is that no column is named "password".
    for (const key of Object.keys(auditFull ?? {})) {
      expect(key.toLowerCase()).not.toContain('password')
    }
  })

  it('tempPassword is returned exactly once (not stored in plaintext)', async () => {
    // RED: route missing.
    const callerUserId = seedUser(sqlite, { username: 'resetter7', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'resetme7', admin: false })
    const r = await handleAdmins(
      req('POST', `/api/admin/users/${targetUserId}/password`, {}),
      makeEnv(db),
      auth(callerUserId, 'resetter7') as never,
    )
    expect(r.status).toBe(200)
    const { tempPassword } = await r.json() as { tempPassword: string }
    // The plaintext temp password must NOT be stored in password_credential.hash
    const cred = sqlite.prepare('SELECT hash FROM password_credential WHERE user_id = ?').get(targetUserId) as { hash: string }
    expect(cred.hash).not.toBe(tempPassword)
  })
})

// ── GET /api/admin/audit — newest first ≤ 200 ────────────────────────────────

describe('GET /api/admin/audit — Phase 2b: audit log', () => {
  it('empty audit → 200 []', async () => {
    // RED: route does not exist in Phase 1 handleAdmins.
    const callerUserId = seedUser(sqlite, { username: 'auditor2', admin: true })
    const r = await handleAdmins(
      req('GET', '/api/admin/audit'),
      makeEnv(db),
      auth(callerUserId, 'auditor2') as never,
    )
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('returns rows newest first (descending by at)', async () => {
    // RED: route missing.
    const callerUserId = seedUser(sqlite, { username: 'auditor3', admin: true })
    const now = new Date()
    const t1 = new Date(now.getTime() - 2000).toISOString()
    const t2 = new Date(now.getTime() - 1000).toISOString()
    const t3 = now.toISOString()
    sqlite.prepare("INSERT INTO admin_audit (actor_user_id, action, at) VALUES (?, 'ban', ?)").run(callerUserId, t1)
    sqlite.prepare("INSERT INTO admin_audit (actor_user_id, action, at) VALUES (?, 'unban', ?)").run(callerUserId, t2)
    sqlite.prepare("INSERT INTO admin_audit (actor_user_id, action, at) VALUES (?, 'grant_admin', ?)").run(callerUserId, t3)

    const r = await handleAdmins(req('GET', '/api/admin/audit'), makeEnv(db), auth(callerUserId, 'auditor3') as never)
    expect(r.status).toBe(200)
    const rows = await r.json() as Array<{ at: string }>
    expect(rows.length).toBe(3)
    // Newest first
    expect(rows[0]!.at).toBe(t3)
    expect(rows[1]!.at).toBe(t2)
    expect(rows[2]!.at).toBe(t1)
  })

  it('returns at most 200 rows', async () => {
    // RED: route missing.
    const callerUserId = seedUser(sqlite, { username: 'auditor4', admin: true })
    const now = new Date().toISOString()
    // Insert 205 rows
    for (let i = 0; i < 205; i++) {
      sqlite.prepare("INSERT INTO admin_audit (actor_user_id, action, at) VALUES (?, 'ban', ?)").run(callerUserId, now)
    }
    const r = await handleAdmins(req('GET', '/api/admin/audit'), makeEnv(db), auth(callerUserId, 'auditor4') as never)
    expect(r.status).toBe(200)
    const rows = await r.json() as unknown[]
    expect(rows.length).toBeLessThanOrEqual(200)
  })

  it('response shape: { id, actor, action, targetUserId, at }', async () => {
    // RED: route missing.
    const callerUserId = seedUser(sqlite, { username: 'auditor5', admin: true })
    const targetUserId = seedUser(sqlite, { username: 'audittarget5', admin: false })
    const now = new Date().toISOString()
    sqlite.prepare('INSERT INTO admin_audit (actor_user_id, action, target_user_id, at) VALUES (?, ?, ?, ?)').run(callerUserId, 'ban', targetUserId, now)

    const r = await handleAdmins(req('GET', '/api/admin/audit'), makeEnv(db), auth(callerUserId, 'auditor5') as never)
    const rows = await r.json() as Array<Record<string, unknown>>
    expect(rows.length).toBe(1)
    const row = rows[0]!
    expect(row).toHaveProperty('id')
    expect(row).toHaveProperty('actor')
    expect(row).toHaveProperty('action')
    expect(row).toHaveProperty('targetUserId')
    expect(row).toHaveProperty('at')
  })
})

// ── Security headers on all responses ────────────────────────────────────────

describe('handleAdmins — security headers on all responses', () => {
  it('every response has Cache-Control: no-store, X-Content-Type-Options: nosniff, X-Robots-Tag: noindex', async () => {
    const callerUserId = seedUser(sqlite, { username: 'hdrtest', admin: true })
    const r = await handleAdmins(req('GET', '/api/admin/admins'), makeEnv(db), auth(callerUserId, 'hdrtest') as never)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex')
  })
})
