/**
 * Username/password register and login (ADR-9, Phase 2b).
 *
 *   POST /api/auth/register  { username, password, nickname, className }  → 201 + session cookie
 *   POST /api/auth/login     { username, password }                        → 200 + session cookie
 *
 * Every login path computes exactly one PBKDF2 derivation, so unknown, locked and wrong-password
 * attempts take the same time and return the same 401 body. Rate limits run before any hash.
 */
import { checkPassword, RAW_LIMITS } from '../shared/password.ts'
import { normalizeUsername } from '../shared/username.ts'
import { COMMON_PASSWORDS } from './commonPasswords.ts'
import { error, HttpError, json, readJson } from './http.ts'
import { PBKDF2_ITERATIONS, hashPassword, verifyPassword } from './password.ts'
import {
  SESSION_MAX_AGE,
  createSession,
  hmacSha256Hex,
  readSession,
  revokeSession,
  sessionCookie,
  sha256Hex,
} from './session.ts'
import type { D1 } from './types.ts'

type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> }

export type AccountsEnv = {
  DB: D1
  AUTH_LIMIT: Limiter
  AUTH_SUB_LIMIT: Limiter
  REGISTER_LIMIT: Limiter
  PASSWORD_PEPPER?: string
  SUB_HMAC_KEY?: string
  IP_HMAC_KEY?: string
  REGISTER_IP_DAILY?: string
  REGISTER_GLOBAL_DAILY?: string
}

export type AccountsDeps = { now?: () => Date }

/** Body cap for the account endpoints (plan: request order). */
const BODY_LIMIT = 2048
/** Failed attempts before the username is locked. */
const LOCK_AFTER = 10
/** Lock duration after the tenth failure. */
const LOCK_MINUTES = 15
/** Age after which a registration's ip_hash is blanked. */
const IP_HASH_DAYS = 30

/**
 * Dummy credential for unknown usernames: one PBKDF2 derivation at PBKDF2_ITERATIONS, never
 * matching a real password. Generated once with the same derivation as hashPassword, using a
 * throwaway pepper. Its only job is to make unknown-user logins cost the same as real ones.
 */
const DUMMY_CREDENTIAL = {
  hash: 'W9jmdSYVrFNBy4R3Fh23WYhj9FWG5cstxwzh71ukoLw=',
  salt: 'BwcHBwcHBwcHBwcHBwcHBw==',
  iterations: 50_000,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalises a client address for rate limits and ip_hash. IPv4 is used as is. IPv6 keeps the
 * /64 prefix (a household or school share one), written as the first four groups plus "::/64".
 */
export function ipKey(ip: string): string {
  if (!ip.includes(':')) return ip
  const halves = ip.split('::')
  let groups: string[]
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : []
    const right = halves[1] ? halves[1].split(':') : []
    groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  } else {
    groups = ip.split(':')
  }
  const first4 = groups.slice(0, 4).map((g) => (g.replace(/^0+(?=.)/, '') || '0').toLowerCase())
  return `${first4.join(':')}::/64`
}

/** Login-style refusal. Body identical for unknown, wrong, locked and expired-temp cases. */
function invalidCredentials(): Response {
  return json({ error: 'invalid_credentials' }, 401)
}

/** Adds a Set-Cookie header to a JSON response without changing its body or other headers. */
function withCookie(res: Response, cookie: string): Response {
  const headers = new Headers(res.headers)
  headers.append('Set-Cookie', cookie)
  return new Response(res.body, { status: res.status, headers })
}

/** Same-origin browser requests only. Sec-Fetch-Site absent covers old browsers and scripts. */
function csrfOk(request: Request): boolean {
  if (request.headers.get('X-Requested-With') !== 'fetch') return false
  const site = request.headers.get('Sec-Fetch-Site')
  return site === null || site === 'same-origin'
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown'
}

/** Start of the current Asia/Ho_Chi_Minh calendar day, as an ISO string in UTC. */
function vietnamDayStart(now: Date): string {
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000
  const shifted = new Date(now.getTime() + VN_OFFSET_MS)
  const midnightUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  return new Date(midnightUtc - VN_OFFSET_MS).toISOString()
}

