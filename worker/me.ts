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
 *   GET  /api/me?campaign=  → adds heartsLeft, heartedGiftIds for the campaign
 *   GET  /api/me/gifts      → own gifts for the campaign with rank and status
 *   PUT  /api/me            → update nickname (1–30) and className (≤10)
 *   DELETE /api/me          → delete the account
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
  hmacSha256Hex,
} from './session.ts'
import { ensureSchema } from './schema.ts'
import type { D1 } from './types.ts'
import { hasControlCharsSingleLine, hasLoneSurrogate } from '../shared/text.ts'

/** Env shape required by handleAuth and handleMe. */
type MeEnv = {
  DB: D1
  GOOGLE_CLIENT_ID?: string
  NONCE_KEY: string
  /** AUTH_LIMIT counts failed sign-in attempts only (not nonces). 300/60 s per IP. */
  AUTH_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  /** Per-sub rate limit on successful sign-ins: 10/60 s. Key = raw sub (never logged). */
  AUTH_SUB_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  ADMIN_FAIL_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  /** GET /api/me: 120/60 s, keyed by user id (IP when signed out). */
  USER_READ_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  /** PUT /api/me, DELETE /api/me and logout: 10/60 s, keyed by user id (IP when signed out). */
  USER_WRITE_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  /** GET /api/auth/nonce: 3,000/60 s per IP (PUBLIC_READ_LIMIT namespace). */
  PUBLIC_READ_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  ADMIN_LEGACY_LOGIN?: string
  /**
   * Phase 2 (required): HMAC key for ban tombstones in banned_identity.
   * Missing key fails closed for banned users (DELETE /api/me returns non-200).
   */
  SUB_HMAC_KEY?: string
}

/** Security headers for all /api/auth/* and /api/me responses (no CORS). */
const BASE_HDR: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
}

/** True when the caller is within `limit` (missing binding → allowed). Key: user id, else IP. */
async function withinUserLimit(
  limit: MeEnv['USER_READ_LIMIT'],
  request: Request,
  userId: number | undefined,
): Promise<boolean> {
  if (!limit) return true
  const key = userId !== undefined ? `u:${userId}` : `ip:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`
  return (await limit.limit({ key })).success
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
    // Security item 1: nonce uses PUBLIC_READ_LIMIT per IP; AUTH_LIMIT counts failures only.
    const rl = await env.PUBLIC_READ_LIMIT?.limit({ key: ip }) ?? { success: true }
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

    // Security item 4: fail closed when NONCE_KEY is not configured.
    if (!env.NONCE_KEY) {
      console.error('auth: misconfigured')
      return failResp('unauthorized', 401, [nonceClear])
    }

    // Rate limit on IP (AUTH_LIMIT counts failures only — charged below on failure)

    // Read and validate nonce cookie
    const nonceCookieVal = getCookieValue(request, NONCE_COOKIE) ?? ''

    // Parse body
    let body: { credential?: unknown }
    try {
      body = await readJson<{ credential?: unknown }>(request, 8192)
    } catch {
      const rl = await env.AUTH_LIMIT?.limit({ key: ip }) ?? { success: true }
      return failResp(rl.success ? 'bad_request' : 'rate_limited', rl.success ? 400 : 429, [nonceClear])
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
    // Key is the raw sub (never logged or returned; decisions.md "Security cycle 1").
    const subKey = claims.sub
    const subRl = await env.AUTH_SUB_LIMIT?.limit({ key: subKey }) ?? { success: true }
    if (!subRl.success) return failResp('rate_limited', 429, [nonceClear])

    // Upsert user
    const userRow = await upsertUser(env.DB, claims.sub, claims.email, claims.hd)

    // Phase 2: check banned_identity tombstone (ban evasion prevention, ADR-8).
    // A banned user who deleted their account has a tombstone keyed by HMAC(SUB_HMAC_KEY, sub).
    // On next sign-in, recreate the account as banned so they cannot evade the ban.
    // Skip silently when SUB_HMAC_KEY is absent (tombstones cannot exist without the key).
    // Never log sub.
    if (env.SUB_HMAC_KEY) {
      const subHmac = await hmacSha256Hex(env.SUB_HMAC_KEY, claims.sub)
      const tombstone = await env.DB
        .prepare('SELECT 1 FROM banned_identity WHERE sub_hmac = ?')
        .bind(subHmac)
        .first<{ result: number }>()
      if (tombstone) {
        await env.DB
          .prepare('UPDATE app_user SET banned = 1 WHERE google_sub = ?')
          .bind(claims.sub)
          .run()
        userRow.banned = 1
      }
    }

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
    const current = await readSession(request, env.DB)
    if (!(await withinUserLimit(env.USER_WRITE_LIMIT, request, current?.userId))) return failResp('rate_limited', 429)
    await revokeSession(request, env.DB)
    const cleared = clearCookie(SESSION_COOKIE)
    return resp({ ok: true }, 200, [cleared])
  }

  return failResp('not_found', 404)
}

