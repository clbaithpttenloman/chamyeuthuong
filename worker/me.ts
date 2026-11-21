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
import { hasControlCharsSingleLine, hasLoneSurrogate } from '../shared/text.ts'

/** Env shape required by handleAuth and handleMe. */
type MeEnv = {
  DB: D1
  GOOGLE_CLIENT_ID?: string
  NONCE_KEY: string
  AUTH_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  /** Per-sub rate limit on successful sign-ins: 10/60 s. Key = HMAC(sub) or sub. */
  AUTH_SUB_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  ADMIN_FAIL_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  ADMIN_LEGACY_LOGIN?: string
  /** Used to hash the sub for AUTH_SUB_LIMIT key (privacy-preserving). */
  IP_HMAC_KEY?: string
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
 *  Also pins admin.google_sub on first Google admin sign-in and rejects different subs.
 *  Conditional UPDATE (WHERE google_sub IS NULL) prevents a race where two sign-ins both
 *  see NULL and try to pin — only one wins, the other re-reads and is refused. */
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
    // Accept #5: pin only while still unpinned (WHERE google_sub IS NULL).
    // A racing sign-in by a different sub loses here.
    const pinned = await db
      .prepare('UPDATE admin SET google_sub = ? WHERE lower(email) = ? AND google_sub IS NULL')
      .bind(sub, email.toLowerCase())
      .run()
    if (!pinned.meta?.changes) {
      // Another concurrent sign-in won the pin. Re-read to verify our sub won.
      const now = await db
        .prepare('SELECT google_sub FROM admin WHERE lower(email) = ?')
        .bind(email.toLowerCase())
        .first<{ google_sub: string | null }>()
      if (now?.google_sub !== sub) return false
    }
    return true
  }

  // Sub already pinned — reject a different sub (recycled email protection).
  return adminRow.google_sub === sub
}

/** Build the public user object returned in GET /api/me and POST /api/auth/google. */
function publicUser(row: UserRow, isAdmin: boolean) {
  return { nickname: row.nickname, className: row.class_name, isAdmin }
}

/** Validate and normalise a user text field (nickname/class): NFC, trim, control/bidi/surrogate check.
 *  Returns the normalised string on success, or null on validation failure.
 *  Accept #8: reuses shared/text.ts rules.
 */
