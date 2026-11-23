/**
 * Test helpers for Google Sign-In ID-token authentication (Phase 1 — campaign platform).
 *
 * Provides:
 *  - Lazy RSA key-pair generation and local JWKS resolvers (no network)
 *  - `signIdToken` / `validToken` for constructing test JWTs
 *  - Nonce helpers that compute valid/expired/tampered nonce strings
 *  - `meEnv` / `googleCredentialEnv` env builders for worker/me.ts and worker/google.ts
 *  - `seedUser` / `seedAdminGoogle` / `seedSession` for DB state setup
 *  - `createNewTables` to add app_user + session tables to a testDb sqlite handle
 *
 * NOT for production use.
 */

import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose'
import type { JWTVerifyGetKey } from 'jose'
import { testDb, type D1 } from './testDb.ts'
import { DatabaseSync } from 'node:sqlite'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Must end with `.apps.googleusercontent.com`. */
export const TEST_CLIENT_ID = 'test-client-123.apps.googleusercontent.com'

/** Default test Gmail address (used as the signed-in user and default admin). */
export const TEST_EMAIL = 'admin@gmail.com'

/** Default Google sub for TEST_EMAIL. */
export const TEST_SUB = 'google-sub-12345678'

/** Workspace email paired with TEST_HD. */
export const TEST_EMAIL_WORKSPACE = 'admin@workspace.example.com'

/** `hd` claim value for Workspace tests. */
export const TEST_HD = 'workspace.example.com'

/** Non-authoritative email (not @gmail.com, no hd). */
export const TEST_EMAIL_OTHER = 'admin@school.edu'

/**
 * 32-byte NONCE_KEY for tests.
 * Production uses a Wrangler secret; tests use this fixed value.
 */
export const TEST_NONCE_KEY = 'test-nonce-key-32bytes-paddingXX'

// ── Key-pair helpers (lazy, generated once per test run) ──────────────────────

type KP = { privateKey: CryptoKey; publicKey: CryptoKey }
let _kp1: KP | null = null
let _kp2: KP | null = null

async function kp1(): Promise<KP> {
  if (!_kp1) _kp1 = await generateKeyPair('RS256', { extractable: true })
  return _kp1
}
async function kp2(): Promise<KP> {
  if (!_kp2) _kp2 = await generateKeyPair('RS256', { extractable: true })
  return _kp2
}

// ── JWKS resolvers ────────────────────────────────────────────────────────────

/** One-key local JWKS (kid: 'k1'). Use for most google.ts / me.ts tests. */
export async function localJwks(): Promise<JWTVerifyGetKey> {
  const { publicKey } = await kp1()
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', use: 'sig' }
  return createLocalJWKSet({ keys: [jwk] })
}

/** Two-key local JWKS (kid: 'k1' and 'k2'). Use for key-selection tests. */
export async function twoKeyJwks(): Promise<JWTVerifyGetKey> {
  const { publicKey: pk1 } = await kp1()
  const { publicKey: pk2 } = await kp2()
  const jwk1 = { ...(await exportJWK(pk1)), kid: 'k1', use: 'sig' }
  const jwk2 = { ...(await exportJWK(pk2)), kid: 'k2', use: 'sig' }
  return createLocalJWKSet({ keys: [jwk1, jwk2] })
}

// ── JWT signing helpers ───────────────────────────────────────────────────────

export type SignOpts = {
  kid?: string
  /** Skip `setIssuedAt()`. Useful for no-iat tests. */
  noIat?: boolean
  /** Skip `setExpirationTime()`. Useful when you set exp manually. */
  noExp?: boolean
  /** Sign with kp2 (key with kid 'k2') instead of kp1. */
  useK2?: boolean
  /** Sign with HS256 instead of RS256. Provide the secret as a string. */
  hs256Secret?: string
  /** Use `none` alg (unsigned JWT, no signing). */
  noneAlg?: boolean
}

/**
 * Sign a JWT with exactly the given claims payload.
 * Sets `iat` and `exp` automatically unless `noIat`/`noExp` are set or the claims already include them.
 */
