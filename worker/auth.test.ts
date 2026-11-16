// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { SignJWT } from 'jose'
import type { JWTVerifyGetKey } from 'jose'
import { requireAdmin, parseConfig } from './auth.ts'
import {
  signJwt, validJwt, localJwks, twoKeyJwks, googleEnv, seedAdmin,
  TEST_CLIENT_ID, TEST_EMAIL, TEST_EMAIL_WORKSPACE, TEST_HD,
} from './testGoogle.ts'
import { testDb } from './testDb.ts'
import type { D1 } from './testDb.ts'

// ---- Request builder ----

/**
 * Build a Request for /api/admin/teachers.
 * @param jwt   JWT string; placed in `Authorization: Bearer <jwt>`, or null for no header.
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
  if (jwt !== null) headers['Authorization'] = `Bearer ${jwt}`
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

// ============================================================
// Happy path — valid Gmail token (admin seeded in DB)
// ============================================================

describe('requireAdmin — valid Gmail token', () => {
  let db: D1

  beforeEach(async () => {
    ;({ db } = testDb())
    await seedAdmin(db, TEST_EMAIL)
  })

  it('valid Gmail token with email_verified: true → returns { email }', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('email matching is case-insensitive (stored lower, JWT upper → match)', async () => {
    const jwt = await validJwt({ email: TEST_EMAIL.toUpperCase() })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('email is trimmed before DB lookup', async () => {
    const jwt = await validJwt({ email: '  ' + TEST_EMAIL + '  ' })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('aud claim as an array containing TEST_CLIENT_ID → passes', async () => {
    const jwt = await validJwt({ aud: [TEST_CLIENT_ID, 'other-aud'] })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })
})

describe('requireAdmin — valid Workspace (hd) token', () => {
  let db: D1

  beforeEach(async () => {
    ;({ db } = testDb())
    await seedAdmin(db, TEST_EMAIL_WORKSPACE)
  })

  it('Workspace token with hd and matching email domain → returns { email }', async () => {
    const jwt = await validJwt({
      email: TEST_EMAIL_WORKSPACE,
      email_verified: true,
      hd: TEST_HD,
    })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL_WORKSPACE })
  })

  it('iss = "accounts.google.com" (without https prefix) → passes (both iss spellings accepted)', async () => {
    const jwt = await validJwt({
      iss: 'accounts.google.com',
      email: TEST_EMAIL_WORKSPACE,
      email_verified: true,
      hd: TEST_HD,
    })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL_WORKSPACE })
  })
})

describe('requireAdmin — both iss spellings accepted', () => {
  let db: D1

  beforeEach(async () => {
    ;({ db } = testDb())
    await seedAdmin(db, TEST_EMAIL)
  })

  it('iss = "https://accounts.google.com" → passes', async () => {
    const jwt = await validJwt()  // default iss is https://accounts.google.com
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('iss = "accounts.google.com" (without https) → passes', async () => {
    const jwt = await validJwt({ iss: 'accounts.google.com' })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('iss = "https://evil.com" → 401 (not an accepted Google issuer)', async () => {
    const jwt = await validJwt({ iss: 'https://evil.com' })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })
})

// ============================================================
// Email rules — email_verified, Gmail suffix, hd domain
// ============================================================

describe('requireAdmin — email rules (email_verified)', () => {
  // Seed TEST_EMAIL as admin so the 401 comes from the email_verified guard, not the bootstrap path.
  let db: D1
  beforeEach(async () => {
    ;({ db } = testDb())
    await seedAdmin(db, TEST_EMAIL)
  })

  it('email_verified: false → 401', async () => {
    const jwt = await validJwt({ email_verified: false })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('email_verified missing (not in payload) → 401', async () => {
    const jwt = await signJwt({
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      email: TEST_EMAIL,
      // email_verified intentionally absent
    })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('email_verified = "true" (string, not boolean) → 401', async () => {
    const jwt = await validJwt({ email_verified: 'true' })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })
})

describe('requireAdmin — email rules (Gmail suffix and hd)', () => {
  it('non-Gmail address without hd → 401', async () => {
    // @example.com is not @gmail.com and no hd claim
    // Seed the same email so rejection is from the email-domain guard, not the bootstrap path.
    const { db } = testDb()
    await seedAdmin(db, 'admin@example.com')
    const jwt = await validJwt({ email: 'admin@example.com' })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('@gmail.com.evil.com → 401 (not an exact @gmail.com suffix)', async () => {
    const { db } = testDb()
    await seedAdmin(db, 'admin@gmail.com.evil.com')
    const jwt = await validJwt({ email: 'admin@gmail.com.evil.com' })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('@notgmail.com → 401 (does not end with @gmail.com)', async () => {
    const { db } = testDb()
    await seedAdmin(db, 'admin@notgmail.com')
    const jwt = await validJwt({ email: 'admin@notgmail.com' })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('@googlemail.com with hd: "googlemail.com" → 401 (googlemail.com explicitly rejected even when hd matches)', async () => {
    // hd matching domain does not rescue googlemail.com — the explicit googlemail.com block fires first.
    const { db } = testDb()
    await seedAdmin(db, 'admin@googlemail.com')
    const jwt = await validJwt({ email: 'admin@googlemail.com', hd: 'googlemail.com' })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('gmail address with hd present but mismatched → 401 (hd must match even for @gmail.com)', async () => {
    // Workspace-issued token for a @gmail.com address: hd='workspace.example.com' ≠ 'gmail.com'.
    // The hd mismatch must reject even though the domain is otherwise valid Gmail.
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const jwt = await validJwt({
      email: TEST_EMAIL,         // admin@gmail.com
      email_verified: true,
      hd: TEST_HD,               // workspace.example.com — mismatches gmail.com
    })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })
})

// ============================================================
// Email pattern — ASCII check and hd domain match
// ============================================================

describe('requireAdmin — email pattern (ASCII) and hd domain match', () => {
  it('email with non-ASCII character (ñ) → 401 (ASCII pattern enforced)', async () => {
    const jwt = await validJwt({ email: 'admiñ@gmail.com', email_verified: true })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('hd present but email domain does not match hd → 401', async () => {
    // hd='workspace.example.com' but email is @different.com
    const jwt = await validJwt({
      email: 'admin@different.com',
      email_verified: true,
      hd: TEST_HD,
    })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('hd present and email domain matches hd → passes', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL_WORKSPACE)
    const jwt = await validJwt({
      email: TEST_EMAIL_WORKSPACE,
      email_verified: true,
      hd: TEST_HD,
    })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL_WORKSPACE })
  })
})

// ============================================================
// JWT rejection cases
// ============================================================

describe('requireAdmin — JWT rejection', () => {
  it('no Authorization header → 401', async () => {
    const r = await requireAdmin(makeReq(null), googleEnv(),  { keys: await localJwks() })
    expect(r).toBeInstanceOf(Response)
    expect((r as Response).status).toBe(401)
  })

  it('Authorization with wrong scheme (Token, not Bearer) → 401', async () => {
    const jwt = await validJwt()
    const headers = {
      'CF-Connecting-IP': '1.2.3.4',
      'Authorization': `Token ${jwt}`,
    }
    const r = await requireAdmin(
      new Request('https://x/api/admin/teachers', { headers }),
      googleEnv(), 
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
  })

  it('garbage (non-JWT) string in Bearer → 401', async () => {
    const r = await requireAdmin(makeReq('not.a.jwt.string'), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('Bearer value > 4 KB (structurally valid padded JWT) → 401 without calling resolver', async () => {
    // Uses a real RS256 JWT with a large payload so only the cap (not header decode) causes the 401.
    const spy = vi.fn() as unknown as JWTVerifyGetKey
    const longJwt = await validJwt({ p: 'a'.repeat(3500) })
    expect(longJwt.length).toBeGreaterThan(4096)
    const r = await requireAdmin(makeReq(longJwt), googleEnv(), { keys: spy })
    expect((r as Response).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('Bearer exactly 4096 chars → cap allows it (resolver is called)', async () => {
    // The cap is `> 4096`, so a 4096-char token must pass the cap and reach the resolver.
    const spy = vi.fn().mockRejectedValue(new Error('key not found')) as unknown as JWTVerifyGetKey
    const base = await validJwt()
    const parts = base.split('.')
    const extra = 4096 - base.length
    // Pad the signature part to reach exactly 4096. This invalidates the sig but preserves the header.
    const padded = extra > 0
      ? `${parts[0]!}.${parts[1]!}.${parts[2]!}${'x'.repeat(extra)}`
      : base.substring(0, 4093) + 'xxx'
    expect(padded.length).toBe(4096)
    const r = await requireAdmin(makeReq(padded), googleEnv(), { keys: spy })
    expect((r as Response).status).toBe(401) // fails but NOT due to the cap
    expect(spy).toHaveBeenCalled()           // resolver was reached; cap did not block
  })

  it('token without aud claim → 401 (aud required)', async () => {
    const jwt = await signJwt({
      iss: 'https://accounts.google.com',
      email: TEST_EMAIL,
      email_verified: true,
      // aud intentionally absent
    })
    const r = await requireAdmin(makeReq(jwt), googleEnv(), { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('wrong signature (k2 private key signed with k1 kid) → 401', async () => {
    const jwt = await validJwt({}, { useK2: true, kid: 'k1' })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('wrong issuer (https://evil.com) → 401', async () => {
    const jwt = await validJwt({ iss: 'https://evil.com' })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('wrong audience → 401', async () => {
    const jwt = await validJwt({ aud: 'wrong-audience-value' })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('aud array NOT containing TEST_CLIENT_ID → 401', async () => {
    const jwt = await validJwt({ aud: ['other-aud-1', 'other-aud-2'] })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('expired token (exp in the past) → 401', async () => {
    const now = Math.floor(Date.now() / 1000)
    const jwt = await signJwt({
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      email: TEST_EMAIL,
      email_verified: true,
      iat: now - 7200,
      exp: now - 3600,
    })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('missing exp claim → 401 (requiredClaims enforcement)', async () => {
    const jwt = await validJwt({}, { noExp: true })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('missing iat claim → 401 (requiredClaims enforcement)', async () => {
    const jwt = await validJwt({}, { noIat: true })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('token older than 1 h (iat = 2 h ago, exp still valid) → 401 (maxTokenAge: "1h")', async () => {
    const now = Math.floor(Date.now() / 1000)
    const jwt = await signJwt({
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      email: TEST_EMAIL,
      email_verified: true,
      iat: now - 7200, // 2 hours ago
      exp: now + 3600, // 1 hour in future (not expired by exp, but older than maxTokenAge: '1h')
    })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('future iat (60 s ahead, beyond 30 s clockTolerance) → 401', async () => {
    const now = Math.floor(Date.now() / 1000)
    const jwt = await signJwt({
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      email: TEST_EMAIL,
      email_verified: true,
      iat: now + 60, // 60 s in future, beyond the 30 s tolerance
      exp: now + 7200,
    })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('email not in admin table (table has admins) → 401', async () => {
    const { db } = testDb()
    await seedAdmin(db, 'other-admin@gmail.com')
    const jwt = await validJwt({ email: 'stranger@gmail.com' })
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('missing email claim → 401', async () => {
    const jwt = await signJwt({
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      email_verified: true,
    })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('email is not a string (number) → 401', async () => {
    const jwt = await validJwt({ email: 123 })
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
  })

  it('email claim > 254 chars → 401 before DB (zero DB prepares)', async () => {
    const longEmail = 'a'.repeat(246) + '@gmail.com'  // 256 chars
    const jwt = await validJwt({ email: longEmail })
    const { db, state } = testDb()
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('no Authorization header → zero DDL (rate limit and config checked first)', async () => {
    const { db, state } = testDb()
    const r = await requireAdmin(makeReq(null), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })
})

// ============================================================
// alg: none and HS256 — decodeProtectedHeader check
// ============================================================

describe('requireAdmin — alg checks (before key resolver)', () => {
  it('alg:none token does not call the key resolver and returns 401', async () => {
    const hdr = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const pay = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: TEST_CLIENT_ID,
        email: TEST_EMAIL,
        email_verified: true,
        exp: 9999999999,
        iat: 1,
      }),
    ).toString('base64url')
    const algNoneJwt = `${hdr}.${pay}.`

    const spy = vi.fn()
    const r = await requireAdmin(makeReq(algNoneJwt), googleEnv(),  { keys: spy })
    expect((r as Response).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('HS256 token does not call the key resolver → 401', async () => {
    const hs256Token = await new SignJWT({
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      email: TEST_EMAIL,
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('some-hs-secret'))

    const spy = vi.fn()
    const r = await requireAdmin(makeReq(hs256Token), googleEnv(),  { keys: spy })
    expect((r as Response).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('RS256 token with no kid in header → 401 without calling key resolver', async () => {
    const tampered = await noKidJwt()
    const spy = vi.fn()
    const r = await requireAdmin(makeReq(tampered), googleEnv(),  { keys: spy })
    expect((r as Response).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('two keys in JWKS — k2-signed JWT is verified using the k2 key (kid selection)', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const twoKeys = await twoKeyJwks()
    const jwtK2 = await validJwt({}, { useK2: true })
    const r = await requireAdmin(makeReq(jwtK2), googleEnv({ db }),  { keys: twoKeys })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('two keys in JWKS — k1-signed JWT is verified using the k1 key (kid selection)', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const twoKeys = await twoKeyJwks()
    const jwtK1 = await validJwt()
    const r = await requireAdmin(makeReq(jwtK1), googleEnv({ db }),  { keys: twoKeys })
    expect(r).toEqual({ email: TEST_EMAIL })
  })
})

// ============================================================
// Config: GOOGLE_CLIENT_ID
// ============================================================

describe('requireAdmin — GOOGLE_CLIENT_ID misconfiguration → 401 + console.error', () => {
  afterEach(() => vi.restoreAllMocks())

  it('empty GOOGLE_CLIENT_ID → 401 and logs admin: misconfigured exactly once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), googleEnv({ clientId: '' }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('GOOGLE_CLIENT_ID does not end with .apps.googleusercontent.com → 401 + misconfigured', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      googleEnv({ clientId: 'just-a-random-id' }), 
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('GOOGLE_CLIENT_ID ends with .apps.googleusercontent.com → config OK (no misconfigured logged on 401)', async () => {
    // The client id is valid; any 401 comes from verification failure, not misconfigured.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    const misconfiguredCalls = spy.mock.calls.filter((c) => c[0] === 'admin: misconfigured')
    // misconfigured not logged because config (GOOGLE_CLIENT_ID) is valid.
    expect(misconfiguredCalls).toHaveLength(0)
  })

  it('invalid-config (empty GOOGLE_CLIENT_ID) → zero DDL (config checked before DB)', async () => {
    const { db, state } = testDb()
    const jwt = await validJwt()
    await requireAdmin(makeReq(jwt), googleEnv({ clientId: '', db }),  { keys: await localJwks() })
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })
})

// ============================================================
// Config: AUTH_DEV_MODE and AUTH_DEV_JWKS_URL
// ============================================================

describe('requireAdmin — AUTH_DEV_MODE', () => {
  afterEach(() => vi.restoreAllMocks())

  it('AUTH_DEV_MODE=1 with valid loopback URL and deps.keys → config OK, token verified via deps', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      googleEnv({ devMode: '1', devJwksUrl: 'http://127.0.0.1:12345/certs', db }), 
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('AUTH_DEV_MODE=1 with missing AUTH_DEV_JWKS_URL → 401 + admin: misconfigured (fail closed)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      googleEnv({ devMode: '1' /* devJwksUrl absent */ }), 
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
  })

  it('AUTH_DEV_MODE=1 with non-loopback URL (https://) → 401 + misconfigured', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      googleEnv({ devMode: '1', devJwksUrl: 'https://accounts.google.com/certs' }), 
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
  })

  it('AUTH_DEV_MODE=1 with http://127.0.0.1.evil.com → 401 + misconfigured (hostname bypass rejected)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      googleEnv({ devMode: '1', devJwksUrl: 'http://127.0.0.1.evil.com/certs' }), 
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
  })

  it('AUTH_DEV_MODE=1 with non-loopback IP (10.0.0.1) → 401 + misconfigured', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      googleEnv({ devMode: '1', devJwksUrl: 'http://10.0.0.1:1234/certs' }), 
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
  })

  it('AUTH_DEV_MODE="2" (non-"1") — invalid JWKS URL is ignored, token verified normally', async () => {
    // With AUTH_DEV_MODE !== '1', auth.ts must NOT validate or use AUTH_DEV_JWKS_URL.
    // A meaningful assertion: token succeeds and no misconfigured is logged for the URL.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      googleEnv({ devMode: '2', devJwksUrl: 'invalid://bad-url', db }),
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
    expect(spy).not.toHaveBeenCalledWith('admin: misconfigured')
  })

  it('AUTH_DEV_MODE unset — JWKS URL present but ignored, token verified normally', async () => {
    // Without AUTH_DEV_MODE, auth.ts must NOT validate or honor AUTH_DEV_JWKS_URL.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      googleEnv({ devJwksUrl: 'http://10.0.0.1:1234/non-loopback', db }),
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
    expect(spy).not.toHaveBeenCalledWith('admin: misconfigured')
  })
})