function parseCap(value: string | undefined, fallback: number): number {
  const n = Number(value ?? fallback)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

type Me = {
  id: number
  username: string | null
  nickname: string
  className: string
  banned: boolean
  isAdmin: boolean
  mustChangePassword: boolean
}

async function meFor(db: D1, userId: number, username: string | null): Promise<Me> {
  const row = await db
    .prepare(
      'SELECT u.nickname, u.class_name, u.banned, pc.must_change,' +
        ' (SELECT 1 FROM admin_role a WHERE a.user_id = u.id) AS is_admin' +
        ' FROM app_user u LEFT JOIN password_credential pc ON pc.user_id = u.id WHERE u.id = ?',
    )
    .bind(userId)
    .first<{ nickname: string; class_name: string; banned: number; must_change: number | null; is_admin: number | null }>()
  return {
    id: userId,
    username,
    nickname: row?.nickname ?? '',
    className: row?.class_name ?? '',
    banned: row?.banned === 1,
    isAdmin: row?.is_admin === 1,
    mustChangePassword: row?.must_change === 1,
  }
}

/**
 * Counts one failed password check (FR-33, AC-25c). One conditional statement: concurrent
 * failures cannot skip the lock, and a count whose last failure is older than 24 h restarts at 1.
 */
export async function recordFailure(db: D1, userId: number, now: Date): Promise<void> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const lockUntil = new Date(now.getTime() + LOCK_MINUTES * 60 * 1000).toISOString()
  await db
    .prepare(
      'UPDATE password_credential SET' +
        ' failed_count = CASE WHEN updated_at < ? THEN 1 WHEN failed_count + 1 >= ? THEN 0 ELSE failed_count + 1 END,' +
        ' locked_until = CASE WHEN updated_at >= ? AND failed_count + 1 >= ? THEN ? ELSE locked_until END,' +
        ' updated_at = ? WHERE user_id = ?',
    )
    .bind(dayAgo, LOCK_AFTER, dayAgo, LOCK_AFTER, lockUntil, now.toISOString(), userId)
    .run()
}

/**
 * Re-checks a signed-in user's password (account deletion, AC-34). Always computes one hash.
 * A wrong or missing password counts toward the lock. Returns 'misconfigured' without a pepper.
 */
export async function verifyOwnPassword(
  env: { DB: D1; PASSWORD_PEPPER?: string },
  userId: number,
  raw: unknown,
  now: Date = new Date(),
): Promise<boolean | 'misconfigured'> {
  if (!env.PASSWORD_PEPPER) return 'misconfigured'
  const nfc = typeof raw === 'string' && raw.length <= RAW_LIMITS.password ? raw.normalize('NFC') : null
  const row = await env.DB
    .prepare('SELECT hash, salt, iterations, locked_until FROM password_credential WHERE user_id = ?')
    .bind(userId)
    .first<{ hash: string; salt: string; iterations: number; locked_until: string | null }>()
  if (!row || nfc === null) {
    await verifyPassword(nfc ?? '', env.PASSWORD_PEPPER, DUMMY_CREDENTIAL)
    return false
  }
  if (row.locked_until !== null && row.locked_until > now.toISOString()) {
    await verifyPassword(nfc, env.PASSWORD_PEPPER, row)
    return false
  }
  const ok = await verifyPassword(nfc, env.PASSWORD_PEPPER, row)
  if (!ok) await recordFailure(env.DB, userId, now)
  return ok
}

// ── Register ──────────────────────────────────────────────────────────────────

type RegisterBody = { username?: unknown; password?: unknown; nickname?: unknown; className?: unknown }

function codePoints(s: string): number {
  return [...s].length
}

