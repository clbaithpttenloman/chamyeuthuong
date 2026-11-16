// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SignJWT } from 'jose'
import type { JWTVerifyGetKey } from 'jose'
import { requireAdmin } from './auth.ts'
import {
  signJwt, validJwt, localJwks, twoKeyJwks, accessEnv,
  TEST_TEAM_DOMAIN, TEST_AUD, TEST_EMAIL,
} from './testAccess.ts'

// ---- Request builder ----

/**
 * Build a Request for /api/admin/teachers.
 * @param jwt   JWT string to put in Cf-Access-Jwt-Assertion, or null for no header.
 * @param opts  method (default GET), noXrw (suppress auto X-Requested-With on non-GET),
 *              secFetchSite, ip.
 */
function makeReq(
  jwt: string | null,
  opts: { method?: string; noXrw?: boolean; secFetchSite?: string; ip?: string } = {},
): Request {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = { 'CF-Connecting-IP': opts.ip ?? '1.2.3.4' }
  if (jwt !== null) headers['Cf-Access-Jwt-Assertion'] = jwt
  // Add X-Requested-With for non-GET unless caller opts out (CSRF tests do this)
  if (method !== 'GET' && !opts.noXrw) headers['X-Requested-With'] = 'fetch'
  if (opts.secFetchSite) headers['Sec-Fetch-Site'] = opts.secFetchSite
  return new Request('https://x/api/admin/teachers', { method, headers })
}

// ---- Helper: strip kid from a valid JWT header (for no-kid test) ----

async function noKidJwt(): Promise<string> {
  const full = await validJwt()
  const parts = full.split('.')
  const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf-8')) as Record<string, unknown>
  delete header['kid']
  const newHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
  // Signature is now invalid (header bytes changed), but decodeProtectedHeader runs before JWKS lookup
  return `${newHeader}.${parts[1]}.${parts[2]}`
}

// ---- Happy path ----

describe('requireAdmin — valid JWT', () => {
  it('passes (returns undefined) when JWT is valid and email is allowed', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r).toBeUndefined()
  })

  it('email matching is case-insensitive', async () => {
    const jwt = await validJwt({ email: TEST_EMAIL.toUpperCase() })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r).toBeUndefined()
  })

  it('email is trimmed before comparison', async () => {
    const jwt = await validJwt({ email: '  ' + TEST_EMAIL + '  ' })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r).toBeUndefined()
  })

  it('aud claim as an array containing TEST_AUD → passes', async () => {
    const jwt = await validJwt({ aud: [TEST_AUD, 'other-aud'] })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r).toBeUndefined()
  })
})

// ---- JWT rejection cases ----