// ============================================================
// Rate limiting (checked first, zero DB prepares)
// ============================================================

describe('requireAdmin — rate limiting', () => {
  it('valid JWT while ADMIN_FAIL_LIMIT exhausted → 429', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt),
      googleEnv({ failLimit: false }), 
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(429)
  })

  it('no JWT + rate limit exhausted → 429 (rate limit checked before JWT)', async () => {
    const r = await requireAdmin(
      makeReq(null),
      googleEnv({ failLimit: false }), 
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(429)
  })

  it('rate limit exhausted → zero DB prepares (DB never touched)', async () => {
    const jwt = await validJwt()
    const { db, state } = testDb()
    await requireAdmin(makeReq(jwt), googleEnv({ failLimit: false, db }),  { keys: await localJwks() })
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })
})

// ============================================================
// CSRF: X-Requested-With and Sec-Fetch-Site
// ============================================================

describe('requireAdmin — CSRF checks', () => {
  let db: D1

  beforeEach(async () => {
    ;({ db } = testDb())
    await seedAdmin(db, TEST_EMAIL)
  })

  it('POST with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'POST', noXrw: true }), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(403)
  })

  it('PUT with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'PUT', noXrw: true }), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(403)
  })

  it('DELETE with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'DELETE', noXrw: true }), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(403)
  })

  it('HEAD with valid JWT but no X-Requested-With → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'HEAD', noXrw: true }), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(403)
  })

  it('OPTIONS with valid JWT but no X-Requested-With → 403 (no CORS headers emitted)', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'OPTIONS', noXrw: true }), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(403)
    // OPTIONS must never return CORS headers on /api/admin/*
    expect((r as Response).headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect((r as Response).headers.get('Access-Control-Allow-Methods')).toBeNull()
    expect((r as Response).headers.get('Access-Control-Allow-Headers')).toBeNull()
  })

  it('POST with valid JWT AND X-Requested-With: fetch → returns { email }', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'POST' }), googleEnv({ db }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('GET with valid JWT and no X-Requested-With → returns { email } (GET is exempt from CSRF)', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
  })

  it('GET with Sec-Fetch-Site: cross-site → 403 forbidden', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { secFetchSite: 'cross-site' }),
      googleEnv({ db }), 
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(403)
  })

  it('POST with Sec-Fetch-Site: cross-site and X-Requested-With → 403 (Sec-Fetch-Site wins)', async () => {
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { method: 'POST', secFetchSite: 'cross-site' }),
      googleEnv({ db }), 
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
      googleEnv({ db: freshDb }), 
      { keys: await localJwks() },
    )
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('cross-site GET → zero DB prepares (Sec-Fetch-Site checked before DB)', async () => {
    const { db: freshDb, state } = testDb()
    await seedAdmin(freshDb, TEST_EMAIL)
    state.prepares = 0
    const jwt = await validJwt()
    await requireAdmin(
      makeReq(jwt, { secFetchSite: 'cross-site' }),
      googleEnv({ db: freshDb }), 
      { keys: await localJwks() },
    )
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('cross-site POST → zero DDL (Sec-Fetch-Site checked before ensureSchema)', async () => {
    const { db: freshDb, state } = testDb()
    await seedAdmin(freshDb, TEST_EMAIL)
    state.prepares = 0
    const jwt = await validJwt()
    await requireAdmin(
      makeReq(jwt, { method: 'POST', secFetchSite: 'cross-site' }),
      googleEnv({ db: freshDb }), 
      { keys: await localJwks() },
    )
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })
})