export async function handleRegister(request: Request, env: AccountsEnv, deps: AccountsDeps = {}): Promise<Response> {
  const now = deps.now?.() ?? new Date()
  const nowIso = now.toISOString()

  if (!env.PASSWORD_PEPPER || !env.IP_HMAC_KEY || !env.SUB_HMAC_KEY) {
    console.error('accounts: misconfigured')
    return json({ error: 'misconfigured' }, 503)
  }
  if (!csrfOk(request)) return error('forbidden')

  const ip = clientIp(request)
  const ipK = ipKey(ip)
  const { success } = await env.REGISTER_LIMIT.limit({ key: ipK })
  if (!success) return json({ error: 'rate_limited' }, 429)

  let body: RegisterBody
  try {
    body = await readJson<RegisterBody>(request, BODY_LIMIT)
  } catch (e) {
    if (e instanceof HttpError) return error(e.code)
    throw e
  }

  const username = normalizeUsername(body.username)
  if (!username.ok) return json({ error: username.code }, 400)

  const password = checkPassword(body.password, username.value, (s) => COMMON_PASSWORDS.has(s))
  if (!password.ok) return json({ error: password.code }, 400)

  const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : ''
  const className = typeof body.className === 'string' ? body.className.trim() : ''
  if (
    typeof body.nickname !== 'string' ||
    body.nickname.length > RAW_LIMITS.nickname ||
    codePoints(nickname) < 1 ||
    codePoints(nickname) > 30 ||
    typeof body.className !== 'string' ||
    body.className.length > RAW_LIMITS.className ||
    codePoints(className) > 10
  ) {
    return json({ error: 'bad_request' }, 400)
  }

  // Ban evasion: a deleted banned account leaves a tombstone keyed by HMAC of its identity.
  const tombstone = await hmacSha256Hex(env.SUB_HMAC_KEY, `password:${username.value}`)
  const banned = await env.DB.prepare('SELECT 1 AS x FROM banned_identity WHERE sub_hmac = ?')
    .bind(tombstone)
    .first()
  if (banned) return json({ error: 'banned' }, 403)

  // Blank ip_hash older than IP_HASH_DAYS (no cron exists; this runs on each registration).
  const cutoff = new Date(now.getTime() - IP_HASH_DAYS * 24 * 60 * 60 * 1000).toISOString()
  await env.DB.prepare("UPDATE user_identity SET ip_hash = '' WHERE ip_hash <> '' AND created_at < ?")
    .bind(cutoff)
    .run()

  const ipHash = await hmacSha256Hex(env.IP_HMAC_KEY, ipK)
  const dayStart = vietnamDayStart(now)
  const perIpMax = parseCap(env.REGISTER_IP_DAILY, 300)
  const globalMax = parseCap(env.REGISTER_GLOBAL_DAILY, 2000)

  const cred = await hashPassword(password.value, env.PASSWORD_PEPPER)
  const userId = 1_000_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000_000)
  const rawToken = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  const tokenHash = await sha256Hex(rawToken)
  const expires = new Date(now.getTime() + SESSION_MAX_AGE * 1000).toISOString()

  // One batch, in this order. Each INSERT after the first runs only if the previous one changed a
  // row (changes() = 1), so a refused registration leaves nothing behind. The admin grant comes
  // last and only fires for the first account ever (see plan.md, "first account is admin").
  let results
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO app_user (id, nickname, class_name, banned, created_at, last_seen_at)' +
          ' SELECT ?, ?, ?, 0, ?, ?' +
          ' WHERE (SELECT COUNT(*) FROM user_identity WHERE ip_hash = ? AND created_at >= ?) < ?' +
          ' AND (SELECT COUNT(*) FROM user_identity WHERE created_at >= ?) < ?',
      ).bind(userId, nickname, className, nowIso, nowIso, ipHash, dayStart, perIpMax, dayStart, globalMax),
      env.DB.prepare(
        "INSERT INTO user_identity (user_id, provider, subject, ip_hash, created_at, last_used_at)" +
          " SELECT ?, 'password', ?, ?, ?, ? WHERE changes() = 1",
      ).bind(userId, username.value, ipHash, nowIso, nowIso),
      env.DB.prepare(
        'INSERT INTO password_credential (user_id, hash, salt, iterations, must_change, failed_count, updated_at)' +
          ' SELECT ?, ?, ?, ?, 0, 0, ? WHERE changes() = 1',
      ).bind(userId, cred.hash, cred.salt, cred.iterations, nowIso),
      env.DB.prepare(
        'INSERT INTO session (token_hash, user_id, expires_at, created_at, ip_hash)' +
          ' SELECT ?, ?, ?, ?, ? WHERE changes() = 1',
      ).bind(tokenHash, userId, expires, nowIso, ''),
      env.DB.prepare(
        "INSERT INTO admin_role (user_id, granted_at, granted_by)" +
          " SELECT ?, ?, 'first_account' WHERE changes() = 1" +
          " AND (SELECT COUNT(*) FROM app_user) = 1" +
          " AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'admin_bootstrap_done')",
      ).bind(userId, nowIso),
      env.DB.prepare(
        "INSERT INTO meta (key, value) SELECT 'admin_bootstrap_done', ? WHERE changes() = 1",
      ).bind(nowIso),
      env.DB.prepare(
        "INSERT INTO admin_audit (actor_user_id, action, target_user_id, at)" +
          " SELECT ?, 'first_account', ?, ? WHERE changes() = 1",
      ).bind(userId, userId, nowIso),
    ])
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE constraint failed: user_identity')) return json({ error: 'username_taken' }, 409)
    console.error('accounts: register failed')
    return error('unavailable')
  }

  // The first statement reports whether the registration itself went in.
  if (results[0]?.meta.changes !== 1) return json({ error: 'register_limit' }, 429)

  const me = await meFor(env.DB, userId, username.value)
  const cookie = sessionCookie(rawToken)
  return withCookie(json({ user: me }, 201), cookie)
}

