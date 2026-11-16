import { jwtVerify, createRemoteJWKSet, decodeProtectedHeader, errors } from 'jose'
import type { JWTVerifyGetKey, RemoteJWKSet } from 'jose'
import { error } from './http.ts'
import { ensureSchema } from './schema.ts'
import type { Env } from './types.ts'

// Module-level cache: one RemoteJWKSet per JWKS URL, reused across requests within the isolate.
// SHORTCUT: in-memory Map — if the Worker is ever split across isolates, each has its own cache.
const _remoteJwksCache = new Map<string, RemoteJWKSet>()

function getRemoteJwks(certsUrl: URL): RemoteJWKSet {
  const key = certsUrl.href
  let resolver = _remoteJwksCache.get(key)
  if (!resolver) {
    resolver = createRemoteJWKSet(certsUrl, {
      cooldownDuration: 30_000,   // ms between re-fetch attempts on unknown kid
      timeoutDuration: 3_000,     // ms HTTP timeout per fetch
      cacheMaxAge: 600_000,       // ms max lifetime of cached keys (10 min)
    })
    _remoteJwksCache.set(key, resolver)
  }
  return resolver
}

type ValidatedConfig = {
  clientId: string
  certsUrl: URL
}

/**
 * Validates GOOGLE_CLIENT_ID and, in dev mode, AUTH_DEV_JWKS_URL.
 * Returns config on success, or null and logs `admin: misconfigured` on failure.
 * Never logs env values — fixed strings only.
 */
function parseConfig(
  env: Pick<Env, 'GOOGLE_CLIENT_ID' | 'AUTH_DEV_MODE' | 'AUTH_DEV_JWKS_URL'>,
): ValidatedConfig | null {
  function fail(): null {
    console.error('admin: misconfigured')
    return null
  }

  const clientId = env.GOOGLE_CLIENT_ID ?? ''
  if (!clientId || !clientId.endsWith('.apps.googleusercontent.com')) return fail()

  if (env.AUTH_DEV_MODE === '1') {
    // Dev mode: AUTH_DEV_JWKS_URL must be present and be http://127.0.0.1:<port>/<path>.
    // Any other value (missing, non-loopback, https) → fail closed, never fall back to Google keys.
    const rawUrl = env.AUTH_DEV_JWKS_URL ?? ''
    if (!rawUrl) return fail()
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return fail()
    }
    if (url.protocol !== 'http:') return fail()
    // Hostname must be exactly '127.0.0.1' — prevents http://127.0.0.1.evil.com bypass.
    if (url.hostname !== '127.0.0.1') return fail()
    if (url.username || url.password) return fail()
    return { clientId, certsUrl: url }
  }

  // Production: use Google's public JWKS endpoint.
  return { clientId, certsUrl: new URL('https://www.googleapis.com/oauth2/v3/certs') }
}

/** ASCII email pattern (after lower-case + trim). */
const EMAIL_ASCII_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+$/

/**
 * Guards every /api/admin/* request using a Google ID token + DB admin table.
 *
 * Returns `{ email }` when the request may proceed, or a Response on any failure.
 * Order: (1) rate limit → (2) config → (3) Bearer token (4 KB cap) → (4) alg/kid pre-check →
 *        (5) jwtVerify → (6) email_verified + email rules → (7) CSRF → (8) DB.
 *
 * deps.keys: inject a local JWKS resolver in tests (avoids network calls).
 * Production: builds RemoteJWKSet once per certsUrl and reuses it.
 */