function normaliseUserText(raw: string, maxCodepoints: number): string | null {
  const normalised = raw.normalize('NFC').trim()
  if (!normalised) return null  // empty or whitespace-only
  if ([...normalised].length > maxCodepoints) return null
  if (hasControlCharsSingleLine(normalised) || hasLoneSurrogate(normalised)) return null
  return normalised
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
    // Accept #7: rate limit nonce requests per IP (reuses AUTH_LIMIT namespace)
    const rl = await env.AUTH_LIMIT?.limit({ key: ip }) ?? { success: true }
    if (!rl.success) return failResp('rate_limited', 429)
    const { nonce, cookie } = await issueNonce(env)
    return resp({ nonce, clientId: env.GOOGLE_CLIENT_ID ?? '' }, 200, [cookie])
  }

  // POST /api/auth/google
  if (request.method === 'POST' && pathname === '/api/auth/google') {
    // Always clear nonce cookie on any sign-in attempt (success or failure)
    const nonceClear = clearCookie(NONCE_COOKIE)

    // CSRF guard
    if (!csrfGuard(request)) {
      return failResp('forbidden', 403, [nonceClear])
    }

    // Accept #6: fail closed when GOOGLE_CLIENT_ID is not configured (misconfiguration guard).
    // This must happen BEFORE any JWT verification attempt.
    if (!env.GOOGLE_CLIENT_ID) {
      console.error('auth: misconfigured')
      return failResp('unauthorized', 401, [nonceClear])
    }

    // Rate limit on IP (Accept #7: AUTH_LIMIT counts failures only — charged below on failure)

    // Read and validate nonce cookie
    const nonceCookieVal = getCookieValue(request, NONCE_COOKIE) ?? ''

    // Parse body
    let body: { credential?: unknown }
    try {
      body = await readJson<{ credential?: unknown }>(request, 8192)
    } catch {
      await env.AUTH_LIMIT?.limit({ key: ip })
      return failResp('bad_request', 400, [nonceClear])
    }
    const credential = typeof body.credential === 'string' ? body.credential : ''

    // Verify token
    let claims
    try {
      claims = await verifyGoogleCredential(credential, { GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID }, deps)
    } catch {
      // Accept #7: charge AUTH_LIMIT only on failure (not on success)
      const rl = await env.AUTH_LIMIT?.limit({ key: ip }) ?? { success: true }
      return failResp(rl.success ? 'unauthorized' : 'rate_limited', rl.success ? 401 : 429, [nonceClear])
    }

    // Verify nonce (cookie must equal token claim, both signed, not expired)
    const nonceOk = await checkNonce(env, nonceCookieVal, claims.nonce)
    if (!nonceOk) {
      // Charge AUTH_LIMIT on nonce failure too
      const rl = await env.AUTH_LIMIT?.limit({ key: ip }) ?? { success: true }
      return failResp(rl.success ? 'unauthorized' : 'rate_limited', rl.success ? 401 : 429, [nonceClear])
    }

    // Accept #7: per-sub rate limit on successful sign-ins (AUTH_SUB_LIMIT, 10/60 s)
    // Key is the sub (or its hash if IP_HMAC_KEY is available, for dashboard privacy)
    const subKey = claims.sub  // SHORTCUT: use raw sub as key — HMAC with IP_HMAC_KEY if dashboard privacy required
    const subRl = await env.AUTH_SUB_LIMIT?.limit({ key: subKey }) ?? { success: true }
    if (!subRl.success) return failResp('rate_limited', 429, [nonceClear])

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

    // Accept #10: single app_user read including google_sub (eliminates the second read)
    const userRow = await env.DB
      .prepare('SELECT id, email, nickname, class_name, banned, hd, google_sub FROM app_user WHERE id = ?')
      .bind(session.userId)
      .first<UserRow & { google_sub: string | null }>()
    if (!userRow) return resp({ user: null, isAdmin: false }, 200)

    // Admin check: email in admin list + authoritative
    const adminRow = await env.DB
      .prepare('SELECT google_sub FROM admin WHERE lower(email) = ?')
      .bind(userRow.email.toLowerCase())
      .first<{ google_sub: string | null }>()

    let isAdmin = false
    if (adminRow && isGoogleAuthoritative(userRow.email, userRow.hd ?? undefined)) {
      if (adminRow.google_sub === null) {
        isAdmin = true  // sub not yet pinned; will be pinned on first requireAdmin call
      } else {
        // Accept #10: use userRow.google_sub from the first read (no second query)
        isAdmin = userRow.google_sub === adminRow.google_sub
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

    const rawNickname = typeof body.nickname === 'string' ? body.nickname : null
    const rawClassName = typeof body.className === 'string' ? body.className : ''

    // Accept #8: validate using shared/text.ts (trim, NFC, control/bidi/lone-surrogate rejection, codepoint length)
    if (!rawNickname) return failResp('bad_request', 400)
    const nickname = normaliseUserText(rawNickname, 30)
    if (!nickname) return failResp('bad_request', 400)

    const className = normaliseUserText(rawClassName, 10) ?? ''
    // className is optional (empty is valid), but if non-empty it must pass validation
    if (rawClassName && !normaliseUserText(rawClassName, 10)) return failResp('bad_request', 400)

    await env.DB
      .prepare('UPDATE app_user SET nickname = ?, class_name = ? WHERE id = ?')
      .bind(nickname, className, session.userId)
      .run()

    return json({ ok: true })
  }

  return failResp('method', 405)
}
