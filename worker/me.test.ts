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
import { TEST_PASSWORD } from './testGoogle.ts'
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
      .prepare("SELECT ui.subject, ui.email FROM user_identity ui WHERE ui.provider = 'google' AND ui.subject = ?")
      .get(TEST_SUB) as { subject: string; email: string } | undefined
    expect(user).toBeDefined()
    expect(user?.subject).toBe(TEST_SUB)
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

  it('signed-in user admin flag is false: Google sign-in never grants admin (admin_role only)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    await seedAdminEmail(db, TEST_EMAIL)
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const req = makeSignInReq(credential, nonceValue)

    const r = await handleAuth(req, env, { keys: await localJwks() })
    const body = await r.json() as { user?: { isAdmin?: boolean } }
    expect(body.user?.isAdmin).toBe(false)
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
    const userId = (await db.prepare("SELECT user_id AS id FROM admin_role LIMIT 1").first<{ id: number }>())!.id
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

// Phase 2b: admin pinning (admin.google_sub) was removed; its tests were deleted.


// ---- Accept #6: missing or empty GOOGLE_CLIENT_ID → refuse ----

describe('Fix Group 5a — Accept #6: missing/empty GOOGLE_CLIENT_ID → sign-in refused', () => {
  it('empty GOOGLE_CLIENT_ID → 503 misconfigured (fail closed)', async () => {
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
    expect(r.status).toBe(503)
  })

  it('undefined GOOGLE_CLIENT_ID → 503 misconfigured (fail closed)', async () => {
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
    expect(r.status).toBe(503)
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
      SUB_HMAC_KEY: 'test-sub-hmac-key-32bytes-padded',
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
      SUB_HMAC_KEY: 'test-sub-hmac-key-32bytes-padded',
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
      SUB_HMAC_KEY: 'test-sub-hmac-key-32bytes-padded',
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

  it('GET /api/auth/nonce is rate-limited per IP via PUBLIC_READ_LIMIT (not AUTH_LIMIT)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = {
      DB: db,
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      NONCE_KEY: TEST_NONCE_KEY,
      AUTH_LIMIT: { limit: async () => ({ success: true }) },      // must NOT block nonce
      PUBLIC_READ_LIMIT: { limit: async () => ({ success: false }) },  // blocks nonce
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    }
    const req = new Request('https://x/api/auth/nonce', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    const r = await handleAuth(req, env as never)
    // Nonce endpoint should be rate-limited via PUBLIC_READ_LIMIT
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

// Review cycle 2 Warning: the re-read branch when the conditional pin changes 0 rows.
// The wrapper writes another sub into admin.google_sub just before the pin UPDATE runs,
// which is what a concurrent sign-in that wins the race looks like.
// Phase 2b: admin pinning (admin.google_sub) was removed; its tests were deleted.


// Review cycle 2 Warning: USER_READ_LIMIT / USER_WRITE_LIMIT are enforced (keyed by user id).
describe('USER_READ_LIMIT / USER_WRITE_LIMIT', () => {
  function limiter(success: boolean) {
    const keys: string[] = []
    return { keys, binding: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success } } } }
  }
  async function signedIn() {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const userId = await seedUser(db)
    const token = makeRawToken()
    await seedSession(db, userId, token)
    return { db, userId, cookie: `${SESSION_COOKIE_NAME}=${token}` }
  }
  const headers = (cookie: string, write = false): Record<string, string> => ({
    Cookie: cookie, 'CF-Connecting-IP': '5.6.7.8',
    ...(write ? { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' } : {}),
  })

  it('GET /api/me: charged by user id; exhausted → 429', async () => {
    const { db, userId, cookie } = await signedIn()
    const ok = limiter(true)
    const r = await handleMe(new Request('https://x/api/me', { headers: headers(cookie) }), { ...meEnv({ db }), USER_READ_LIMIT: ok.binding } as never)
    expect(r.status).toBe(200)
    expect(ok.keys).toEqual([`u:${userId}`])
    const no = limiter(false)
    const r2 = await handleMe(new Request('https://x/api/me', { headers: headers(cookie) }), { ...meEnv({ db }), USER_READ_LIMIT: no.binding } as never)
    expect(r2.status).toBe(429)
  })

  it('GET /api/me signed out: charged by IP', async () => {
    const { db } = await signedIn()
    const ok = limiter(true)
    await handleMe(new Request('https://x/api/me', { headers: { 'CF-Connecting-IP': '5.6.7.8' } }), { ...meEnv({ db }), USER_READ_LIMIT: ok.binding } as never)
    expect(ok.keys).toEqual(['ip:5.6.7.8'])
  })

  it('PUT /api/me: exhausted USER_WRITE_LIMIT → 429 and the nickname is unchanged', async () => {
    const { db, userId, cookie } = await signedIn()
    const no = limiter(false)
    const r = await handleMe(
      new Request('https://x/api/me', { method: 'PUT', headers: headers(cookie, true), body: JSON.stringify({ nickname: 'Mới', className: '10A1' }) }),
      { ...meEnv({ db }), USER_WRITE_LIMIT: no.binding } as never,
    )
    expect(r.status).toBe(429)
    expect(no.keys).toEqual([`u:${userId}`])
    expect(await db.prepare('SELECT nickname FROM app_user WHERE id = ?').bind(userId).first()).toEqual({ nickname: 'TestUser' })
  })

  it('logout: exhausted USER_WRITE_LIMIT → 429 and the session survives', async () => {
    const { db, userId, cookie } = await signedIn()
    const no = limiter(false)
    const r = await handleAuth(
      new Request('https://x/api/auth/logout', { method: 'POST', headers: headers(cookie, true) }),
      { ...meEnv({ db }), USER_WRITE_LIMIT: no.binding } as never,
    )
    expect(r.status).toBe(429)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ?').bind(userId).first()).toEqual({ n: 1 })
  })
})

describe('POST /api/auth/google — unparseable body', () => {
  it('charges AUTH_LIMIT and returns 429 when it is exhausted (400 otherwise)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const req = () => new Request('https://x/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', 'CF-Connecting-IP': '5.6.7.8' },
      body: '{not json',
    })
    const limited = { limit: async () => ({ success: false }) }
    const open = { limit: async () => ({ success: true }) }
    expect((await handleAuth(req(), { ...meEnv({ db }), AUTH_LIMIT: limited } as never)).status).toBe(429)
    expect((await handleAuth(req(), { ...meEnv({ db }), AUTH_LIMIT: open } as never)).status).toBe(400)
  })
})

// ===================================================================
// Fix Group 6a — Security fixes
// ===================================================================

// ---- Item 1: nonce uses PUBLIC_READ_LIMIT, not AUTH_LIMIT ----

describe('Fix Group 6a — Item 1: nonce uses PUBLIC_READ_LIMIT, not AUTH_LIMIT', () => {
  it('1,000 nonce requests from one IP leave AUTH_LIMIT uncharged', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    let authLimitCalls = 0
    const env = {
      DB: db,
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      NONCE_KEY: TEST_NONCE_KEY,
      AUTH_LIMIT: { limit: async () => { authLimitCalls++; return { success: true } } },
      PUBLIC_READ_LIMIT: { limit: async () => ({ success: true }) },
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    }
    for (let i = 0; i < 1000; i++) {
      await handleAuth(
        new Request('https://x/api/auth/nonce', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
        env as never,
      )
    }
    expect(authLimitCalls).toBe(0)
  })

  it('nonce is blocked by PUBLIC_READ_LIMIT (not AUTH_LIMIT)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = {
      DB: db,
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      NONCE_KEY: TEST_NONCE_KEY,
      AUTH_LIMIT: { limit: async () => ({ success: true }) },     // allows all — must NOT block nonce
      PUBLIC_READ_LIMIT: { limit: async () => ({ success: false }) },  // blocks nonce
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    }
    const r = await handleAuth(
      new Request('https://x/api/auth/nonce', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      env as never,
    )
    expect(r.status).toBe(429)
  })
})

// ---- Item 3: DELETE /api/me ----

describe('Fix Group 6a — Item 3: DELETE /api/me', () => {
  it('DELETE /api/me → 200 { ok: true } and session cookie cleared', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const req = new Request('https://x/api/me', {
      method: 'DELETE',
      body: JSON.stringify({ password: TEST_PASSWORD }),
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        Cookie: `${SESSION_COOKIE_NAME}=${rawToken}`,
      },
    })
    const r = await handleMe(req, env)
    expect(r.status).toBe(200)
    expect((await r.json() as { ok?: boolean }).ok).toBe(true)
    const cookies = getSetCookies(r)
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && c.includes('Max-Age=0'))).toBe(true)
  })

  it('DELETE /api/me deletes the app_user row', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    await handleMe(new Request('https://x/api/me', {
      method: 'DELETE',
      body: JSON.stringify({ password: TEST_PASSWORD }),
      headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Requested-With': 'fetch', Cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
    }), env)

    const user = sqlite.prepare('SELECT id FROM app_user WHERE id = ?').get(userId)
    expect(user).toBeUndefined()
  })

  it('DELETE /api/me deletes ALL sessions for the user (not just the presented one)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const userId = await seedUser(db)
    const token1 = makeRawToken()
    const token2 = makeRawToken()
    await seedSession(db, userId, token1)
    await seedSession(db, userId, token2)

    await handleMe(new Request('https://x/api/me', {
      method: 'DELETE',
      body: JSON.stringify({ password: TEST_PASSWORD }),
      headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Requested-With': 'fetch', Cookie: `${SESSION_COOKIE_NAME}=${token1}` },
    }), env)

    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ?').get(userId) as { n: number }
    expect(count.n).toBe(0)
  })

  it('DELETE /api/me without session cookie → 401', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const r = await handleMe(new Request('https://x/api/me', {
      method: 'DELETE',
      body: JSON.stringify({ password: TEST_PASSWORD }),
      headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Requested-With': 'fetch' },
    }), env)
    expect(r.status).toBe(401)
  })

  it('DELETE /api/me without X-Requested-With → 403 (CSRF guard)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const env = meEnv({ db })
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)
    const r = await handleMe(new Request('https://x/api/me', {
      method: 'DELETE',
      body: JSON.stringify({ password: TEST_PASSWORD }),
      headers: { 'CF-Connecting-IP': '1.2.3.4', Cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
    }), env)
    expect(r.status).toBe(403)
  })
})

