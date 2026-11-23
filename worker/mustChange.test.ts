// @vitest-environment node
/**
 * RED-phase tests for AC-25a: must_change session enforcement.
 *
 * A user with must_change=1 must receive 403 { "error": "password_change_required" }
 * on EVERY session-requiring route EXCEPT:
 *   - GET /api/me
 *   - POST /api/me/password
 *   - POST /api/auth/logout
 *
 * Also verifies:
 *   - GET /api/campaigns/<slug>/tree is byte-identical for must_change and anonymous sessions
 *   - A grep test: every /api/ route pattern found in worker/index.ts must appear in
 *     SESSION_ROUTES or one of the explicit allowance/public lists.
 *     Future developers adding a new session-requiring route to index.ts must add it here.
 *
 * All tests fail NOW because worker/testAccounts.ts → worker/password.ts does not exist yet,
 * and because worker/session.ts does not yet return { kind: 'must_change' }.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── RED MECHANISM: cascades from testAccounts.ts → password.ts (not yet written) ─
import {
  createAccountTables,
  accountsEnv,
  seedUser,
  sessionFor,
  SESSION_COOKIE_NAME,
} from './testAccounts.ts'
// ─────────────────────────────────────────────────────────────────────────────

import { testDb } from './testDb.ts'
import { seedGiftCampaign } from './testGift.ts'
import worker from './index.ts'

// ── Route lists ───────────────────────────────────────────────────────────────

/**
 * Every session-requiring route that must return 403 { "error": "password_change_required" }
 * when the session has must_change = 1.
 *
 * MAINTENANCE NOTE: When adding a new session-requiring route to worker/index.ts,
 * add it here too. The grep test below fails if a /api/ pattern in index.ts is not covered.
 */
export const SESSION_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  // ── /api/me routes ──
  { method: 'GET',    path: '/api/me/gifts' },
  { method: 'PUT',    path: '/api/me' },
  { method: 'DELETE', path: '/api/me' },
  // Phase 2b: POST /api/me/password is ALLOWED for must_change — not listed here
  // ── Gift write routes ──
  { method: 'POST',   path: '/api/campaigns/noel-2026/gifts' },
  { method: 'DELETE', path: '/api/gifts/testpublicid00001' },
  { method: 'POST',   path: '/api/gifts/testpublicid00001/heart' },
  { method: 'POST',   path: '/api/gifts/testpublicid00001/report' },
  // ── Admin routes (admin-role users must also change password first) ──
  { method: 'POST',   path: '/api/admin/campaigns' },
  { method: 'GET',    path: '/api/admin/campaigns' },
  { method: 'GET',    path: '/api/admin/gifts' },
  { method: 'PATCH',  path: '/api/admin/gifts/1' },
  { method: 'GET',    path: '/api/admin/users' },
  { method: 'PATCH',  path: '/api/admin/users/1' },
  // ── Phase 2b admin routes (added to index.ts as part of implementation) ──
  { method: 'GET',    path: '/api/admin/admins' },
  { method: 'POST',   path: '/api/admin/admins' },
  { method: 'DELETE', path: '/api/admin/admins/1' },
  { method: 'GET',    path: '/api/admin/audit' },
  { method: 'POST',   path: '/api/admin/users/1/password' },
]

/**
 * Routes that ARE allowed for a must_change session (must NOT return 403 password_change_required).
 */
export const MUST_CHANGE_ALLOWED: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET',  path: '/api/me' },
  { method: 'POST', path: '/api/me/password' },
  { method: 'POST', path: '/api/auth/logout' },
]

/**
 * Public routes that do not require a session (tree, campaign reads, etc.).
 * These never consult the session, so must_change is irrelevant.
 */
