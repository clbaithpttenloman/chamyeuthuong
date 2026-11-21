// @vitest-environment node
/**
 * RED-PHASE tests for POST /api/gifts/<publicId>/report (via worker/gifts.ts).
 *
 * Module contract:
 *
 *   POST /api/gifts/<publicId>/report
 *     Body: { reason: 'inappropriate' | 'spam' | 'other' }
 *     Auth: session cookie required (401 if missing)
 *     Rate-limit: REPORT_LIMIT per user (429 rate_limited)
 *
 *   Success: 200 { ok: true }
 *
 *   Error codes:
 *     401 — not signed in
 *     404 { error: 'gift_not_found' } — gift hidden, deleted, or not found
 *     409 { error: 'campaign_closed' } — campaign is not effectively open
 *     403 { error: 'banned' } — user is banned
 *     409 { error: 'already_reported' } — user already reported this gift
 *     400 { error: 'bad_request' } — unknown reason value
 *     429 { error: 'rate_limited' } — REPORT_LIMIT exhausted
 *
 *   Auto-hide (ADR-8):
 *     When the number of DISTINCT UNACKNOWLEDGED reports reaches report_threshold
 *     (from campaign settings, default 3), the gift status changes to 'hidden_auto'
 *     IN THE SAME BATCH as the INSERT report + recount.
 *     This is atomic: the gift appears in the admin queue immediately.
 *
 *   Banned user exclusion (ADR-8):
 *     Reports from banned users are NOT counted in report_count and do NOT contribute
 *     to auto-hide. The INSERT still succeeds (they can file the report) but it has
 *     no visible effect on the gift.
 *     report_count = COUNT(unacknowledged reports from non-banned users).
 *
 *   Acknowledged reports (after admin restore):
 *     When an admin restores a gift, existing reports are marked acknowledged=1.
 *     Only new reports (acknowledged=0) count toward the threshold.
 *
 * All tests fail NOW because worker/gifts.ts does not exist.
 */
import { describe, it, expect, beforeEach } from 'vitest'

// ── Module under test: does not exist yet → all tests fail at import ──────────
import { handleGifts } from './gifts.ts'
import { testDb } from './testDb.ts'
import { createNewTables, seedUser, seedSession, makeRawToken } from './testGoogle.ts'
import {
  createGiftTables,
  giftsEnv,
  seedGiftCampaign,
  seedTemplate,
  seedGift,
  sessionReq,
  anonReq,
} from './testGift.ts'

// ── Setup ─────────────────────────────────────────────────────────────────────

let db: ReturnType<typeof testDb>['db']
let sqlite: ReturnType<typeof testDb>['sqlite']
let campaignId: number
let templateId: number
let ownerId: number
let reporterId: number
let reporterToken: string

beforeEach(async () => {
  ;({ db, sqlite } = testDb())
  createNewTables(sqlite)
  createGiftTables(sqlite)
  campaignId = await seedGiftCampaign(db, { settings: { report_threshold: 3 } })
  templateId = await seedTemplate(db, campaignId)
  ownerId = await seedUser(db, { sub: 'report-owner-001', email: 'report-owner@gmail.com' })
  reporterId = await seedUser(db, { sub: 'report-user-001', email: 'report-user@gmail.com' })
  reporterToken = makeRawToken()
  await seedSession(db, reporterId, reporterToken)
})

// ── POST /api/gifts/<publicId>/report — happy path ───────────────────────────