// ---- Item 4: NONCE_KEY guard on POST /api/auth/google ----

describe('Fix Group 6a — Item 4: NONCE_KEY guard on POST /api/auth/google', () => {
  it('NONCE_KEY unset → 401 (fail closed, before JWT verification)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const envNoNonce = {
      DB: db,
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      NONCE_KEY: undefined as unknown as string,
      AUTH_LIMIT: { limit: async () => ({ success: true }) },
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    }
    const r = await handleAuth(makeSignInReq(credential, nonceValue), envNoNonce, { keys: await localJwks() })
    expect(r.status).toBe(401)
  })

  it('NONCE_KEY unset → logs auth: misconfigured (not email/sub)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const envNoNonce = {
      DB: db,
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      NONCE_KEY: undefined as unknown as string,
      AUTH_LIMIT: { limit: async () => ({ success: true }) },
      ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleAuth(makeSignInReq(credential, nonceValue), envNoNonce, { keys: await localJwks() })
    const logs = spy.mock.calls.map((a) => a.join(' '))
    spy.mockRestore()
    expect(logs.some((l) => l.includes('misconfigured'))).toBe(true)
    for (const log of logs) {
      expect(log).not.toContain(TEST_EMAIL)
      expect(log).not.toContain(TEST_SUB)
    }
  })
})