// ── Login ─────────────────────────────────────────────────────────────────────

type LoginBody = { username?: unknown; password?: unknown }

type CredentialRow = {
  user_id: number
  banned: number
  hash: string
  salt: string
  iterations: number
  must_change: number
  temp_expires_at: string | null
  failed_count: number
  locked_until: string | null
  updated_at: string
}

export async function handleLogin(request: Request, env: AccountsEnv, deps: AccountsDeps = {}): Promise<Response> {
  const now = deps.now?.() ?? new Date()
  const nowIso = now.toISOString()

  if (!env.PASSWORD_PEPPER) {
    console.error('accounts: misconfigured')
    return json({ error: 'misconfigured' }, 503)
  }
  if (!csrfOk(request)) return error('forbidden')

  const ip = clientIp(request)
  const ipK = ipKey(ip)
  const ipLimit = await env.AUTH_LIMIT.limit({ key: ipK })
  if (!ipLimit.success) return json({ error: 'rate_limited' }, 429)

  let body: LoginBody
  try {
    body = await readJson<LoginBody>(request, BODY_LIMIT)
  } catch (e) {
    if (e instanceof HttpError) return error(e.code)
    throw e
  }

  const username = normalizeUsername(body.username)
  const passwordOk = typeof body.password === 'string' && body.password.length <= RAW_LIMITS.password
  const nfc = passwordOk ? (body.password as string).normalize('NFC') : null

  // Malformed input still pays for one hash, so it is not faster than a real attempt.
  if (!username.ok || nfc === null) {
    await verifyPassword(nfc ?? '', env.PASSWORD_PEPPER, DUMMY_CREDENTIAL)
    return invalidCredentials()
  }
  const name = username.value

  const subLimit = await env.AUTH_SUB_LIMIT.limit({ key: `pw:${name}:${ipK}` })
  if (!subLimit.success) return json({ error: 'rate_limited' }, 429)

  const row = await env.DB
    .prepare(
      'SELECT ui.user_id, u.banned, pc.hash, pc.salt, pc.iterations, pc.must_change, pc.temp_expires_at,' +
        ' pc.failed_count, pc.locked_until, pc.updated_at' +
        ' FROM user_identity ui' +
        ' JOIN app_user u ON u.id = ui.user_id' +
        ' JOIN password_credential pc ON pc.user_id = ui.user_id' +
        " WHERE ui.provider = 'password' AND ui.subject = ?",
    )
    .bind(name)
    .first<CredentialRow>()

  if (!row) {
    await verifyPassword(nfc, env.PASSWORD_PEPPER, DUMMY_CREDENTIAL)
    return invalidCredentials()
  }

  // Locked: spend the same hash and discard the result, so a lock is not visible in timing.
  if (row.locked_until !== null && row.locked_until > nowIso) {
    await verifyPassword(nfc, env.PASSWORD_PEPPER, row)
    return invalidCredentials()
  }

  const matches = await verifyPassword(nfc, env.PASSWORD_PEPPER, row)
  const tempExpired = row.must_change === 1 && row.temp_expires_at !== null && row.temp_expires_at < nowIso

  if (!matches || tempExpired) {
    await recordFailure(env.DB, row.user_id, now)
    return invalidCredentials()
  }

  // Success: reset the counter, upgrade the hash when the configured count is higher.
  if (row.iterations < PBKDF2_ITERATIONS) {
    const upgraded = await hashPassword(nfc, env.PASSWORD_PEPPER)
    await env.DB.prepare(
      'UPDATE password_credential SET hash = ?, salt = ?, iterations = ?, failed_count = 0, locked_until = NULL, updated_at = ?' +
        ' WHERE user_id = ?',
    )
      .bind(upgraded.hash, upgraded.salt, upgraded.iterations, nowIso, row.user_id)
      .run()
  } else {
    await env.DB.prepare('UPDATE password_credential SET failed_count = 0, locked_until = NULL WHERE user_id = ?')
      .bind(row.user_id)
      .run()
  }
  await env.DB.prepare("UPDATE user_identity SET last_used_at = ? WHERE provider = 'password' AND subject = ?")
    .bind(nowIso, name)
    .run()

  // Session fixation: drop the presented session before issuing a new one.
  await revokeSession(request, env.DB)
  const { cookie } = await createSession(env.DB, row.user_id)

  const me = await meFor(env.DB, row.user_id, name)
  return withCookie(json({ user: me }), cookie)
}

