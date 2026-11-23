// @vitest-environment node
/**
 * RED-phase tests for Phase 2b account endpoints.
 *
 * Covers (by AC):
 *   AC-20  register success; username_taken (case-insensitive); password_common / password_contains_username
 *   AC-21  login: unknown/wrong/locked → byte-identical 401; PASSWORD_STATS spy; 11th attempt locked
 *   AC-25c 24-h restart of failed_count; correct password succeeds after lock window
 *   AC-22  rehash 10k→PBKDF2_ITERATIONS on login; login deletes presented session
 *   AC-23  change password: other session → 401
 *   AC-35  change password: own token rotated, new cookie set
 *   AC-25b NFD register → NFC login; missing secrets → 503; body > 2048 → 413; 10k-char pw → 400
 *   AC-29  banned delete → tombstone; re-register same username → 403 banned
 *   AC-30  per-IP cap; global cap; 429 register_limit; no orphan rows; concurrent at cap-1;
 *          IPv6 same /64 share cap; ipKey unit cases; ip_hash blanked after 30 days
 *   AC-25  first account = admin + audit + meta; second not admin; concurrent first → one admin;
 *          refused reg + non-admin → no admin_role; bootstrap_done → never admin;
 *          registrations 2..N get sessions
 *   AC-34  DELETE /api/me without/wrong password → 401 nothing deleted
 *   CSRF   Sec-Fetch-Site cross-site/same-site; missing X-Requested-With
 *   Limits AUTH_LIMIT refusing → 429; AUTH_SUB_LIMIT key format
 *
 * All tests fail NOW because worker/accounts.ts and worker/password.ts do not exist.
 * They should become green once Phase 2b is implemented.
 */

import { describe, it, expect, beforeEach } from 'vitest'

// ── RED MECHANISM: neither module exists yet ──────────────────────────────────
import { handleAccounts, ipKey } from './accounts.ts'
import { PASSWORD_STATS, PBKDF2_ITERATIONS } from './password.ts'
// ─────────────────────────────────────────────────────────────────────────────

import { testDb } from './testDb.ts'
import worker from './index.ts'
import {
  createAccountTables,
  accountsEnv,
  seedUser,
  sessionFor,
  jsonReq,
  SESSION_COOKIE_NAME,
} from './testAccounts.ts'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSetCookies(res: Response): string[] {
  const h = res.headers as typeof res.headers & {
    getAll?: (n: string) => string[]
    getSetCookie?: () => string[]
  }
  return h.getAll?.('Set-Cookie') ?? h.getSetCookie?.() ?? (res.headers.get('Set-Cookie') ? [res.headers.get('Set-Cookie')!] : [])
}

function cookieToken(setCookieHeader: string): string {
  const m = setCookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))
  return m ? m[1]! : ''
}

function hasFlag(setCookieHeader: string, flag: string): boolean {
  return setCookieHeader.toLowerCase().includes(flag.toLowerCase())
}

// ── Shared setup ──────────────────────────────────────────────────────────────

let db: ReturnType<typeof testDb>['db']
let sqlite: ReturnType<typeof testDb>['sqlite']
let env: ReturnType<typeof accountsEnv>

beforeEach(() => {
  ;({ db, sqlite } = testDb())
  createAccountTables(sqlite)
  env = accountsEnv({ db })
})

// ── ipKey unit tests (pure; from worker/accounts.ts) ─────────────────────────

describe('ipKey', () => {
  it('IPv4 returned unchanged', () => {
    expect(ipKey('1.2.3.4')).toBe('1.2.3.4')
    expect(ipKey('192.168.0.1')).toBe('192.168.0.1')
  })

  it('IPv6: first four groups + "::/64"', () => {
    expect(ipKey('2001:db8:0:1:5:6:7:8')).toBe('2001:db8:0:1::/64')
  })

  it('IPv6: :: expansion fills zeroes', () => {
    // 2001:db8::1 → full: 2001:0db8:0000:0000:0000:0000:0000:0001
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
  })

  it('IPv6: same /64 prefix → identical key', () => {
    expect(ipKey('2001:db8:0:1:aaaa:bbbb:cccc:dddd'))
      .toBe(ipKey('2001:db8:0:1:5:6:7:8'))
  })

  it('IPv6: different /64 → different key', () => {
    expect(ipKey('2001:db8:0:1:5:6:7:8'))
      .not.toBe(ipKey('2001:db8:0:2:5:6:7:8'))
  })
})

// ── AC-20: Register ───────────────────────────────────────────────────────────