// ── handleMe ──────────────────────────────────────────────────────────────────

/** Vietnam day string (YYYY-MM-DD, UTC+7). Uses Date.now() so fake clocks work in tests. */
function vietnamDay(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
}

/** Shared admin-status check from a loaded user row. */
function resolveAdminFromRow(
  userRow: { email: string; hd: string | null; google_sub: string | null },
  adminRow: { google_sub: string | null } | null,
): boolean {
  if (!adminRow || !isGoogleAuthoritative(userRow.email, userRow.hd ?? undefined)) return false
  if (adminRow.google_sub === null) return true
  return adminRow.google_sub === userRow.google_sub
}

/**
 * Handle /api/me and /api/me/gifts requests.
 *   GET /api/me             → { user|null, isAdmin }  (no auth required; no-store)
 *   GET /api/me?campaign=   → adds heartsLeft, heartedGiftIds
 *   GET /api/me/gifts       → own gifts for campaign, with rank (auth required)
 *   PUT /api/me             → update nickname/className (auth required; CSRF checked)
 *   DELETE /api/me          → delete account (auth required; CSRF checked)
 */
export async function handleMe(request: Request, env: MeEnv): Promise<Response> {
  await ensureSchema(env.DB)

  const { pathname } = new URL(request.url)

  // ── GET /api/me/gifts ─────────────────────────────────────────────────────────
  if (pathname === '/api/me/gifts') {
    if (request.method !== 'GET') return failResp('method', 405)
    const session = await readSession(request, env.DB)
    if (!session) return failResp('unauthorized', 401)

    if (!(await withinUserLimit(env.USER_READ_LIMIT, request, session.userId))) return failResp('rate_limited', 429)

    const url = new URL(request.url)
    const campaignSlug = url.searchParams.get('campaign') ?? ''

    // Find campaign
    const campaign = await env.DB
      .prepare('SELECT id FROM campaign WHERE slug = ? LIMIT 1')
      .bind(campaignSlug)
      .first<{ id: number }>()

    if (!campaign) return resp({ gifts: [] }, 200)

    // Fetch user's non-deleted gifts with rank computed against visible gifts
    const { results } = await env.DB
      .prepare(
        'SELECT g.public_id, g.box_style, g.ornament_style, g.layout, g.background_template_id,' +
        ' g.font, g.ink, g.message, g.nickname, g.class_name, g.heart_count, g.created_at,' +
        ' g.status,' +
        " (SELECT COUNT(*) + 1 FROM gift g2 WHERE g2.campaign_id = g.campaign_id AND g2.status = 'visible'" +
        "   AND (g2.heart_count > g.heart_count" +
        '       OR (g2.heart_count = g.heart_count AND g2.created_at < g.created_at)' +
        '       OR (g2.heart_count = g.heart_count AND g2.created_at = g.created_at AND g2.id < g.id))) AS rank' +
        " FROM gift g WHERE g.campaign_id = ? AND g.user_id = ? AND g.status != 'deleted'" +
        ' ORDER BY g.created_at DESC',
      )
      .bind(campaign.id, session.userId)
      .all<{
        public_id: string; box_style: number; ornament_style: number; layout: string
        background_template_id: number | null; font: string; ink: string; message: string
        nickname: string; class_name: string; heart_count: number; created_at: string
        status: string; rank: number
      }>()

    return resp(
      {
        gifts: results.map((g) => ({
          publicId: g.public_id,
          heartCount: g.heart_count,
          nickname: g.nickname,
          className: g.class_name,
          boxStyle: g.box_style,
          ornamentStyle: g.ornament_style,
          layout: g.layout,
          backgroundTemplateId: g.background_template_id ?? null,
          font: g.font,
          ink: g.ink,
          message: g.message,
          createdAt: g.created_at,
          status: g.status,
          rank: g.rank,
        })),
      },
      200,
    )
  }

  // ── GET /api/me ───────────────────────────────────────────────────────────────
  if (request.method === 'GET') {
    const session = await readSession(request, env.DB)
    if (!(await withinUserLimit(env.USER_READ_LIMIT, request, session?.userId))) return failResp('rate_limited', 429)

    // Check for campaign param — if present, add heartsLeft and heartedGiftIds
    const url = new URL(request.url)
    const campaignSlug = url.searchParams.get('campaign')

    if (!session) {
      if (campaignSlug) {
        // Anonymous with campaign param: return hearts_per_day as heartsLeft, empty heartedGiftIds
        const campaignData = await env.DB
          .prepare('SELECT settings FROM campaign WHERE slug = ? AND kind = ? LIMIT 1')
          .bind(campaignSlug, 'gift_tree')
          .first<{ settings: string }>()
        let heartsPerDay = 5
        if (campaignData) {
          try {
            const s = JSON.parse(campaignData.settings) as { hearts_per_day?: number }
            if (typeof s.hearts_per_day === 'number') heartsPerDay = s.hearts_per_day
          } catch { /* use default */ }
        }
        return resp({ user: null, isAdmin: false, heartsLeft: heartsPerDay, heartedGiftIds: [] }, 200)
      }
      return resp({ user: null, isAdmin: false }, 200)
    }

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

    const isAdmin = resolveAdminFromRow(userRow, adminRow)

    if (campaignSlug) {
      // Add heartsLeft and heartedGiftIds for the campaign
      const campaignData = await env.DB
        .prepare('SELECT id, settings FROM campaign WHERE slug = ? AND kind = ? LIMIT 1')
        .bind(campaignSlug, 'gift_tree')
        .first<{ id: number; settings: string }>()

      let heartsLeft = 5
      let heartedGiftIds: string[] = []

      if (campaignData) {
        let heartsPerDay = 5
        try {
          const s = JSON.parse(campaignData.settings) as { hearts_per_day?: number }
          if (typeof s.hearts_per_day === 'number') heartsPerDay = s.hearts_per_day
        } catch { /* use default */ }

        const today = vietnamDay()

        const givenRow = await env.DB
          .prepare(
            'SELECT COUNT(*) AS n FROM heart h JOIN gift g ON g.id = h.gift_id' +
            ' WHERE h.user_id = ? AND h.day = ? AND g.campaign_id = ?',
          )
          .bind(session.userId, today, campaignData.id)
          .first<{ n: number }>()
        const given = givenRow?.n ?? 0
        heartsLeft = heartsPerDay - given

        const { results: heartedRows } = await env.DB
          .prepare(
            'SELECT g.public_id FROM heart h JOIN gift g ON g.id = h.gift_id' +
            ' WHERE h.user_id = ? AND g.campaign_id = ?',
          )
          .bind(session.userId, campaignData.id)
          .all<{ public_id: string }>()
        heartedGiftIds = heartedRows.map((r) => r.public_id)
      }

      return resp({ user: publicUser(userRow, isAdmin), isAdmin, heartsLeft, heartedGiftIds }, 200)
    }

    return resp({ user: publicUser(userRow, isAdmin), isAdmin }, 200)
  }

  if (request.method === 'DELETE') {
    // Phase 2: full account deletion (ADR-8, FR-13).
    // Refused while any gift is hidden (pending_review); writes a tombstone for banned users.
    if (!csrfGuard(request)) return failResp('forbidden', 403)
    const session = await readSession(request, env.DB)
    if (!session) return failResp('unauthorized', 401)
    if (!(await withinUserLimit(env.USER_WRITE_LIMIT, request, session.userId))) return failResp('rate_limited', 429)

    // Load user (need google_sub for tombstone, banned for key-required check).
    const userRow = await env.DB
      .prepare('SELECT google_sub, banned FROM app_user WHERE id = ?')
      .bind(session.userId)
      .first<{ google_sub: string; banned: number }>()
    if (!userRow) return failResp('unauthorized', 401)

    // Refused while any own gift is hidden (evidence cannot be removed — ADR-8, AC-14).
    const pendingRow = await env.DB
      .prepare(
        "SELECT 1 FROM gift WHERE user_id = ? AND status IN ('hidden_auto','hidden_admin') LIMIT 1",
      )
      .bind(session.userId)
      .first()
    if (pendingRow) return failResp('pending_review', 409)

    // Tombstone for banned users (fail closed if SUB_HMAC_KEY is missing — security: a banned
    // user must not silently escape the ban because the key was removed by mistake).
    // Never log sub.
    let subHmac: string | null = null
    if (userRow.banned) {
      if (!env.SUB_HMAC_KEY) {
        console.error('auth: misconfigured')
        return failResp('misconfigured', 500)
      }
      subHmac = await hmacSha256Hex(env.SUB_HMAC_KEY, userRow.google_sub)
    }

    // Pre-fetch gift IDs this user hearted (need IDs before deleting hearts, for recount).
    const { results: heartRows } = await env.DB
      .prepare('SELECT DISTINCT gift_id FROM heart WHERE user_id = ?')
      .bind(session.userId)
      .all<{ gift_id: number }>()
    const heartedGiftIds = heartRows.map((r) => r.gift_id)

    // One D1 batch for the entire deletion (ADR-8: "delete the user's gifts, hearts and reports,
    // recount affected gifts, revoke sessions"):
    //   1. Write tombstone if banned.
    //   2. Delete own gift rows (gift.user_id FK has no CASCADE, so rows must be deleted before the user).
    //      Cascade on heart.gift_id and report.gift_id removes hearts/reports on own gifts.
    //   3. Delete hearts the user gave to other gifts (not cascade-deleted in step 2).
    //   4. Recount heart_count for every gift they had hearted (after hearts are deleted in step 3).
    //   5. Delete reports the user filed on others' gifts (not cascade-deleted in step 2).
    //   6. Delete sessions (also covered by app_user CASCADE, but explicit for clarity).
    //   7. Delete the user row (remaining session/heart/report rows on this user_id are
    //      cascade-deleted by the FKs on those tables, but all should be gone by now).
    const stmts = [
      ...(subHmac !== null
        ? [
            env.DB.prepare(
              'INSERT OR IGNORE INTO banned_identity (sub_hmac, created_at) VALUES (?, ?)',
            ).bind(subHmac, new Date().toISOString()),
          ]
        : []),
      env.DB.prepare('DELETE FROM gift WHERE user_id = ?').bind(session.userId),
      env.DB.prepare('DELETE FROM heart WHERE user_id = ?').bind(session.userId),
      ...heartedGiftIds.map((giftId) =>
        env.DB.prepare(
          'UPDATE gift SET heart_count = (SELECT COUNT(*) FROM heart WHERE gift_id = ?) WHERE id = ?',
        ).bind(giftId, giftId),
      ),
      env.DB.prepare('DELETE FROM report WHERE user_id = ?').bind(session.userId),
      env.DB.prepare('DELETE FROM session WHERE user_id = ?').bind(session.userId),
      env.DB.prepare('DELETE FROM app_user WHERE id = ?').bind(session.userId),
    ]
    await env.DB.batch(stmts)

    const cleared = clearCookie(SESSION_COOKIE)
    return resp({ ok: true }, 200, [cleared])
  }

  if (request.method === 'PUT') {
    if (!csrfGuard(request)) return failResp('forbidden', 403)

    const session = await readSession(request, env.DB)
    if (!session) return failResp('unauthorized', 401)
    if (!(await withinUserLimit(env.USER_WRITE_LIMIT, request, session.userId))) return failResp('rate_limited', 429)

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