describe('requireAdmin — JWT rejection', () => {
  it('no Cf-Access-Jwt-Assertion header → 401', async () => {
    const r = await requireAdmin(makeReq(null), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(401)
  })

  it('garbage (non-JWT) string in header → 401', async () => {
    const r = await requireAdmin(makeReq('not.a.jwt.string'), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(401)
  })

  it('wrong signature (k2 private key signed with k1 kid) → 401', async () => {
    // JWT signed with k2 private key but header claims kid k1 → k1 key found, sig mismatch
    const jwt = await validJwt({}, { useK2: true, kid: 'k1' })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(401)
  })

  it('wrong issuer → 401', async () => {
    const jwt = await validJwt({ iss: 'https://evil.cloudflareaccess.com' })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(401)
  })

  it('wrong audience → 401', async () => {
    const jwt = await validJwt({ aud: 'wrong-aud-value' })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(401)
  })

  it('aud array NOT containing TEST_AUD → 401', async () => {
    const jwt = await validJwt({ aud: ['other-aud-1', 'other-aud-2'] })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(401)
  })

  it('expired token (exp in the past) → 401', async () => {
    const now = Math.floor(Date.now() / 1000)
    const jwt = await signJwt({
      iss: TEST_TEAM_DOMAIN,
      aud: TEST_AUD,
      email: TEST_EMAIL,
      iat: now - 7200,
      exp: now - 3600,
    })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(401)
  })

  it('missing exp claim → 401 (requiredClaims enforcement)', async () => {
    const jwt = await validJwt({}, { noExp: true })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(401)
  })

  it('missing iat claim → 401 (requiredClaims enforcement)', async () => {
    const jwt = await validJwt({}, { noIat: true })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(401)
  })

  it('email not in ADMIN_EMAILS list → 401', async () => {
    const jwt = await validJwt({ email: 'stranger@example.com' })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(401)
  })

  it('missing email claim → 401', async () => {
    const jwt = await signJwt({ iss: TEST_TEAM_DOMAIN, aud: TEST_AUD })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(401)
  })

  it('email is not a string (number) → 401', async () => {
    const jwt = await validJwt({ email: 123 })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(401)
  })
})

// ---- alg: none and HS256 — decodeProtectedHeader check (W3) ----

describe('requireAdmin — alg checks (before key resolver)', () => {
  it('alg:none token does not call the key resolver and returns 401', async () => {
    // Manually construct an alg:none JWT (jose does not support signing with none)
    const hdr = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const pay = Buffer.from(
      JSON.stringify({ iss: TEST_TEAM_DOMAIN, aud: TEST_AUD, email: TEST_EMAIL, exp: 9999999999, iat: 1 }),
    ).toString('base64url')
    const algNoneJwt = `${hdr}.${pay}.`

    const spy = vi.fn()
    const r = await requireAdmin(makeReq(algNoneJwt), accessEnv(), { keys: spy })
    expect(r?.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('HS256 token does not call the key resolver → 401', async () => {
    const hs256Token = await new SignJWT({ iss: TEST_TEAM_DOMAIN, aud: TEST_AUD, email: TEST_EMAIL })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('some-hs-secret'))

    const spy = vi.fn()
    const r = await requireAdmin(makeReq(hs256Token), accessEnv(), { keys: spy })
    expect(r?.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('RS256 token with no kid in header → 401 without calling key resolver', async () => {
    // Strip the kid field from the JWT header (signature becomes invalid but check is pre-JWKS)
    const tampered = await noKidJwt()
    const spy = vi.fn()
    const r = await requireAdmin(makeReq(tampered), accessEnv(), { keys: spy })
    expect(r?.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('two keys in JWKS — k2-signed JWT is verified using the k2 key (kid selection)', async () => {
    const twoKeys = await twoKeyJwks()
    // JWT signed with k2 private key, kid: k2 → twoKeyJwks selects k2 → passes
    const jwtK2 = await validJwt({}, { useK2: true })
    const r = await requireAdmin(makeReq(jwtK2), accessEnv(), { keys: twoKeys })
    expect(r).toBeUndefined()
  })

  it('two keys in JWKS — k1-signed JWT is verified using the k1 key (kid selection)', async () => {
    const twoKeys = await twoKeyJwks()
    const jwtK1 = await validJwt()
    const r = await requireAdmin(makeReq(jwtK1), accessEnv(), { keys: twoKeys })
    expect(r).toBeUndefined()
  })
})

// ---- Misconfiguration ----

describe('requireAdmin — misconfiguration → 401 + console.error', () => {
  afterEach(() => vi.restoreAllMocks())

  it('empty ACCESS_AUD → 401 and logs admin: misconfigured exactly once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), accessEnv({ aud: '' }), { keys: await localJwks() })
    expect(r?.status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('empty ADMIN_EMAILS → 401 and logs admin: misconfigured exactly once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), accessEnv({ adminEmails: '' }), { keys: await localJwks() })
    expect(r?.status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('empty ACCESS_TEAM_DOMAIN → 401 and logs admin: misconfigured exactly once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), accessEnv({ teamDomain: '' }), { keys: await localJwks() })
    expect(r?.status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('non-https ACCESS_TEAM_DOMAIN (without dev mode) → 401 misconfigured exactly once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ teamDomain: 'http://test.cloudflareaccess.com' }),
      { keys: await localJwks() },
    )
    expect(r?.status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('ACCESS_TEAM_DOMAIN without .cloudflareaccess.com suffix → 401 misconfigured exactly once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt({ iss: 'https://evil.com' })
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ teamDomain: 'https://evil.com' }),
      { keys: await localJwks() },
    )
    expect(r?.status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('ADMIN_EMAILS with only empty entries (all commas/spaces) → 401 misconfigured exactly once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), accessEnv({ adminEmails: ' , , ' }), { keys: await localJwks() })
    expect(r?.status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('ACCESS_TEAM_DOMAIN with trailing slash → 401 misconfigured exactly once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ teamDomain: 'https://test.cloudflareaccess.com/' }),
      { keys: await localJwks() },
    )
    expect(r?.status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('ACCESS_TEAM_DOMAIN with userinfo (user:pass) → 401 misconfigured exactly once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ teamDomain: 'https://user:pass@test.cloudflareaccess.com' }),
      { keys: await localJwks() },
    )
    expect(r?.status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('ACCESS_TEAM_DOMAIN with non-root pathname → 401 misconfigured exactly once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ teamDomain: 'https://test.cloudflareaccess.com/subpath' }),
      { keys: await localJwks() },
    )
    expect(r?.status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

// ---- Amendment W1: dev mode (127.0.0.1 origin) ----

describe('requireAdmin — dev mode (ACCESS_DEV_MODE)', () => {
  it('http://127.0.0.1:<port> team domain is REJECTED when ACCESS_DEV_MODE is unset', async () => {
    const devDomain = 'http://127.0.0.1:8788'
    const jwt = await signJwt({ iss: devDomain, aud: TEST_AUD, email: TEST_EMAIL })
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ teamDomain: devDomain }), // no devMode
      { keys: await localJwks() },
    )
    expect(r?.status).toBe(401)
  })

  it('http://127.0.0.1:<port> team domain is ACCEPTED when ACCESS_DEV_MODE=1', async () => {
    const devDomain = 'http://127.0.0.1:8788'
    const jwt = await signJwt({ iss: devDomain, aud: TEST_AUD, email: TEST_EMAIL })
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ teamDomain: devDomain, devMode: '1' }),
      { keys: await localJwks() },
    )
    expect(r).toBeUndefined()
  })

  it('http://127.0.0.1.evil.com is REJECTED even when ACCESS_DEV_MODE=1', async () => {
    const evilDomain = 'http://127.0.0.1.evil.com'
    const jwt = await signJwt({ iss: evilDomain, aud: TEST_AUD, email: TEST_EMAIL })
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ teamDomain: evilDomain, devMode: '1' }),
      { keys: await localJwks() },
    )
    expect(r?.status).toBe(401)
  })

  it('ACCESS_DEV_MODE=2 (not exactly "1") does not enable dev mode → 401', async () => {
    const devDomain = 'http://127.0.0.1:8788'
    const jwt = await signJwt({ iss: devDomain, aud: TEST_AUD, email: TEST_EMAIL })
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ teamDomain: devDomain, devMode: '2' }),
      { keys: await localJwks() },
    )
    expect(r?.status).toBe(401)
  })
})

// ---- Rate limiting (checked first) ----

describe('requireAdmin — rate limiting', () => {
  it('valid JWT while ADMIN_FAIL_LIMIT exhausted → 429', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ failLimit: false }),
      { keys: await localJwks() },
    )
    expect(r?.status).toBe(429)
  })

  it('no JWT + rate limit exhausted → 429 (rate limit checked before JWT)', async () => {
    const r = await requireAdmin(
      makeReq(null),
      accessEnv({ failLimit: false }),
      { keys: await localJwks() },
    )
    expect(r?.status).toBe(429)
  })
})

// ---- CSRF: X-Requested-With and Sec-Fetch-Site (Amendment W5) ----

describe('requireAdmin — CSRF checks', () => {
  it('POST with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'POST', noXrw: true }), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(403)
  })

  it('PUT with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'PUT', noXrw: true }), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(403)
  })

  it('DELETE with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'DELETE', noXrw: true }), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(403)
  })

  it('HEAD with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'HEAD', noXrw: true }), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(403)
  })

  it('OPTIONS with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'OPTIONS', noXrw: true }), accessEnv(), { keys: await localJwks() })
    expect(r?.status).toBe(403)
  })

  it('POST with valid JWT AND X-Requested-With: fetch → passes (undefined)', async () => {
    const jwt = await validJwt()
    // makeReq adds X-Requested-With for non-GET by default
    const r = await requireAdmin(makeReq(jwt, { method: 'POST' }), accessEnv(), { keys: await localJwks() })
    expect(r).toBeUndefined()
  })

  it('GET with valid JWT and no X-Requested-With → passes (GET is exempt from CSRF)', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect(r).toBeUndefined()
  })

  it('GET with Sec-Fetch-Site: cross-site → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { secFetchSite: 'cross-site' }),
      accessEnv(),
      { keys: await localJwks() },
    )
    expect(r?.status).toBe(403)
  })

  it('POST with Sec-Fetch-Site: cross-site and X-Requested-With → 403 (Sec-Fetch-Site wins)', async () => {
    const jwt = await validJwt()
    // Even with X-Requested-With present, cross-site is rejected
    const r = await requireAdmin(
      makeReq(jwt, { method: 'POST', secFetchSite: 'cross-site' }),
      accessEnv(),
      { keys: await localJwks() },
    )
    expect(r?.status).toBe(403)
  })
})