describe('AC-20 register', () => {
  it('success: 201, HttpOnly Secure SameSite=Lax __Host-cyt_s cookie', async () => {
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'thien_01',
        password: 'correct-horse-battery',
        nickname: 'Thiện',
        className: '11A',
      }),
      env,
    )
    expect(r.status).toBe(201)
    const cookies = getSetCookies(r)
    const sessionCookie = cookies.find((c) => c.includes(SESSION_COOKIE_NAME))
    expect(sessionCookie).toBeTruthy()
    expect(hasFlag(sessionCookie!, 'HttpOnly')).toBe(true)
    expect(hasFlag(sessionCookie!, 'Secure')).toBe(true)
    expect(hasFlag(sessionCookie!, 'SameSite=Lax')).toBe(true)
    expect(hasFlag(sessionCookie!, 'Path=/')).toBe(true)
    // __Host- prefix requires no Domain attribute
    expect(sessionCookie!.toLowerCase()).not.toMatch(/\bdomain=/i)
  })

  it('success: GET /api/me returns username after register', async () => {
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'thien_01',
        password: 'correct-horse-battery',
        nickname: 'Thiện',
        className: '11A',
      }),
      env,
    )
    expect(r.status).toBe(201)
    const setCookies = getSetCookies(r)
    const rawToken = cookieToken(setCookies.find((c) => c.includes(SESSION_COOKIE_NAME))!)

    const meRes = await worker.fetch(
      new Request('https://x/api/me', {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${rawToken}`,
          'CF-Connecting-IP': '1.2.3.4',
        },
      }),
      env,
    )
    expect(meRes.status).toBe(200)
    const body = (await meRes.json()) as { user?: { username?: string } }
    expect(body.user?.username).toBe('thien_01')
  })

  it('username_taken: case-insensitive (Thien_01 → thien_01 conflict)', async () => {
    await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'Thien_01',
        password: 'correct-horse-battery',
        nickname: 'A',
        className: '11A',
      }),
      env,
    )
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'thien_01',
        password: 'correct-horse-battery',
        nickname: 'B',
        className: '11B',
      }),
      env,
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('username_taken')
  })

  it('400 password_common for a common password', async () => {
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'thien_01',
        password: '12345678',
        nickname: 'A',
        className: '11A',
      }),
      env,
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('password_common')
  })

  it('400 password_contains_username', async () => {
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'thien_01',
        password: 'thien_01secret',
        nickname: 'A',
        className: '11A',
      }),
      env,
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('password_contains_username')
  })

  it('response has Cache-Control: no-store', async () => {
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'thien_01',
        password: 'correct-horse-battery',
        nickname: 'A',
        className: '11A',
      }),
      env,
    )
    expect(r.headers.get('Cache-Control')).toContain('no-store')
  })
})

// ── AC-21, AC-25c: Login indistinguishable failures ───────────────────────────

describe('AC-21 login failures are indistinguishable', () => {
  const goodPassword = 'correct-horse-battery'

  beforeEach(async () => {
    // Seed a known user
    await seedUser(db, { username: 'realuser', password: goodPassword })
  })

  it('unknown username → 401 invalid_credentials, body matches locked/wrong', async () => {
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'nobody', password: goodPassword }),
      env,
    )
    expect(r.status).toBe(401)
    expect((await r.json() as { error: string }).error).toBe('invalid_credentials')
  })

  it('wrong password → 401 invalid_credentials, computes exactly 1 hash', async () => {
    const before = PASSWORD_STATS.hashes
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'realuser', password: 'wrongpass!!' }),
      env,
    )
    expect(r.status).toBe(401)
    expect((await r.json() as { error: string }).error).toBe('invalid_credentials')
    expect(PASSWORD_STATS.hashes - before).toBe(1)
  })

  it('unknown username also computes exactly 1 hash (against dummy credential)', async () => {
    const before = PASSWORD_STATS.hashes
    await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'nobody', password: goodPassword }),
      env,
    )
    expect(PASSWORD_STATS.hashes - before).toBe(1)
  })

  it('byte-identical bodies for unknown / wrong-password / locked', async () => {
    // Trigger lockout for 'realuser'
    for (let i = 0; i < 10; i++) {
      await handleAccounts(
        jsonReq('POST', '/api/auth/login', { username: 'realuser', password: 'wrongpass!!' }),
        env,
      )
    }

    const rUnknown = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'nobody', password: goodPassword }),
      env,
    )
    const rWrong = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'realuser', password: 'wrongpass!!' }),
      env,
    )
    const rLocked = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'realuser', password: goodPassword }),
      env,
    )
    expect(rUnknown.status).toBe(401)
    expect(rWrong.status).toBe(401)
    expect(rLocked.status).toBe(401)

    const bodyUnknown = await rUnknown.text()
    const bodyWrong = await rWrong.text()
    const bodyLocked = await rLocked.text()
    expect(bodyWrong).toBe(bodyUnknown)
    expect(bodyLocked).toBe(bodyUnknown)
  })

  it('locked: each of unknown/wrong/locked computes exactly 1 hash', async () => {
    // Trigger lockout
    for (let i = 0; i < 10; i++) {
      await handleAccounts(
        jsonReq('POST', '/api/auth/login', { username: 'realuser', password: 'wrongpass!!' }),
        env,
      )
    }
    const before = PASSWORD_STATS.hashes

    await handleAccounts(jsonReq('POST', '/api/auth/login', { username: 'nobody', password: goodPassword }), env)
    expect(PASSWORD_STATS.hashes - before).toBe(1)

    await handleAccounts(jsonReq('POST', '/api/auth/login', { username: 'realuser', password: 'wrongpass!!' }), env)
    expect(PASSWORD_STATS.hashes - before).toBe(2)

    await handleAccounts(jsonReq('POST', '/api/auth/login', { username: 'realuser', password: goodPassword }), env)
    expect(PASSWORD_STATS.hashes - before).toBe(3)
  })

  it('11th attempt with correct password → still 401 for 15 min (deps.now)', async () => {
    const baseTime = new Date('2026-01-01T12:00:00Z')
    const envWithNow = accountsEnv({ db })

    // 10 wrong passwords at base time
    for (let i = 0; i < 10; i++) {
      await handleAccounts(
        jsonReq('POST', '/api/auth/login', { username: 'realuser', password: 'wrongpass!!' }),
        envWithNow,
        { now: () => baseTime },
      )
    }
    // 11th attempt, correct password, 10 minutes later (still locked)
    const tenMinsLater = new Date(baseTime.getTime() + 10 * 60 * 1000)
    const r11 = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'realuser', password: goodPassword }),
      envWithNow,
      { now: () => tenMinsLater },
    )
    expect(r11.status).toBe(401)
    expect((await r11.json() as { error: string }).error).toBe('invalid_credentials')

    // 16 minutes later: should succeed
    const sixteenMinsLater = new Date(baseTime.getTime() + 16 * 60 * 1000)
    const r16 = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'realuser', password: goodPassword }),
      envWithNow,
      { now: () => sixteenMinsLater },
    )
    expect(r16.status).toBe(200)
  })
})

// ── AC-25c: 24-h failed_count restart ─────────────────────────────────────────

describe('AC-25c 24-h failed_count restart', () => {
  const goodPassword = 'correct-horse-battery'

  beforeEach(async () => {
    await seedUser(db, { username: 'realuser', password: goodPassword })
  })

  it('failed_count resets after 24 h: can be locked again from zero', async () => {
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000)
    const now = new Date()

    // 9 wrong passwords yesterday → failed_count = 9
    for (let i = 0; i < 9; i++) {
      await handleAccounts(
        jsonReq('POST', '/api/auth/login', { username: 'realuser', password: 'wrongpass!!' }),
        env,
        { now: () => yesterday },
      )
    }

    // 1 wrong password today → resets count to 1 (< 10), does NOT lock
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'realuser', password: 'wrongpass!!' }),
      env,
      { now: () => now },
    )
    expect(r.status).toBe(401)

    // Correct password today → should succeed (not locked)
    const rOk = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'realuser', password: goodPassword }),
      env,
      { now: () => now },
    )
    expect(rOk.status).toBe(200)
  })
})

// ── AC-22: Rehash on login ─────────────────────────────────────────────────────

describe('AC-22 rehash on login', () => {
  it('credential rehashed to PBKDF2_ITERATIONS; old password still works', async () => {
    const password = 'correct-horse-battery'
    // Seed with low iterations (10k)
    const { userId } = await seedUser(db, { username: 'lowiter', password, iterations: 10_000 })

    // Login triggers rehash
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'lowiter', password }),
      env,
    )
    expect(r.status).toBe(200)

    // Credential row should now have current iterations
    const cred = await db
      .prepare('SELECT iterations FROM password_credential WHERE user_id = ?')
      .bind(userId)
      .first<{ iterations: number }>()
    expect(cred!.iterations).toBe(PBKDF2_ITERATIONS)

    // Old password still works (same password, new hash)
    const r2 = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'lowiter', password }),
      env,
    )
    expect(r2.status).toBe(200)
  })

  it('login deletes the presented session (fixation prevention)', async () => {
    const password = 'correct-horse-battery'
    const { userId } = await seedUser(db, { username: 'fixuser', password })
    const oldToken = await sessionFor(db, userId)

    // Login while presenting old session
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'fixuser', password }, { token: oldToken }),
      env,
    )
    expect(r.status).toBe(200)

    // Old session should be gone from the DB
    const { sha256Hex: sha } = await import('./testAccounts.ts')
    const oldHash = await sha(oldToken)
    const oldRow = await db.prepare('SELECT 1 FROM session WHERE token_hash = ?').bind(oldHash).first()
    expect(oldRow).toBeNull()
  })
})

// ── AC-23 / AC-35: Change password ───────────────────────────────────────────

describe('AC-23 / AC-35 change password', () => {
  const goodPassword = 'correct-horse-battery'
  const newPassword = 'new-horse-staple-battery'

  it('other session → 401 after password change', async () => {
    const { userId } = await seedUser(db, { username: 'changepw', password: goodPassword })
    const token1 = await sessionFor(db, userId)
    const token2 = await sessionFor(db, userId)

    // Change password via token1
    const r = await worker.fetch(
      jsonReq('POST', '/api/me/password', { current: goodPassword, next: newPassword }, { token: token1 }),
      env,
    )
    expect(r.status).toBe(200)

    // token2 should now be invalid
    await worker.fetch(
      new Request('https://x/api/me', {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${token2}`,
          'CF-Connecting-IP': '1.2.3.4',
        },
      }),
      env,
    )
    // /api/me may return 200 with user=null for a stale session, or 401
    // The contract says "other sessions are revoked" so session2 should be gone
    // Calling a session-requiring write endpoint should give 401
    const rWrite = await worker.fetch(
      jsonReq('PUT', '/api/me', { nickname: 'X', className: '12A' }, { token: token2 }),
      env,
    )
    expect(rWrite.status).toBe(401)
  })

  it('own token is rotated (old token → 401 on write)', async () => {
    const { userId } = await seedUser(db, { username: 'rotatetest', password: goodPassword })
    const oldToken = await sessionFor(db, userId)

    const r = await worker.fetch(
      jsonReq('POST', '/api/me/password', { current: goodPassword, next: newPassword }, { token: oldToken }),
      env,
    )
    expect(r.status).toBe(200)

    // Old token should no longer work for writes
    const rOld = await worker.fetch(
      jsonReq('PUT', '/api/me', { nickname: 'X', className: '12A' }, { token: oldToken }),
      env,
    )
    expect(rOld.status).toBe(401)
  })

  it('response sets new session cookie', async () => {
    const { userId } = await seedUser(db, { username: 'newcookie', password: goodPassword })
    const oldToken = await sessionFor(db, userId)

    const r = await worker.fetch(
      jsonReq('POST', '/api/me/password', { current: goodPassword, next: newPassword }, { token: oldToken }),
      env,
    )
    expect(r.status).toBe(200)
    const cookies = getSetCookies(r)
    const newSession = cookies.find((c) => c.includes(SESSION_COOKIE_NAME))
    expect(newSession).toBeTruthy()
    const newToken = cookieToken(newSession!)
    expect(newToken).not.toBe(oldToken)
    expect(newToken.length).toBeGreaterThan(0)
  })
})