// ============================================================
// Error response shape
// ============================================================

describe('requireAdmin — error response shape', () => {
  it('error responses carry Cache-Control, X-Content-Type-Options, X-Robots-Tag', async () => {
    const r = await requireAdmin(makeReq(null), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).headers.get('Cache-Control')).toBe('no-store')
    expect((r as Response).headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect((r as Response).headers.get('X-Robots-Tag')).toBe('noindex')
  })

  it('error response body is JSON with { error } field', async () => {
    const r = await requireAdmin(makeReq(null), googleEnv(),  { keys: await localJwks() })
    const body = await (r as Response).json() as { error?: string }
    expect(typeof body?.error).toBe('string')
  })

  it('403 response body has error: forbidden', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { method: 'POST', noXrw: true }), googleEnv({ db }),  { keys: await localJwks() })
    const body = await (r as Response).json() as { error?: string }
    expect(body?.error).toBe('forbidden')
  })
})

// ============================================================
// Key resolver error logging — jwks_error only for fetch failures, not for unknown kid
// ============================================================

describe('requireAdmin — jwks_error logging', () => {
  afterEach(() => vi.restoreAllMocks())

  it('key resolver throws (simulated fetch failure) → 401 and logs admin: jwks_error once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await validJwt()
    const throwingResolver: JWTVerifyGetKey = vi.fn().mockRejectedValue(
      new Error('simulated JWKS fetch failure'),
    )
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: throwingResolver })
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: jwks_error')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toBe('admin: jwks_error')
  })

  it('well-formed token with unknown kid → 401 and NO jwks_error logged (JWKSNoMatchingKey is not a fetch error)', async () => {
    // localJwks() only knows kid 'k1'; a token with kid 'unknown' triggers JWKSNoMatchingKey.
    // The new auth.ts must NOT log admin: jwks_error for this case — unknown kid is a token
    // issue, not a JWKS fetch failure.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jwt = await signJwt(
      {
        iss: 'https://accounts.google.com',
        aud: TEST_CLIENT_ID,
        email: TEST_EMAIL,
        email_verified: true,
      },
      { kid: 'unknown-kid' },
    )
    const r = await requireAdmin(makeReq(jwt), googleEnv(),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    // admin: jwks_error must NOT be logged for an unknown kid
    expect(spy).not.toHaveBeenCalledWith('admin: jwks_error')
  })
})