// ── Change password ───────────────────────────────────────────────────────────

/**
 * POST /api/me/password { current, next } (FR-35, AC-23, AC-35). Verifies the current password,
 * stores the new one, revokes every session of the user and issues a fresh one for this request,
 * so the other devices sign in again and the old token stops working.
 */
export async function handleChangePassword(request: Request, env: AccountsEnv, deps: AccountsDeps = {}): Promise<Response> {
  const now = deps.now?.() ?? new Date()
  if (!env.PASSWORD_PEPPER) {
    console.error('accounts: misconfigured')
    return json({ error: 'misconfigured' }, 503)
  }
  if (request.method !== 'POST') return error('method')
  if (!csrfOk(request)) return error('forbidden')

  const session = await readSession(request, env.DB)
  if (!session) return error('unauthorized')

  let body: { current?: unknown; next?: unknown }
  try {
    body = await readJson<{ current?: unknown; next?: unknown }>(request, BODY_LIMIT)
  } catch (e) {
    if (e instanceof HttpError) return error(e.code)
    throw e
  }

  const verified = await verifyOwnPassword(env, session.userId, body.current, now)
  if (verified === 'misconfigured') return json({ error: 'misconfigured' }, 503)
  if (!verified) return invalidCredentials()

  const subject = await env.DB
    .prepare("SELECT subject FROM user_identity WHERE user_id = ? AND provider = 'password'")
    .bind(session.userId)
    .first<{ subject: string }>()
  const next = checkPassword(body.next, subject?.subject ?? '', (s) => COMMON_PASSWORDS.has(s))
  if (!next.ok) return json({ error: next.code }, 400)

  const cred = await hashPassword(next.value, env.PASSWORD_PEPPER)
  const nowIso = now.toISOString()
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE password_credential SET hash = ?, salt = ?, iterations = ?, must_change = 0,' +
        ' temp_expires_at = NULL, failed_count = 0, locked_until = NULL, updated_at = ? WHERE user_id = ?',
    ).bind(cred.hash, cred.salt, cred.iterations, nowIso, session.userId),
    env.DB.prepare('DELETE FROM session WHERE user_id = ?').bind(session.userId),
  ])
  const { cookie } = await createSession(env.DB, session.userId)
  const me = await meFor(env.DB, session.userId, subject?.subject ?? null)
  return withCookie(json({ user: me }), cookie)
}

// ── Router ────────────────────────────────────────────────────────────────────

export async function handleAccounts(request: Request, env: AccountsEnv, deps: AccountsDeps = {}): Promise<Response> {
  const { pathname } = new URL(request.url)
  if (pathname !== '/api/auth/register' && pathname !== '/api/auth/login') return error('not_found')
  if (request.method !== 'POST') return error('method')
  return pathname === '/api/auth/register'
    ? handleRegister(request, env, deps)
    : handleLogin(request, env, deps)
}