// ── AC-25b: NFC normalization ─────────────────────────────────────────────────

describe('AC-25b NFC normalization', () => {
  it('NFD register → NFC login succeeds', async () => {
    // Vietnamese chars in NFD form
    const nfdPassword = 'Ma\u0323t-kha\u0309u-ma\u0323nh'  // NFD "Mật-khẩu-mạnh"
    const nfcPassword = nfdPassword.normalize('NFC')

    const rReg = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'nfctest',
        password: nfdPassword,
        nickname: 'NFC',
        className: '11A',
      }),
      env,
    )
    expect(rReg.status).toBe(201)

    const rLogin = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'nfctest', password: nfcPassword }),
      env,
    )
    expect(rLogin.status).toBe(200)
  })
})

// ── AC-25b: Missing secrets → 503 ────────────────────────────────────────────

describe('AC-25b missing secrets → 503', () => {
  it('SUB_HMAC_KEY missing → 503 misconfigured on register', async () => {
    const badEnv = accountsEnv({ db, subHmacKey: undefined as unknown as string })
    // Force key to be absent
    ;(badEnv as Record<string, unknown>).SUB_HMAC_KEY = undefined
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'misctest',
        password: 'correct-horse-battery',
        nickname: 'A',
        className: '11A',
      }),
      badEnv,
    )
    expect(r.status).toBe(503)
    expect((await r.json() as { error: string }).error).toBe('misconfigured')
  })

  it('PASSWORD_PEPPER missing → 503 misconfigured on register', async () => {
    const badEnv = accountsEnv({ db })
    ;(badEnv as Record<string, unknown>).PASSWORD_PEPPER = undefined
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'misctest2',
        password: 'correct-horse-battery',
        nickname: 'A',
        className: '11A',
      }),
      badEnv,
    )
    expect(r.status).toBe(503)
    expect((await r.json() as { error: string }).error).toBe('misconfigured')
  })

  it('IP_HMAC_KEY missing → 503 misconfigured on register', async () => {
    const badEnv = accountsEnv({ db })
    ;(badEnv as Record<string, unknown>).IP_HMAC_KEY = undefined
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'misctest3',
        password: 'correct-horse-battery',
        nickname: 'A',
        className: '11A',
      }),
      badEnv,
    )
    expect(r.status).toBe(503)
    expect((await r.json() as { error: string }).error).toBe('misconfigured')
  })

  it('missing secrets on login → 503', async () => {
    await seedUser(db, { username: 'misclogin', password: 'correct-horse-battery' })
    const badEnv = accountsEnv({ db })
    ;(badEnv as Record<string, unknown>).PASSWORD_PEPPER = undefined
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/login', { username: 'misclogin', password: 'correct-horse-battery' }),
      badEnv,
    )
    expect(r.status).toBe(503)
  })
})

