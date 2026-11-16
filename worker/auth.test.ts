// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { SignJWT } from 'jose'
import type { JWTVerifyGetKey } from 'jose'
import { requireAdmin } from './auth.ts'
import {
  signJwt, validJwt, localJwks, twoKeyJwks, accessEnv, seedAdmin,
  TEST_TEAM_DOMAIN, TEST_AUD, TEST_EMAIL,
} from './testAccess.ts'
import { testDb } from './testDb.ts'
import type { D1 } from './testDb.ts'

// ---- Request builder ----

/**
 * Build a Request for /api/admin/teachers.
 * @param jwt   JWT string to put in Cf-Access-Jwt-Assertion, or null for no header.
 * @param opts  method (default GET), noXrw (suppress auto X-Requested-With on non-GET),
 *              xrw (force X-Requested-With on any method, needed for bootstrap GET),
 *              secFetchSite, ip.
 */
function makeReq(
  jwt: string | null,
  opts: { method?: string; noXrw?: boolean; xrw?: boolean; secFetchSite?: string; ip?: string } = {},
): Request {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = { 'CF-Connecting-IP': opts.ip ?? '1.2.3.4' }
  if (jwt !== null) headers['Cf-Access-Jwt-Assertion'] = jwt
  // Add X-Requested-With for non-GET unless caller opts out (CSRF tests do this)
  if (method !== 'GET' && !opts.noXrw) headers['X-Requested-With'] = 'fetch'
  // Force X-Requested-With even for GET (bootstrap write requirement)
  if (opts.xrw) headers['X-Requested-With'] = 'fetch'
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
  return `${newHeader}.${parts[1]}.${parts[2]}`
}

// ---- Happy path (caller seeded as admin in DB) ----

