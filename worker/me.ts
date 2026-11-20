/**
 * worker/me.ts — authentication (nonce, sign-in, logout) and user profile endpoints.
 *
 * handleAuth handles:
 *   GET  /api/auth/nonce   → issues a one-time nonce (Cache-Control: no-store)
 *   POST /api/auth/google  → verify ID token + nonce, upsert user, create session
 *   POST /api/auth/logout  → revoke session, clear session cookie
 *
 * handleMe handles:
 *   GET  /api/me            → { user|null, isAdmin }, no-store
 *   PUT  /api/me            → update nickname (1–30) and className (≤10)
 *
 * Security: no CORS headers; writes require X-Requested-With: fetch and reject
 * Sec-Fetch-Site: cross-site. Nonce cookie cleared after every sign-in attempt.
 * Email and sub are never logged.
 */
import { json, readJson } from './http.ts'
import { verifyGoogleCredential, isGoogleAuthoritative } from './google.ts'
import type { JWTVerifyGetKey } from './google.ts'
import {
  SESSION_COOKIE,
  NONCE_COOKIE,
  createSession,
  readSession,
  revokeSession,
  clearCookie,
  issueNonce,
  checkNonce,
  getCookieValue,
} from './session.ts'
import { ensureSchema } from './schema.ts'
import type { D1 } from './types.ts'

/** Env shape required by handleAuth and handleMe. */
type MeEnv = {
  DB: D1
  GOOGLE_CLIENT_ID?: string
  NONCE_KEY: string
  AUTH_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  ADMIN_FAIL_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  ADMIN_LEGACY_LOGIN?: string
}

/** Security headers for all /api/auth/* and /api/me responses (no CORS). */
const BASE_HDR: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
}

function resp(body: unknown, status: number, extraCookies: string[] = []): Response {
  const headers = new Headers(BASE_HDR)
  for (const c of extraCookies) headers.append('Set-Cookie', c)
  return new Response(JSON.stringify(body), { status, headers })
}

function failResp(code: string, status: number, extraCookies: string[] = []): Response {
  return resp({ error: code }, status, extraCookies)
}

// ── CSRF guard ────────────────────────────────────────────────────────────────

function csrfGuard(request: Request): boolean {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false
  if (request.method !== 'GET' && request.headers.get('X-Requested-With') !== 'fetch') return false
  return true
}

// ── User row helpers ──────────────────────────────────────────────────────────

type UserRow = {
  id: number
  email: string
  nickname: string
  class_name: string
  banned: number
  hd: string | null
}

/** Upsert app_user; returns the user row (with current id). Never logs email or sub. */
async function upsertUser(db: D1, sub: string, email: string, hd: string | undefined): Promise<UserRow> {
  const now = new Date().toISOString()
  await db
    .prepare(
      'INSERT INTO app_user (google_sub, email, hd, nickname, class_name, banned, created_at, last_seen_at)' +
      ' VALUES (?, ?, ?, \'\', \'\', 0, ?, ?)' +
      ' ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, hd = excluded.hd, last_seen_at = excluded.last_seen_at',
    )
    .bind(sub, email, hd ?? null, now, now)
    .run()

  const row = await db
    .prepare('SELECT id, email, nickname, class_name, banned, hd FROM app_user WHERE google_sub = ?')
    .bind(sub)
    .first<UserRow>()

  if (!row) throw new Error('upsertUser: row missing after insert')
  return row
}

/** Check whether a user's email is in the admin list and Google is authoritative for it.
 *  Also pins admin.google_sub on first Google admin sign-in and rejects different subs. */
async function resolveAdmin(
  db: D1,
  email: string,
  sub: string,
  hd: string | null | undefined,
): Promise<boolean> {
  if (!isGoogleAuthoritative(email, hd ?? undefined)) return false

  const adminRow = await db
    .prepare('SELECT google_sub FROM admin WHERE lower(email) = ?')
    .bind(email.toLowerCase())
    .first<{ google_sub: string | null }>()

  if (!adminRow) return false

  if (adminRow.google_sub === null) {
    // First Google sign-in for this admin: pin the sub.
    await db.prepare('UPDATE admin SET google_sub = ? WHERE lower(email) = ?').bind(sub, email.toLowerCase()).run()
    return true
  }

  // Sub already pinned — reject a different sub (recycled email protection).
  return adminRow.google_sub === sub
}

/** Build the public user object returned in GET /api/me and POST /api/auth/google. */
function publicUser(row: UserRow, isAdmin: boolean) {
  return { nickname: row.nickname, className: row.class_name, isAdmin }
}

// ── handleAuth ────────────────────────────────────────────────────────────────

/**
 * Handle /api/auth/* requests.
 *
 * deps.keys: inject a local JWKS in tests (skips network).
 */
