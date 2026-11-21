// @vitest-environment node
/**
 * RED-phase tests for worker/me.ts (auth handler + profile endpoints).
 *
 * Contract:
 *   handleAuth(request, env, deps?) handles:
 *     GET  /api/auth/nonce   → sets nonce cookie, Cache-Control: no-store
 *     POST /api/auth/google  → verify token + nonce, upsert user, set session cookie
 *     POST /api/auth/logout  → revoke session, clear session cookie
 *
 *   handleMe(request, env) handles:
 *     GET  /api/me            → { user|null, isAdmin }, no-store
 *     PUT  /api/me            → { nickname (1–30), className (≤10) }
 *
 * Guards for POST /api/auth/google:
 *   - X-Requested-With: fetch required (missing → 403)
 *   - Content-Type: application/json required
 *   - Sec-Fetch-Site: cross-site → 403
 *   - Nonce claim must match nonce cookie; both cleared on attempt
 *   - Presented session deleted (session fixation prevention)
 *   - No Access-Control-Allow-* headers on any response
 *
 * Tests fail at import because worker/me.ts does not exist yet.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
// --- Module under test does not exist yet; import triggers red phase ---
import { handleAuth, handleMe } from './me.ts'
import { testDb } from './testDb.ts'
import {
  createNewTables,
  seedUser,
  seedSession,
  seedAdminEmail,
  makeRawToken,
  makeNonce,
  makeExpiredNonce,
  validToken,
  localJwks,
  meEnv,
  SESSION_COOKIE_NAME,
  NONCE_COOKIE_NAME,
  TEST_EMAIL,
  TEST_SUB,
  TEST_NONCE_KEY,
  TEST_CLIENT_ID,
} from './testGoogle.ts'

/** Get all Set-Cookie header values, handling both Cloudflare Workers (getAll) and Node.js 22 (getSetCookie). */
function getSetCookies(res: Response): string[] {
  const h = res.headers as typeof res.headers & { getAll?: (n: string) => string[]; getSetCookie?: () => string[] }
  return h.getAll?.('Set-Cookie') ?? h.getSetCookie?.() ?? [h.get('Set-Cookie') ?? '']
}

// ── Helper: build POST /api/auth/google request ───────────────────────────────

function makeSignInReq(
  credential: string,
  nonceCookie: string,
  opts: { noXrw?: boolean; crossSite?: boolean; noContentType?: boolean } = {},
): Request {
  const headers: Record<string, string> = {
    'CF-Connecting-IP': '1.2.3.4',
    'Content-Type': opts.noContentType ? 'text/plain' : 'application/json',
  }
  if (!opts.noXrw) headers['X-Requested-With'] = 'fetch'
  if (opts.crossSite) headers['Sec-Fetch-Site'] = 'cross-site'
  if (nonceCookie) headers['Cookie'] = `${NONCE_COOKIE_NAME}=${nonceCookie}`
  return new Request('https://x/api/auth/google', {
    method: 'POST',
    headers,
    body: JSON.stringify({ credential }),
  })
}

// ── GET /api/auth/nonce ───────────────────────────────────────────────────────

describe('GET /api/auth/nonce — clientId delivery (decisions.md 2026-11-16 item 3)', () => {
  it('response includes clientId equal to env.GOOGLE_CLIENT_ID when set', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    // meEnv sets GOOGLE_CLIENT_ID = TEST_CLIENT_ID by default
    const env = meEnv({ db })
    const req = new Request('https://x/api/auth/nonce', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    const r = await handleAuth(req, env)
    expect(r.status).toBe(200)
    const body = await r.json() as { nonce?: string; clientId?: string }
    expect(typeof body.clientId).toBe('string')
    expect(body.clientId).toBe(TEST_CLIENT_ID)
  })

  it('clientId is empty string when GOOGLE_CLIENT_ID is absent', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    // Build env without GOOGLE_CLIENT_ID
    const envNoId = {
      DB: db,
      GOOGLE_CLIENT_ID: undefined as unknown as string,
      NONCE_KEY: TEST_NONCE_KEY,
      AUTH_LIMIT: { limit: async () => ({ success: true }) },
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    }
    const req = new Request('https://x/api/auth/nonce', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    const r = await handleAuth(req, envNoId)
    expect(r.status).toBe(200)
    const body = await r.json() as { nonce?: string; clientId?: string }
    expect(body.clientId).toBe('')
  })
})