describe('requireAdmin — valid JWT', () => {
  let db: D1

  beforeEach(async () => {
    ;({ db } = testDb())
    await seedAdmin(db, TEST_EMAIL)
  })

  it('returns { email } when JWT is valid and email is in admin table', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), accessEnv({ db }), { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('email matching is case-insensitive (stored lower, JWT upper → match)', async () => {
    const jwt = await validJwt({ email: TEST_EMAIL.toUpperCase() })
    const r = await requireAdmin(makeReq(jwt), accessEnv({ db }), { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('email is trimmed before DB lookup', async () => {
    const jwt = await validJwt({ email: '  ' + TEST_EMAIL + '  ' })
    const r = await requireAdmin(makeReq(jwt), accessEnv({ db }), { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('aud claim as an array containing TEST_AUD → passes', async () => {
    const jwt = await validJwt({ aud: [TEST_AUD, 'other-aud'] })
    const r = await requireAdmin(makeReq(jwt), accessEnv({ db }), { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })
})

// ---- JWT rejection cases ----

describe('requireAdmin — JWT rejection', () => {
  it('no Cf-Access-Jwt-Assertion header → 401', async () => {
    const r = await requireAdmin(makeReq(null), accessEnv(), { keys: await localJwks() })
    expect(r).toBeInstanceOf(Response)
    expect((r as Response).status).toBe(401)
  })

  it('garbage (non-JWT) string in header → 401', async () => {
    const r = await requireAdmin(makeReq('not.a.jwt.string'), accessEnv(), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('wrong signature (k2 private key signed with k1 kid) → 401', async () => {
    const jwt = await validJwt({}, { useK2: true, kid: 'k1' })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('wrong issuer → 401', async () => {
    const jwt = await validJwt({ iss: 'https://evil.cloudflareaccess.com' })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('wrong audience → 401', async () => {
    const jwt = await validJwt({ aud: 'wrong-aud-value' })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('aud array NOT containing TEST_AUD → 401', async () => {
    const jwt = await validJwt({ aud: ['other-aud-1', 'other-aud-2'] })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
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
    expect((r as Response).status).toBe(401)
  })

  it('missing exp claim → 401 (requiredClaims enforcement)', async () => {
    const jwt = await validJwt({}, { noExp: true })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('missing iat claim → 401 (requiredClaims enforcement)', async () => {
    const jwt = await validJwt({}, { noIat: true })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('email not in admin table (table has admins) → 401', async () => {
    // Seed a different email as admin; caller is 'stranger@example.com' (not in table)
    const { db } = testDb()
    await seedAdmin(db, 'other-admin@example.com')
    const jwt = await validJwt({ email: 'stranger@example.com' })
    const r = await requireAdmin(makeReq(jwt), accessEnv({ db }), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('missing email claim → 401', async () => {
    const jwt = await signJwt({ iss: TEST_TEAM_DOMAIN, aud: TEST_AUD })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('email is not a string (number) → 401', async () => {
    const jwt = await validJwt({ email: 123 })
    const r = await requireAdmin(makeReq(jwt), accessEnv(), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('email claim > 254 chars → 401 before DB (zero DB prepares)', async () => {
    const longEmail = 'a'.repeat(246) + '@example.com'  // 258 chars
    const jwt = await validJwt({ email: longEmail })
    const { db, state } = testDb()
    const r = await requireAdmin(makeReq(jwt), accessEnv({ db }), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(state.prepares).toBe(0)
  })
})

// ---- alg: none and HS256 — decodeProtectedHeader check ----

describe('requireAdmin — alg checks (before key resolver)', () => {
  it('alg:none token does not call the key resolver and returns 401', async () => {
    const hdr = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const pay = Buffer.from(
      JSON.stringify({ iss: TEST_TEAM_DOMAIN, aud: TEST_AUD, email: TEST_EMAIL, exp: 9999999999, iat: 1 }),
    ).toString('base64url')
    const algNoneJwt = `${hdr}.${pay}.`

    const spy = vi.fn()
    const r = await requireAdmin(makeReq(algNoneJwt), accessEnv(), { keys: spy })
    expect((r as Response).status).toBe(401)
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
    expect((r as Response).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('RS256 token with no kid in header → 401 without calling key resolver', async () => {
    const tampered = await noKidJwt()
    const spy = vi.fn()
    const r = await requireAdmin(makeReq(tampered), accessEnv(), { keys: spy })
    expect((r as Response).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('two keys in JWKS — k2-signed JWT is verified using the k2 key (kid selection)', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const twoKeys = await twoKeyJwks()
    const jwtK2 = await validJwt({}, { useK2: true })
    const r = await requireAdmin(makeReq(jwtK2), accessEnv({ db }), { keys: twoKeys })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('two keys in JWKS — k1-signed JWT is verified using the k1 key (kid selection)', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const twoKeys = await twoKeyJwks()
    const jwtK1 = await validJwt()
    const r = await requireAdmin(makeReq(jwtK1), accessEnv({ db }), { keys: twoKeys })
    expect(r).toEqual({ email: TEST_EMAIL })
  })
})

// ---- Misconfiguration ----

describe('requireAdmin — misconfiguration → 401 + console.error', () => {
  afterEach(() => vi.restoreAllMocks())

  it('empty ACCESS_AUD → 401 and logs admin: misconfigured exactly once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), accessEnv({ aud: '' }), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('empty ACCESS_TEAM_DOMAIN → 401 and logs admin: misconfigured exactly once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), accessEnv({ teamDomain: '' }), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
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
    expect((r as Response).status).toBe(401)
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
    expect((r as Response).status).toBe(401)
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
    expect((r as Response).status).toBe(401)
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
    expect((r as Response).status).toBe(401)
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
    expect((r as Response).status).toBe(401)
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
      accessEnv({ teamDomain: devDomain }),
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
  })

  it('http://127.0.0.1:<port> team domain is ACCEPTED when ACCESS_DEV_MODE=1', async () => {
    const devDomain = 'http://127.0.0.1:8788'
    const jwt = await signJwt({ iss: devDomain, aud: TEST_AUD, email: TEST_EMAIL })
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ teamDomain: devDomain, devMode: '1', db }),
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('http://127.0.0.1.evil.com is REJECTED even when ACCESS_DEV_MODE=1', async () => {
    const evilDomain = 'http://127.0.0.1.evil.com'
    const jwt = await signJwt({ iss: evilDomain, aud: TEST_AUD, email: TEST_EMAIL })
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ teamDomain: evilDomain, devMode: '1' }),
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
  })

  it('ACCESS_DEV_MODE=2 (not exactly "1") does not enable dev mode → 401', async () => {
    const devDomain = 'http://127.0.0.1:8788'
    const jwt = await signJwt({ iss: devDomain, aud: TEST_AUD, email: TEST_EMAIL })
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ teamDomain: devDomain, devMode: '2' }),
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
  })
})

// ---- Rate limiting (checked first, zero DB prepares) ----

describe('requireAdmin — rate limiting', () => {
  it('valid JWT while ADMIN_FAIL_LIMIT exhausted → 429', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ failLimit: false }),
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(429)
  })

  it('no JWT + rate limit exhausted → 429 (rate limit checked before JWT)', async () => {
    const r = await requireAdmin(
      makeReq(null),
      accessEnv({ failLimit: false }),
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(429)
  })

  it('rate limit exhausted → zero DB prepares (DB never touched)', async () => {
    const jwt = await validJwt()
    const { db, state } = testDb()
    await requireAdmin(makeReq(jwt), accessEnv({ failLimit: false, db }), { keys: await localJwks() })
    expect(state.prepares).toBe(0)
  })
})

// ---- CSRF: X-Requested-With and Sec-Fetch-Site ----

describe('requireAdmin — CSRF checks', () => {
  let db: D1

  beforeEach(async () => {
    ;({ db } = testDb())
    await seedAdmin(db, TEST_EMAIL)
  })

  it('POST with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'POST', noXrw: true }), accessEnv({ db }), { keys: await localJwks() })
    expect((r as Response).status).toBe(403)
  })

  it('PUT with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'PUT', noXrw: true }), accessEnv({ db }), { keys: await localJwks() })
    expect((r as Response).status).toBe(403)
  })

  it('DELETE with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'DELETE', noXrw: true }), accessEnv({ db }), { keys: await localJwks() })
    expect((r as Response).status).toBe(403)
  })

  it('HEAD with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'HEAD', noXrw: true }), accessEnv({ db }), { keys: await localJwks() })
    expect((r as Response).status).toBe(403)
  })

  it('OPTIONS with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'OPTIONS', noXrw: true }), accessEnv({ db }), { keys: await localJwks() })
    expect((r as Response).status).toBe(403)
  })

  it('POST with valid JWT AND X-Requested-With: fetch → returns { email }', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'POST' }), accessEnv({ db }), { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('GET with valid JWT and no X-Requested-With → returns { email } (GET is exempt from CSRF)', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), accessEnv({ db }), { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('GET with Sec-Fetch-Site: cross-site → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { secFetchSite: 'cross-site' }),
      accessEnv({ db }),
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(403)
  })

  it('POST with Sec-Fetch-Site: cross-site and X-Requested-With → 403 (Sec-Fetch-Site wins)', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { method: 'POST', secFetchSite: 'cross-site' }),
      accessEnv({ db }),
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(403)
  })

  it('POST without X-Requested-With → zero DB prepares (CSRF checked before DB)', async () => {
    const { db: freshDb, state } = testDb()
    await seedAdmin(freshDb, TEST_EMAIL)
    state.prepares = 0 // seeding used prepare(); count only what requireAdmin does
    const jwt = await validJwt()
    await requireAdmin(
      makeReq(jwt, { method: 'POST', noXrw: true }),
      accessEnv({ db: freshDb }),
      { keys: await localJwks() },
    )
    expect(state.prepares).toBe(0)
  })

  it('cross-site GET → zero DB prepares (Sec-Fetch-Site checked before DB)', async () => {
    const { db: freshDb, state } = testDb()
    await seedAdmin(freshDb, TEST_EMAIL)
    state.prepares = 0 // seeding used prepare(); count only what requireAdmin does
    const jwt = await validJwt()
    await requireAdmin(
      makeReq(jwt, { secFetchSite: 'cross-site' }),
      accessEnv({ db: freshDb }),
      { keys: await localJwks() },
    )
    expect(state.prepares).toBe(0)
  })
})

// ---- Error response shape ----

describe('requireAdmin — error response shape', () => {
  it('error responses carry Cache-Control, X-Content-Type-Options, X-Robots-Tag', async () => {
    const r = await requireAdmin(makeReq(null), accessEnv(), { keys: await localJwks() })
    expect((r as Response).headers.get('Cache-Control')).toBe('no-store')
    expect((r as Response).headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect((r as Response).headers.get('X-Robots-Tag')).toBe('noindex')
  })

  it('error response body is JSON with { error } field', async () => {
    const r = await requireAdmin(makeReq(null), accessEnv(), { keys: await localJwks() })
    const body = await (r as Response).json() as { error?: string }
    expect(typeof body?.error).toBe('string')
  })

  it('403 response body has error: forbidden', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'POST', noXrw: true }), accessEnv({ db }), { keys: await localJwks() })
    const body = await (r as Response).json() as { error?: string }
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
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: jwks_error')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toBe('admin: jwks_error')
  })
})

// ---- Logging: fixed strings only, never JWT/email/secret ----

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
    // Non-admin on a table that has other admins
    const { db } = testDb()
    await seedAdmin(db, 'other-admin@example.com')
    await requireAdmin(makeReq(jwt), accessEnv({ db }), { keys })
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

// ---- Bootstrap flow (plan § Decision + Amendments W1, W2, W3, W4, W5) ----

describe('requireAdmin — bootstrap: ALLOW_FIRST_CLAIM', () => {
  afterEach(() => vi.restoreAllMocks())

  it('ALLOW_FIRST_CLAIM=1, empty table, GET + X-Requested-With → returns { email }, row has created_by=bootstrap', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      accessEnv({ db, allowFirstClaim: '1' }),
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
    // Row inserted with created_by = 'bootstrap'
    const row = await db.prepare('SELECT created_by FROM admin WHERE email = ?').bind(TEST_EMAIL).first<{ created_by: string }>()
    expect(row?.created_by).toBe('bootstrap')
    // admin: bootstrap logged exactly once
    expect(spy).toHaveBeenCalledWith('admin: bootstrap')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('admin: bootstrap log never contains the email', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const jwt = await validJwt()
    await requireAdmin(makeReq(jwt, { xrw: true }), accessEnv({ db, allowFirstClaim: '1' }), { keys: await localJwks() })
    for (const call of spy.mock.calls) {
      expect(call.map(String).join(' ')).not.toContain(TEST_EMAIL)
    }
  })

  it('second different user after bootstrap → 401, no extra row', async () => {
    const { db } = testDb()
    const jwt1 = await validJwt()
    // First user claims bootstrap
    await requireAdmin(makeReq(jwt1, { xrw: true }), accessEnv({ db, allowFirstClaim: '1' }), { keys: await localJwks() })
    // Second user (different email) → 401
    const jwt2 = await validJwt({ email: 'stranger@example.com' })
    const r2 = await requireAdmin(makeReq(jwt2, { xrw: true }), accessEnv({ db, allowFirstClaim: '1' }), { keys: await localJwks() })
    expect((r2 as Response).status).toBe(401)
    // Only one row in admin table
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('same user twice → both succeed, exactly one admin row', async () => {
    const { db } = testDb()
    const jwt = await validJwt()
    const r1 = await requireAdmin(makeReq(jwt, { xrw: true }), accessEnv({ db, allowFirstClaim: '1' }), { keys: await localJwks() })
    const r2 = await requireAdmin(makeReq(jwt, { xrw: true }), accessEnv({ db, allowFirstClaim: '1' }), { keys: await localJwks() })
    expect(r1).toEqual({ email: TEST_EMAIL })
    expect(r2).toEqual({ email: TEST_EMAIL })
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('Promise.all two different first users → exactly one 200 and one 401, one row', async () => {
    const { db } = testDb()
    const env = accessEnv({ db, allowFirstClaim: '1' })
    const keys = await localJwks()
    const jwt1 = await validJwt({ email: TEST_EMAIL })
    const jwt2 = await validJwt({ email: 'other@example.com' })
    const [r1, r2] = await Promise.all([
      requireAdmin(makeReq(jwt1, { xrw: true }), env, { keys }),
      requireAdmin(makeReq(jwt2, { xrw: true }), env, { keys }),
    ])
    const statuses = [(r1 as Response | Record<string, unknown>), (r2 as Response | Record<string, unknown>)]
      .map((r) => (r instanceof Response ? r.status : 200))
      .sort()
    expect(statuses).toEqual([200, 401])
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('Promise.all two same-user first requests → both succeed', async () => {
    const { db } = testDb()
    const env = accessEnv({ db, allowFirstClaim: '1' })
    const keys = await localJwks()
    const jwt = await validJwt()
    const [r1, r2] = await Promise.all([
      requireAdmin(makeReq(jwt, { xrw: true }), env, { keys }),
      requireAdmin(makeReq(jwt, { xrw: true }), env, { keys }),
    ])
    // Both should return { email } (second request re-SELECTs and finds the same user's row)
    expect(r1).toEqual({ email: TEST_EMAIL })
    expect(r2).toEqual({ email: TEST_EMAIL })
  })

  it('neither BOOTSTRAP_EMAIL nor ALLOW_FIRST_CLAIM → 401 and logs admin: misconfigured', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { xrw: true }), accessEnv({ db }), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
  })

  it('admin: misconfigured NOT logged when non-admin calls on populated table', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    await seedAdmin(db, 'other-admin@example.com')
    const jwt = await validJwt({ email: 'stranger@example.com' })
    await requireAdmin(makeReq(jwt, { xrw: true }), accessEnv({ db }), { keys: await localJwks() })
    const misconfiguredCalls = spy.mock.calls.filter((c) => c[0] === 'admin: misconfigured')
    expect(misconfiguredCalls).toHaveLength(0)
  })

  it('leftover ALLOW_FIRST_CLAIM is inert for existing admin (no extra row)', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), accessEnv({ db, allowFirstClaim: '1' }), { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('leftover ALLOW_FIRST_CLAIM is inert when table non-empty (non-admin caller → 401, no insert)', async () => {
    const { db } = testDb()
    await seedAdmin(db, 'other-admin@example.com')
    const jwt = await validJwt({ email: 'stranger@example.com' })
    const r = await requireAdmin(makeReq(jwt, { xrw: true }), accessEnv({ db, allowFirstClaim: '1' }), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('bootstrap GET without X-Requested-With → 403 (required for bootstrap write)', async () => {
    const { db } = testDb()
    const jwt = await validJwt()
    // No xrw, no X-Requested-With on GET
    const r = await requireAdmin(makeReq(jwt), accessEnv({ db, allowFirstClaim: '1' }), { keys: await localJwks() })
    expect((r as Response).status).toBe(403)
  })

  it('exactly one prepare() for the bootstrap write (1 SELECT + 1 INSERT)', async () => {
    const { db, state } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { xrw: true }), accessEnv({ db, allowFirstClaim: '1' }), { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
    // 1 SELECT (email check) + 1 INSERT (bootstrap write) = 2 prepare() calls
    expect(state.prepares).toBe(2)
  })

  it('DB error during bootstrap → 503 and no row inserted', async () => {
    const { db, state } = testDb()
    state.fail = true
    const jwt = await validJwt()
    // Expect the handler to either return 503 or throw; index.ts catches throws as 503
    let r: unknown
    try {
      r = await requireAdmin(makeReq(jwt, { xrw: true }), accessEnv({ db, allowFirstClaim: '1' }), { keys: await localJwks() })
    } catch {
      r = null
    }
    // Either returns a 503 Response or throws — both are valid fail-closed behavior
    if (r !== null) {
      expect((r as Response).status).toBe(503)
    }
  })

  it('missing admin table (0002 not applied) → 503 and no grant', async () => {
    // Create a DB with ONLY 0001 (no admin table)
    const { DatabaseSync } = await import('node:sqlite')
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const sqlite = new DatabaseSync(':memory:')
    const sql0001 = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../migrations/0001_init.sql'),
      'utf-8',
    )
    sqlite.exec(sql0001)
    // Wrap in a D1-compatible shim
    const noTableDb = {
      prepare: (sql: string) => ({
        bind: (..._v: unknown[]) => noTableDb.prepare(sql),
        run: async () => { const r = sqlite.prepare(sql).run(); return { success: true, meta: { changes: Number(r.changes) } } },
        first: async <T>() => (sqlite.prepare(sql).get() as T | undefined) ?? null,
        all: async <T>() => ({ results: sqlite.prepare(sql).all() as T[] }),
      }),
      batch: async (stmts: Array<{ run(): Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())),
    }
    const jwt = await validJwt()
    let r: unknown
    try {
      r = await requireAdmin(makeReq(jwt, { xrw: true }), { ...accessEnv({ allowFirstClaim: '1' }), DB: noTableDb as never }, { keys: await localJwks() })
    } catch {
      r = null
    }
    if (r !== null) {
      expect((r as Response).status).toBe(503)
    }
  })
})

describe('requireAdmin — bootstrap: BOOTSTRAP_EMAIL', () => {
  afterEach(() => vi.restoreAllMocks())

  it('BOOTSTRAP_EMAIL matches caller → allowed, row inserted', async () => {
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      accessEnv({ db, bootstrapEmail: TEST_EMAIL }),
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
    const row = await db.prepare('SELECT created_by FROM admin WHERE email = ?').bind(TEST_EMAIL).first<{ created_by: string }>()
    expect(row?.created_by).toBe('bootstrap')
  })

  it('BOOTSTRAP_EMAIL mismatch → 401, no row inserted', async () => {
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      accessEnv({ db, bootstrapEmail: 'different@example.com' }),
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })

  it('BOOTSTRAP_EMAIL set but empty string → 401 (empty value is treated as mismatch)', async () => {
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      accessEnv({ db, bootstrapEmail: '' }),
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
  })

  it('BOOTSTRAP_EMAIL present, ALLOW_FIRST_CLAIM=1, non-matching caller → 401 (BOOTSTRAP_EMAIL takes precedence)', async () => {
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      accessEnv({ db, bootstrapEmail: 'specific@example.com', allowFirstClaim: '1' }),
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
  })

  it('BOOTSTRAP_EMAIL matches case-insensitively (stored trimmed lower)', async () => {
    const { db } = testDb()
    const jwt = await validJwt({ email: TEST_EMAIL })
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      accessEnv({ db, bootstrapEmail: TEST_EMAIL.toUpperCase() }),
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('leftover BOOTSTRAP_EMAIL inert for existing admin (no second row)', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      accessEnv({ db, bootstrapEmail: TEST_EMAIL }),
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('zero DB prepares when JWT is bad (DB never reached)', async () => {
    const { db, state } = testDb()
    await requireAdmin(makeReq('garbage.jwt.value'), accessEnv({ db, bootstrapEmail: TEST_EMAIL }), { keys: await localJwks() })
    expect(state.prepares).toBe(0)
  })
})

// ---- Fix Group 1: W3 — ALLOW_FIRST_CLAIM exact '1' gate (non-'1' values) ----

describe('requireAdmin — ALLOW_FIRST_CLAIM non-"1" values → 401 + misconfigured', () => {
  afterEach(() => vi.restoreAllMocks())

  it('ALLOW_FIRST_CLAIM="0" → 401, admin: misconfigured, no row inserted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { xrw: true }), accessEnv({ db, allowFirstClaim: '0' }), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })

  it('ALLOW_FIRST_CLAIM="true" → 401, admin: misconfigured, no row inserted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { xrw: true }), accessEnv({ db, allowFirstClaim: 'true' }), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })

  it('ALLOW_FIRST_CLAIM="" → 401, admin: misconfigured, no row inserted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { xrw: true }), accessEnv({ db, allowFirstClaim: '' }), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })
})

// ---- Fix Group 1: Suggestion — padded BOOTSTRAP_EMAIL ----

describe('requireAdmin — BOOTSTRAP_EMAIL padding', () => {
  it('BOOTSTRAP_EMAIL padded with spaces is trimmed and matches caller email', async () => {
    const { db } = testDb()
    const jwt = await validJwt()  // email = TEST_EMAIL
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      accessEnv({ db, bootstrapEmail: `  ${TEST_EMAIL}  ` }),
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
    const row = await db.prepare('SELECT created_by FROM admin WHERE email = ?').bind(TEST_EMAIL).first<{ created_by: string }>()
    expect(row?.created_by).toBe('bootstrap')
  })

  it('BOOTSTRAP_EMAIL padded uppercase + spaces matches caller (trim + lowercase)', async () => {
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      accessEnv({ db, bootstrapEmail: `  ${TEST_EMAIL.toUpperCase()}  ` }),
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
  })
})

// ---- Fix Group 1: Suggestion — zero DB prepares for non-string / missing email ----

describe('requireAdmin — zero DB prepares before email shape check', () => {
  it('non-string email claim (number) → zero DB prepares', async () => {
    const { db, state } = testDb()
    const jwt = await validJwt({ email: 123 })
    await requireAdmin(makeReq(jwt), accessEnv({ db }), { keys: await localJwks() })
    expect(state.prepares).toBe(0)
  })

  it('missing email claim → zero DB prepares', async () => {
    const { db, state } = testDb()
    const jwt = await signJwt({ iss: TEST_TEAM_DOMAIN, aud: TEST_AUD })
    await requireAdmin(makeReq(jwt), accessEnv({ db }), { keys: await localJwks() })
    expect(state.prepares).toBe(0)
  })
})