const PUBLIC_ROUTES: ReadonlyArray<{ path: string }> = [
  { path: '/api/image/' },
  { path: '/api/wall' },
  { path: '/api/templates' },
  { path: '/api/wishes' },
  { path: '/api/about' },
  { path: '/api/auth/nonce' },
  { path: '/api/auth/google' },
  { path: '/api/auth/' },
  // Phase 2b: register and login do not require a session
  { path: '/api/auth/register' },
  { path: '/api/auth/login' },
  { path: '/api/campaigns/active' },
  { path: '/api/campaigns/' },
  { path: '/api/campaigns/noel-2026/tree' },
  { path: '/api/campaigns/noel-2026/gifts' },      // GET is public; POST is in SESSION_ROUTES
  { path: '/api/campaigns/noel-2026/templates' },
  { path: '/api/gifts/testpublicid00001' },         // GET is public
  { path: '/api/gifts/' },
  { path: '/api/cards' },
  { path: '/api/qr/' },
  { path: '/api/admin/tombstones' },               // read-only tombstone admin list
]

// ── Setup ─────────────────────────────────────────────────────────────────────

let db: ReturnType<typeof testDb>['db']
let sqlite: ReturnType<typeof testDb>['sqlite']
let env: ReturnType<typeof accountsEnv>
let mustChangeToken: string
let campaignSlug: string

beforeEach(async () => {
  ;({ db, sqlite } = testDb())
  createAccountTables(sqlite)
  env = accountsEnv({ db })

  // Seed a gift_tree campaign so tree endpoints work
  campaignSlug = 'noel-2026'
  await seedGiftCampaign(db, { slug: campaignSlug })

  // Seed a user with must_change = 1 and admin = true (so admin routes also need testing)
  const { userId } = await seedUser(db, {
    username: 'mustchangeuser',
    password: 'Password1!',
    admin: true,
    mustChange: true,
  })
  mustChangeToken = await sessionFor(db, userId)
})

// ── Helper ────────────────────────────────────────────────────────────────────

function makeReq(method: string, path: string, token?: string): Request {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '1.2.3.4' }
  if (token) headers['Cookie'] = `${SESSION_COOKIE_NAME}=${token}`
  if (method !== 'GET') {
    headers['X-Requested-With'] = 'fetch'
    headers['Content-Type'] = 'application/json'
  }
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: method !== 'GET' ? JSON.stringify({}) : undefined,
  })
}

async function json(res: Response) {
  try { return await res.clone().json() as Record<string, unknown> } catch { return {} }
}

// ── AC-25a: Every session-requiring route returns 403 for must_change ─────────

describe('AC-25a: SESSION_ROUTES → 403 password_change_required for must_change session', () => {
  for (const { method, path } of SESSION_ROUTES) {
    it(`${method} ${path}`, async () => {
      const res = await worker.fetch(makeReq(method, path, mustChangeToken), env)
      expect(res.status).toBe(403)
      expect((await json(res)).error).toBe('password_change_required')
    })
  }
})

// ── AC-25a: Allowed routes do NOT return 403 password_change_required ─────────

describe('AC-25a: allowed routes do NOT return 403 password_change_required', () => {
  it('GET /api/me returns 200 (or at least not 403 password_change_required)', async () => {
    const res = await worker.fetch(makeReq('GET', '/api/me', mustChangeToken), env)
    // must_change user can read their own profile
    expect(res.status).toBe(200)
    expect((await json(res)).error).not.toBe('password_change_required')
  })

  it('POST /api/me/password with wrong password → 401 (not 403 password_change_required)', async () => {
    const req = new Request('https://x/api/me/password', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
        'Cookie': `${SESSION_COOKIE_NAME}=${mustChangeToken}`,
      },
      body: JSON.stringify({ current: 'wrongpassword!!', next: 'NewPassword1!' }),
    })
    const res = await worker.fetch(req, env)
    // Should NOT be 403 password_change_required (this route is allowed for must_change)
    // May be 401 (wrong current password) or 200 — but not 403 must_change
    const body = await json(res)
    expect(body.error).not.toBe('password_change_required')
  })

  it('POST /api/auth/logout → not 403 password_change_required', async () => {
    const req = new Request('https://x/api/auth/logout', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
        'Cookie': `${SESSION_COOKIE_NAME}=${mustChangeToken}`,
      },
      body: JSON.stringify({}),
    })
    const res = await worker.fetch(req, env)
    expect((await json(res)).error).not.toBe('password_change_required')
    // Successful logout clears the cookie
    if (res.status === 200) {
      expect(res.headers.get('Set-Cookie') ?? '').toMatch(/Max-Age=0|expires=.*1970/i)
    }
  })
})