describe('GET /api/auth/nonce', () => {
  it('returns 200 with { nonce } body and sets __Host-cyt_n cookie', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })

    const req = new Request('https://x/api/auth/nonce', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    const r = await handleAuth(req, env)

    expect(r.status).toBe(200)
    const body = await r.json() as { nonce?: string }
    expect(typeof body.nonce).toBe('string')
    expect(body.nonce!.split('.').length).toBe(3)  // rand.expiry.hmac format

    const setCookie = r.headers.get('Set-Cookie')
    expect(setCookie).toContain(`${NONCE_COOKIE_NAME}=`)
    expect(setCookie).toContain('Max-Age=300')
    expect(setCookie).toContain('HttpOnly')
  })

  it('response has Cache-Control: no-store', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })

    const req = new Request('https://x/api/auth/nonce', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    const r = await handleAuth(req, env)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
  })

  it('response has no Access-Control-Allow-* headers', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const req = new Request('https://x/api/auth/nonce', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    const r = await handleAuth(req, env)
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Methods')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Headers')).toBeNull()
  })
})

// ── POST /api/auth/google — full sign-in flow ────────────────────────────────

describe('POST /api/auth/google — successful sign-in', () => {
  it('valid token + matching nonce → 200, sets __Host-cyt_s cookie, creates user', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue }, )
    const req = makeSignInReq(credential, nonceValue)

    const r = await handleAuth(req, env, { keys: await localJwks() })

    expect(r.status).toBe(200)
    const setCookie = getSetCookies(r)
    const sessionCookieHeader = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
    expect(sessionCookieHeader).toBeDefined()
    expect(sessionCookieHeader).toContain('HttpOnly')
    expect(sessionCookieHeader).toContain('Secure')
    expect(sessionCookieHeader).toContain('SameSite=Lax')
    expect(sessionCookieHeader).not.toContain('Domain=')

    // User created in DB
    const user = sqlite
      .prepare('SELECT google_sub, email FROM app_user WHERE google_sub = ?')
      .get(TEST_SUB) as { google_sub: string; email: string } | undefined
    expect(user).toBeDefined()
    expect(user?.google_sub).toBe(TEST_SUB)
  })

  it('response body has { user: { nickname, className, isAdmin } }', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const req = makeSignInReq(credential, nonceValue)

    const r = await handleAuth(req, env, { keys: await localJwks() })
    const body = await r.json() as { user?: { nickname?: string; className?: string; isAdmin?: boolean } }
    expect(body.user).toBeDefined()
    expect(typeof body.user?.nickname).toBe('string')
    expect(typeof body.user?.className).toBe('string')
    expect(typeof body.user?.isAdmin).toBe('boolean')
  })

  it('response has no Access-Control-Allow-* headers', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const req = makeSignInReq(credential, nonceValue)

    const r = await handleAuth(req, env, { keys: await localJwks() })
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Methods')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Headers')).toBeNull()
  })

  it('presented session cookie is deleted (session fixation prevention)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })

    // Create an existing session
    const userId = await seedUser(db)
    const oldToken = makeRawToken()
    await seedSession(db, userId, oldToken)

    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ sub: TEST_SUB, nonce: nonceValue })

    const headers: Record<string, string> = {
      'CF-Connecting-IP': '1.2.3.4',
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch',
      Cookie: `${SESSION_COOKIE_NAME}=${oldToken}; ${NONCE_COOKIE_NAME}=${nonceValue}`,
    }
    const req = new Request('https://x/api/auth/google', {
      method: 'POST',
      headers,
      body: JSON.stringify({ credential }),
    })

    await handleAuth(req, env, { keys: await localJwks() })

    // Old session must be gone (check the specific old token hash)
    const { sha256Hex: sha256HexFn } = await import('./testGoogle.ts')
    const oldHash = await sha256HexFn(oldToken)
    const oldRow = sqlite.prepare('SELECT 1 FROM session WHERE token_hash = ?').get(oldHash)
    expect(oldRow).toBeUndefined()
  })

  it('nonce cookie is cleared in the response (Max-Age=0) on successful sign-in', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const req = makeSignInReq(credential, nonceValue)

    const r = await handleAuth(req, env, { keys: await localJwks() })
    // Use getAll (Cloudflare Workers) or getSetCookie (Node.js 22) for Set-Cookie headers
    const h = r.headers as typeof r.headers & { getAll?: (n: string) => string[]; getSetCookie?: () => string[] }
    const headers = h.getAll?.('Set-Cookie') ?? h.getSetCookie?.() ?? [h.get('Set-Cookie') ?? '']
    const nonceClear = headers.find((c) => c.startsWith(`${NONCE_COOKIE_NAME}=`) && c.includes('Max-Age=0'))
    expect(nonceClear).toBeDefined()
  })

  it('signed-in user admin flag is true when email is in admin table', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    await seedAdminEmail(db, TEST_EMAIL)
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const req = makeSignInReq(credential, nonceValue)

    const r = await handleAuth(req, env, { keys: await localJwks() })
    const body = await r.json() as { user?: { isAdmin?: boolean } }
    expect(body.user?.isAdmin).toBe(true)
  })
})