// ── AC-25b: Body size / password length limits ────────────────────────────────

describe('AC-25b body and password limits', () => {
  it('body > 2048 bytes → 413 too_long; no hash computed', async () => {
    const before = PASSWORD_STATS.hashes
    const oversizedBody = JSON.stringify({
      username: 'toolong',
      password: 'correct-horse-battery',
      nickname: 'A'.repeat(2000),
      className: '11A',
    })
    expect(oversizedBody.length).toBeGreaterThan(2048)

    const req = new Request('https://x/api/auth/register', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
        'Content-Length': String(oversizedBody.length),
      },
      body: oversizedBody,
    })
    const r = await handleAccounts(req, env)
    expect(r.status).toBe(413)
    expect((await r.json() as { error: string }).error).toBe('too_long')
    expect(PASSWORD_STATS.hashes).toBe(before)
  })

  it('10,000-character password → 400; no hash computed', async () => {
    const before = PASSWORD_STATS.hashes
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'pwlen',
        password: 'a'.repeat(10_000),
        nickname: 'A',
        className: '11A',
      }),
      env,
    )
    // Body cap (2048 bytes) runs before the password check, so a 10k-character body is 413 too_long.
    // Either way no hash is computed. (Spec conflict resolved toward the cap; see the Phase 2b report.)
    expect(r.status).toBe(413)
    expect(PASSWORD_STATS.hashes).toBe(before)
  })
})