// Security cycle 2 suggestion: DELETE /api/me destroys data — pin down exactly what it touches.
describe('DELETE /api/me — scope and guards', () => {
  async function twoUsers() {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    await seedAdminEmail(db, TEST_EMAIL)
    const me = await seedUser(db)
    const other = await seedUser(db, { sub: 'other-sub-1', email: 'other@gmail.com' })
    const myToken = makeRawToken()
    const otherToken = makeRawToken()
    await seedSession(db, me, myToken)
    await seedSession(db, other, otherToken)
    return { db, me, other, cookie: `${SESSION_COOKIE_NAME}=${myToken}` }
  }
  const del = (cookie: string, extra: Record<string, string> = {}) => new Request('https://x/api/me', {
    method: 'DELETE',
    headers: { Cookie: cookie, 'X-Requested-With': 'fetch', 'CF-Connecting-IP': '5.6.7.8', 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  })
  const count = async (db: Awaited<ReturnType<typeof twoUsers>>['db'], sql: string, id?: number) =>
    ((await (id === undefined ? db.prepare(sql) : db.prepare(sql).bind(id)).first()) as { n: number }).n

  it("deletes only the caller: the other user's row and session survive, and the admin row is untouched", async () => {
    const { db, me, other, cookie } = await twoUsers()
    expect((await handleMe(del(cookie), meEnv({ db }) as never)).status).toBe(200)
    expect(await count(db, 'SELECT COUNT(*) AS n FROM app_user WHERE id = ?', me)).toBe(0)
    expect(await count(db, 'SELECT COUNT(*) AS n FROM session WHERE user_id = ?', me)).toBe(0)
    expect(await count(db, 'SELECT COUNT(*) AS n FROM app_user WHERE id = ?', other)).toBe(1)
    expect(await count(db, 'SELECT COUNT(*) AS n FROM session WHERE user_id = ?', other)).toBe(1)
    expect(await count(db, 'SELECT COUNT(*) AS n FROM admin_role')).toBe(1)
  })

  it('Sec-Fetch-Site: cross-site → 403 and nothing deleted', async () => {
    const { db, me, cookie } = await twoUsers()
    expect((await handleMe(del(cookie, { 'Sec-Fetch-Site': 'cross-site' }), meEnv({ db }) as never)).status).toBe(403)
    expect(await count(db, 'SELECT COUNT(*) AS n FROM app_user WHERE id = ?', me)).toBe(1)
  })

  it('exhausted USER_WRITE_LIMIT → 429 and nothing deleted', async () => {
    const { db, me, cookie } = await twoUsers()
    const env = { ...meEnv({ db }), USER_WRITE_LIMIT: { limit: async () => ({ success: false }) } }
    expect((await handleMe(del(cookie), env as never)).status).toBe(429)
    expect(await count(db, 'SELECT COUNT(*) AS n FROM app_user WHERE id = ?', me)).toBe(1)
  })

  it('an expired session → 401 and nothing deleted', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const me = await seedUser(db)
    const token = makeRawToken()
    await seedSession(db, me, token, { expired: true })
    expect((await handleMe(del(`${SESSION_COOKIE_NAME}=${token}`), meEnv({ db }) as never)).status).toBe(401)
    expect(await count(db, 'SELECT COUNT(*) AS n FROM app_user WHERE id = ?', me)).toBe(1)
  })
})