// ── POST /api/auth/google — CSRF guards ───────────────────────────────────────

describe('POST /api/auth/google — CSRF guards', () => {
  it('missing X-Requested-With → 403', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const req = makeSignInReq(credential, nonceValue, { noXrw: true })

    const r = await handleAuth(req, env, { keys: await localJwks() })
    expect(r.status).toBe(403)
  })

  it('Sec-Fetch-Site: cross-site → 403', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const req = makeSignInReq(credential, nonceValue, { crossSite: true })

    const r = await handleAuth(req, env, { keys: await localJwks() })
    expect(r.status).toBe(403)
  })

  it('cross-site: no session cookie set even if token is valid', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const req = makeSignInReq(credential, nonceValue, { crossSite: true })

    const r = await handleAuth(req, env, { keys: await localJwks() })
    const setCookies = getSetCookies(r)
    const sessionCookieSet = setCookies.some(
      (c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && !c.includes('Max-Age=0'),
    )
    expect(sessionCookieSet).toBe(false)
  })
})

// ── POST /api/auth/google — nonce validation ──────────────────────────────────

describe('POST /api/auth/google — nonce validation', () => {
  it('wrong nonce (token nonce ≠ cookie nonce) → 401, no session created', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const { nonceValue: cookieNonce } = await makeNonce(TEST_NONCE_KEY)
    const { nonceValue: tokenNonce } = await makeNonce(TEST_NONCE_KEY)
    // Different nonces in cookie vs token claim
    const credential = await validToken({ nonce: tokenNonce })
    const req = makeSignInReq(credential, cookieNonce)

    const r = await handleAuth(req, env, { keys: await localJwks() })
    expect(r.status).toBe(401)
    const userCount = (
      sqlite.prepare('SELECT COUNT(*) AS c FROM app_user').get() as { c: number }
    ).c
    expect(userCount).toBe(0)
  })

  it('expired nonce → 401', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const expiredNonce = await makeExpiredNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: expiredNonce })
    const req = makeSignInReq(credential, expiredNonce)

    const r = await handleAuth(req, env, { keys: await localJwks() })
    expect(r.status).toBe(401)
  })

  it('no nonce cookie → 401', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    // No nonce cookie
    const req = makeSignInReq(credential, '')

    const r = await handleAuth(req, env, { keys: await localJwks() })
    expect(r.status).toBe(401)
  })

  it('nonce cookie always cleared on sign-in attempt — even when attempt fails', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: 'wrong-nonce-claim' })
    const req = makeSignInReq(credential, nonceValue)

    const r = await handleAuth(req, env, { keys: await localJwks() })
    // Even on 401, the nonce cookie must be cleared
    const headers = getSetCookies(r)
    const nonceClear = headers.find((c) => c.startsWith(`${NONCE_COOKIE_NAME}=`) && c.includes('Max-Age=0'))
    expect(nonceClear).toBeDefined()
  })
})

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  it('logout revokes session and clears session cookie (Max-Age=0)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const req = new Request('https://x/api/auth/logout', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        Cookie: `${SESSION_COOKIE_NAME}=${rawToken}`,
      },
    })
    const r = await handleAuth(req, env)
    expect(r.status).toBe(200)

    const setCookies = getSetCookies(r)
    const cleared = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && c.includes('Max-Age=0'))
    expect(cleared).toBeDefined()
  })

  it('logout with no session cookie is a no-op (200)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const req = new Request('https://x/api/auth/logout', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Requested-With': 'fetch' },
    })
    const r = await handleAuth(req, env)
    expect(r.status).toBe(200)
  })
})