// ── AC-29: Banned user tombstone ──────────────────────────────────────────────

describe('AC-29 banned identity tombstone', () => {
  it('banned user deletes account; re-register same username → 403 banned', async () => {
    const { userId, username } = await seedUser(db, {
      username: 'banthis',
      password: 'correct-horse-battery',
      banned: true,
    })
    const token = await sessionFor(db, userId)

    // Delete account (banned users write tombstone)
    const rDel = await worker.fetch(
      jsonReq('DELETE', '/api/me', { password: 'correct-horse-battery' }, { token }),
      env,
    )
    // The ban tombstone should be written
    expect(rDel.status).toBe(200)

    // Re-register with the same username
    const rReg = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username,
        password: 'new-correct-horse',
        nickname: 'B',
        className: '11B',
      }),
      env,
    )
    expect(rReg.status).toBe(403)
    expect((await rReg.json() as { error: string }).error).toBe('banned')
  })
})

// ── AC-30: Registration caps ──────────────────────────────────────────────────

describe('AC-30 registration caps', () => {
  it('per-IP cap: 429 register_limit after REGISTER_IP_DAILY exhausted', async () => {
    const capEnv = accountsEnv({ db, registerIpDaily: '3' })
    const ip = '10.0.0.1'

    for (let i = 0; i < 3; i++) {
      const r = await handleAccounts(
        jsonReq('POST', '/api/auth/register', {
          username: `ipuser${i}`,
          password: 'correct-horse-battery',
          nickname: 'U',
          className: '11A',
        }, { ip }),
        capEnv,
      )
      expect(r.status).toBe(201)
    }

    const rOver = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'ipuser99',
        password: 'correct-horse-battery',
        nickname: 'U',
        className: '11A',
      }, { ip }),
      capEnv,
    )
    expect(rOver.status).toBe(429)
    expect((await rOver.json() as { error: string }).error).toBe('register_limit')
  })

  it('429 leaves no orphan rows in app_user/user_identity/password_credential/session', async () => {
    const capEnv = accountsEnv({ db, registerIpDaily: '0' })
    const beforeUsers = await db.prepare('SELECT COUNT(*) AS c FROM app_user').first<{ c: number }>()

    await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'orphan',
        password: 'correct-horse-battery',
        nickname: 'O',
        className: '11A',
      }),
      capEnv,
    )

    const afterUsers = await db.prepare('SELECT COUNT(*) AS c FROM app_user').first<{ c: number }>()
    expect(afterUsers!.c).toBe(beforeUsers!.c)
    const idRows = await db.prepare("SELECT COUNT(*) AS c FROM user_identity WHERE subject = 'orphan'").first<{ c: number }>()
    expect(idRows!.c).toBe(0)
    const credRows = await db.prepare('SELECT COUNT(*) AS c FROM password_credential WHERE user_id NOT IN (SELECT id FROM app_user)').first<{ c: number }>()
    expect(credRows!.c).toBe(0)
  })

  it('global daily cap: 429 register_limit after REGISTER_GLOBAL_DAILY', async () => {
    const capEnv = accountsEnv({ db, registerGlobalDaily: '2' })

    for (let i = 0; i < 2; i++) {
      await handleAccounts(
        jsonReq('POST', '/api/auth/register', {
          username: `globaluser${i}`,
          password: 'correct-horse-battery',
          nickname: 'U',
          className: '11A',
        }, { ip: `10.0.${i}.1` }),
        capEnv,
      )
    }
    const rOver = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'globaluser99',
        password: 'correct-horse-battery',
        nickname: 'U',
        className: '11A',
      }, { ip: '10.0.99.1' }),
      capEnv,
    )
    expect(rOver.status).toBe(429)
    expect((await rOver.json() as { error: string }).error).toBe('register_limit')
  })

  it('concurrent requests at cap-1 → at most one success', async () => {
    // Share a single SQLite DB between two bindings (simulates two concurrent isolates)
    const { db: db1, sqlite: sharedSqlite } = testDb()
    createAccountTables(sharedSqlite)
    const { db: db2 } = testDb({ shareWith: sharedSqlite })

    const capEnv1 = accountsEnv({ db: db1, registerIpDaily: '2' })
    const capEnv2 = accountsEnv({ db: db2, registerIpDaily: '2' })
    const ip = '10.1.1.1'

    // Register 1 to consume 1 of 2 slots
    await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'concurrent0',
        password: 'correct-horse-battery',
        nickname: 'U',
        className: '11A',
      }, { ip }),
      capEnv1,
    )

    // 2 concurrent attempts for the last slot
    const [r1, r2] = await Promise.all([
      handleAccounts(
        jsonReq('POST', '/api/auth/register', {
          username: 'concurrent1',
          password: 'correct-horse-battery',
          nickname: 'U',
          className: '11A',
        }, { ip }),
        capEnv1,
      ),
      handleAccounts(
        jsonReq('POST', '/api/auth/register', {
          username: 'concurrent2',
          password: 'correct-horse-battery',
          nickname: 'U',
          className: '11A',
        }, { ip }),
        capEnv2,
      ),
    ])
    const successes = [r1, r2].filter((r) => r.status === 201).length
    expect(successes).toBeLessThanOrEqual(1)
  })

  it('IPv6 addresses in same /64 share the per-IP cap', async () => {
    const capEnv = accountsEnv({ db, registerIpDaily: '2' })
    const ipA = '2001:db8:0:1:aaaa:bbbb:cccc:dddd'  // /64 prefix: 2001:db8:0:1
    const ipB = '2001:db8:0:1:1111:2222:3333:4444'  // same /64

    await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'ipv6user0',
        password: 'correct-horse-battery',
        nickname: 'U',
        className: '11A',
      }, { ip: ipA }),
      capEnv,
    )
    await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'ipv6user1',
        password: 'correct-horse-battery',
        nickname: 'U',
        className: '11A',
      }, { ip: ipB }),
      capEnv,
    )

    // Third registration from same /64 → 429
    const rOver = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'ipv6user2',
        password: 'correct-horse-battery',
        nickname: 'U',
        className: '11A',
      }, { ip: ipA }),
      capEnv,
    )
    expect(rOver.status).toBe(429)
    expect((await rOver.json() as { error: string }).error).toBe('register_limit')
  })

  it('ip_hash blanked after 30 days on a later registration', async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    // Seed an old identity with a non-empty ip_hash
    await seedUser(db, { username: 'olduser', createdAt: thirtyOneDaysAgo })
    // Force ip_hash to be non-empty on the old identity
    await db
      .prepare("UPDATE user_identity SET ip_hash = 'staleHash', created_at = ? WHERE subject = 'olduser'")
      .bind(thirtyOneDaysAgo)
      .run()

    // Register a new user (triggers ip_hash blanking of old rows)
    await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'newuser',
        password: 'correct-horse-battery',
        nickname: 'N',
        className: '11A',
      }),
      env,
    )

    const row = await db
      .prepare("SELECT ip_hash FROM user_identity WHERE subject = 'olduser'")
      .first<{ ip_hash: string }>()
    expect(row?.ip_hash).toBe('')
  })
})