// ============================================================
// Logging discipline — fixed strings only, never JWT/email/client_id/iss
// ============================================================

describe('requireAdmin — logging discipline', () => {
  afterEach(() => vi.restoreAllMocks())

  it('console.error/warn never contain JWT, email, CLIENT_ID, or iss', async () => {
    const errorCalls: unknown[][] = []
    const warnCalls: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => { errorCalls.push(args) })
    vi.spyOn(console, 'warn').mockImplementation((...args) => { warnCalls.push(args) })

    const jwt = await validJwt()
    const keys = await localJwks()

    // Trigger several error paths
    await requireAdmin(makeReq(jwt), googleEnv({ clientId: '' }),  { keys })
    // Non-admin on a table that has other admins
    const { db } = testDb()
    await seedAdmin(db, 'other-admin@gmail.com')
    await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys })
    await requireAdmin(makeReq('garbage.jwt.value'), googleEnv(),  { keys })

    for (const call of [...errorCalls, ...warnCalls]) {
      const msg = call.map(String).join(' ')
      expect(msg, 'must not log JWT token').not.toContain(jwt)
      expect(msg, 'must not log email').not.toContain(TEST_EMAIL)
      expect(msg, 'must not log CLIENT_ID').not.toContain(TEST_CLIENT_ID)
      expect(msg, 'must not log iss').not.toContain('https://accounts.google.com')
    }
  })
})