// ── GET /api/me ───────────────────────────────────────────────────────────────

describe('GET /api/me', () => {
  it('anonymous request → 200 { user: null, isAdmin: false }', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })

    const req = new Request('https://x/api/me', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    const r = await handleMe(req, env)

    expect(r.status).toBe(200)
    const body = await r.json() as { user: unknown; isAdmin: boolean }
    expect(body.user).toBeNull()
    expect(body.isAdmin).toBe(false)
  })

  it('signed-in non-admin → { user: {...}, isAdmin: false }', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const req = new Request('https://x/api/me', {
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        Cookie: `${SESSION_COOKIE_NAME}=${rawToken}`,
      },
    })
    const r = await handleMe(req, env)
    const body = await r.json() as { user: unknown; isAdmin: boolean }
    expect(body.user).not.toBeNull()
    expect(body.isAdmin).toBe(false)
  })

  it('signed-in admin → { user: {...}, isAdmin: true }', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    await seedAdminEmail(db, TEST_EMAIL)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const req = new Request('https://x/api/me', {
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        Cookie: `${SESSION_COOKIE_NAME}=${rawToken}`,
      },
    })
    const r = await handleMe(req, env)
    const body = await r.json() as { user: unknown; isAdmin: boolean }
    expect(body.isAdmin).toBe(true)
  })

  it('response has Cache-Control: no-store', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const req = new Request('https://x/api/me', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    const r = await handleMe(req, env)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
  })

  it('response has no Access-Control-Allow-* headers', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const req = new Request('https://x/api/me', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    const r = await handleMe(req, env)
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Methods')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Headers')).toBeNull()
  })
})

// ── PUT /api/me ───────────────────────────────────────────────────────────────

describe('PUT /api/me — profile update', () => {
  it('valid nickname (1–30 chars) and className (≤10 chars) → 200, user updated', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const req = new Request('https://x/api/me', {
      method: 'PUT',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${rawToken}`,
      },
      body: JSON.stringify({ nickname: 'NewName', className: '12A' }),
    })
    const r = await handleMe(req, env)
    expect(r.status).toBe(200)
    const user = sqlite
      .prepare('SELECT nickname, class_name FROM app_user WHERE id = ?')
      .get(userId) as { nickname: string; class_name: string } | undefined
    expect(user?.nickname).toBe('NewName')
    expect(user?.class_name).toBe('12A')
  })

  it('nickname > 30 chars → 400', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const req = new Request('https://x/api/me', {
      method: 'PUT',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${rawToken}`,
      },
      body: JSON.stringify({ nickname: 'N'.repeat(31), className: '12A' }),
    })
    const r = await handleMe(req, env)
    expect(r.status).toBe(400)
  })

  it('nickname empty string → 400', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const req = new Request('https://x/api/me', {
      method: 'PUT',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${rawToken}`,
      },
      body: JSON.stringify({ nickname: '', className: '12A' }),
    })
    const r = await handleMe(req, env)
    expect(r.status).toBe(400)
  })

  it('className > 10 chars → 400', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const req = new Request('https://x/api/me', {
      method: 'PUT',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${rawToken}`,
      },
      body: JSON.stringify({ nickname: 'Valid', className: 'C'.repeat(11) }),
    })
    const r = await handleMe(req, env)
    expect(r.status).toBe(400)
  })

  it('unauthenticated PUT /api/me → 401', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })

    const req = new Request('https://x/api/me', {
      method: 'PUT',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ nickname: 'Valid', className: '11A' }),
    })
    const r = await handleMe(req, env)
    expect(r.status).toBe(401)
  })
})