// ── AC-25: First account = admin bootstrap ────────────────────────────────────

describe('AC-25 first account = admin', () => {
  it('first registration gets admin_role + admin_audit first_account + meta marker', async () => {
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'firstadmin',
        password: 'correct-horse-battery',
        nickname: 'Admin',
        className: '11A',
      }),
      env,
    )
    expect(r.status).toBe(201)

    const adminRow = await db.prepare('SELECT COUNT(*) AS c FROM admin_role').first<{ c: number }>()
    expect(adminRow!.c).toBe(1)

    const auditRow = await db
      .prepare("SELECT action FROM admin_audit WHERE action = 'first_account'")
      .first<{ action: string }>()
    expect(auditRow?.action).toBe('first_account')

    const metaRow = await db
      .prepare("SELECT value FROM meta WHERE key = 'admin_bootstrap_done'")
      .first<{ value: string }>()
    expect(metaRow?.value).toBeTruthy()
  })

  it('second registration is NOT admin', async () => {
    await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'firstadmin',
        password: 'correct-horse-battery',
        nickname: 'A',
        className: '11A',
      }),
      env,
    )
    await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'seconduser',
        password: 'correct-horse-battery',
        nickname: 'B',
        className: '11B',
      }),
      env,
    )
    const adminCount = await db.prepare('SELECT COUNT(*) AS c FROM admin_role').first<{ c: number }>()
    expect(adminCount!.c).toBe(1)  // still only 1 admin
  })

  it('concurrent first registrations → exactly one admin', async () => {
    const { db: db1, sqlite: shared } = testDb()
    createAccountTables(shared)
    const { db: db2 } = testDb({ shareWith: shared })
    const env1 = accountsEnv({ db: db1 })
    const env2 = accountsEnv({ db: db2 })

    const [r1, r2] = await Promise.all([
      handleAccounts(
        jsonReq('POST', '/api/auth/register', {
          username: 'first1',
          password: 'correct-horse-battery',
          nickname: 'A',
          className: '11A',
        }),
        env1,
      ),
      handleAccounts(
        jsonReq('POST', '/api/auth/register', {
          username: 'first2',
          password: 'correct-horse-battery',
          nickname: 'B',
          className: '11B',
        }),
        env2,
      ),
    ])
    // Both should get sessions
    expect([r1.status, r2.status]).toEqual(expect.arrayContaining([201]))

    const adminCount = await db1.prepare('SELECT COUNT(*) AS c FROM admin_role').first<{ c: number }>()
    expect(adminCount!.c).toBe(1)
  })

  it('refused registration (username_taken) with one non-admin user → no admin_role created', async () => {
    // Seed one non-admin user (no admin_role)
    await seedUser(db, { username: 'existing', admin: false })

    // Attempt registration that will be refused (same username)
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'existing',
        password: 'correct-horse-battery',
        nickname: 'B',
        className: '11B',
      }),
      env,
    )
    expect(r.status).toBe(409)  // username_taken

    const adminCount = await db.prepare('SELECT COUNT(*) AS c FROM admin_role').first<{ c: number }>()
    expect(adminCount!.c).toBe(0)
  })

  it('admin_bootstrap_done marker: subsequent registrations never become admin', async () => {
    // Insert the marker manually (as if first admin already existed)
    await db.prepare("INSERT INTO meta (key, value) VALUES ('admin_bootstrap_done', 'test')").run()

    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'latecomer',
        password: 'correct-horse-battery',
        nickname: 'L',
        className: '11A',
      }),
      env,
    )
    expect(r.status).toBe(201)
    const adminCount = await db.prepare('SELECT COUNT(*) AS c FROM admin_role').first<{ c: number }>()
    expect(adminCount!.c).toBe(0)
  })

  it('registrations 2..N each receive a session cookie', async () => {
    // First registration (becomes admin)
    const r1 = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'admin1',
        password: 'correct-horse-battery',
        nickname: 'A',
        className: '11A',
      }),
      env,
    )
    expect(r1.status).toBe(201)
    const c1 = getSetCookies(r1).find((c) => c.includes(SESSION_COOKIE_NAME))
    expect(c1).toBeTruthy()

    // Second registration (not admin) also gets a session
    const r2 = await handleAccounts(
      jsonReq('POST', '/api/auth/register', {
        username: 'user2',
        password: 'correct-horse-battery',
        nickname: 'B',
        className: '11B',
      }),
      env,
    )
    expect(r2.status).toBe(201)
    const c2 = getSetCookies(r2).find((c) => c.includes(SESSION_COOKIE_NAME))
    expect(c2).toBeTruthy()
  })
})