export async function signIdToken(
  claims: Record<string, unknown>,
  opts: SignOpts = {},
): Promise<string> {
  if (opts.hs256Secret !== undefined) {
    const secretKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(opts.hs256Secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    let b = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' })
    if (!opts.noIat && !('iat' in claims)) b = b.setIssuedAt()
    if (!opts.noExp && !('exp' in claims)) b = b.setExpirationTime('1h')
    return b.sign(secretKey)
  }

  if (opts.noneAlg) {
    // Build a JWT with alg:none manually (jose won't sign with 'none').
    const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      iat: now,
      exp: now + 3600,
      ...claims,
    }
    const body = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    return `${header}.${body}.`
  }

  const { privateKey } = opts.useK2 ? await kp2() : await kp1()
  const kid = opts.kid ?? (opts.useK2 ? 'k2' : 'k1')
  let builder = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid })
  if (!opts.noIat && !('iat' in claims)) builder = builder.setIssuedAt()
  if (!opts.noExp && !('exp' in claims)) builder = builder.setExpirationTime('1h')
  return builder.sign(privateKey)
}

/**
 * Convenience: sign a valid Google-shaped ID token with standard test claims and optional overrides.
 *
 * Default claims: `{ iss, aud, sub, email, email_verified: true, nonce }`.
 * Use `nonce` override to control the nonce claim for me.ts handler tests.
 */
export async function validToken(
  overrides: Record<string, unknown> = {},
  opts: SignOpts = {},
): Promise<string> {
  return signIdToken(
    {
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      sub: TEST_SUB,
      email: TEST_EMAIL,
      email_verified: true,
      nonce: 'placeholder-nonce',
      ...overrides,
    },
    opts,
  )
}

// ── Nonce helpers ─────────────────────────────────────────────────────────────

/**
 * Build a valid nonce string: `{rand16hex}.{expiryEpoch}.{hmacHex}`.
 *
 * Both the cookie value and the token's `nonce` claim should be this value.
 * @param nonceKey  The NONCE_KEY secret (hex or string).
 * @param now       Reference time for expiry calculation (default: Date.now()).
 * @param ttlSeconds  Lifetime in seconds (default: 300 = 5 min).
 */
export async function makeNonce(
  nonceKey: string = TEST_NONCE_KEY,
  now: Date = new Date(),
  ttlSeconds = 300,
): Promise<{ nonceValue: string; expEpoch: number }> {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const expEpoch = Math.floor(now.getTime() / 1000) + ttlSeconds
  const rawPayload = `${rand}.${expEpoch}`

  const keyBytes = new TextEncoder().encode(nonceKey)
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(rawPayload))
  const sig = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  return { nonceValue: `${rawPayload}.${sig}`, expEpoch }
}

/**
 * Build an expired nonce (expiry 1 second in the past).
 */
export async function makeExpiredNonce(nonceKey: string = TEST_NONCE_KEY): Promise<string> {
  const past = new Date(Date.now() - 2000)
  const { nonceValue } = await makeNonce(nonceKey, past, 1)
  return nonceValue
}

/**
 * Build a tampered nonce: valid structure but HMAC changed.
 */
export async function makeTamperedNonce(nonceKey: string = TEST_NONCE_KEY): Promise<string> {
  const { nonceValue } = await makeNonce(nonceKey)
  const parts = nonceValue.split('.')
  // Flip last char of HMAC
  const hmac = parts[2]!
  const flipped = hmac.slice(0, -1) + (hmac.endsWith('a') ? 'b' : 'a')
  parts[2] = flipped
  return parts.join('.')
}

// ── Session helpers ───────────────────────────────────────────────────────────

/** Cookie name for sessions (from worker/session.ts contract). */
export const SESSION_COOKIE_NAME = '__Host-cyt_s'

/** Cookie name for nonces (from worker/session.ts contract). */
export const NONCE_COOKIE_NAME = '__Host-cyt_n'

/**
 * Generate a valid raw session token (32 random bytes, base64url).
 */
export function makeRawToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Compute SHA-256 hex hash of a raw token (what gets stored in D1).
 */
export async function sha256Hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── DB setup helpers ──────────────────────────────────────────────────────────