// ---- Error response shape ----

describe('requireAdmin — error response shape', () => {
  it('error responses carry Cache-Control, X-Content-Type-Options, X-Robots-Tag', async () => {
    const r = await requireAdmin(makeReq(null), accessEnv(), { keys: await localJwks() })
    expect(r?.headers.get('Cache-Control')).toBe('no-store')
    expect(r?.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r?.headers.get('X-Robots-Tag')).toBe('noindex')
  })

  it('error response body is JSON with { error } field', async () => {
    const r = await requireAdmin(makeReq(null), accessEnv(), { keys: await localJwks() })
    const body = await r?.json() as { error?: string }
    expect(typeof body?.error).toBe('string')
  })

  it('403 response body has error: forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'POST', noXrw: true }), accessEnv(), { keys: await localJwks() })
    const body = await r?.json() as { error?: string }
    expect(body?.error).toBe('forbidden')
  })
})

// ---- Key resolver error (JWKS fetch failure) ----

describe('requireAdmin — key resolver error', () => {
  afterEach(() => vi.restoreAllMocks())

  it('key resolver throws → 401 and logs admin: jwks_error once (not e.message)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const throwingResolver: JWTVerifyGetKey = vi.fn().mockRejectedValue(
      new Error('simulated JWKS fetch failure'),
    )
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: throwingResolver })
    expect(r?.status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: jwks_error')
    expect(spy).toHaveBeenCalledTimes(1)
    // The error message itself must not appear in any log call
    expect(spy.mock.calls[0]?.[0]).toBe('admin: jwks_error')
  })
})