// ── Logging discipline ────────────────────────────────────────────────────────

describe('logging discipline — email and sub never in logs', () => {
  afterEach(() => vi.restoreAllMocks())

  it('console.error never called with email or sub during sign-in', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const req = makeSignInReq(credential, nonceValue)

    const errorCalls: unknown[][] = []
    const warnCalls: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...a) => { errorCalls.push(a) })
    vi.spyOn(console, 'warn').mockImplementation((...a) => { warnCalls.push(a) })

    await handleAuth(req, env, { keys: await localJwks() })

    for (const call of [...errorCalls, ...warnCalls]) {
      const msg = call.map(String).join(' ')
      expect(msg, 'must not log email').not.toContain(TEST_EMAIL)
      expect(msg, 'must not log sub').not.toContain(TEST_SUB)
    }
  })

  it('console.error never called with email during failed sign-in (bad token)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    // Invalid credential (wrong nonce)
    const credential = await validToken({ nonce: 'wrong', email: TEST_EMAIL })
    const req = makeSignInReq(credential, nonceValue)

    const errorCalls: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...a) => { errorCalls.push(a) })

    await handleAuth(req, env, { keys: await localJwks() })

    for (const call of errorCalls) {
      expect(call.map(String).join(' ')).not.toContain(TEST_EMAIL)
    }
  })
})

// ===================================================================
// Fix Group 5a — new failing tests
// ===================================================================

// ---- Accept #5: resolveAdmin race (conditional pin) ----

describe('Fix Group 5a — Accept #5: resolveAdmin pins only WHERE google_sub IS NULL', () => {
  it('a second sub for the same admin email is refused after the sub is pinned', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    await seedAdminEmail(db, TEST_EMAIL)

    // First sign-in: pins TEST_SUB
    const { nonceValue: n1 } = await makeNonce(TEST_NONCE_KEY)
    const cred1 = await validToken({ nonce: n1, sub: TEST_SUB })
    await handleAuth(makeSignInReq(cred1, n1), env, { keys: await localJwks() })

    // Second sign-in with a DIFFERENT sub but same email
    const { nonceValue: n2 } = await makeNonce(TEST_NONCE_KEY)
    const differentSub = 'different-sub-99999'
    const cred2 = await validToken({ nonce: n2, sub: differentSub, email: TEST_EMAIL, email_verified: true })
    // Need to seed a second user with the different sub
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO app_user (google_sub, email, nickname, class_name, banned, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .bind(differentSub, TEST_EMAIL, '', '', now, now).run()

    const r = await handleAuth(makeSignInReq(cred2, n2), env, { keys: await localJwks() })
    // Different sub must be refused with 200 isAdmin: false (not elevated)
    // OR return 200 with isAdmin: false (the user gets a session but NOT admin access)
    // After fix: resolveAdmin refuses a different sub
    const body = await r.json() as { user?: { isAdmin?: boolean } }
    expect(body.user?.isAdmin).toBe(false)
  })

  it('resolveAdmin: UPDATE only WHERE google_sub IS NULL (re-reads on 0 changes, refuses different sub)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    // Seed admin with a pinned sub
    await seedAdminEmail(db, TEST_EMAIL)
    // Manually pin a sub
    const pinnedSub = 'pinned-sub-12345'
    await db.prepare('UPDATE admin SET google_sub = ? WHERE lower(email) = ?')
      .bind(pinnedSub, TEST_EMAIL).run()

    // Try to sign in with a different sub — resolveAdmin should refuse
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const differentSub = 'different-sub-99999'
    const cred = await validToken({ nonce: nonceValue, sub: differentSub, email: TEST_EMAIL, email_verified: true })
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO app_user (google_sub, email, nickname, class_name, banned, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .bind(differentSub, TEST_EMAIL, '', '', now, now).run()

    const r = await handleAuth(makeSignInReq(cred, nonceValue), meEnv({ db }), { keys: await localJwks() })
    const body = await r.json() as { user?: { isAdmin?: boolean } }
    expect(body.user?.isAdmin).toBe(false)
  })
})