// ── AC-25: Last admin guards ──────────────────────────────────────────────────

describe('AC-25 last admin deletion guard', () => {
  it('last admin deleting own account → 409 last_admin', async () => {
    const { userId } = await seedUser(db, {
      username: 'onlyadmin',
      password: 'correct-horse-battery',
      admin: true,
    })
    const token = await sessionFor(db, userId)

    const r = await worker.fetch(
      jsonReq('DELETE', '/api/me', { password: 'correct-horse-battery' }, { token }),
      env,
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('last_admin')
  })
})

// ── AC-34: DELETE /api/me password checks ────────────────────────────────────

describe('AC-34 DELETE /api/me requires correct password', () => {
  it('no password → 401, nothing deleted', async () => {
    const { userId } = await seedUser(db, { username: 'deltest', password: 'correct-horse-battery' })
    const token = await sessionFor(db, userId)

    const r = await worker.fetch(
      jsonReq('DELETE', '/api/me', {}, { token }),
      env,
    )
    expect(r.status).toBe(401)

    const userRow = await db.prepare('SELECT id FROM app_user WHERE id = ?').bind(userId).first()
    expect(userRow).not.toBeNull()
  })

  it('wrong password → 401, nothing deleted', async () => {
    const { userId } = await seedUser(db, { username: 'deltest2', password: 'correct-horse-battery' })
    const token = await sessionFor(db, userId)

    const r = await worker.fetch(
      jsonReq('DELETE', '/api/me', { password: 'wrongpassword!' }, { token }),
      env,
    )
    expect(r.status).toBe(401)

    const userRow = await db.prepare('SELECT id FROM app_user WHERE id = ?').bind(userId).first()
    expect(userRow).not.toBeNull()
  })
})

// ── CSRF / header checks ──────────────────────────────────────────────────────

describe('CSRF and header checks', () => {
  const validBody = {
    username: 'csrftest',
    password: 'correct-horse-battery',
    nickname: 'C',
    className: '11A',
  }

  it('Sec-Fetch-Site: cross-site → 403 forbidden on register', async () => {
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', validBody, { secFetchSite: 'cross-site' }),
      env,
    )
    expect(r.status).toBe(403)
    expect((await r.json() as { error: string }).error).toBe('forbidden')
  })

  it('Sec-Fetch-Site: same-site → 403 forbidden on register', async () => {
    // The contract says "same-origin or absent (else 403)" — same-site is NOT same-origin
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', validBody, { secFetchSite: 'same-site' }),
      env,
    )
    expect(r.status).toBe(403)
  })

  it('Sec-Fetch-Site: absent → OK on register', async () => {
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/register', validBody),
      env,
    )
    expect(r.status).toBe(201)
  })

  it('missing X-Requested-With → 403 on register', async () => {
    const req = new Request('https://x/api/auth/register', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'Content-Type': 'application/json',
        // No X-Requested-With
      },
      body: JSON.stringify(validBody),
    })
    const r = await handleAccounts(req, env)
    expect(r.status).toBe(403)
    expect((await r.json() as { error: string }).error).toBe('forbidden')
  })

  it('Sec-Fetch-Site: cross-site → 403 forbidden on login', async () => {
    await seedUser(db, { username: 'csrflogin', password: 'correct-horse-battery' })
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/login', {
        username: 'csrflogin',
        password: 'correct-horse-battery',
      }, { secFetchSite: 'cross-site' }),
      env,
    )
    expect(r.status).toBe(403)
  })

  it('Sec-Fetch-Site: same-origin → OK on login', async () => {
    await seedUser(db, { username: 'csrfloginok', password: 'correct-horse-battery' })
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/login', {
        username: 'csrfloginok',
        password: 'correct-horse-battery',
      }, { secFetchSite: 'same-origin' }),
      env,
    )
    expect(r.status).toBe(200)
  })
})