// ============================================================
// Bootstrap flow — ALLOW_FIRST_CLAIM
// ============================================================

describe('requireAdmin — bootstrap: ALLOW_FIRST_CLAIM', () => {
  afterEach(() => vi.restoreAllMocks())

  it('ALLOW_FIRST_CLAIM=1, empty table, GET + X-Requested-With → returns { email }, row has created_by=bootstrap', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      googleEnv({ db, allowFirstClaim: '1' }), 
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
    await requireAdmin(makeReq(jwt, { xrw: true }), googleEnv({ db, allowFirstClaim: '1' }),  { keys: await localJwks() })
    for (const call of spy.mock.calls) {
      expect(call.map(String).join(' ')).not.toContain(TEST_EMAIL)
    }
  })

  it('second different user after bootstrap → 401, no extra row', async () => {
    const { db } = testDb()
    const jwt1 = await validJwt()
    // First user claims bootstrap
    await requireAdmin(makeReq(jwt1, { xrw: true }), googleEnv({ db, allowFirstClaim: '1' }),  { keys: await localJwks() })
    // Second user (different email) → 401
    const jwt2 = await validJwt({ email: 'stranger@gmail.com' })
    const r2 = await requireAdmin(makeReq(jwt2, { xrw: true }), googleEnv({ db, allowFirstClaim: '1' }),  { keys: await localJwks() })
    expect((r2 as Response).status).toBe(401)
    // Only one row in admin table
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('same user twice → both succeed, exactly one admin row', async () => {
    const { db } = testDb()
    const jwt = await validJwt()
    const r1 = await requireAdmin(makeReq(jwt, { xrw: true }), googleEnv({ db, allowFirstClaim: '1' }),  { keys: await localJwks() })
    const r2 = await requireAdmin(makeReq(jwt, { xrw: true }), googleEnv({ db, allowFirstClaim: '1' }),  { keys: await localJwks() })
    expect(r1).toEqual({ email: TEST_EMAIL })
    expect(r2).toEqual({ email: TEST_EMAIL })
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('Promise.all two different first users → exactly one 200 and one 401, one row', async () => {
    const { db } = testDb()
    const env = googleEnv({ db, allowFirstClaim: '1' })
    const keys = await localJwks()
    const jwt1 = await validJwt({ email: TEST_EMAIL })
    const jwt2 = await validJwt({ email: 'other@gmail.com' })
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
    const env = googleEnv({ db, allowFirstClaim: '1' })
    const keys = await localJwks()
    const jwt = await validJwt()
    const [r1, r2] = await Promise.all([
      requireAdmin(makeReq(jwt, { xrw: true }), env, { keys }),
      requireAdmin(makeReq(jwt, { xrw: true }), env, { keys }),
    ])
    expect(r1).toEqual({ email: TEST_EMAIL })
    expect(r2).toEqual({ email: TEST_EMAIL })
  })

  it('neither BOOTSTRAP_EMAIL nor ALLOW_FIRST_CLAIM → 401 and logs admin: misconfigured', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { xrw: true }), googleEnv({ db }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
  })

  it('admin: misconfigured NOT logged when non-admin calls on populated table', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    await seedAdmin(db, 'other-admin@gmail.com')
    const jwt = await validJwt({ email: 'stranger@gmail.com' })
    await requireAdmin(makeReq(jwt, { xrw: true }), googleEnv({ db }),  { keys: await localJwks() })
    const misconfiguredCalls = spy.mock.calls.filter((c) => c[0] === 'admin: misconfigured')
    expect(misconfiguredCalls).toHaveLength(0)
  })

  it('leftover ALLOW_FIRST_CLAIM is inert for existing admin (no extra row)', async () => {
    const { db } = testDb()
    await seedAdmin(db, TEST_EMAIL)
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db, allowFirstClaim: '1' }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('leftover ALLOW_FIRST_CLAIM is inert when table non-empty (non-admin caller → 401, no insert)', async () => {
    const { db } = testDb()
    await seedAdmin(db, 'other-admin@gmail.com')
    const jwt = await validJwt({ email: 'stranger@gmail.com' })
    const r = await requireAdmin(makeReq(jwt, { xrw: true }), googleEnv({ db, allowFirstClaim: '1' }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('bootstrap GET without X-Requested-With → 403 (required for bootstrap write)', async () => {
    const { db } = testDb()
    const jwt = await validJwt()
    // No xrw, no X-Requested-With on GET
    const r = await requireAdmin(makeReq(jwt), googleEnv({ db, allowFirstClaim: '1' }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(403)
  })

  it('exactly two prepare() calls for the bootstrap write (1 SELECT + 1 INSERT)', async () => {
    const { db, state } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { xrw: true }), googleEnv({ db, allowFirstClaim: '1' }),  { keys: await localJwks() })
    expect(r).toEqual({ email: TEST_EMAIL })
    // 1 SELECT (email check) + 1 INSERT (bootstrap write) = 2 prepare() calls
    expect(state.prepares).toBe(2)
  })

  it('DB error during bootstrap → requireAdmin rejects, no row inserted', async () => {
    const { db, state } = testDb()
    state.fail = true
    const jwt = await validJwt()
    await expect(
      requireAdmin(makeReq(jwt, { xrw: true }), googleEnv({ db, allowFirstClaim: '1' }),  { keys: await localJwks() })
    ).rejects.toThrow()
    state.fail = false
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })

  it('DDL failure on first request → requireAdmin rejects, no admin row inserted, no grant', async () => {
    const { db, state, sqlite } = testDb({ schema: false })
    state.fail = true
    const jwt = await validJwt()
    await expect(
      requireAdmin(makeReq(jwt, { xrw: true }), googleEnv({ db, allowFirstClaim: '1' }),  { keys: await localJwks() })
    ).rejects.toThrow()
    state.fail = false
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables).toHaveLength(0)
  })
})

// ============================================================
// Bootstrap flow — BOOTSTRAP_EMAIL
// ============================================================

describe('requireAdmin — bootstrap: BOOTSTRAP_EMAIL', () => {
  afterEach(() => vi.restoreAllMocks())

  it('BOOTSTRAP_EMAIL matches caller → allowed, row inserted', async () => {
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      googleEnv({ db, bootstrapEmail: TEST_EMAIL }), 
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
      googleEnv({ db, bootstrapEmail: 'different@gmail.com' }), 
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
      googleEnv({ db, bootstrapEmail: '' }), 
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
  })

  it('BOOTSTRAP_EMAIL present, ALLOW_FIRST_CLAIM=1, non-matching caller → 401 (BOOTSTRAP_EMAIL takes precedence)', async () => {
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      googleEnv({ db, bootstrapEmail: 'specific@gmail.com', allowFirstClaim: '1' }), 
      { keys: await localJwks() },
    )
    expect((r as Response).status).toBe(401)
  })

  it('BOOTSTRAP_EMAIL matches case-insensitively (stored trimmed lower)', async () => {
    const { db } = testDb()
    const jwt = await validJwt({ email: TEST_EMAIL })
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      googleEnv({ db, bootstrapEmail: TEST_EMAIL.toUpperCase() }), 
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
      googleEnv({ db, bootstrapEmail: TEST_EMAIL }), 
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it('zero DB prepares when JWT is bad (DB never reached)', async () => {
    const { db, state } = testDb()
    await requireAdmin(makeReq('garbage.jwt.value'), googleEnv({ db, bootstrapEmail: TEST_EMAIL }),  { keys: await localJwks() })
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })
})

// ============================================================
// Bootstrap — ALLOW_FIRST_CLAIM exact '1' gate
// ============================================================

describe('requireAdmin — ALLOW_FIRST_CLAIM non-"1" values → 401 + misconfigured', () => {
  afterEach(() => vi.restoreAllMocks())

  it('ALLOW_FIRST_CLAIM="0" → 401, admin: misconfigured, no row inserted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { xrw: true }), googleEnv({ db, allowFirstClaim: '0' }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })

  it('ALLOW_FIRST_CLAIM="true" → 401, admin: misconfigured, no row inserted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { xrw: true }), googleEnv({ db, allowFirstClaim: 'true' }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })

  it('ALLOW_FIRST_CLAIM="" → 401, admin: misconfigured, no row inserted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(makeReq(jwt, { xrw: true }), googleEnv({ db, allowFirstClaim: '' }),  { keys: await localJwks() })
    expect((r as Response).status).toBe(401)
    expect(spy).toHaveBeenCalledWith('admin: misconfigured')
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })
})

// ============================================================
// BOOTSTRAP_EMAIL padding
// ============================================================

describe('requireAdmin — BOOTSTRAP_EMAIL padding', () => {
  it('BOOTSTRAP_EMAIL padded with spaces is trimmed and matches caller email', async () => {
    const { db } = testDb()
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      googleEnv({ db, bootstrapEmail: `  ${TEST_EMAIL}  ` }), 
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
      googleEnv({ db, bootstrapEmail: `  ${TEST_EMAIL.toUpperCase()}  ` }), 
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
  })
})

// ============================================================
// Zero DB prepares before email shape check
// ============================================================

describe('requireAdmin — zero DB prepares before email shape check', () => {
  it('non-string email claim (number) → zero DB prepares', async () => {
    const { db, state } = testDb()
    const jwt = await validJwt({ email: 123 })
    await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('missing email claim → zero DB prepares', async () => {
    const { db, state } = testDb()
    const jwt = await signJwt({
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      email_verified: true,
    })
    await requireAdmin(makeReq(jwt), googleEnv({ db }),  { keys: await localJwks() })
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })
})

// ============================================================
// ensureSchema integration (empty DB)
// ============================================================

describe('requireAdmin — empty DB: admin bootstrap (ensureSchema integration)', () => {
  it('ALLOW_FIRST_CLAIM=1 on a table-less DB bootstraps successfully (ensureSchema creates tables first)', async () => {
    const { db, state } = testDb({ schema: false })
    const jwt = await validJwt()
    const r = await requireAdmin(
      makeReq(jwt, { xrw: true }),
      googleEnv({ db, allowFirstClaim: '1' }), 
      { keys: await localJwks() },
    )
    expect(r).toEqual({ email: TEST_EMAIL })
    expect(state.ddl).toBeGreaterThan(0)
  })

  it('second admin request on the same DB issues no DDL (WeakMap cache hit)', async () => {
    const { db, state } = testDb({ schema: false })
    const jwt = await validJwt()
    await requireAdmin(
      makeReq(jwt, { xrw: true }),
      googleEnv({ db, allowFirstClaim: '1' }), 
      { keys: await localJwks() },
    )
    const ddlAfterFirst = state.ddl
    await requireAdmin(
      makeReq(jwt),
      googleEnv({ db }), 
      { keys: await localJwks() },
    )
    expect(state.ddl).toBe(ddlAfterFirst)
  })

  it('two concurrent first-claim requests on empty DB → exactly one admin row', async () => {
    const { db } = testDb({ schema: false })
    const env = googleEnv({ db, allowFirstClaim: '1' })
    const keys = await localJwks()
    const jwt1 = await validJwt({ email: TEST_EMAIL })
    const jwt2 = await validJwt({ email: 'other@gmail.com' })
    const [r1, r2] = await Promise.all([
      requireAdmin(makeReq(jwt1, { xrw: true }), env, { keys }),
      requireAdmin(makeReq(jwt2, { xrw: true }), env, { keys }),
    ])
    const statuses = [r1, r2]
      .map((r) => (r instanceof Response ? r.status : 200))
      .sort()
    expect(statuses).toEqual([200, 401])
    const count = await db.prepare('SELECT COUNT(*) as c FROM admin').first<{ c: number }>()
    expect(count?.c).toBe(1)
  })
})

describe('requireAdmin — DDL failure (ensureSchema integration)', () => {
  it('DDL failure → requireAdmin rejects (503 path), no admin row inserted, no grant', async () => {
    const { db, state, sqlite } = testDb({ schema: false })
    state.fail = true
    const jwt = await validJwt()
    await expect(
      requireAdmin(
        makeReq(jwt, { xrw: true }),
        googleEnv({ db, allowFirstClaim: '1' }), 
        { keys: await localJwks() },
      )
    ).rejects.toThrow()
    state.fail = false
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables).toHaveLength(0)
  })

  it('DDL failure issues DDL prepares but zero non-DDL prepares', async () => {
    const { db, state } = testDb({ schema: false })
    state.fail = true
    const jwt = await validJwt()
    await expect(
      requireAdmin(
        makeReq(jwt, { xrw: true }),
        googleEnv({ db, allowFirstClaim: '1' }), 
        { keys: await localJwks() },
      )
    ).rejects.toThrow()
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBeGreaterThan(0)
  })
})

// ============================================================
// parseConfig — production JWKS URL
// ============================================================

describe('parseConfig — production JWKS URL', () => {
  it('valid GOOGLE_CLIENT_ID with no dev mode → production Google JWKS URL', () => {
    const config = parseConfig({
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      AUTH_DEV_MODE: undefined,
      AUTH_DEV_JWKS_URL: undefined,
    })
    expect(config).not.toBeNull()
    expect(config!.certsUrl.href).toBe('https://www.googleapis.com/oauth2/v3/certs')
  })
})