export async function requireAdmin(
  request: Request,
  env: Pick<Env, 'GOOGLE_CLIENT_ID' | 'AUTH_DEV_MODE' | 'AUTH_DEV_JWKS_URL' | 'ADMIN_FAIL_LIMIT' | 'DB' | 'BOOTSTRAP_EMAIL' | 'ALLOW_FIRST_CLAIM'>,
  deps?: { keys: JWTVerifyGetKey },
): Promise<{ email: string } | Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  // 1. Rate limit — always checked first; prevents JWT work on flooded IPs.
  const { success } = await env.ADMIN_FAIL_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  // 2. Config validation — fail closed if anything is missing or malformed.
  const config = parseConfig(env)
  if (!config) return error('unauthorized')

  // 3. Authorization: Bearer <token> — 4 KB cap before any decoding.
  const authHeader = request.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) return error('unauthorized')
  const token = authHeader.slice(7) // skip 'Bearer '
  if (!token || token.length > 4096) return error('unauthorized')

  // 4. Pre-check protected header: alg must be 'RS256' and kid must be a string.
  //    Rejects alg:none, HS256, and tokens without a kid before any JWKS fetch.
  let protectedHeader: ReturnType<typeof decodeProtectedHeader>
  try {
    protectedHeader = decodeProtectedHeader(token)
  } catch {
    return error('unauthorized')
  }
  if (protectedHeader.alg !== 'RS256' || typeof protectedHeader.kid !== 'string') {
    return error('unauthorized')
  }

  // 5. Full JWT verification: signature, issuer array, audience, exp, iat, maxTokenAge.
  const rawKeys: JWTVerifyGetKey = deps?.keys ?? getRemoteJwks(config.certsUrl)

  // Wrap the key resolver to distinguish JWKS-fetch failures from JWKSNoMatchingKey.
  // JWKSNoMatchingKey is a token issue (unknown kid), not a JWKS fetch failure — do not log it.
  let keyFetchFailed = false
  const keyResolver: JWTVerifyGetKey = async (header, input) => {
    try {
      return await rawKeys(header, input)
    } catch (e) {
      if (!(e instanceof errors.JWKSNoMatchingKey)) {
        keyFetchFailed = true
      }
      throw e
    }
  }

  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(token, keyResolver, {
      algorithms: ['RS256'],
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: config.clientId,
      requiredClaims: ['exp', 'iat'],
      clockTolerance: 30,
      maxTokenAge: '1h',
    })
    payload = result.payload as Record<string, unknown>
  } catch {
    // Log only a fixed string — never jose error messages (may contain JWT fragments).
    if (keyFetchFailed) console.error('admin: jwks_error')
    return error('unauthorized')
  }

  // 6. Email rules — Google must be authoritative for the address.

  // 6a. email_verified must be boolean true (not the string "true", not missing, not false).
  if (payload['email_verified'] !== true) return error('unauthorized')

  // 6b. email claim must be a non-empty string.
  const rawEmail = payload['email']
  if (typeof rawEmail !== 'string') return error('unauthorized')
  const email = rawEmail.trim().toLowerCase()

  // 6c. Length ≤ 254 (before DB).
  if (email.length === 0 || email.length > 254) return error('unauthorized')

  // 6d. ASCII pattern only — rejects IDN, encoded chars, non-ASCII.
  if (!EMAIL_ASCII_RE.test(email)) return error('unauthorized')

  // 6e. Google is authoritative only for @gmail.com (exact suffix) or for Workspace (hd set
  //     and email domain equals hd). googlemail.com is explicitly rejected regardless of hd.
  const atIdx = email.lastIndexOf('@')
  const domain = email.slice(atIdx + 1)
  if (domain === 'googlemail.com') return error('unauthorized')

  const isGmail = domain === 'gmail.com'
  const hd = payload['hd']
  const isWorkspace = typeof hd === 'string' && hd.length > 0 && domain === hd.toLowerCase()
  if (!isGmail && !isWorkspace) return error('unauthorized')

  // 7. CSRF checks (after successful JWT auth):
  //    - Sec-Fetch-Site: cross-site → 403 for every method.
  //    - Non-GET without X-Requested-With: fetch → 403.
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return error('forbidden')
  if (request.method !== 'GET' && request.headers.get('X-Requested-With') !== 'fetch') {
    return error('forbidden')
  }

  // 8. DB lookup: single query checks caller membership AND whether the table has any admins.
  //    This avoids a second round-trip and keeps bootstrap-path prepares at exactly 1 SELECT + 1 INSERT.
  await ensureSchema(env.DB)
  const check = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM admin WHERE email = ?) AS is_caller,' +
    ' (SELECT COUNT(*) FROM admin) AS total_admins',
  ).bind(email).first<{ is_caller: number; total_admins: number }>()

  if ((check?.is_caller ?? 0) > 0) return { email }

  // Caller is not an admin. If the table already has admins (just not this caller), deny silently.
  if ((check?.total_admins ?? 0) > 0) return error('unauthorized')

  // ---- Bootstrap path: table is empty ----

  // Bootstrap write requires X-Requested-With: fetch on every method (including GET).
  // Standard CSRF (above) only guards non-GET; this guard covers GET specifically for bootstrap.
  if (request.headers.get('X-Requested-With') !== 'fetch') return error('forbidden')

  // Gate evaluation: BOOTSTRAP_EMAIL present (even empty string) takes precedence
  // over ALLOW_FIRST_CLAIM. Only if BOOTSTRAP_EMAIL is undefined does ALLOW_FIRST_CLAIM apply.
  const rawBootstrapEmail = env.BOOTSTRAP_EMAIL
  if (rawBootstrapEmail !== undefined) {
    // BOOTSTRAP_EMAIL is set; normalise and compare. Empty or mismatch → 401.
    const bootstrapEmail = rawBootstrapEmail.trim().toLowerCase()
    if (!bootstrapEmail || bootstrapEmail !== email) return error('unauthorized')
    // Match: proceed to INSERT.
  } else if (env.ALLOW_FIRST_CLAIM !== '1') {
    // Neither BOOTSTRAP_EMAIL nor ALLOW_FIRST_CLAIM configured for empty table.
    console.error('admin: misconfigured')
    return error('unauthorized')
  }
  // else: BOOTSTRAP_EMAIL undefined AND ALLOW_FIRST_CLAIM === '1' → open claim, proceed.

  // Bootstrap INSERT: exactly one prepare() call, atomic WHERE NOT EXISTS.
  // If two simultaneous first requests arrive, only one INSERT wins (D1/SQLite serialises writes).
  const now = new Date().toISOString()
  const result = await env.DB
    .prepare(
      "INSERT INTO admin (email, created_at, created_by) SELECT ?, ?, 'bootstrap' WHERE NOT EXISTS (SELECT 1 FROM admin)",
    )
    .bind(email, now)
    .run()

  if (result.meta.changes === 1) {
    // This caller inserted the first admin row.
    console.error('admin: bootstrap')
    return { email }
  }

  // changes === 0: someone else won the race (admin table is now non-empty).
  // Re-SELECT to check if the winner used this same email (same user, two parallel requests).
  const reCheck = await env.DB.prepare('SELECT 1 FROM admin WHERE email = ?').bind(email).first()
  if (reCheck) return { email }

  // A different user won the first-admin slot; this caller is not an admin.
  return error('unauthorized')
}
