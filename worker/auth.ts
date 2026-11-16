import { jwtVerify, createRemoteJWKSet, decodeProtectedHeader } from 'jose'
import type { JWTVerifyGetKey, RemoteJWKSet } from 'jose'
import { error } from './http.ts'
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
  issuer: string
  certsUrl: URL
  aud: string
}

/**
 * Validates all required env fields for Access JWT auth.
 * Returns a config object on success, or null and logs `admin: misconfigured` on failure.
 * Never logs env values — fixed strings only.
 */
function parseConfig(
  env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'ACCESS_DEV_MODE'>,
): ValidatedConfig | null {
  const rawDomain = env.ACCESS_TEAM_DOMAIN ?? ''
  const aud = env.ACCESS_AUD ?? ''
  const devMode = env.ACCESS_DEV_MODE === '1'

  // Single failure path: log fixed string and return null.
  function fail(): null {
    console.error('admin: misconfigured')
    return null
  }

  // Both required strings must be non-empty before URL parsing.
  if (!rawDomain || !aud) return fail()

  // No trailing slash in configured string — iss must equal url.origin exactly.
  if (rawDomain.endsWith('/')) return fail()

  let url: URL
  try {
    url = new URL(rawDomain)
  } catch {
    return fail()
  }

  // No username or password in the URL.
  if (url.username || url.password) return fail()

  // Pathname must be exactly '/'.
  if (url.pathname !== '/') return fail()

  if (devMode) {
    // Dev mode (ACCESS_DEV_MODE === '1'): only http://127.0.0.1:<port> is allowed.
    // The hostname must be exactly '127.0.0.1' — prevents http://127.0.0.1.evil.com bypass.
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return fail()
  } else {
    // Production: must be https://<subdomain>.cloudflareaccess.com.
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.cloudflareaccess.com')) return fail()
  }

  const issuer = url.origin
  const certsUrl = new URL('/cdn-cgi/access/certs', issuer)

  return { issuer, certsUrl, aud }
}

/**
 * Guards every /api/admin/* request using a Cloudflare Access JWT + DB admin table.
 *
 * Returns `{ email }` when the request may proceed, or a Response on any failure.
 * Order: (1) rate limit → (2) config → (3) JWT header → (4) alg/kid pre-check →
 *        (5) jwtVerify → (6) email claim shape (≤254) → (7) CSRF → (8) DB.
 *
 * deps.keys: inject a local JWKS resolver in tests (avoids network calls).
 * Production: builds RemoteJWKSet once per team domain and reuses it.
 */
export async function requireAdmin(
  request: Request,
  env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'ACCESS_DEV_MODE' | 'ADMIN_FAIL_LIMIT' | 'DB' | 'BOOTSTRAP_EMAIL' | 'ALLOW_FIRST_CLAIM'>,
  deps?: { keys: JWTVerifyGetKey },
): Promise<{ email: string } | Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  // 1. Rate limit — always checked first; prevents JWT work on flooded IPs.
  const { success } = await env.ADMIN_FAIL_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  // 2. Config validation — fail closed if anything is missing or malformed.
  const config = parseConfig(env)
  if (!config) return error('unauthorized')

  // 3. JWT header must be present.
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return error('unauthorized')

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

  // 5. Full JWT verification: signature, issuer, audience, exp, iat.
  const rawKeys: JWTVerifyGetKey = deps?.keys ?? getRemoteJwks(config.certsUrl)
  // Wrap the key resolver to distinguish JWKS-fetch failures from JWT-claim failures.
  let keyFetchFailed = false
  const keyResolver: JWTVerifyGetKey = async (header, input) => {
    try {
      return await rawKeys(header, input)
    } catch (e) {
      keyFetchFailed = true
      throw e
    }
  }
  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(token, keyResolver, {
      algorithms: ['RS256'],
      issuer: config.issuer,
      audience: config.aud,
      requiredClaims: ['exp', 'iat'],
      clockTolerance: 30,
    })
    payload = result.payload as Record<string, unknown>
  } catch {
    // Log only a fixed string — never jose error messages (may contain JWT fragments).
    if (keyFetchFailed) console.error('admin: jwks_error')
    return error('unauthorized')
  }

  // 6. Email claim shape: must be a string, trimmed+lowercased, length ≤ 254 (before DB).
  const rawEmail = payload['email']
  if (typeof rawEmail !== 'string') return error('unauthorized')
  const email = rawEmail.trim().toLowerCase()
  if (email.length === 0 || email.length > 254) return error('unauthorized')

  // 7. CSRF checks (after successful JWT auth):
  //    - Sec-Fetch-Site: cross-site → 403 for every method.
  //    - Non-GET without X-Requested-With: fetch → 403.
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return error('forbidden')
  if (request.method !== 'GET' && request.headers.get('X-Requested-With') !== 'fetch') {
    return error('forbidden')
  }

  // 8. DB lookup: single query checks caller membership AND whether the table has any admins.
  //    This avoids a second round-trip and keeps bootstrap-path prepares at exactly 1 SELECT + 1 INSERT.
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

  // Gate evaluation (W5): BOOTSTRAP_EMAIL present (even empty string) takes precedence
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