describe('POST /api/gifts/<publicId>/report — happy path', () => {
  it('valid report → 200 { ok: true }', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await handleGifts(
      sessionReq(reporterId ? reporterToken : '', `/api/gifts/${publicId}/report`, 'POST', {
        reason: 'spam',
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { ok: boolean }).ok).toBe(true)
  })

  it('report is stored in the report table', async () => {
    const { publicId, id: giftId } = await seedGift(db, ownerId, campaignId, templateId)
    await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'inappropriate' }),
      giftsEnv(db),
    )
    const row = sqlite
      .prepare('SELECT reason, acknowledged FROM report WHERE gift_id = ? AND user_id = ?')
      .get(giftId, reporterId) as { reason: string; acknowledged: number } | undefined
    expect(row?.reason).toBe('inappropriate')
    expect(row?.acknowledged).toBe(0)
  })

  it('unauthenticated request → 401', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await handleGifts(
      anonReq(`/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
      giftsEnv(db),
    )
    expect(r.status).toBe(401)
  })
})

// ── Reason enum validation ────────────────────────────────────────────────────

describe('POST /api/gifts/<publicId>/report — reason enum validation', () => {
  it('reason: inappropriate → 200', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'reason1gift1234567'.slice(0, 16),
    })
    const r = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'inappropriate' }),
      giftsEnv(db),
    )
    expect(r.status).toBe(200)
  })

  it('reason: spam → 200', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'reason2gift1234567'.slice(0, 16),
    })
    const r = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
      giftsEnv(db),
    )
    expect(r.status).toBe(200)
  })

  it('reason: other → 200', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'reason3gift1234567'.slice(0, 16),
    })
    const r = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'other' }),
      giftsEnv(db),
    )
    expect(r.status).toBe(200)
  })

  it('unknown reason → 400 bad_request', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'reason4gift1234567'.slice(0, 16),
    })
    const r = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'hate_speech' }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('missing reason field → 400', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'reason5gift1234567'.slice(0, 16),
    })
    const r = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', {}),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })
})

// ── Once per user ─────────────────────────────────────────────────────────────

describe('POST /api/gifts/<publicId>/report — once per user', () => {
  it('same user reporting same gift twice → 409 already_reported', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'dupereport1234567'.slice(0, 16),
    })
    await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
      giftsEnv(db),
    )
    const r = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'other' }),
      giftsEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('already_reported')
  })

  it('different users can each report the same gift once', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'multirepgift12345'.slice(0, 16),
    })
    // Reporter 1 (already seeded)
    const r1 = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
      giftsEnv(db),
    )
    expect(r1.status).toBe(200)
    // Reporter 2
    const r2Id = await seedUser(db, { sub: 'report2-user-001', email: 'report2@gmail.com' })
    const r2Token = makeRawToken()
    await seedSession(db, r2Id, r2Token)
    const r2 = await handleGifts(
      sessionReq(r2Token, `/api/gifts/${publicId}/report`, 'POST', { reason: 'other' }),
      giftsEnv(db),
    )
    expect(r2.status).toBe(200)
  })
})

// ── Auto-hide on 3rd distinct report (threshold from settings) ────────────────

describe('POST /api/gifts/<publicId>/report — auto-hide on threshold (ADR-8, AC-13)', () => {
  it('3rd distinct report sets status to hidden_auto in the same batch', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'autohidegift12345'.slice(0, 16),
    })

    // Three distinct users report
    const users: Array<{ id: number; token: string }> = []
    for (let i = 0; i < 3; i++) {
      const uid = await seedUser(db, {
        sub: `autohide-reporter-${i}`,
        email: `ahreporter${i}@gmail.com`,
      })
      const tok = makeRawToken()
      await seedSession(db, uid, tok)
      users.push({ id: uid, token: tok })
    }

    // First two reports: gift still visible
    for (let i = 0; i < 2; i++) {
      const r = await handleGifts(
        sessionReq(users[i].token, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
        giftsEnv(db),
      )
      expect(r.status).toBe(200)
    }
    const afterTwo = sqlite
      .prepare('SELECT status FROM gift WHERE public_id = ?')
      .get(publicId) as { status: string } | undefined
    expect(afterTwo?.status).toBe('visible')

    // Third report: gift becomes hidden_auto
    const r3 = await handleGifts(
      sessionReq(users[2].token, `/api/gifts/${publicId}/report`, 'POST', { reason: 'inappropriate' }),
      giftsEnv(db),
    )
    expect(r3.status).toBe(200)

    const afterThree = sqlite
      .prepare('SELECT status FROM gift WHERE public_id = ?')
      .get(publicId) as { status: string } | undefined
    expect(afterThree?.status).toBe('hidden_auto')
  })

  it('report_count equals distinct unacknowledged reports after 3 reports', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'rcountgift1234567'.slice(0, 16),
    })
    for (let i = 0; i < 3; i++) {
      const uid = await seedUser(db, {
        sub: `rcount-reporter-${i}`,
        email: `rcreporter${i}@gmail.com`,
      })
      const tok = makeRawToken()
      await seedSession(db, uid, tok)
      await handleGifts(
        sessionReq(tok, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
        giftsEnv(db),
      )
    }
    const gift = sqlite
      .prepare('SELECT report_count FROM gift WHERE public_id = ?')
      .get(publicId) as { report_count: number } | undefined
    const actual = (sqlite
      .prepare(
        'SELECT COUNT(*) AS c FROM report ' +
        'WHERE gift_id = (SELECT id FROM gift WHERE public_id = ?) AND acknowledged = 0',
      )
      .get(publicId) as { c: number }).c
    expect(gift?.report_count).toBe(actual)
    expect(actual).toBe(3)
  })

  it('threshold from campaign settings is respected (custom threshold = 2)', async () => {
    // Campaign with report_threshold = 2
    await seedGiftCampaign(db, { id: 8, slug: 'noel-thresh2', settings: { report_threshold: 2 } })
    const tmpl = await seedTemplate(db, 8)
    const ownerT = await seedUser(db, { sub: 'thresh2-owner-001', email: 'thresh2owner@gmail.com' })
    const { publicId } = await seedGift(db, ownerT, 8, tmpl, { publicId: 'thresh2gift1234567'.slice(0, 16) })

    const u1 = await seedUser(db, { sub: 'thresh2-r1', email: 'thresh2r1@gmail.com' })
    const u2 = await seedUser(db, { sub: 'thresh2-r2', email: 'thresh2r2@gmail.com' })
    const t1 = makeRawToken()
    const t2 = makeRawToken()
    await seedSession(db, u1, t1)
    await seedSession(db, u2, t2)

    // 1st report: still visible
    await handleGifts(
      sessionReq(t1, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
      giftsEnv(db),
    )
    const after1 = sqlite.prepare('SELECT status FROM gift WHERE public_id = ?').get(publicId) as { status: string }
    expect(after1.status).toBe('visible')

    // 2nd report: threshold reached → hidden_auto
    await handleGifts(
      sessionReq(t2, `/api/gifts/${publicId}/report`, 'POST', { reason: 'other' }),
      giftsEnv(db),
    )
    const after2 = sqlite.prepare('SELECT status FROM gift WHERE public_id = ?').get(publicId) as { status: string }
    expect(after2.status).toBe('hidden_auto')
  })
})

// ── Reports from banned users not counted ─────────────────────────────────────

describe('POST /api/gifts/<publicId>/report — reports from banned users not counted (ADR-8)', () => {
  it('banned user report does not increment report_count or trigger auto-hide', async () => {
    // report_threshold = 3; 2 real reports + 1 banned = not auto-hidden
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'bannedrepgift12345'.slice(0, 16),
    })

    // 2 valid reporters
    for (let i = 0; i < 2; i++) {
      const uid = await seedUser(db, {
        sub: `banned-valid-r-${i}`,
        email: `bannedvalid${i}@gmail.com`,
      })
      const tok = makeRawToken()
      await seedSession(db, uid, tok)
      await handleGifts(
        sessionReq(tok, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
        giftsEnv(db),
      )
    }

    // 1 banned reporter
    const bannedId = await seedUser(db, {
      sub: 'banned-reporter-001',
      email: 'banned-rep@gmail.com',
      banned: true,
    })
    const bannedToken = makeRawToken()
    await seedSession(db, bannedId, bannedToken)
    // Banned user gets 403 when trying to report
    const r = await handleGifts(
      sessionReq(bannedToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'other' }),
      giftsEnv(db),
    )
    expect(r.status).toBe(403)
    expect((await r.json() as { error: string }).error).toBe('banned')

    // Gift is still visible (only 2 valid reports < threshold 3)
    const gift = sqlite
      .prepare('SELECT status, report_count FROM gift WHERE public_id = ?')
      .get(publicId) as { status: string; report_count: number } | undefined
    expect(gift?.status).toBe('visible')
    expect(gift?.report_count).toBe(2)
  })

  it('report_count reflects only non-banned reporters: handler-driven ban reduces count (item 2)', async () => {
    // Handler-driven replacement for the tautological SQL-only test.
    // Three reporters; one gets banned via handleGiftModeration.
    // After ban: report_count must equal COUNT(unacknowledged, non-banned reporter reports).
    const { id: giftId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'rcountbangift12345'.slice(0, 16),
      reportCount: 0,
    })
    const now = new Date().toISOString()

    // Three reporters: r1, r2 (normal), r3 (will be banned)
    const r1Id = await seedUser(db, { sub: 'rcb-r1-new', email: 'rcb-r1-new@gmail.com' })
    const r2Id = await seedUser(db, { sub: 'rcb-r2-new', email: 'rcb-r2-new@gmail.com' })
    const r3Id = await seedUser(db, { sub: 'rcb-r3-new', email: 'rcb-r3-new@gmail.com' })

    // Insert 3 reports directly (simulating 3 prior reports)
    sqlite.prepare('INSERT INTO report (gift_id,user_id,reason,acknowledged,created_at) VALUES (?,?,?,0,?)').run(giftId, r1Id, 'spam', now)
    sqlite.prepare('INSERT INTO report (gift_id,user_id,reason,acknowledged,created_at) VALUES (?,?,?,0,?)').run(giftId, r2Id, 'other', now)
    sqlite.prepare('INSERT INTO report (gift_id,user_id,reason,acknowledged,created_at) VALUES (?,?,?,0,?)').run(giftId, r3Id, 'inappropriate', now)
    sqlite.prepare('UPDATE gift SET report_count = 3 WHERE id = ?').run(giftId)

    // Set up an admin
    const { handleGiftModeration } = await import('./giftModeration.ts')
    const { seedAdminEmail, pinAdminSub, TEST_EMAIL, TEST_SUB, makeRawToken: mrt, seedSession: ss } = await import('./testGoogle.ts')
    const { giftModerationEnv, sessionReq: sReq } = await import('./testGift.ts')

    await seedAdminEmail(db, TEST_EMAIL)
    const adminId = await seedUser(db, { sub: TEST_SUB, email: TEST_EMAIL })
    await pinAdminSub(db, TEST_EMAIL, TEST_SUB)
    const adminToken = mrt()
    await ss(db, adminId, adminToken)

    // Ban r3 via handleGiftModeration → their report should no longer count
    await handleGiftModeration(
      sReq(adminToken, `/api/admin/users/${r3Id}`, 'PATCH', { banned: true }),
      giftModerationEnv(db),
    )

    // report_count should now be 2 (r1 and r2 only)
    const gift = sqlite
      .prepare('SELECT report_count FROM gift WHERE id = ?')
      .get(giftId) as { report_count: number } | undefined
    const actual = (sqlite.prepare(
      'SELECT COUNT(*) AS c FROM report r ' +
      'JOIN app_user u ON u.id = r.user_id ' +
      'WHERE r.gift_id = ? AND r.acknowledged = 0 AND u.banned = 0',
    ).get(giftId) as { c: number }).c

    expect(gift?.report_count).toBe(actual)
    expect(actual).toBe(2)  // r1 and r2, not r3 (banned)
  })
})

// ── gift_not_found for hidden/deleted gifts ───────────────────────────────────

describe('POST /api/gifts/<publicId>/report — gift visibility', () => {
  it('hidden gift → 404 gift_not_found', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'hiddengiftrep1234',
      status: 'hidden_auto',
    })
    const r = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
      giftsEnv(db),
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('gift_not_found')
  })
})

// ── REPORT_LIMIT rate-limit ───────────────────────────────────────────────────

describe('POST /api/gifts/<publicId>/report — REPORT_LIMIT', () => {
  it('REPORT_LIMIT exhausted → 429 rate_limited', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'ratelimitrep12345',
    })
    const r = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
      giftsEnv(db, { reportLimitFail: true }),
    )
    expect(r.status).toBe(429)
    expect((await r.json() as { error: string }).error).toBe('rate_limited')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Cycle-2 fix: report batch race condition
// Review finding [worker/gifts.ts report batch]: 0-change conditional insert
// still returns { ok: true }; race branch untested.
// When the conditional INSERT changes 0 rows, the handler must run the report
// diagnosis (gift_not_found 404, campaign_closed 409) instead of returning
// { ok: true }. The recount/auto-hide statements must not change anything in
// that case (guarded by status check).
// ═════════════════════════════════════════════════════════════════════════════

import type { D1 as D1Type } from './testDb.ts'

/**
 * Wraps a D1 binding so a callback fires before the Nth batch call.
 * Use callNumber=2 to fire AFTER the schema DDL batch (call #1 from ensureSchema)
 * but BEFORE the INSERT batch (call #2 from handleReport).
 * testDb() pre-applies all upgrades and seeds, so ensureSchema makes exactly one
 * batch call (the SCHEMA DDL batch); no upgrade/seed batches fire.
 */
function withBatchInterceptorOnCall(db: D1Type, callNumber: number, before: () => void): D1Type {
  let count = 0
  return {
    prepare: (sql) => db.prepare(sql),
    batch: async (stmts) => {
      count++
      if (count === callNumber) before()
      return db.batch(stmts)
    },
  }
}

describe('POST /api/gifts/<publicId>/report — race: 0-change INSERT runs diagnosis (cycle-2)', () => {
  it('race: gift deleted after preliminary read → 404 gift_not_found (not { ok: true })', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'racedeleted123456',
    })

    // Interceptor fires on batch call #2:
    //   Call #1 = ensureSchema schema DDL batch  (before the preliminary read)
    //   Call #2 = handleReport INSERT batch       (preliminary read has already returned 'visible')
    const racyDb = withBatchInterceptorOnCall(db, 2, () => {
      sqlite.prepare("UPDATE gift SET status = 'deleted' WHERE public_id = ?").run(publicId)
    })
    const racyEnv = { ...giftsEnv(db), DB: racyDb }

    const r = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
      racyEnv,
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('gift_not_found')
  })

  it('race: campaign closed after preliminary read → 409 campaign_closed (not { ok: true })', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'raceclosed1234567',
    })

    const racyDb = withBatchInterceptorOnCall(db, 2, () => {
      sqlite.prepare("UPDATE campaign SET status = 'closed' WHERE id = ?").run(campaignId)
    })
    const racyEnv = { ...giftsEnv(db), DB: racyDb }

    const r = await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
      racyEnv,
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_closed')
  })

  it('race: recount/auto-hide do not modify the deleted gift (report_count stays 2, status stays deleted)', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'racenoop12345678',
      reportCount: 0,
    })
    // Pre-seed a report_count of 2 (below threshold 3) so we can verify it isn't touched.
    sqlite.prepare('UPDATE gift SET report_count = 2 WHERE public_id = ?').run(publicId)

    const racyDb = withBatchInterceptorOnCall(db, 2, () => {
      sqlite.prepare("UPDATE gift SET status = 'deleted' WHERE public_id = ?").run(publicId)
    })
    const racyEnv = { ...giftsEnv(db), DB: racyDb }

    await handleGifts(
      sessionReq(reporterToken, `/api/gifts/${publicId}/report`, 'POST', { reason: 'spam' }),
      racyEnv,
    )

    // The deleted gift must retain status = 'deleted' (auto-hide did not trigger)
    // and report_count = 2 (the recount must not update deleted gifts).
    const gift = sqlite
      .prepare('SELECT status, report_count FROM gift WHERE public_id = ?')
      .get(publicId) as { status: string; report_count: number } | undefined
    expect(gift?.status).toBe('deleted')
    // After the fix, the recount is gated so it does not update deleted gifts.
    expect(gift?.report_count).toBe(2)
  })
})