// ── AC-25a / AC-19: tree response is byte-identical for must_change vs anonymous ─

describe('AC-25a / AC-19: tree byte-identical for must_change and anonymous', () => {
  it('GET /api/campaigns/noel-2026/tree: same response with or without must_change cookie', async () => {
    const withCookie = new Request(`https://x/api/campaigns/${campaignSlug}/tree`, {
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'Cookie': `${SESSION_COOKIE_NAME}=${mustChangeToken}`,
      },
    })
    const anon = new Request(`https://x/api/campaigns/${campaignSlug}/tree`, {
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    })
    // Sequential: the second request is served from the 5 s memo, so both carry the same asOf.
    const r1 = await worker.fetch(withCookie, env)
    const r2 = await worker.fetch(anon, env)
    // Both should succeed
    expect(r1.status).toBe(r2.status)
    // Bodies must be byte-identical (tree never reads Cookie)
    const [t1, t2] = [await r1.text(), await r2.text()]
    expect(t1).toBe(t2)
  })
})

// ── Grep test: every /api/ pattern in index.ts covered by this list ───────────

describe('Route coverage: index.ts patterns appear in SESSION_ROUTES or allowance lists', () => {
  it('no /api/ pattern in index.ts is missing from the route lists', () => {
    const indexPath = resolve(import.meta.dirname ?? process.cwd(), 'index.ts')
    const source = readFileSync(indexPath, 'utf-8')

    // Extract string literals and regex literal strings that look like /api/ paths.
    // This catches: '/api/me', '/api/auth/', /^\/api\/.../, startsWith('/api/image/')
    const STRING_RE = /['"`](\/api\/[^'"`\n]+)['"`]/g
    const REGEX_RE = /\/(\^?\\?\/api\\?\/[^/\s]+(?:\\?\/[^/\s]*)*)/g

    const found = new Set<string>()
    let m: RegExpExecArray | null

    while ((m = STRING_RE.exec(source)) !== null) {
      found.add(m[1]!)
    }
    while ((m = REGEX_RE.exec(source)) !== null) {
      // Convert escaped regex to readable path: replace \/ with /
      found.add(m[1]!.replace(/\\\//g, '/').replace(/\^/, ''))
    }

    // Build set of all covered paths from all three lists
    const covered = new Set<string>()
    for (const { path } of SESSION_ROUTES) covered.add(path)
    for (const { path } of MUST_CHANGE_ALLOWED) covered.add(path)
    for (const { path } of PUBLIC_ROUTES) covered.add(path)

    // Check that every found /api/ pattern has a prefix match in covered
    // (we do prefix matching because index.ts often has path prefixes like '/api/auth/')
    const uncovered: string[] = []
    for (const pattern of found) {
      const isCovered = [...covered].some(
        (c) => pattern.startsWith(c) || c.startsWith(pattern) || pattern === c,
      )
      if (!isCovered) uncovered.push(pattern)
    }

    if (uncovered.length > 0) {
      throw new Error(
        `These /api/ patterns from worker/index.ts are not covered by SESSION_ROUTES, ` +
        `MUST_CHANGE_ALLOWED, or PUBLIC_ROUTES:\n  ${uncovered.join('\n  ')}\n\n` +
        `Add them to the appropriate list in worker/mustChange.test.ts.`,
      )
    }
  })
})