export async function handleAuth(
  request: Request,
  env: MeEnv,
  deps?: { keys?: JWTVerifyGetKey },
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  await ensureSchema(env.DB)

  // GET /api/auth/nonce — no CSRF needed, no auth needed
  if (request.method === 'GET' && pathname === '/api/auth/nonce') {
    const { nonce, cookie } = await issueNonce(env)
    return resp({ nonce }, 200, [cookie])
  }

  // POST /api/auth/google
  if (request.method === 'POST' && pathname === '/api/auth/google') {
    // Always clear nonce cookie on any sign-in attempt (success or failure)
    const nonceClear = clearCookie(NONCE_COOKIE)

    // CSRF guard
    if (!csrfGuard(request)) {
      return failResp('forbidden', 403, [nonceClear])
    }

    // Rate limit on IP (failures and successful attempts)
    const rlResult = await env.AUTH_LIMIT?.limit({ key: ip }) ?? { success: true }
    if (!rlResult.success) return failResp('rate_limited', 429, [nonceClear])

    // Read and validate nonce cookie
    const nonceCookieVal = getCookieValue(request, NONCE_COOKIE) ?? ''

    // Parse body
    let body: { credential?: unknown }
    try {
      body = await readJson<{ credential?: unknown }>(request, 8192)
    } catch {
      return failResp('bad_request', 400, [nonceClear])
    }
    const credential = typeof body.credential === 'string' ? body.credential : ''

    // Verify token
    let claims
    try {
      claims = await verifyGoogleCredential(credential, { GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID! }, deps)
    } catch {
      return failResp('unauthorized', 401, [nonceClear])
    }

    // Verify nonce (cookie must equal token claim, both signed, not expired)
    const nonceOk = await checkNonce(env, nonceCookieVal, claims.nonce)
    if (!nonceOk) {
      return failResp('unauthorized', 401, [nonceClear])
    }

    // Upsert user
    const userRow = await upsertUser(env.DB, claims.sub, claims.email, claims.hd)

    // Session fixation: revoke presented session before issuing new one
    await revokeSession(request, env.DB)

    // Create new session
    const { cookie: sessionCookieVal } = await createSession(env.DB, userRow.id)

    // Check isAdmin
    const isAdmin = await resolveAdmin(env.DB, claims.email, claims.sub, userRow.hd)

    return resp({ user: publicUser(userRow, isAdmin) }, 200, [sessionCookieVal, nonceClear])
  }

  // POST /api/auth/logout
  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    if (!csrfGuard(request)) return failResp('forbidden', 403)
    await revokeSession(request, env.DB)
    const cleared = clearCookie(SESSION_COOKIE)
    return resp({ ok: true }, 200, [cleared])
  }

  return failResp('not_found', 404)
}

// ── handleMe ──────────────────────────────────────────────────────────────────

/**
 * Handle /api/me requests.
 *   GET  → { user|null, isAdmin }  (no auth required; no-store)
 *   PUT  → update nickname/className (auth required; CSRF checked)
 */
export async function handleMe(request: Request, env: MeEnv): Promise<Response> {
  await ensureSchema(env.DB)

  if (request.method === 'GET') {
    const session = await readSession(request, env.DB)
    if (!session) return resp({ user: null, isAdmin: false }, 200)

    const userRow = await env.DB
      .prepare('SELECT id, email, nickname, class_name, banned, hd FROM app_user WHERE id = ?')
      .bind(session.userId)
      .first<UserRow>()
    if (!userRow) return resp({ user: null, isAdmin: false }, 200)

    // Admin check: email in admin list + authoritative
    const adminRow = await env.DB
      .prepare('SELECT google_sub FROM admin WHERE lower(email) = ?')
      .bind(userRow.email.toLowerCase())
      .first<{ google_sub: string | null }>()

    let isAdmin = false
    if (adminRow && isGoogleAuthoritative(userRow.email, userRow.hd ?? undefined)) {
      // If sub is pinned, verify it matches the user's sub
      if (adminRow.google_sub === null) {
        isAdmin = true  // sub not yet pinned; will be pinned on first requireAdmin call
      } else {
        const userSub = await env.DB
          .prepare('SELECT google_sub FROM app_user WHERE id = ?')
          .bind(session.userId)
          .first<{ google_sub: string }>()
        isAdmin = userSub?.google_sub === adminRow.google_sub
      }
    }

    return resp({ user: publicUser(userRow, isAdmin), isAdmin }, 200)
  }

  if (request.method === 'PUT') {
    if (!csrfGuard(request)) return failResp('forbidden', 403)

    const session = await readSession(request, env.DB)
    if (!session) return failResp('unauthorized', 401)

    let body: { nickname?: unknown; className?: unknown }
    try {
      body = await readJson<{ nickname?: unknown; className?: unknown }>(request, 4096)
    } catch {
      return failResp('bad_request', 400)
    }

    const nickname = typeof body.nickname === 'string' ? body.nickname : null
    const className = typeof body.className === 'string' ? body.className : ''

    if (!nickname || nickname.length < 1 || nickname.length > 30) return failResp('bad_request', 400)
    if (className.length > 10) return failResp('bad_request', 400)

    await env.DB
      .prepare('UPDATE app_user SET nickname = ?, class_name = ? WHERE id = ?')
      .bind(nickname, className, session.userId)
      .run()

    return json({ ok: true })
  }

  return failResp('method', 405)
}