// ===================================================================
// Phase 2 — GET /api/me?campaign=<slug> and GET /api/me/gifts?campaign=<slug>
//
// New behaviour added to handleMe:
//   GET /api/me?campaign=<slug>
//       Extends the existing { user, isAdmin } body with:
//         heartsLeft     — hearts_per_day minus today's hearts given (Vietnam day = UTC+7)
//         heartedGiftIds — public_ids of gifts the user hearted in this campaign
//       Anonymous: heartsLeft = hearts_per_day (from campaign settings), heartedGiftIds = []
//
//   GET /api/me/gifts?campaign=<slug>
//       Returns own gifts for the campaign (including hidden ones) each with:
//         status, rank (from heart_count ordering)
//
// These tests fail because handleMe does not yet implement the campaign param.
// Pre-existing tests (without campaign param) continue to pass.
// ===================================================================

// Helper: create gift + heart tables (column names matching plan.md § Data model)
function createGiftAndHeartTables(sqlite: import('node:sqlite').DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS gift (
      id                     INTEGER PRIMARY KEY,
      public_id              TEXT UNIQUE NOT NULL,
      campaign_id            INTEGER NOT NULL,
      user_id                INTEGER NOT NULL,
      box_style              INTEGER NOT NULL DEFAULT 1,
      ornament_style         INTEGER NOT NULL DEFAULT 1,
      layout                 TEXT    NOT NULL DEFAULT 'classic',
      background_template_id INTEGER,
      font                   TEXT    NOT NULL DEFAULT 'patrick-hand',
      ink                    TEXT    NOT NULL DEFAULT '#1d3fa6',
      message                TEXT    NOT NULL DEFAULT '',
      nickname               TEXT    NOT NULL DEFAULT '',
      class_name             TEXT    NOT NULL DEFAULT '',
      heart_count            INTEGER NOT NULL DEFAULT 0,
      report_count           INTEGER NOT NULL DEFAULT 0,
      status                 TEXT    NOT NULL DEFAULT 'visible'
                               CHECK (status IN ('visible','hidden_auto','hidden_admin','deleted')),
      status_before_ban      TEXT,
      created_at             TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS heart (
      gift_id    INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      day        TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      PRIMARY KEY (gift_id, user_id)
    );
  `)
}

/** Returns current date as YYYY-MM-DD in Asia/Ho_Chi_Minh (+7 UTC). */
function vnToday(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** Seeds a gift_tree campaign and returns its id. Closes any active campaign first. */
function seedNoelCampaign(
  sqlite: import('node:sqlite').DatabaseSync,
  settings = JSON.stringify({ tree_slots: 15, ground_slots: 10, hearts_per_day: 5, gifts_per_user: 3, report_threshold: 3 }),
): number {
  sqlite.prepare("UPDATE campaign SET status = 'closed' WHERE status = 'active'").run()
  sqlite.prepare(`
    INSERT OR IGNORE INTO campaign
      (slug, kind, name, tagline, content, theme_colors, settings,
       starts_at, ends_at, status, created_at, created_by)
    VALUES ('noel', 'gift_tree', 'Noel', '', '{}', '{}', ?,
      '2026-01-01T00:00:00Z', '2027-12-31T23:59:59Z', 'active', datetime('now'), 'test')
  `).run(settings)
  return (sqlite.prepare("SELECT id FROM campaign WHERE slug = 'noel'").get() as { id: number }).id
}

let _meGiftSeq = 0
/** Seeds one gift and returns its id and publicId. */
function seedMeGift(
  sqlite: import('node:sqlite').DatabaseSync,
  opts: { campaignId: number; userId: number; heartCount?: number; status?: string },
): { id: number; publicId: string } {
  _meGiftSeq++
  const publicId = `me${String(_meGiftSeq).padStart(14, '0')}`
  const now = new Date(Date.now() + _meGiftSeq).toISOString()
  sqlite.prepare(`
    INSERT INTO gift
      (public_id, campaign_id, user_id, box_style, ornament_style, layout,
       font, ink, message, nickname, class_name,
       heart_count, report_count, status, created_at)
    VALUES (?, ?, ?, 1, 1, 'classic', 'patrick-hand', '#1d3fa6', 'msg', 'Nick', '11A', ?, 0, ?, ?)
  `).run(publicId, opts.campaignId, opts.userId, opts.heartCount ?? 0, opts.status ?? 'visible', now)
  const row = sqlite.prepare('SELECT id FROM gift WHERE public_id = ?').get(publicId) as { id: number }
  return { id: row.id, publicId }
}

/** Seeds a heart row (day defaults to today Vietnam time). */
function seedHeart(
  sqlite: import('node:sqlite').DatabaseSync,
  giftId: number,
  userId: number,
  day = vnToday(),
): void {
  sqlite.prepare(`
    INSERT OR IGNORE INTO heart (gift_id, user_id, day, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(giftId, userId, day)
}

// ── GET /api/me?campaign=<slug> — heartsLeft ─────────────────────────────────

describe('GET /api/me?campaign=<slug> — heartsLeft', () => {
  it('anonymous → heartsLeft equals hearts_per_day from campaign settings', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    const settings = JSON.stringify({ tree_slots: 15, ground_slots: 10, hearts_per_day: 5, gifts_per_user: 3, report_threshold: 3 })
    seedNoelCampaign(sqlite, settings)
    const env = meEnv({ db })

    const r = await handleMe(
      new Request('https://x/api/me?campaign=noel', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      env,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { heartsLeft?: number; heartedGiftIds?: unknown[] }
    expect(body.heartsLeft).toBe(5)   // hearts_per_day = 5, no hearts given
    expect(Array.isArray(body.heartedGiftIds)).toBe(true)
    expect((body.heartedGiftIds as unknown[]).length).toBe(0)
  })

  it('signed-in user with no hearts → heartsLeft = hearts_per_day', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    const campaignId = seedNoelCampaign(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const r = await handleMe(
      new Request('https://x/api/me?campaign=noel', {
        headers: { 'CF-Connecting-IP': '1.2.3.4', Cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
      }),
      meEnv({ db }),
    )
    const body = await r.json() as { heartsLeft?: number; heartedGiftIds?: string[] }
    expect(body.heartsLeft).toBe(5)
    expect(body.heartedGiftIds).toEqual([])
    // suppress unused variable warning
    void campaignId
  })

  it('signed-in user who gave 2 hearts today → heartsLeft = hearts_per_day − 2', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    const campaignId = seedNoelCampaign(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    // Other user owns the gifts (can't heart own gift)
    const otherId = await seedUser(db, { sub: 'other-sub-hearts', email: 'other-h@gmail.com' })
    const { id: g1 } = seedMeGift(sqlite, { campaignId, userId: otherId })
    const { id: g2 } = seedMeGift(sqlite, { campaignId, userId: otherId })
    seedHeart(sqlite, g1, userId)
    seedHeart(sqlite, g2, userId)

    const r = await handleMe(
      new Request('https://x/api/me?campaign=noel', {
        headers: { 'CF-Connecting-IP': '1.2.3.4', Cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
      }),
      meEnv({ db }),
    )
    const body = await r.json() as { heartsLeft?: number }
    expect(body.heartsLeft).toBe(3) // 5 − 2
  })

  it('heartsLeft counts only today (Vietnam day) — yesterday hearts do not reduce it', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    const campaignId = seedNoelCampaign(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const otherId = await seedUser(db, { sub: 'other-sub-yday', email: 'yday@gmail.com' })
    const { id: g1 } = seedMeGift(sqlite, { campaignId, userId: otherId })
    const { id: g2 } = seedMeGift(sqlite, { campaignId, userId: otherId })

    // One heart yesterday, one today
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const yesterdayVn = new Date(yesterday.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
    seedHeart(sqlite, g1, userId, yesterdayVn)   // yesterday → not counted
    seedHeart(sqlite, g2, userId, vnToday())     // today → counted

    const r = await handleMe(
      new Request('https://x/api/me?campaign=noel', {
        headers: { 'CF-Connecting-IP': '1.2.3.4', Cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
      }),
      meEnv({ db }),
    )
    const body = await r.json() as { heartsLeft?: number }
    expect(body.heartsLeft).toBe(4) // 5 − 1 (only today's heart counts)
  })
})

// ── GET /api/me?campaign=<slug> — heartedGiftIds ─────────────────────────────

describe('GET /api/me?campaign=<slug> — heartedGiftIds', () => {
  it('heartedGiftIds contains publicIds of gifts the user hearted', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    const campaignId = seedNoelCampaign(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const otherId = await seedUser(db, { sub: 'other-sub-hid', email: 'hid@gmail.com' })
    const { id: g1, publicId: pid1 } = seedMeGift(sqlite, { campaignId, userId: otherId })
    const { publicId: pid2 } = seedMeGift(sqlite, { campaignId, userId: otherId })
    // Heart only g1
    seedHeart(sqlite, g1, userId)

    const r = await handleMe(
      new Request('https://x/api/me?campaign=noel', {
        headers: { 'CF-Connecting-IP': '1.2.3.4', Cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
      }),
      meEnv({ db }),
    )
    const body = await r.json() as { heartedGiftIds?: string[] }
    expect(body.heartedGiftIds).toContain(pid1)
    expect(body.heartedGiftIds).not.toContain(pid2)
  })

  it('heartedGiftIds contains public_ids (not integer ids)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    const campaignId = seedNoelCampaign(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const otherId = await seedUser(db, { sub: 'other-sub-pid', email: 'pid@gmail.com' })
    const { id: giftId, publicId } = seedMeGift(sqlite, { campaignId, userId: otherId })
    seedHeart(sqlite, giftId, userId)

    const r = await handleMe(
      new Request('https://x/api/me?campaign=noel', {
        headers: { 'CF-Connecting-IP': '1.2.3.4', Cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
      }),
      meEnv({ db }),
    )
    const body = await r.json() as { heartedGiftIds?: unknown[] }
    expect((body.heartedGiftIds ?? []).every((v) => typeof v === 'string')).toBe(true)
    expect(body.heartedGiftIds).toContain(publicId)
    expect(body.heartedGiftIds).not.toContain(giftId) // must not leak integer id
  })

  it('response remains no-store when campaign param is present', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    seedNoelCampaign(sqlite)

    const r = await handleMe(
      new Request('https://x/api/me?campaign=noel', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      meEnv({ db }),
    )
    expect(r.headers.get('Cache-Control')).toBe('no-store')
  })
})

// ── GET /api/me/gifts?campaign=<slug> ────────────────────────────────────────

describe('GET /api/me/gifts?campaign=<slug>', () => {
  it('returns own gifts including hidden ones with status', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    const campaignId = seedNoelCampaign(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const { publicId: visiblePid } = seedMeGift(sqlite, { campaignId, userId, status: 'visible' })
    const { publicId: hiddenPid } = seedMeGift(sqlite, { campaignId, userId, status: 'hidden_auto' })

    const r = await handleMe(
      new Request('https://x/api/me/gifts?campaign=noel', {
        headers: { 'CF-Connecting-IP': '1.2.3.4', Cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
      }),
      meEnv({ db }),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { gifts?: { publicId: string; status: string }[] }
    expect(Array.isArray(body.gifts)).toBe(true)
    const pids = (body.gifts ?? []).map((g) => g.publicId)
    expect(pids).toContain(visiblePid)
    expect(pids).toContain(hiddenPid) // owner sees own hidden gifts
    // Status must be present
    for (const g of body.gifts ?? []) {
      expect(typeof g.status).toBe('string')
    }
  })

  it('does not return other users\' gifts', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    const campaignId = seedNoelCampaign(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const otherId = await seedUser(db, { sub: 'other-sub-myg', email: 'myg@gmail.com' })
    const { publicId: myGift } = seedMeGift(sqlite, { campaignId, userId })
    const { publicId: theirGift } = seedMeGift(sqlite, { campaignId, userId: otherId })

    const r = await handleMe(
      new Request('https://x/api/me/gifts?campaign=noel', {
        headers: { 'CF-Connecting-IP': '1.2.3.4', Cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
      }),
      meEnv({ db }),
    )
    const body = await r.json() as { gifts?: { publicId: string }[] }
    const pids = (body.gifts ?? []).map((g) => g.publicId)
    expect(pids).toContain(myGift)
    expect(pids).not.toContain(theirGift)
  })

  it('each gift has a rank computed from heart_count ordering', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    const campaignId = seedNoelCampaign(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    // Other users' gifts to fill the leaderboard
    const otherId = await seedUser(db, { sub: 'other-sub-rnk', email: 'rnk@gmail.com' })
    // Gift with 10 hearts is rank 1 (not mine)
    seedMeGift(sqlite, { campaignId, userId: otherId, heartCount: 10 })
    // My gift with 5 hearts is rank 2
    const { publicId: myGiftPid } = seedMeGift(sqlite, { campaignId, userId, heartCount: 5 })

    const r = await handleMe(
      new Request('https://x/api/me/gifts?campaign=noel', {
        headers: { 'CF-Connecting-IP': '1.2.3.4', Cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
      }),
      meEnv({ db }),
    )
    const body = await r.json() as { gifts?: { publicId: string; rank: number }[] }
    const myGift = (body.gifts ?? []).find((g) => g.publicId === myGiftPid)
    expect(myGift).toBeDefined()
    expect(myGift?.rank).toBe(2) // rank 1 belongs to the other user's gift
  })

  it('unauthenticated GET /api/me/gifts → 401', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    seedNoelCampaign(sqlite)

    const r = await handleMe(
      new Request('https://x/api/me/gifts?campaign=noel', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      meEnv({ db }),
    )
    expect(r.status).toBe(401)
  })

  it('response has Cache-Control: no-store', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    seedNoelCampaign(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const r = await handleMe(
      new Request('https://x/api/me/gifts?campaign=noel', {
        headers: { 'CF-Connecting-IP': '1.2.3.4', Cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
      }),
      meEnv({ db }),
    )
    expect(r.headers.get('Cache-Control')).toBe('no-store')
  })

  it('deleted gifts are excluded from own gift list', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftAndHeartTables(sqlite)
    const campaignId = seedNoelCampaign(sqlite)
    const userId = await seedUser(db)
    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const { publicId: activePid } = seedMeGift(sqlite, { campaignId, userId, status: 'visible' })
    const { publicId: deletedPid } = seedMeGift(sqlite, { campaignId, userId, status: 'deleted' })

    const r = await handleMe(
      new Request('https://x/api/me/gifts?campaign=noel', {
        headers: { 'CF-Connecting-IP': '1.2.3.4', Cookie: `${SESSION_COOKIE_NAME}=${rawToken}` },
      }),
      meEnv({ db }),
    )
    const body = await r.json() as { gifts?: { publicId: string }[] }
    const pids = (body.gifts ?? []).map((g) => g.publicId)
    expect(pids).toContain(activePid)
    expect(pids).not.toContain(deletedPid)
  })
})