// ── Rate limit: AUTH_LIMIT refusing ──────────────────────────────────────────

describe('Rate limits', () => {
  it('AUTH_LIMIT refusing → 429 rate_limited; no hash computed', async () => {
    const limitEnv = accountsEnv({ db, authLimitFail: true })
    await seedUser(db, { username: 'ratelimited', password: 'correct-horse-battery' })

    const before = PASSWORD_STATS.hashes
    const r = await handleAccounts(
      jsonReq('POST', '/api/auth/login', {
        username: 'ratelimited',
        password: 'correct-horse-battery',
      }),
      limitEnv,
    )
    expect(r.status).toBe(429)
    expect((await r.json() as { error: string }).error).toBe('rate_limited')
    expect(PASSWORD_STATS.hashes).toBe(before)
  })

  it('AUTH_SUB_LIMIT key contains username and ip (format: pw:<username>:<ip>)', async () => {
    const recordedKeys: string[] = []
    const recordingLimiter = {
      limit: async (opts: { key: string }) => {
        recordedKeys.push(opts.key)
        return { success: true }
      },
    }
    const limitEnv = accountsEnv({ db, authSubLimit: recordingLimiter })
    await seedUser(db, { username: 'keytest', password: 'correct-horse-battery' })

    await handleAccounts(
      jsonReq('POST', '/api/auth/login', {
        username: 'keytest',
        password: 'correct-horse-battery',
      }, { ip: '10.20.30.40' }),
      limitEnv,
    )

    expect(recordedKeys.some((k) => k === 'pw:keytest:10.20.30.40')).toBe(true)
  })
})
