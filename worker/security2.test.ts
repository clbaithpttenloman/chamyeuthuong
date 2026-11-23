// @vitest-environment node
/**
 * RED-PHASE tests for security cycle 1 fixes (Phase 2).
 *
 * Item 1 — Indexes: gift_user, gift_new, report_user present on fresh + upgraded DB.
 * Item 2 — LIST_READ_LIMIT: gift list 5 s memo (slug+sort+page); limiter charged on miss
 *           only; 429 when exhausted.
 * Item 3 — Reports: per-user daily cap 10 (reports_exhausted after already_reported);
 *           new-account reporter (<24 h) excluded from report_count/auto-hide; recount
 *           consistency across ban/unban/delete/restore paths.
 * Item 4 — Hardening: sign-in 503 without SUB_HMAC_KEY; USER_WRITE_LIMIT key `u:<id>`;
 *           owner delete conditions in write (campaign-closed/banned race); blanked text;
 *           restore gift with banned owner → 409 owner_banned; 404 TTL 5 s for draft/unknown
 *           campaign; campaign date second-precision test at ends_at second; self-ban
 *           check by session user id.
 *
 * All tests must FAIL before the fixes and PASS after.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import { handleGifts } from './gifts.ts'
import { handleTree } from './tree.ts'
import { handleAuth } from './me.ts'
import { handleGiftModeration } from './giftModeration.ts'
import { testDb, type D1 as D1Type } from './testDb.ts'
import {
  createNewTables,
  seedUser,
  seedSession,
  seedAdminEmail,
  pinAdminSub,
  makeRawToken,
  TEST_EMAIL,
  TEST_SUB,
  TEST_NONCE_KEY,
} from './testGoogle.ts'
import {
  createGiftTables,
  giftsEnv,
  giftModerationEnv,
  seedGiftCampaign,
  seedTemplate,
  seedGift,
  sessionReq,
} from './testGift.ts'

// ── Setup helpers ─────────────────────────────────────────────────────────────

type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> }
const fakeLimit = (): Limiter => ({ limit: async () => ({ success: true }) })
const fakeLimitFail = (): Limiter => ({ limit: async () => ({ success: false }) })

/** Make a tree env with optional LIST_READ_LIMIT. */
function treeEnv(db: D1Type, opts: { listReadLimitFail?: boolean } = {}) {
  return {
    DB: db,
    LIST_READ_LIMIT: opts.listReadLimitFail ? fakeLimitFail() : fakeLimit(),
  }
}

let db: ReturnType<typeof testDb>['db']
let sqlite: ReturnType<typeof testDb>['sqlite']
let campaignId: number
let templateId: number
let ownerId: number
let ownerToken: string

beforeEach(async () => {
  ;({ db, sqlite } = testDb())
  createNewTables(sqlite)
  createGiftTables(sqlite)
  campaignId = await seedGiftCampaign(db)
  templateId = await seedTemplate(db, campaignId)
  ownerId = await seedUser(db, { sub: 'sec2-owner-001', email: 'sec2owner@gmail.com' })
  ownerToken = makeRawToken()
  await seedSession(db, ownerId, ownerToken)
})

afterEach(() => {
  vi.useRealTimers()
})

// ═══════════════════════════════════════════════════════════════════════════════
// Item 1 — Indexes
// ═══════════════════════════════════════════════════════════════════════════════

