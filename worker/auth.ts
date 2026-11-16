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
  allowedEmails: Set<string>
  aud: string
}

/**
 * Validates all required env fields for Access JWT auth.
 * Returns a config object on success, or null and logs `admin: misconfigured` on failure.
 * Never logs env values — fixed strings only.
 */
function parseConfig(
  env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'ADMIN_EMAILS' | 'ACCESS_DEV_MODE'>,
): ValidatedConfig | null {
  const rawDomain = env.ACCESS_TEAM_DOMAIN ?? ''
  const aud = env.ACCESS_AUD ?? ''
  const rawEmails = env.ADMIN_EMAILS ?? ''
  const devMode = env.ACCESS_DEV_MODE === '1'

  // Single failure path: log fixed string and return null.
  function fail(): null {
    console.error('admin: misconfigured')
    return null
  }

  // All three required strings must be non-empty before URL parsing.
  if (!rawDomain || !aud || !rawEmails) return fail()

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

  // Parse and validate ADMIN_EMAILS: split by comma, trim, lowercase, drop empty entries.
  const allowedEmails = new Set(
    rawEmails.split(',').map(e => e.trim().toLowerCase()).filter(e => e.length > 0),
  )
  if (allowedEmails.size === 0) return fail()

  // Issuer must equal the URL origin (plan Amendment W1).
  const issuer = url.origin
  const certsUrl = new URL('/cdn-cgi/access/certs', issuer)

  return { issuer, certsUrl, allowedEmails, aud }
}

/**
 * Guards every /api/admin/* request using a Cloudflare Access JWT.
 *
 * Returns `undefined` when the request may proceed, or a Response on any failure.
 * Order: (1) rate limit → (2) config → (3) JWT header → (4) alg/kid pre-check →
 *        (5) jwtVerify → (6) email → (7) CSRF.
 *
 * deps.keys: inject a local JWKS resolver in tests (avoids network calls).
 * Production: builds RemoteJWKSet once per team domain and reuses it.
 */
export async function requireAdmin(
  request: Request,
  env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'ADMIN_EMAILS' | 'ACCESS_DEV_MODE' | 'ADMIN_FAIL_LIMIT'>,
  deps?: { keys: JWTVerifyGetKey },
): Promise<Response | undefined> {
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

  // 6. Email claim: must be a present string in the allow-list.
  const rawEmail = payload['email']
  if (typeof rawEmail !== 'string') return error('unauthorized')
  const email = rawEmail.trim().toLowerCase()
  if (!config.allowedEmails.has(email)) return error('unauthorized')

  // 7. CSRF checks (after successful JWT auth):
  //    - Sec-Fetch-Site: cross-site → 403 for every method (browser cannot add this cross-site
  //      without a preflight that the Worker never answers).
  //    - Non-GET without X-Requested-With: fetch → 403 (plan Amendment W5).
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return error('forbidden')
  if (request.method !== 'GET' && request.headers.get('X-Requested-With') !== 'fetch') {
    return error('forbidden')
  }

  return undefined
}