// ---- Accept #6: missing or empty GOOGLE_CLIENT_ID → refuse ----

describe('Fix Group 5a — Accept #6: missing/empty GOOGLE_CLIENT_ID → sign-in refused', () => {
  it('empty GOOGLE_CLIENT_ID → 401 unauthorized (fail closed)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })

    // env with empty GOOGLE_CLIENT_ID
    const envNoId = {
      DB: db,
      GOOGLE_CLIENT_ID: '',  // empty string — misconfigured
      NONCE_KEY: TEST_NONCE_KEY,
      AUTH_LIMIT: { limit: async () => ({ success: true }) },
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    }

    const r = await handleAuth(makeSignInReq(credential, nonceValue), envNoId, { keys: await localJwks() })
    expect(r.status).toBe(401)
  })

  it('undefined GOOGLE_CLIENT_ID → 401 unauthorized (fail closed)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })

    const envNoId = {
      DB: db,
      GOOGLE_CLIENT_ID: undefined as unknown as string,
      NONCE_KEY: TEST_NONCE_KEY,
      AUTH_LIMIT: { limit: async () => ({ success: true }) },
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    }

    const r = await handleAuth(makeSignInReq(credential, nonceValue), envNoId, { keys: await localJwks() })
    expect(r.status).toBe(401)
  })

  it('missing GOOGLE_CLIENT_ID logs auth: misconfigured (not email/sub)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })

    const envNoId = {
      DB: db,
      GOOGLE_CLIENT_ID: '',
      NONCE_KEY: TEST_NONCE_KEY,
      AUTH_LIMIT: { limit: async () => ({ success: true }) },
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    }

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleAuth(makeSignInReq(credential, nonceValue), envNoId, { keys: await localJwks() })
    // Read calls BEFORE mockRestore (mockRestore clears mock.calls in Vitest)
    const logs = spy.mock.calls.map((a) => a.join(' '))
    spy.mockRestore()

    expect(logs.some((l) => l.includes('misconfigured'))).toBe(true)
    // Must not log email or sub
    for (const log of logs) {
      expect(log).not.toContain(TEST_EMAIL)
      expect(log).not.toContain(TEST_SUB)
    }
  })
})

// ---- Accept #7: rate limits ----

