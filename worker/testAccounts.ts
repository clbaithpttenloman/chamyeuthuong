// @vitest-environment node
/**
 * Shared test fixtures for Phase 2b: username/password accounts, admin role, must_change.
 *
 * RED PHASE: this module imports from worker/password.ts which does not exist yet.
 * Every test file importing this module will fail at import until the implementation is added.
 *
 * After Phase 2b implementation:
 *   - worker/password.ts provides hashPassword, generateTempPassword, PBKDF2_ITERATIONS, PASSWORD_STATS
 *   - worker/schema.ts has the Phase 2b app_user shape (no google_sub) + new tables
 *   - createAccountTables() becomes a safe no-op (IF NOT EXISTS handles everything)
 */

// ── RED MECHANISM: this import fails until worker/password.ts is written ─────
import { hashPassword, generateTempPassword, PBKDF2_ITERATIONS, PASSWORD_STATS } from './password.ts'
// ─────────────────────────────────────────────────────────────────────────────

import type { DatabaseSync } from 'node:sqlite'
import { testDb, type D1 } from './testDb.ts'
import { makeRawToken, sha256Hex, SESSION_COOKIE_NAME } from './testGoogle.ts'
import type { Env } from './types.ts'

export { SESSION_COOKIE_NAME, sha256Hex, makeRawToken }
export { PBKDF2_ITERATIONS, PASSWORD_STATS }
export { generateTempPassword }

// ── Constants ─────────────────────────────────────────────────────────────────

/** Test value for PASSWORD_PEPPER secret. */
export const TEST_PEPPER = 'test-password-pepper-32bytesx!'

/** Test value for SUB_HMAC_KEY secret (re-used from testGift for compatibility). */
export const TEST_SUB_HMAC_KEY = 'test-sub-hmac-key-32bytes-padded'

/** Test value for IP_HMAC_KEY secret. */
export const TEST_IP_HMAC_KEY = 'test-ip-hmac-key-32bytes-paddedx'

// ── Limiter helpers ───────────────────────────────────────────────────────────

type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> }

/** Always-allow rate limiter stub. */
export function allowLimiter(): Limiter {
  return { limit: async () => ({ success: true }) }
}

/**
 * Counting limiter: allows the first `max` calls, then blocks.
 * The returned object also exposes `.keys` and `.count` for assertions.
 */
export function countingLimiter(max: number): Limiter & { keys: string[]; count: number } {
  const keys: string[] = []
  let count = 0
  return {
    get keys() { return keys },
    get count() { return count },
    limit: async (opts: { key: string }) => {
      keys.push(opts.key)
      count++
      return { success: count <= max }
    },
  }
}

// ── Schema helpers ────────────────────────────────────────────────────────────

/**
 * Create the Phase 2b account tables on a bare sqlite handle.
 *
 * If app_user is still the Phase 1 shape (has google_sub), it is rebuilt.
 * After Phase 2b implementation updates SCHEMA, testDb() creates these tables
 * automatically and this function becomes a safe no-op.
 */
