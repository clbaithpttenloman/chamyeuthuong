/**
 * worker/session.ts — HTTP-only session management for Google sign-in users.
 *
 * Sessions use an opaque 32-byte random token stored in a __Host-cyt_s cookie.
 * D1 stores only SHA-256(token), not the raw token (no fixation on DB breach).
 * Max 10 sessions per user; oldest deleted when inserting the 11th.
 * Expired sessions are purged on every createSession call.
 *
 * Nonces are HMAC(NONCE_KEY, rand.expiry) to protect the Google sign-in flow
 * from replay and CSRF attacks.
 */
import type { D1 } from './types.ts'

/** Cookie name for the session token. __Host- prefix enforces Secure + Path=/. */
export const SESSION_COOKIE = '__Host-cyt_s'

/** Cookie name for the sign-in nonce. */
export const NONCE_COOKIE = '__Host-cyt_n'

const SESSION_MAX_AGE = 14 * 24 * 60 * 60  // 1 209 600 s = 14 days
const NONCE_MAX_AGE = 300                    // 5 min

// ── Cookie builders ───────────────────────────────────────────────────────────

function cookieFlags(maxAge: number): string {
  return `; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
}

/** Build a Set-Cookie header value for a live session token (14-day expiry). */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}${cookieFlags(SESSION_MAX_AGE)}`
}

/** Build a Set-Cookie header value that expires any named cookie immediately. */
export function clearCookie(name: string): string {
  return `${name}=${cookieFlags(0)}`
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

/** Compute SHA-256 hex hash. Used to store the session token hash. */
async function sha256Hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Compute HMAC-SHA256 hex over a message using a string key. */
export async function hmacSha256Hex(keyStr: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Timing-safe comparison of two equal-length hex strings. */
function safeHexEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ── Cookie parsing ────────────────────────────────────────────────────────────

/** Extract one named cookie from a request's Cookie header, or null if absent. */
export function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

// ── Session CRUD ──────────────────────────────────────────────────────────────

/**
 * Create a new session for userId.
 *
 * Steps (in one D1 batch / transaction):
 *   1. Purge expired sessions for this user.
 *   2. Delete the oldest session if count ≥ 10, so inserting stays at max 10.
 *   3. Insert the new session (hash only).
 *
 * Returns { token, cookie } where token is the raw (unhashed) base64url value
 * and cookie is the ready-to-use Set-Cookie header string.
 */
export async function createSession(
  db: D1,
  userId: number,
): Promise<{ token: string; cookie: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

  const hash = await sha256Hex(token)
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString()

  await db.batch([
    // 1. Purge expired sessions
    db.prepare('DELETE FROM session WHERE user_id = ? AND expires_at < ?').bind(userId, now),
    // 2. Drop oldest if already at cap (keeps exactly 9, insert brings to 10)
    db.prepare(
      'DELETE FROM session WHERE token_hash = (' +
      '  SELECT token_hash FROM session WHERE user_id = ? ORDER BY created_at ASC LIMIT 1' +
      ') AND (' +
      '  SELECT COUNT(*) FROM session WHERE user_id = ?' +
      ') >= 10',
    ).bind(userId, userId),
    // 3. Insert new session
    db.prepare(
      'INSERT INTO session (token_hash, user_id, expires_at, created_at, ip_hash)' +
      ' VALUES (?, ?, ?, ?, ?)',
    ).bind(hash, userId, expires, now, ''),
  ])

  return { token, cookie: sessionCookie(token) }
}

/**
 * Read the session from the request's session cookie.
 * Returns { userId } if the session is valid and not expired, otherwise null.
 */
export async function readSession(
  request: Request,
  db: D1,
): Promise<{ userId: number } | null> {
  const token = getCookieValue(request, SESSION_COOKIE)
  if (!token) return null

  const hash = await sha256Hex(token)
  const now = new Date().toISOString()
  const row = await db
    .prepare('SELECT user_id FROM session WHERE token_hash = ? AND expires_at > ?')
    .bind(hash, now)
    .first<{ user_id: number }>()

  return row ? { userId: row.user_id } : null
}

/**
 * Revoke the session presented in the request's session cookie.
 * No-op if the cookie is absent or the session is not found.
 */
export async function revokeSession(request: Request, db: D1): Promise<void> {
  const token = getCookieValue(request, SESSION_COOKIE)
  if (!token) return

  const hash = await sha256Hex(token)
  await db.prepare('DELETE FROM session WHERE token_hash = ?').bind(hash).run()
}

// ── Nonce ─────────────────────────────────────────────────────────────────────

/**
 * Issue a one-time nonce for the Google sign-in flow.
 *
 * Format: `<rand16hex>.<expiryEpoch>.<hmac-sha256-hex>`
 * The HMAC is over `<rand16hex>.<expiryEpoch>` keyed by NONCE_KEY.
 *
 * Returns { nonce, cookie } where cookie is the ready-to-use Set-Cookie string.
 */
export async function issueNonce(
  env: { NONCE_KEY: string | undefined },
  now: Date = new Date(),
): Promise<{ nonce: string; cookie: string }> {
  // Optional #10: guard against missing NONCE_KEY (misconfiguration).
  if (!env.NONCE_KEY) {
    console.error('auth: misconfigured')
    throw new Error('NONCE_KEY not configured')
  }
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const expEpoch = Math.floor(now.getTime() / 1000) + NONCE_MAX_AGE
  const rawPayload = `${rand}.${expEpoch}`
  const sig = await hmacSha256Hex(env.NONCE_KEY, rawPayload)

  const nonce = `${rawPayload}.${sig}`
  const cookie = `${NONCE_COOKIE}=${nonce}${cookieFlags(NONCE_MAX_AGE)}`
  return { nonce, cookie }
}

/**
 * Verify a nonce: cookie value must equal the claim, HMAC must be valid, and
 * the nonce must not be expired.
 *
 * Returns true only if all checks pass.
 */
export async function checkNonce(
  env: { NONCE_KEY: string },
  cookieValue: string,
  claimNonce: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!cookieValue || !claimNonce) return false
  if (cookieValue !== claimNonce) return false

  const parts = cookieValue.split('.')
  if (parts.length !== 3) return false
  const [rand, expStr, storedSig] = parts as [string, string, string]

  // Check expiry
  const expEpoch = parseInt(expStr, 10)
  if (!Number.isFinite(expEpoch)) return false
  if (Math.floor(now.getTime() / 1000) > expEpoch) return false

  // Verify HMAC
  const rawPayload = `${rand}.${expStr}`
  const expectedSig = await hmacSha256Hex(env.NONCE_KEY, rawPayload)
  return safeHexEq(storedSig, expectedSig)
}