describe('Fix Group 5a — Accept #7: AUTH_LIMIT counts failures only', () => {
  it('AUTH_LIMIT is NOT charged on a successful sign-in', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    let authLimitCallCount = 0
    const env = {
      DB: db,
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      NONCE_KEY: TEST_NONCE_KEY,
      AUTH_LIMIT: {
        limit: async () => { authLimitCallCount++; return { success: true } }
      },
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    }
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const r = await handleAuth(makeSignInReq(credential, nonceValue), env, { keys: await localJwks() })
    expect(r.status).toBe(200)
    // AUTH_LIMIT must NOT be charged on success
    expect(authLimitCallCount).toBe(0)
  })

  it('AUTH_LIMIT IS charged when sign-in fails (bad token)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    let authLimitCallCount = 0
    const env = {
      DB: db,
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      NONCE_KEY: TEST_NONCE_KEY,
      AUTH_LIMIT: {
        limit: async () => { authLimitCallCount++; return { success: true } }
      },
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    }
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    // Invalid credential (badly formatted JWT)
    const r = await handleAuth(makeSignInReq('bad-credential', nonceValue), env, { keys: await localJwks() })
    expect(r.status).toBe(401)
    // AUTH_LIMIT should be charged on failure
    expect(authLimitCallCount).toBe(1)
  })

  it('AUTH_SUB_LIMIT is charged on successful sign-in and blocks when exceeded', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = {
      DB: db,
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      NONCE_KEY: TEST_NONCE_KEY,
      AUTH_LIMIT: { limit: async () => ({ success: true }) },
      AUTH_SUB_LIMIT: { limit: async () => ({ success: false }) },  // always blocked
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    } as Parameters<typeof handleAuth>[1]
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const r = await handleAuth(makeSignInReq(credential, nonceValue), env, { keys: await localJwks() })
    // AUTH_SUB_LIMIT exceeded → 429
    expect(r.status).toBe(429)
  })

  it('GET /api/auth/nonce is rate-limited per IP via AUTH_LIMIT', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = {
      DB: db,
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      NONCE_KEY: TEST_NONCE_KEY,
      AUTH_LIMIT: { limit: async () => ({ success: false }) },  // always blocked
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    }
    const req = new Request('https://x/api/auth/nonce', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    const r = await handleAuth(req, env)
    // Nonce endpoint should be rate-limited
    expect(r.status).toBe(429)
  })
})

// ---- Accept #8: nickname/class validation using shared/text.ts ----

describe('Fix Group 5a — Accept #8: nickname/class validation (shared/text.ts)', () => {
  async function putProfile(db: Parameters<typeof handleMe>[1]['DB'], rawToken: string, nickname: string, className = '11A') {
    const req = new Request('https://x/api/me', {
      method: 'PUT',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${rawToken}`,
      },
      body: JSON.stringify({ nickname, className }),
    })
    return handleMe(req, { DB: db, GOOGLE_CLIENT_ID: TEST_CLIENT_ID, NONCE_KEY: TEST_NONCE_KEY, AUTH_LIMIT: { limit: async () => ({ success: true }) }, ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) } })
  }

  it('whitespace-only nickname → 400', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)
    const r = await putProfile(db, rawToken, '   ')
    expect(r.status).toBe(400)
  })

  it('nickname with control character (\\x01) → 400', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)
    const r = await putProfile(db, rawToken, 'Valid\x01Name')
    expect(r.status).toBe(400)
  })

  it('nickname with bidi char (U+202E right-to-left override) → 400', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)
    const r = await putProfile(db, rawToken, 'Valid\u202EName')
    expect(r.status).toBe(400)
  })

  it('nickname with lone surrogate → 400', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)
    // Lone high surrogate (not followed by low surrogate)
    const r = await putProfile(db, rawToken, 'Valid\uD800Name')
    expect(r.status).toBe(400)
  })

  it('nickname is NFC-normalized and trimmed (spaces trimmed, then validated)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)
    // Leading/trailing spaces with valid content
    const r = await putProfile(db, rawToken, '  Nguyễn Văn A  ')
    expect(r.status).toBe(200)
    // The stored nickname should be trimmed
    const user = sqlite.prepare('SELECT nickname FROM app_user WHERE id = ?').get(userId) as { nickname: string }
    expect(user.nickname).toBe('Nguyễn Văn A')
  })

  it('className with control character → 400', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)
    const r = await putProfile(db, rawToken, 'Valid', '12A\x00')
    expect(r.status).toBe(400)
  })

  it('nickname codepoint length > 30 (multibyte) → 400 (not UTF-16 length)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)
    // 31 emoji: each is 2 UTF-16 code units but 1 codepoint — length check must use codepoints
    const r = await putProfile(db, rawToken, '😀'.repeat(31))
    expect(r.status).toBe(400)
  })
})