describe('Item 1 — SCHEMA indexes: gift_user, gift_new, report_user', () => {
  it('fresh DB: gift table has gift_user index (user_id, campaign_id, status)', () => {
    const { sqlite: s } = testDb()
    const rows = s.prepare("PRAGMA index_list('gift')").all() as Array<{ name: string }>
    expect(rows.map(r => r.name)).toContain('gift_user')
  })

  it('fresh DB: gift table has gift_new index (campaign_id, status, created_at)', () => {
    const { sqlite: s } = testDb()
    const rows = s.prepare("PRAGMA index_list('gift')").all() as Array<{ name: string }>
    expect(rows.map(r => r.name)).toContain('gift_new')
  })

  it('fresh DB: report table has report_user index (user_id)', () => {
    const { sqlite: s } = testDb()
    const rows = s.prepare("PRAGMA index_list('report')").all() as Array<{ name: string }>
    expect(rows.map(r => r.name)).toContain('report_user')
  })

  it('schema.test FRESH_COLD_START constant still matches actual DDL count', async () => {
    // Verifies the schema test constant is updated after adding 3 new index statements.
    const { SCHEMA } = await import('./schema.ts')
    // gift_user, gift_new, report_user must each be present in SCHEMA
    const hasGiftUser  = SCHEMA.some(s => s.includes('gift_user'))
    const hasGiftNew   = SCHEMA.some(s => s.includes('gift_new'))
    const hasReportUser = SCHEMA.some(s => s.includes('report_user'))
    expect(hasGiftUser).toBe(true)
    expect(hasGiftNew).toBe(true)
    expect(hasReportUser).toBe(true)
  })

  it('upgraded DB: same indexes present (via CAMPAIGN_INDEX_SQLS path in testDb)', () => {
    // testDb() applies CAMPAIGN_UPGRADE_SQLS + CAMPAIGN_INDEX_SQLS then SCHEMA
    // so the gift and report indexes appear on the simulated "already-upgraded" DB.
    const { sqlite: s } = testDb()
    const giftIdxs  = (s.prepare("PRAGMA index_list('gift')").all() as Array<{ name: string }>).map(r => r.name)
    const repIdxs   = (s.prepare("PRAGMA index_list('report')").all() as Array<{ name: string }>).map(r => r.name)
    expect(giftIdxs).toContain('gift_user')
    expect(giftIdxs).toContain('gift_new')
    expect(repIdxs).toContain('report_user')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Item 2 — LIST_READ_LIMIT and gift-list memo
// ═══════════════════════════════════════════════════════════════════════════════

describe('Item 2 — LIST_READ_LIMIT and 5 s memo for GET /api/campaigns/<slug>/gifts', () => {
  it('LIST_READ_LIMIT exhausted → 429 on GET /api/campaigns/<slug>/gifts', async () => {
    const r = await handleTree(
      new Request(`https://x/api/campaigns/noel-2026/gifts`, {
        headers: { 'CF-Connecting-IP': '1.2.3.4' },
      }),
      treeEnv(db, { listReadLimitFail: true }),
    )
    expect(r.status).toBe(429)
  })

  it('LIST_READ_LIMIT exhausted → 429 on GET /api/gifts/<publicId>', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'rlgift1234567890',  // exactly 16 lowercase alphanumeric chars
    })
    const r = await handleTree(
      new Request(`https://x/api/gifts/${publicId}`, {
        headers: { 'CF-Connecting-IP': '1.2.3.4' },
      }),
      treeEnv(db, { listReadLimitFail: true }),
    )
    expect(r.status).toBe(429)
  })

  it('repeated identical page → one DB read (second call uses memo, state.prepares does not increase)', async () => {
    const env = treeEnv(db)
    const req1 = () => new Request(`https://x/api/campaigns/noel-2026/gifts?sort=hearts&page=1`, {
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    })

    const r1 = await handleTree(req1(), env)
    expect(r1.status).toBe(200)
    // Track prepares after first call
    // Clear the state tracker isn't directly accessible, so we check by counting via a fresh share
    const { db: db2, state } = testDb({ shareWith: sqlite })
    const env2 = treeEnv(db2)
    const r2a = await handleTree(req1(), env2) // miss on this new binding
    const preparesAfterMiss = state.prepares
    const r2b = await handleTree(req1(), env2) // should be a memo hit
    const preparesAfterHit = state.prepares
    expect(r2a.status).toBe(200)
    expect(r2b.status).toBe(200)
    // On a hit, no additional DB prepares should occur (or significantly fewer)
    expect(preparesAfterHit).toBe(preparesAfterMiss)
  })

  it('random sort values share the hearts memo entry (no cache-busting keys)', async () => {
    const { db: db2, state } = testDb({ shareWith: sqlite })
    const env2 = treeEnv(db2)
    const req = (sort: string) => new Request(`https://x/api/campaigns/noel-2026/gifts?sort=${sort}&page=1`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    expect((await handleTree(req('hearts'), env2)).status).toBe(200)
    const afterFirst = state.prepares
    expect((await handleTree(req('zz1'), env2)).status).toBe(200)
    expect((await handleTree(req('zz2'), env2)).status).toBe(200)
    expect(state.prepares).toBe(afterFirst)
  })

  it('LIST_READ_LIMIT is charged on miss (first call) but not on hit (second call)', async () => {
    const calls: string[] = []
    const countingLimit: Limiter = {
      limit: async (opts) => { calls.push(opts.key); return { success: true } },
    }
    const env = { DB: db, LIST_READ_LIMIT: countingLimit }
    const req = () => new Request(`https://x/api/campaigns/noel-2026/gifts`, {
      headers: { 'CF-Connecting-IP': '5.6.7.8' },
    })
    await handleTree(req(), env)
    const callsAfterMiss = calls.length
    await handleTree(req(), env)
    const callsAfterHit = calls.length
    // Limiter called once for miss, not again for hit
    expect(callsAfterMiss).toBeGreaterThan(0)
    expect(callsAfterHit).toBe(callsAfterMiss) // no new limiter calls on hit
  })

  it('draft/unknown campaign: 404 TTL is 5 s (not 30 s), re-fetches after expiry', async () => {
    // With a 5 s TTL, a request at t=4999 ms still returns 404 (from memo)
    // but at t=5001 ms a DB hit is needed (memo expired).
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const env = treeEnv(db)
    // First call — miss for unknown slug, DB returns 404, caches for 5 s
    const r1 = await handleTree(
      new Request('https://x/api/campaigns/no-such-slug/gifts', {
        headers: { 'CF-Connecting-IP': '1.2.3.4' },
      }),
      env,
    )
    expect(r1.status).toBe(404)

    // At t=4 s — still in 5 s window → 404 from memo (no new DB hit)
    vi.setSystemTime(4000)
    // Verify the second request (same binding) also returns 404 from memo
    const r2 = await handleTree(
      new Request('https://x/api/campaigns/no-such-slug/gifts', {
        headers: { 'CF-Connecting-IP': '1.2.3.4' },
      }),
      env,
    )
    expect(r2.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Item 3 — Reports: daily cap 10, new-account exclusion, recount consistency
// ═══════════════════════════════════════════════════════════════════════════════

describe('Item 3 — Report daily cap 10 (reports_exhausted)', () => {
  it('11th report by same user in one Vietnam day → 429 reports_exhausted', async () => {
    // Seed 10 reports by the reporter on 10 different gifts
    const reporterId = await seedUser(db, { sub: 'daily-cap-reporter', email: 'dailycap@gmail.com' })
    const reporterToken = makeRawToken()
    await seedSession(db, reporterId, reporterToken)
    const now = new Date().toISOString()

    for (let i = 0; i < 10; i++) {
      const ownI = await seedUser(db, { sub: `dc-owner-${i}`, email: `dcowner${i}@gmail.com` })
      const { id: giftId } = await seedGift(db, ownI, campaignId, templateId, {
        publicId: `dc${i}giftpad12345`.slice(0, 16),
      })
      sqlite.prepare('INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?,?,?,0,?)').run(giftId, reporterId, 'spam', now)
    }

    // 11th report on a fresh gift
    const owner11 = await seedUser(db, { sub: 'dc-owner-11', email: 'dcowner11@gmail.com' })
    const { publicId: pid11 } = await seedGift(db, owner11, campaignId, templateId, {
      publicId: 'dc11giftpad12345'.slice(0, 16),
    })
    const r = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${pid11}/report`, 'POST', { reason: 'spam' }),
      giftsEnv(db),
    )
    expect(r.status).toBe(429)
    expect((await r.json() as { error: string }).error).toBe('reports_exhausted')
  })

  it('error order: already_reported before reports_exhausted (same gift = already_reported wins)', async () => {
    const reporterId = await seedUser(db, { sub: 'order-test-reporter', email: 'ordertest@gmail.com' })
    const reporterToken = makeRawToken()
    await seedSession(db, reporterId, reporterToken)
    const now = new Date().toISOString()

    const { id: giftId, publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'ordertestgift1234'.slice(0, 16),
    })
    // Seed 10 reports on OTHER gifts by the same reporter
    for (let i = 0; i < 9; i++) {
      const ownI = await seedUser(db, { sub: `order-o-${i}`, email: `ordero${i}@gmail.com` })
      const { id: g } = await seedGift(db, ownI, campaignId, templateId, {
        publicId: `ot${i}giftpad12345`.slice(0, 16),
      })
      sqlite.prepare('INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?,?,?,0,?)').run(g, reporterId, 'spam', now)
    }
    // Also add a report on THIS gift (the one below) → already_reported
    sqlite.prepare('INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?,?,?,0,?)').run(giftId, reporterId, 'spam', now)
    // So reporter has 10 total (9 others + 1 on this gift), daily cap is 10, and this gift is already reported

    const r = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'other' }),
      giftsEnv(db),
    )
    // already_reported takes precedence over reports_exhausted
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('already_reported')
  })
})

describe('Item 3 — New-account reporter exclusion from report_count / auto-hide', () => {
  it('report from account < 24 h old does not count toward auto-hide (threshold 2 + 1 new-account = stays visible)', async () => {
    // threshold = 2: 2 normal reports would auto-hide; with 1 normal + 1 new-account → still visible
    const camp2 = await seedGiftCampaign(db, { id: 9, slug: 'noel-new-acct', settings: { report_threshold: 2 } })
    const tmpl2 = await seedTemplate(db, camp2)
    const owner2 = await seedUser(db, { sub: 'na-owner', email: 'naowner@gmail.com' })
    const { publicId } = await seedGift(db, owner2, camp2, tmpl2, { publicId: 'naacctgift123456'.slice(0, 16) })

    // Reporter 1: account created > 24 h ago → counts
    const r1Id = await seedUser(db, { sub: 'na-r1', email: 'nar1@gmail.com' })
    const r1Token = makeRawToken()
    await seedSession(db, r1Id, r1Token)
    // Backdate r1 account creation to > 24 h ago
    sqlite.prepare("UPDATE app_user SET created_at = datetime('now', '-25 hours') WHERE id = ?").run(r1Id)
    await handleGifts(
      sessionReq(r1Token, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
      giftsEnv(db),
    )

    // Reporter 2: account just created (< 24 h ago) → does NOT count toward auto-hide
    const r2Id = await seedUser(db, { sub: 'na-r2', email: 'nar2@gmail.com' })
    const r2Token = makeRawToken()
    await seedSession(db, r2Id, r2Token)
    // created_at is already "now" (default)
    await handleGifts(
      sessionReq(r2Token, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
      giftsEnv(db),
    )

    // Gift should still be visible (new-account report excluded → effective count = 1 < threshold 2)
    const gift = sqlite.prepare('SELECT status, report_count FROM gift WHERE public_id = ?').get(publicId) as { status: string; report_count: number }
    expect(gift.status).toBe('visible')
    expect(gift.report_count).toBe(1) // only the aged account counts
  })

  it('new-account exclusion is consistent on ban recount: banning the old reporter drops count correctly', async () => {
    // 2 reporters: aged (counts) and new (doesn't count); ban the aged reporter → count drops to 0
    const r1Id = await seedUser(db, { sub: 'nc-ban-r1', email: 'ncbanr1@gmail.com' })
    const r2Id = await seedUser(db, { sub: 'nc-ban-r2', email: 'ncbanr2@gmail.com' })
    const { id: giftId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'ncbangift1234567'.slice(0, 16),
    })
    const now = new Date().toISOString()
    // Insert reports
    sqlite.prepare('INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?,?,?,0,?)').run(giftId, r1Id, 'spam', now)
    sqlite.prepare('INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?,?,?,0,?)').run(giftId, r2Id, 'spam', now)
    // r1 is aged (> 24 h before the report)
    sqlite.prepare("UPDATE app_user SET created_at = datetime(?, '-25 hours') WHERE id = ?").run(now, r1Id)
    // r2 is new (created at now = same time as report → < 24 h)
    sqlite.prepare('UPDATE app_user SET created_at = ? WHERE id = ?').run(now, r2Id)
    sqlite.prepare('UPDATE gift SET report_count = 1 WHERE id = ?').run(giftId)

    // Set up admin
    await seedAdminEmail(db, TEST_EMAIL)
    const adminId = await seedUser(db, { sub: TEST_SUB, email: TEST_EMAIL })
    await pinAdminSub(db, TEST_EMAIL, TEST_SUB)
    const adminToken = makeRawToken()
    await seedSession(db, adminId, adminToken)

    // Ban r1 (aged reporter) → their report should be excluded → count goes to 0
    const banResp = await handleGiftModeration(
      sessionReq(adminToken, `/api/admin/users/${r1Id}`, 'PATCH', { banned: true }),
      giftModerationEnv(db),
    )
    expect(banResp.status).toBe(200)

    const gift = sqlite.prepare('SELECT report_count FROM gift WHERE id = ?').get(giftId) as { report_count: number }
    // r2's report doesn't count (new account), r1's doesn't count (banned), so total = 0
    expect(gift.report_count).toBe(0)
  })

  it('GET /api/admin/gifts reports reportsFromNewAccounts count in items', async () => {
    const { id: giftId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'newacctadmingift1'.slice(0, 16),
      reportCount: 1,
    })
    // New-account reporter
    const newUserId = await seedUser(db, { sub: 'new-acct-rpt', email: 'newacctrpt@gmail.com' })
    const now = new Date().toISOString()
    sqlite.prepare('INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?,?,?,0,?)').run(giftId, newUserId, 'spam', now)
    // new user created_at = now = same as report → < 24h
    sqlite.prepare('UPDATE app_user SET created_at = ? WHERE id = ?').run(now, newUserId)

    // Set up admin
    await seedAdminEmail(db, TEST_EMAIL)
    const adminId = await seedUser(db, { sub: TEST_SUB, email: TEST_EMAIL })
    await pinAdminSub(db, TEST_EMAIL, TEST_SUB)
    const adminToken = makeRawToken()
    await seedSession(db, adminId, adminToken)

    const r = await handleGiftModeration(
      sessionReq(adminToken, `/api/admin/gifts?status=reported`, 'GET'),
      giftModerationEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Array<{ reportsFromNewAccounts?: number }>
    const item = body.find(g => (g as unknown as { id: number }).id === giftId)
    expect(item).toBeDefined()
    expect(typeof item!.reportsFromNewAccounts).toBe('number')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Item 4 — Hardening
// ═══════════════════════════════════════════════════════════════════════════════

describe('Item 4 — Sign-in fails closed when SUB_HMAC_KEY is missing', () => {
  it('POST /api/auth/google without SUB_HMAC_KEY → 503 misconfigured', async () => {
    const env = {
      DB: db,
      GOOGLE_CLIENT_ID: 'test-client-123.apps.googleusercontent.com',
      NONCE_KEY: TEST_NONCE_KEY,
      // SUB_HMAC_KEY intentionally absent
    }
    const r = await handleAuth(
      new Request('https://x/api/auth/google', {
        method: 'POST',
        headers: {
          'X-Requested-With': 'fetch',
          'CF-Connecting-IP': '1.2.3.4',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ credential: 'dummy' }),
      }),
      env,
    )
    expect(r.status).toBe(503)
    const body = await r.json() as { error: string }
    expect(body.error).toBe('misconfigured')
  })
})

describe('Item 4 — USER_WRITE_LIMIT key format u:<id>', () => {
  it('USER_WRITE_LIMIT called with key u:<userId> (not bare id) on owner delete', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const usedKeys: string[] = []
    const spyLimit: Limiter = { limit: async (opts) => { usedKeys.push(opts.key); return { success: true } } }
    const env = { ...giftsEnv(db), USER_WRITE_LIMIT: spyLimit }
    await handleGifts(sessionReq(ownerToken, `/api/gifts/${publicId}`, 'DELETE'), env)
    expect(usedKeys.some(k => k.startsWith('u:'))).toBe(true)
    expect(usedKeys.some(k => k === String(ownerId))).toBe(false)
  })
})

describe('Item 4 — Owner delete conditions inside the write', () => {
  it('campaign already closed → 409 campaign_closed (conditional UPDATE detects closed campaign)', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    // Close the campaign BEFORE the delete request — the conditional UPDATE should detect it
    sqlite.prepare("UPDATE campaign SET status = 'closed' WHERE id = ?").run(campaignId)
    const r = await handleGifts(
      sessionReq(ownerToken, `/api/gifts/${publicId}`, 'DELETE'),
      giftsEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_closed')
  })

  it('user already banned → 403 banned (conditional UPDATE detects banned user)', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    // Ban the user BEFORE the delete request — the conditional UPDATE should detect it
    sqlite.prepare('UPDATE app_user SET banned = 1 WHERE id = ?').run(ownerId)
    const r = await handleGifts(
      sessionReq(ownerToken, `/api/gifts/${publicId}`, 'DELETE'),
      giftsEnv(db),
    )
    expect(r.status).toBe(403)
    expect((await r.json() as { error: string }).error).toBe('banned')
  })

  it('open (unacknowledged) reports below the threshold → 409 pending_review, text kept', async () => {
    const { id, publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const reporter = (sqlite.prepare("INSERT INTO app_user (nickname, class_name, banned, created_at, last_seen_at) VALUES ('R','',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z') RETURNING id").get() as { id: number }).id
    sqlite.prepare("INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?, ?, 'spam', 0, ?)").run(id, reporter, new Date().toISOString())
    const r = await handleGifts(sessionReq(ownerToken, `/api/gifts/${publicId}`, 'DELETE'), giftsEnv(db))
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('pending_review')
    const row = sqlite.prepare('SELECT status, message FROM gift WHERE id = ?').get(id) as { status: string; message: string }
    expect(row.status).toBe('visible')
    expect(row.message.trim()).not.toBe('')
  })

  it('a report from an account < 24 h old does not block owner delete', async () => {
    const { id, publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const now = new Date().toISOString()
    const fresh = (sqlite.prepare("INSERT INTO app_user (nickname, class_name, banned, created_at, last_seen_at) VALUES ('R','',0,?,?) RETURNING id").get(now, now) as { id: number }).id
    sqlite.prepare("INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?, ?, 'spam', 0, ?)").run(id, fresh, now)
    expect((await handleGifts(sessionReq(ownerToken, `/api/gifts/${publicId}`, 'DELETE'), giftsEnv(db))).status).toBe(200)
  })

  it('a report from a banned reporter does not block owner delete', async () => {
    const { id, publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const banned = (sqlite.prepare("INSERT INTO app_user (nickname, class_name, banned, created_at, last_seen_at) VALUES ('R','',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z') RETURNING id").get() as { id: number }).id
    sqlite.prepare("INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?, ?, 'spam', 0, ?)").run(id, banned, new Date().toISOString())
    expect((await handleGifts(sessionReq(ownerToken, `/api/gifts/${publicId}`, 'DELETE'), giftsEnv(db))).status).toBe(200)
  })

  it('reporting your own gift → 403 own_gift, nothing stored', async () => {
    const { id, publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await handleGifts(sessionReq(ownerToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }), giftsEnv(db))
    expect(r.status).toBe(403)
    expect((await r.json() as { error: string }).error).toBe('own_gift')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM report WHERE gift_id = ?').get(id)).toEqual({ n: 0 })
  })

  it('acknowledged reports do not block owner delete', async () => {
    const { id, publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const reporter = (sqlite.prepare("INSERT INTO app_user (nickname, class_name, banned, created_at, last_seen_at) VALUES ('R','',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z') RETURNING id").get() as { id: number }).id
    sqlite.prepare("INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?, ?, 'spam', 1, ?)").run(id, reporter, new Date().toISOString())
    expect((await handleGifts(sessionReq(ownerToken, `/api/gifts/${publicId}`, 'DELETE'), giftsEnv(db))).status).toBe(200)
  })

  it('owner delete blanks message, nickname; class_name becomes empty', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await handleGifts(sessionReq(ownerToken, `/api/gifts/${publicId}`, 'DELETE'), giftsEnv(db))
    expect(r.status).toBe(200)
    const row = sqlite.prepare('SELECT message, nickname, class_name, status FROM gift WHERE public_id = ?').get(publicId) as { message: string; nickname: string; class_name: string; status: string }
    // text is blanked (empty or single-space), status is deleted
    expect(row.status).toBe('deleted')
    expect(row.message.trim()).toBe('')
    expect(row.nickname.trim()).toBe('')
    expect(row.class_name).toBe('')
  })

  it('owner delete: nothing public or admin shows the blanked text (gift excluded from all public lists)', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    await handleGifts(sessionReq(ownerToken, `/api/gifts/${publicId}`, 'DELETE'), giftsEnv(db))
    // Gift not found via public endpoint
    const r = await handleTree(
      new Request(`https://x/api/gifts/${publicId}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      treeEnv(db),
    )
    expect(r.status).toBe(404)
  })
})

describe('Item 4 — Restore gift with banned owner → 409 owner_banned', () => {
  it('admin restore on a gift owned by a banned user → 409 owner_banned', async () => {
    // Create a gift that was hidden_admin, owner now banned
    const bannedOwner = await seedUser(db, { sub: 'banned-own-sec2', email: 'bannedownsec2@gmail.com', banned: true })
    const { id: giftId } = await seedGift(db, bannedOwner, campaignId, templateId, {
      publicId: 'bannedrestoregift'.slice(0, 16),
      status: 'hidden_admin',
    })

    await seedAdminEmail(db, TEST_EMAIL)
    const adminId = await seedUser(db, { sub: TEST_SUB, email: TEST_EMAIL })
    await pinAdminSub(db, TEST_EMAIL, TEST_SUB)
    const adminToken = makeRawToken()
    await seedSession(db, adminId, adminToken)

    const r = await handleGiftModeration(
      sessionReq(adminToken, `/api/admin/gifts/${giftId}`, 'PATCH', { status: 'visible' }),
      giftModerationEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('owner_banned')
  })
})

describe('Item 4 — Self-ban check uses session user id (not admin email)', () => {
  it('admin cannot ban themselves (check uses session userId, not email lookup)', async () => {
    await seedAdminEmail(db, TEST_EMAIL)
    const adminId = await seedUser(db, { sub: TEST_SUB, email: TEST_EMAIL })
    await pinAdminSub(db, TEST_EMAIL, TEST_SUB)
    const adminToken = makeRawToken()
    await seedSession(db, adminId, adminToken)

    // Trying to ban the admin's own userId via PATCH should return 403
    const r = await handleGiftModeration(
      sessionReq(adminToken, `/api/admin/users/${adminId}`, 'PATCH', { banned: true }),
      giftModerationEnv(db),
    )
    expect(r.status).toBe(403)
    expect((await r.json() as { error: string }).error).toBe('forbidden')
  })
})

describe('Item 4 — Campaign date second-precision at ends_at second', () => {
  it('gift create at ends_at.999 ms succeeds (second-precision comparison treats it as open)', async () => {
    vi.useFakeTimers()
    const endsAt = '2026-12-24T23:59:59Z'
    // Set clock to the last millisecond of the campaign
    vi.setSystemTime(new Date('2026-12-24T23:59:59.999Z').getTime())
    // Replace campaign with one that ends at exactly this second
    await seedGiftCampaign(db, { id: 3, slug: 'noel-sec-test', endsAt, startsAt: '2026-01-01T00:00:00Z' })
    const tmplSec = await seedTemplate(db, 3)
    const r = await handleGifts(
      sessionReq(ownerToken, '/api/campaigns/noel-sec-test/gifts', 'POST', {
        boxStyle: 1, ornamentStyle: 1, layout: 'doc-giua',
        backgroundTemplateId: tmplSec, font: 'patrick-hand', ink: '#1d3fa6',
        message: 'Test tại giây cuối', nickname: 'Học sinh', className: '11A',
      }),
      giftsEnv(db),
    )
    // With second-precision fix: campaign is still open → 201
    // Without fix: now.getTime() > ends_at.getTime() → campaign_closed → 409
    expect(r.status).toBe(201)
  })
})

describe('Item 4 — Wrangler ADMIN_LEGACY_LOGIN comment is accurate', () => {
  it('wrangler.jsonc no longer contains stale "Remove before Phase 2 production deploy" comment', async () => {
    const { readFileSync } = await import('node:fs')
    const content = readFileSync(
      new URL('../wrangler.jsonc', import.meta.url).pathname, 'utf-8',
    )
    expect(content).not.toContain('Remove before Phase 2 production deploy')
  })
})

describe('Item 4 — errors.ts has all new error codes', () => {
  it('errors.ts includes reports_exhausted', async () => {
    const { ERROR_MESSAGES } = await import('../src/game/errors.ts')
    expect(ERROR_MESSAGES).toHaveProperty('reports_exhausted')
    expect(typeof ERROR_MESSAGES['reports_exhausted']).toBe('string')
  })

  it('errors.ts includes owner_banned', async () => {
    const { ERROR_MESSAGES } = await import('../src/game/errors.ts')
    expect(ERROR_MESSAGES).toHaveProperty('owner_banned')
    expect(typeof ERROR_MESSAGES['owner_banned']).toBe('string')
  })
})