/**
 * Create the new Phase 1 tables (app_user, session, plus google_sub column on admin)
 * on a bare sqlite handle obtained from `testDb()`.
 *
 * These tables are not in the current worker/schema.ts yet; this helper fakes the
 * schema for red-phase tests so the test setup is valid even though the implementation
 * doesn't exist.
 */
export function createNewTables(_sqlite: DatabaseSync): void {
  // Phase 2b: testDb() applies the real SCHEMA (user_identity, password_credential, admin_role).
  // Nothing to create; kept so existing callers still compile.
}

/**
 * Seed an admin row (email only). `google_sub` can be set afterwards via `pinAdminSub`.
 */
export async function seedAdminEmail(db: D1, email: string = TEST_EMAIL): Promise<void> {
  // Phase 2b: an admin is a user with an admin_role row. The legacy helper name is kept so the
  // 20/11 tests read the same. The user gets a known session token so makeLegacyAdminReq can
  // send a session cookie (no email header is accepted any more).
  const addr = email.toLowerCase().trim()
  const now = new Date().toISOString()
  const existing = await db
    .prepare("SELECT user_id FROM user_identity WHERE provider = 'google' AND subject = ?")
    .bind(`admin-${addr}`)
    .first<{ user_id: number }>()
  let userId: number
  if (existing) {
    userId = existing.user_id
  } else {
    userId = await seedUser(db, { sub: `admin-${addr}`, email: addr, nickname: 'Admin', createdAt: now })
  }
  await db
    .prepare('INSERT OR IGNORE INTO admin_role (user_id, granted_at, granted_by) VALUES (?, ?, ?)')
    .bind(userId, now, 'test-seed')
    .run()
  await db
    .prepare('INSERT OR IGNORE INTO session (token_hash, user_id, expires_at, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(legacyToken(addr)), userId, '9999-12-31T23:59:59.000Z', now, '')
    .run()
}

/** Deterministic session token for a seeded admin (tests only). */
export function legacyToken(email: string): string {
  return `t-${email.toLowerCase().trim()}`
}

/**
 * Pin `google_sub` for an existing admin row.
 */
export async function pinAdminSub(db: D1, email: string, sub: string): Promise<void> {
  // Phase 2b: there is no admin.google_sub any more. "Pin" now means: the user who owns this
  // Google subject becomes an admin (admin_role). Email alone never grants admin.
  const owner = await db
    .prepare("SELECT user_id FROM user_identity WHERE provider = 'google' AND subject = ?")
    .bind(sub)
    .first<{ user_id: number }>()
  if (!owner) return
  await db
    .prepare('INSERT OR IGNORE INTO admin_role (user_id, granted_at, granted_by) VALUES (?, ?, ?)')
    .bind(owner.user_id, new Date().toISOString(), `test-pin:${email.toLowerCase().trim()}`)
    .run()
}

/**
 * Seed an `app_user` row. Returns the new user's integer id.
 */
export async function seedUser(
  db: D1,
  opts: { sub?: string; email?: string; nickname?: string; banned?: boolean; createdAt?: string } = {},
): Promise<number> {
  const sub = opts.sub ?? TEST_SUB
  const email = opts.email ?? TEST_EMAIL
  const now = opts.createdAt ?? new Date().toISOString()
  await db
    .prepare('INSERT INTO app_user (nickname, class_name, banned, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .bind(opts.nickname ?? 'TestUser', '11A', opts.banned ? 1 : 0, now, now)
    .run()
  const row = await db.prepare('SELECT MAX(id) AS id FROM app_user').first<{ id: number }>()
  const userId = row!.id
  await db
    .prepare(
      "INSERT INTO user_identity (user_id, provider, subject, email, hd, ip_hash, created_at, last_used_at) VALUES (?, 'google', ?, ?, NULL, '', ?, ?)",
    )
    .bind(userId, sub, email, now, now)
    .run()
  return userId
}

/**
 * Seed a `session` row. `rawToken` is the base64url token that goes in the cookie;
 * its SHA-256 hash is stored in D1.
 */
export async function seedSession(
  db: D1,
  userId: number,
  rawToken: string,
  opts: { expired?: boolean } = {},
): Promise<void> {
  const hash = await sha256Hex(rawToken)
  const now = new Date().toISOString()
  // Use far-future expiry by default so fake-clock tests (vi.setSystemTime) don't expire
  // sessions created in beforeEach. Only { expired: true } creates a past expiry.
  const expires = opts.expired
    ? new Date(Date.now() - 1000).toISOString()
    : '9999-12-31T23:59:59.000Z'
  await db
    .prepare(
      'INSERT INTO session (token_hash, user_id, expires_at, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(hash, userId, expires, now, 'testhash')
    .run()
}

// ── Env builders ──────────────────────────────────────────────────────────────

/** Minimal env for `verifyGoogleCredential` (worker/google.ts). */
export type GoogleCredentialEnv = {
  GOOGLE_CLIENT_ID: string
}
export function googleCredentialEnv(opts: { clientId?: string } = {}): GoogleCredentialEnv {
  return { GOOGLE_CLIENT_ID: opts.clientId ?? TEST_CLIENT_ID }
}

/** Full env for `handleAuth` / `handleMe` (worker/me.ts). */
export type MeTestEnv = {
  DB: D1
  GOOGLE_CLIENT_ID: string
  NONCE_KEY: string
  AUTH_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  ADMIN_FAIL_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  ADMIN_LEGACY_LOGIN?: string
  /** Phase 2: required for sign-in and ban tombstones. */
  SUB_HMAC_KEY?: string
}

export function meEnv(opts: { db?: D1; nonceKey?: string; legacyLogin?: string; subHmacKey?: string } = {}): MeTestEnv {
  return {
    DB: opts.db ?? testDb().db,
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    NONCE_KEY: opts.nonceKey ?? TEST_NONCE_KEY,
    AUTH_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_LEGACY_LOGIN: opts.legacyLogin,
    // Always provide SUB_HMAC_KEY in tests unless explicitly testing the missing-key path.
    SUB_HMAC_KEY: 'subHmacKey' in opts ? opts.subHmacKey : 'test-sub-hmac-key-32bytes-padded',
  }
}

/** Full env for new `requireAdmin` / `handleAdmin` with Google session support. */
export type GoogleAdminEnv = {
  DB: D1
  GOOGLE_CLIENT_ID: string
  NONCE_KEY: string
  ADMIN_FAIL_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  ADMIN_LEGACY_LOGIN?: string
  BOOTSTRAP_EMAIL?: string
  ALLOW_FIRST_CLAIM?: string
}

export function googleAdminEnv(
  opts: { db?: D1; legacyLogin?: string; failLimit?: boolean } = {},
): GoogleAdminEnv {
  return {
    DB: opts.db ?? testDb().db,
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    NONCE_KEY: TEST_NONCE_KEY,
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: opts.failLimit ?? true }) },
    ADMIN_LEGACY_LOGIN: opts.legacyLogin,
  }
}

/**
 * Build a request to /api/admin/teachers with an X-Admin-Email header (legacy path).
 */
export function makeLegacyAdminReq(
  email: string,
  opts: { method?: string; path?: string } = {},
): Request {
  // Phase 2b: send the seeded admin's session cookie (see seedAdminEmail).
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {
    Cookie: `${SESSION_COOKIE_NAME}=${legacyToken(email)}`,
    'CF-Connecting-IP': '1.2.3.4',
  }
  if (method !== 'GET') headers['X-Requested-With'] = 'fetch'
  return new Request(`https://x${opts.path ?? '/api/admin/teachers'}`, { method, headers })
}

/**
 * Build a request to /api/admin/* with a session cookie (Google session path).
 */
export function makeSessionReq(
  sessionToken: string,
  opts: { method?: string; path?: string; body?: unknown } = {},
): Request {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {
    'CF-Connecting-IP': '1.2.3.4',
    Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
  }
  if (method !== 'GET') {
    headers['X-Requested-With'] = 'fetch'
    headers['Content-Type'] = 'application/json'
  }
  return new Request(`https://x${opts.path ?? '/api/admin/teachers'}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}