export function createAccountTables(sqlite: DatabaseSync): void {
  // Check if app_user is Phase 1 (has google_sub)
  const appUserCols = new Set(
    (sqlite.prepare('PRAGMA table_info(app_user)').all() as { name: string }[]).map((c) => c.name),
  )

  if (appUserCols.has('google_sub')) {
    // Phase 1 → Phase 2b: drop session first (child of app_user), then app_user.
    // gift/heart/report FK to app_user.id — SQLite allows dropping the parent even with
    // referencing tables as long as there are no child ROWS (fresh testDb has none).
    // After recreating app_user (same id column), those FKs work normally.
    sqlite.exec('DROP TABLE IF EXISTS session')
    sqlite.exec('DROP TABLE IF EXISTS app_user')
    sqlite.exec(`CREATE TABLE app_user (
      id           INTEGER PRIMARY KEY,
      nickname     TEXT    NOT NULL DEFAULT '',
      class_name   TEXT    NOT NULL DEFAULT '',
      banned       INTEGER NOT NULL DEFAULT 0 CHECK (banned IN (0,1)),
      created_at   TEXT    NOT NULL,
      last_seen_at TEXT    NOT NULL
    )`)
    sqlite.exec(`CREATE TABLE session (
      token_hash TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      expires_at TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      ip_hash    TEXT    NOT NULL DEFAULT ''
    )`)
  }

  // New Phase 2b tables (IF NOT EXISTS: no-op once SCHEMA is updated)
  sqlite.exec(`CREATE TABLE IF NOT EXISTS user_identity (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    provider     TEXT    NOT NULL CHECK (provider IN ('password','google')),
    subject      TEXT    NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
    ip_hash      TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL,
    last_used_at TEXT    NOT NULL,
    UNIQUE (provider, subject),
    CHECK (provider <> 'password' OR (
      subject NOT GLOB '*[^a-z0-9_]*' AND length(subject) BETWEEN 3 AND 20
    ))
  )`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_user_identity_user ON user_identity(user_id)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_user_identity_created ON user_identity(created_at)`)

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
    action         TEXT    NOT NULL CHECK (action IN (
      'first_account','reset_password','grant_admin','revoke_admin',
      'ban','unban','delete_gift','remove_tombstone'
    )),
    target_user_id INTEGER,
    at             TEXT    NOT NULL
  )`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at)`)
}

// ── Env builders ──────────────────────────────────────────────────────────────

/** Type for worker/accounts.ts handler (Phase 2b). */
export type AccountsEnv = {
  DB: D1
  AUTH_LIMIT: Limiter
  AUTH_SUB_LIMIT: Limiter
  REGISTER_LIMIT: Limiter
  SUB_HMAC_KEY?: string
  PASSWORD_PEPPER?: string
  IP_HMAC_KEY?: string
  REGISTER_IP_DAILY?: string
  REGISTER_GLOBAL_DAILY?: string
}

/**
 * Build a full Env acceptable to worker/index.ts default fetch.
 * All limiters allow. Secrets set. GOOGLE_CLIENT_ID unset.
 */
export function accountsEnv(
  opts: {
    db?: D1
    pepper?: string
    subHmacKey?: string
    ipHmacKey?: string
    registerIpDaily?: string
    registerGlobalDaily?: string
    authLimitFail?: boolean
    authSubLimit?: Limiter
    registerLimitFail?: boolean
  } = {},
): AccountsEnv & Env {
  const { db } = opts.db !== undefined ? { db: opts.db } : testDb()
  const allow = allowLimiter()
  return {
    DB: db,
    // ASSETS: minimal fake for non-API routes (accounts tests only hit /api/*)
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    // Rate limiters — all allow unless explicitly failed
    PUBLIC_IP_LIMIT: allow,
    SUBMIT_IP_LIMIT: allow,
    CARD_IP_LIMIT: allow,
    ADMIN_FAIL_LIMIT: allow,
    IMAGE_IP_LIMIT: allow,
    AUTH_LIMIT: opts.authLimitFail ? { limit: async () => ({ success: false }) } : allow,
    AUTH_SUB_LIMIT: opts.authSubLimit ?? allow,
    USER_READ_LIMIT: allow,
    USER_WRITE_LIMIT: allow,
    PUBLIC_READ_LIMIT: allow,
    // Phase 2b bindings
    REGISTER_LIMIT: opts.registerLimitFail ? { limit: async () => ({ success: false }) } : allow,
    GIFT_LIMIT: allow,
    HEART_LIMIT: allow,
    REPORT_LIMIT: allow,
    TREE_READ_LIMIT: allow,
    LIST_READ_LIMIT: allow,
    // Secrets
    PASSWORD_PEPPER: 'pepper' in opts ? opts.pepper : TEST_PEPPER,
    SUB_HMAC_KEY: 'subHmacKey' in opts ? opts.subHmacKey : TEST_SUB_HMAC_KEY,
    IP_HMAC_KEY: 'ipHmacKey' in opts ? opts.ipHmacKey : TEST_IP_HMAC_KEY,
    NONCE_KEY: 'test-nonce-key-32bytes-paddingXX',
    // Phase 2b var bindings (string env vars, not secrets)
    REGISTER_IP_DAILY: opts.registerIpDaily ?? '300',
    REGISTER_GLOBAL_DAILY: opts.registerGlobalDaily ?? '2000',
    // Google: unset (Phase 2b — no Google sign-in configured)
    GOOGLE_CLIENT_ID: undefined,
  } as AccountsEnv & Env
}

// ── Seeders ───────────────────────────────────────────────────────────────────

/**
 * Seed a user with a password identity.
 *
 * Writes app_user + user_identity('password', username) + password_credential
 * (using real hashPassword at low iterations for speed) + optional admin_role.
 *
 * Returns { userId, username, password }.
 */
export async function seedUser(
  db: D1,
  opts: {
    username?: string
    password?: string
    nickname?: string
    className?: string
    banned?: boolean
    admin?: boolean
    mustChange?: boolean
    createdAt?: string
    iterations?: number
  } = {},
): Promise<{ userId: number; username: string; password: string }> {
  const username = opts.username ?? `testuser${Date.now()}`
  const password = opts.password ?? 'Password1!'
  const now = opts.createdAt ?? new Date().toISOString()
  const iterations = opts.iterations ?? 10_000  // low for test speed

  // Insert app_user
  await db
    .prepare(
      'INSERT INTO app_user (nickname, class_name, banned, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(opts.nickname ?? 'TestUser', opts.className ?? '11A', opts.banned ? 1 : 0, now, now)
    .run()
  const userRow = await db.prepare('SELECT MAX(id) AS id FROM app_user').first<{ id: number }>()
  const userId = userRow!.id

  // Hash the password
  const cred = await hashPassword(password, TEST_PEPPER, { iterations })

  // Insert user_identity
  await db
    .prepare(
      'INSERT INTO user_identity (user_id, provider, subject, ip_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(userId, 'password', username.toLowerCase(), '', now, now)
    .run()

  // Insert password_credential
  await db
    .prepare(
      'INSERT INTO password_credential (user_id, hash, salt, iterations, must_change, failed_count, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    )
    .bind(userId, cred.hash, cred.salt, cred.iterations, opts.mustChange ? 1 : 0, now)
    .run()

  // Optional admin_role
  if (opts.admin) {
    await db
      .prepare('INSERT INTO admin_role (user_id, granted_at, granted_by) VALUES (?, ?, ?)')
      .bind(userId, now, 'test-seed')
      .run()
  }

  return { userId, username: username.toLowerCase(), password }
}

/**
 * Create a session for a user. Returns the raw token (what goes in the cookie).
 */
export async function sessionFor(db: D1, userId: number): Promise<string> {
  const raw = makeRawToken()
  const hash = await sha256Hex(raw)
  const now = new Date().toISOString()
  await db
    .prepare(
      'INSERT INTO session (token_hash, user_id, expires_at, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(hash, userId, '9999-12-31T23:59:59.000Z', now, '')
    .run()
  return raw
}

// ── Request builder ───────────────────────────────────────────────────────────

/**
 * Build a JSON request suitable for account endpoints.
 * Sets X-Requested-With: fetch and Content-Type: application/json by default.
 */
export function jsonReq(
  method: string,
  path: string,
  body?: unknown,
  opts: {
    token?: string
    ip?: string
    headers?: Record<string, string>
    secFetchSite?: string
  } = {},
): Request {
  const headers: Record<string, string> = {
    'CF-Connecting-IP': opts.ip ?? '1.2.3.4',
    'X-Requested-With': 'fetch',
    ...(opts.headers ?? {}),
  }
  if (opts.token) headers['Cookie'] = `${SESSION_COOKIE_NAME}=${opts.token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.secFetchSite !== undefined) headers['Sec-Fetch-Site'] = opts.secFetchSite
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}