// ---- Logging: fixed strings only, never JWT/email/secret (plan § Amendments > Logging) ----

describe('requireAdmin — logging discipline', () => {
  afterEach(() => vi.restoreAllMocks())

  it('console.error/warn never contain JWT, email, AUD, or team domain', async () => {
    const errorCalls: unknown[][] = []
    const warnCalls: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => { errorCalls.push(args) })
    vi.spyOn(console, 'warn').mockImplementation((...args) => { warnCalls.push(args) })

    const jwt = await validJwt()
    const keys = await localJwks()

    // Trigger several error paths
    await requireAdmin(makeReq(jwt), accessEnv({ teamDomain: '' }), { keys })
    await requireAdmin(makeReq(jwt), accessEnv({ adminEmails: 'other@example.com' }), { keys })
    await requireAdmin(makeReq('garbage.jwt.value'), accessEnv(), { keys })

    for (const call of [...errorCalls, ...warnCalls]) {
      const msg = call.map(String).join(' ')
      expect(msg, 'must not log JWT token').not.toContain(jwt)
      expect(msg, 'must not log email').not.toContain(TEST_EMAIL)
      expect(msg, 'must not log AUD').not.toContain(TEST_AUD)
      expect(msg, 'must not log team domain').not.toContain(TEST_TEAM_DOMAIN)
    }
  })
})
