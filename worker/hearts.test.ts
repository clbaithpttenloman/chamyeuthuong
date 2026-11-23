// @vitest-environment node
/**
 * RED-PHASE tests for POST /api/gifts/<publicId>/heart (via worker/gifts.ts).
 *
 * Module contract (from worker/gifts.ts — same module as gift create):
 *
 *   POST /api/gifts/<publicId>/heart
 *     Auth: session cookie required (401 if missing)
 *     Rate-limit: HEART_LIMIT per user (429 rate_limited if exhausted)
 *
 *   Success response: 200 { heartCount: number, heartsLeft: number, rank: number }
 *     heartCount — total hearts on the gift after this heart
 *     heartsLeft — hearts the user has left today (hearts_per_day − given today)
 *     rank       — the gift's current rank (1 = most hearts, ties broken by created_at ASC, id ASC)
 *
 *   Diagnosis order (ADR-7):
 *     gift_not_found  → 404  (also for hidden or deleted gifts, except to the owner/admin)
 *     campaign_closed → 409  (campaign status!=active or outside dates, or ended)
 *     banned          → 403  (user is banned)
 *     own_gift        → 403  (can't heart your own gift)
 *     already_hearted → 409  (already gave a heart to this gift)
 *     hearts_exhausted → 429 (used all hearts_per_day today)
 *
 *   Day bucket (Vietnam = UTC+7, no DST):
 *     day = new Date(Date.now() + 7*3600_000).toISOString().slice(0, 10)
 *     The day resets when UTC crosses 17:00:00 (Vietnam midnight).
 *     hearts_per_day = settings.hearts_per_day (default 5).
 *
 *   Concurrency invariant (ADR-7):
 *     heart_count in gift table ALWAYS equals COUNT(heart) for that gift_id.
 *     The write path uses INSERT OR IGNORE + recount in one D1 batch, so the counter
 *     never drifts even under concurrent requests.
 *
 *   Rank:
 *     ORDER BY heart_count DESC, created_at ASC, id ASC
 *     among visible gifts of the campaign.
 *
 * All tests fail NOW because worker/gifts.ts does not exist.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

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
let gifterId: number
let gifterToken: string
let ownerId: number
let ownerToken: string

beforeEach(async () => {
  ;({ db, sqlite } = testDb())
  createNewTables(sqlite)
  createGiftTables(sqlite)
  // heart_min_account_age_hours: 0 so these users (created now) can give hearts; the 24 h rule has its own test (heartAge.test.ts).
  campaignId = await seedGiftCampaign(db, { settings: { hearts_per_day: 5, heart_min_account_age_hours: 0 } })
  templateId = await seedTemplate(db, campaignId)
  // Owner creates the gift
  ownerId = await seedUser(db, { sub: 'owner-sub-001', email: 'owner@gmail.com' })
  ownerToken = makeRawToken()
  await seedSession(db, ownerId, ownerToken)
  // Gifter gives hearts
  gifterId = await seedUser(db, { sub: 'gifter-sub-001', email: 'gifter@gmail.com' })
  gifterToken = makeRawToken()
  await seedSession(db, gifterId, gifterToken)
})

afterEach(() => {
  vi.useRealTimers()
})

// ── POST /api/gifts/<publicId>/heart — happy path ────────────────────────────

describe('POST /api/gifts/<publicId>/heart — happy path', () => {
  it('returns 200 { heartCount, heartsLeft, rank }', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    expect(typeof body.heartCount).toBe('number')
    expect(typeof body.heartsLeft).toBe('number')
    expect(typeof body.rank).toBe('number')
  })

  it('heartCount is 1 after first heart on a gift', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { heartCount: number }).heartCount).toBe(1)
  })

  it('heartsLeft is hearts_per_day - 1 after first heart (default 5 → 4 left)', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect((await r.json() as { heartsLeft: number }).heartsLeft).toBe(4)
  })

  it('unauthenticated request → 401', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await handleGifts(
      anonReq(`/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect(r.status).toBe(401)
  })
})

// ── Diagnosis order (ADR-7) ───────────────────────────────────────────────────

describe('POST /api/gifts/<publicId>/heart — diagnosis order (ADR-7)', () => {
  it('nonexistent publicId → 404 gift_not_found', async () => {
    const r = await handleGifts(
      sessionReq(gifterToken, '/api/gifts/doesnotexist1234/heart', 'POST'),
      giftsEnv(db),
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('gift_not_found')
  })

  it('hidden gift → 404 gift_not_found (ADR-7: also for hidden/deleted)', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, { status: 'hidden_auto' })
    const r = await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('gift_not_found')
  })

  it('campaign_closed: closed campaign → 409 campaign_closed', async () => {
    // Seed campaign, then close it; gift is still there
    await seedGiftCampaign(db, { id: 7, slug: 'noel-closed-h', status: 'closed' })
    const tmpl = await seedTemplate(db, 7)
    const { publicId } = await seedGift(db, ownerId, 7, tmpl)
    const r = await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_closed')
  })

  it('banned user → 403 banned (checked after campaign status)', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const bannedId = await seedUser(db, { sub: 'banned-h-001', email: 'banned-h@gmail.com', banned: true })
    const bannedToken = makeRawToken()
    await seedSession(db, bannedId, bannedToken)
    const r = await handleGifts(
      sessionReq(bannedToken, `/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect(r.status).toBe(403)
    expect((await r.json() as { error: string }).error).toBe('banned')
  })

  it('own_gift → 403 own_gift (can not heart your own gift)', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await handleGifts(
      sessionReq(ownerToken, `/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect(r.status).toBe(403)
    expect((await r.json() as { error: string }).error).toBe('own_gift')
  })

  it('already_hearted → 409 already_hearted (1 heart per gift per account)', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    // Give the first heart
    await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db),
    )
    // Try again on the same gift
    const r = await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('already_hearted')
  })

  it('hearts_exhausted → 429 hearts_exhausted after using all daily hearts', async () => {
    // Create 5 gifts from other users and heart them all (uses all 5 daily hearts)
    for (let i = 0; i < 5; i++) {
      const otherId = await seedUser(db, {
        sub: `other-exhaust-${i}`,
        email: `exhaust${i}@gmail.com`,
      })
      const { publicId } = await seedGift(db, otherId, campaignId, templateId, {
        publicId: `exhaust${i}gift123456`.slice(0, 16),
      })
      await handleGifts(
        sessionReq(gifterToken, `/api/gifts/${publicId}/heart`, 'POST'),
        giftsEnv(db),
      )
    }
    // Now heart one more gift from a 6th user
    const extra = await seedUser(db, { sub: 'other-extra-99', email: 'extra99@gmail.com' })
    const { publicId: extraPublicId } = await seedGift(db, extra, campaignId, templateId, {
      publicId: 'extraheartgift1234'.slice(0, 16),
    })
    const r = await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${extraPublicId}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect(r.status).toBe(429)
    expect((await r.json() as { error: string }).error).toBe('hearts_exhausted')
  })
})

// ── HEART_LIMIT rate-limit ────────────────────────────────────────────────────

describe('POST /api/gifts/<publicId>/heart — HEART_LIMIT', () => {
  it('HEART_LIMIT exhausted → 429 rate_limited', async () => {
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db, { heartLimitFail: true }),
    )
    expect(r.status).toBe(429)
    expect((await r.json() as { error: string }).error).toBe('rate_limited')
  })
})

// ── Day bucket reset at Vietnam midnight ──────────────────────────────────────
//
// Vietnam is UTC+7 and has no DST. The day bucket resets at 17:00:00 UTC.
// The handler computes: day = new Date(Date.now() + 7*3600_000).toISOString().slice(0,10)
// vi.useFakeTimers() controls Date.now() so the test can straddle midnight.
//
// 16:59:59 UTC → Vietnam day = same as the day before 17:00
// 17:00:00 UTC → Vietnam day = one day later (new day, hearts reset)

describe('POST /api/gifts/<publicId>/heart — day bucket resets at Vietnam midnight', () => {
  it('hearts given before 17:00 UTC exhaust the daily quota; after 17:00 UTC the quota resets', async () => {
    vi.useFakeTimers()
    // 2026-12-10 16:59:59 UTC → Vietnam day 2026-12-11 (UTC+7 = 23:59:59)
    vi.setSystemTime(new Date('2026-12-10T16:59:59Z'))

    // Create 5 gifts to heart
    const gifts: string[] = []
    for (let i = 0; i < 5; i++) {
      const otherId = await seedUser(db, {
        sub: `midnight-other-${i}`,
        email: `midnight${i}@gmail.com`,
      })
      const { publicId } = await seedGift(db, otherId, campaignId, templateId, {
        publicId: `midnight${i}gift123456`.slice(0, 16),
      })
      gifts.push(publicId)
    }

    // Heart all 5 — exhausts the daily limit on 2026-12-11 (Vietnam)
    for (const pid of gifts) {
      await handleGifts(
        sessionReq(gifterToken, `/api/gifts/${pid}/heart`, 'POST'),
        giftsEnv(db),
      )
    }

    // Now try to heart a 6th gift — should fail (hearts_exhausted)
    const extra = await seedUser(db, { sub: 'midnight-extra-99', email: 'mex99@gmail.com' })
    const { publicId: extraPid } = await seedGift(db, extra, campaignId, templateId, {
      publicId: 'midnightextra12345'.slice(0, 16),
    })
    const failResp = await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${extraPid}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect(failResp.status).toBe(429)

    // Advance to 17:00:00 UTC = Vietnam day 2026-12-12 (new day!)
    vi.setSystemTime(new Date('2026-12-10T17:00:00Z'))

    // Heart a fresh gift — should succeed on the new Vietnam day
    const newDayOther = await seedUser(db, { sub: 'newday-other-01', email: 'newday01@gmail.com' })
    const { publicId: newPid } = await seedGift(db, newDayOther, campaignId, templateId, {
      publicId: 'newdaygift1234567'.slice(0, 16),
    })
    const okResp = await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${newPid}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect(okResp.status).toBe(200)
    expect((await okResp.json() as { heartsLeft: number }).heartsLeft).toBe(4)
  })

  it('the day boundary is 17:00:00 UTC (not 00:00:00 UTC)', async () => {
    vi.useFakeTimers()
    // 2026-12-10 16:59:59 UTC = day 2026-12-11 Vietnam (before midnight)
    vi.setSystemTime(new Date('2026-12-10T16:59:59Z'))
    const other1 = await seedUser(db, { sub: 'boundary-other-1', email: 'bnd1@gmail.com' })
    const { publicId: pid1 } = await seedGift(db, other1, campaignId, templateId, {
      publicId: 'boundary1gift12345'.slice(0, 16),
    })
    const r1 = await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${pid1}/heart`, 'POST'),
      giftsEnv(db),
    )
    expect(r1.status).toBe(200)
    expect((await r1.json() as { heartsLeft: number }).heartsLeft).toBe(4)

    // 2026-12-10 17:00:00 UTC = day 2026-12-12 Vietnam (crossed midnight)
    vi.setSystemTime(new Date('2026-12-10T17:00:00Z'))
    const other2 = await seedUser(db, { sub: 'boundary-other-2', email: 'bnd2@gmail.com' })
    const { publicId: pid2 } = await seedGift(db, other2, campaignId, templateId, {
      publicId: 'boundary2gift12345'.slice(0, 16),
    })
    const r2 = await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${pid2}/heart`, 'POST'),
      giftsEnv(db),
    )
    // hearts_left should be BACK to 4 (started fresh on the new day), not 3
    expect(r2.status).toBe(200)
    expect((await r2.json() as { heartsLeft: number }).heartsLeft).toBe(4)
  })
})

// ── Concurrency: heart_count = COUNT(heart) ───────────────────────────────────
//
// Uses testDb({ shareWith }) to get two D1 bindings on the same SQLite.
// Promise.all queues both batches; testDb's batch lock serializes them.
// After both complete, heart_count must equal COUNT(heart) — the recount design ensures this.

describe('POST /api/gifts/<publicId>/heart — concurrency invariant (ADR-7)', () => {
  it('two concurrent hearts from different users: heart_count = COUNT(heart)', async () => {
    // Two DB bindings share one SQLite connection
    const { db: db1, sqlite: shared } = testDb()
    createNewTables(shared)
    createGiftTables(shared)
    const { db: db2 } = testDb({ shareWith: shared })

    // Set up data on db1
    const campId = await seedGiftCampaign(db1, { settings: { heart_min_account_age_hours: 0 } })
    const tmplId = await seedTemplate(db1, campId)
    const ownId = await seedUser(db1, { sub: 'owner-race-001', email: 'owner-race@gmail.com' })
    const gifter1Id = await seedUser(db1, { sub: 'gifter-race-001', email: 'gifter-race1@gmail.com' })
    const gifter2Id = await seedUser(db1, { sub: 'gifter-race-002', email: 'gifter-race2@gmail.com' })
    const gifter1Token = makeRawToken()
    const gifter2Token = makeRawToken()
    await seedSession(db1, gifter1Id, gifter1Token)
    await seedSession(db1, gifter2Id, gifter2Token)
    const { publicId } = await seedGift(db1, ownId, campId, tmplId, {
      publicId: 'racegift12345678',
    })

    // Both users heart the same gift concurrently
    const env1 = giftsEnv(db1)
    const env2 = giftsEnv(db2)
    await Promise.all([
      handleGifts(sessionReq(gifter1Token, `/api/gifts/${publicId}/heart`, 'POST'), env1),
      handleGifts(sessionReq(gifter2Token, `/api/gifts/${publicId}/heart`, 'POST'), env2),
    ])

    // Verify heart_count equals the actual count
    const gift = shared.prepare('SELECT heart_count FROM gift WHERE public_id = ?').get(publicId) as { heart_count: number }
    const count = (shared.prepare('SELECT COUNT(*) AS c FROM heart WHERE gift_id = (SELECT id FROM gift WHERE public_id = ?)').get(publicId) as { c: number }).c

    expect(gift.heart_count).toBe(count)
    expect(count).toBe(2)
  })

  it('concurrent hearts from the same user: exactly one heart recorded (INSERT OR IGNORE)', async () => {
    const { db: db1, sqlite: shared2 } = testDb()
    createNewTables(shared2)
    createGiftTables(shared2)
    const { db: db2 } = testDb({ shareWith: shared2 })

    const campId = await seedGiftCampaign(db1, { settings: { heart_min_account_age_hours: 0 } })
    const tmplId = await seedTemplate(db1, campId)
    const ownId = await seedUser(db1, { sub: 'owner-dbl-001', email: 'owner-dbl@gmail.com' })
    const gif1Id = await seedUser(db1, { sub: 'gifter-dbl-001', email: 'gifter-dbl@gmail.com' })
    const tok = makeRawToken()
    await seedSession(db1, gif1Id, tok)
    const { publicId } = await seedGift(db1, ownId, campId, tmplId, {
      publicId: 'dblegift12345678',
    })

    // Same user sends two concurrent hearts — only one should stick
    await Promise.all([
      handleGifts(sessionReq(tok, `/api/gifts/${publicId}/heart`, 'POST'), giftsEnv(db1)),
      handleGifts(sessionReq(tok, `/api/gifts/${publicId}/heart`, 'POST'), giftsEnv(db2)),
    ])

    const count = (shared2
      .prepare('SELECT COUNT(*) AS c FROM heart WHERE gift_id = (SELECT id FROM gift WHERE public_id = ?)')
      .get(publicId) as { c: number }).c
    expect(count).toBe(1)

    const heartCount = (shared2
      .prepare('SELECT heart_count FROM gift WHERE public_id = ?')
      .get(publicId) as { heart_count: number }).heart_count
    expect(heartCount).toBe(count)
  })

  it('heart_count = COUNT(heart) after ban via handleGiftModeration (handler-driven, item 2)', async () => {
    // Handler-driven replacement for the tautological SQL-only test.
    // The ban operation goes through handleGiftModeration so the actual batch is exercised.
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'drifttest12345678'.slice(0, 16),
    })

    // gifter1 hearts via handler
    await handleGifts(
      sessionReq(gifterToken, `/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db),
    )

    // gifter2 hearts via handler
    const gifter2 = await seedUser(db, { sub: 'drift-g2-001', email: 'driftg2@gmail.com' })
    const tok2 = makeRawToken()
    await seedSession(db, gifter2, tok2)
    await handleGifts(
      sessionReq(tok2, `/api/gifts/${publicId}/heart`, 'POST'),
      giftsEnv(db),
    )

    // Both hearts are there: heart_count = 2
    const beforeBan = sqlite
      .prepare('SELECT heart_count FROM gift WHERE public_id = ?')
      .get(publicId) as { heart_count: number }
    expect(beforeBan.heart_count).toBe(2)

    // Ban gifter1 via handleGiftModeration (handler-driven — not raw SQL)
    const { handleGiftModeration } = await import('./giftModeration.ts')
    const {
      seedAdminEmail, pinAdminSub,
      TEST_EMAIL: ADMIN_EMAIL, TEST_SUB: ADMIN_SUB,
    } = await import('./testGoogle.ts')
    const { giftModerationEnv, sessionReq: sReq } = await import('./testGift.ts')

    await seedAdminEmail(db, ADMIN_EMAIL)
    const adminId = await seedUser(db, { sub: ADMIN_SUB, email: ADMIN_EMAIL })
    await pinAdminSub(db, ADMIN_EMAIL, ADMIN_SUB)
    const adminToken = makeRawToken()
    await seedSession(db, adminId, adminToken)

    await handleGiftModeration(
      sReq(adminToken, `/api/admin/users/${gifterId}`, 'PATCH', { banned: true }),
      giftModerationEnv(db),
    )

    // After ban: heart_count = COUNT(heart) for the gift
    const afterBan = sqlite
      .prepare('SELECT heart_count FROM gift WHERE public_id = ?')
      .get(publicId) as { heart_count: number }
    const actual = (sqlite
      .prepare('SELECT COUNT(*) AS c FROM heart WHERE gift_id = (SELECT id FROM gift WHERE public_id = ?)')
      .get(publicId) as { c: number }).c

    expect(afterBan.heart_count).toBe(actual)
    expect(actual).toBe(1)  // gifter2's heart remains
  })
})

// ── Rank calculation ──────────────────────────────────────────────────────────

describe('POST /api/gifts/<publicId>/heart — rank in response', () => {
  it('rank of a gift with the most hearts is 1', async () => {
    // Create two gifts; heart the second one twice (by two different users)
    // Note: we don't use lowPid since we only care about highPid's rank
    await seedGift(db, ownerId, campaignId, templateId, {
      publicId: 'lowrankedgift1234',
    })
    const other = await seedUser(db, { sub: 'rank-other-01', email: 'rankother@gmail.com' })
    const { publicId: highPid } = await seedGift(db, other, campaignId, templateId, {
      publicId: 'highrankedgift123',
    })

    // Heart the high-rank gift with 2 different users
    const u1 = await seedUser(db, { sub: 'rank-gifter-01', email: 'rg1@gmail.com' })
    const u2 = await seedUser(db, { sub: 'rank-gifter-02', email: 'rg2@gmail.com' })
    const t1 = makeRawToken()
    const t2 = makeRawToken()
    await seedSession(db, u1, t1)
    await seedSession(db, u2, t2)
    await handleGifts(sessionReq(t1, `/api/gifts/${highPid}/heart`, 'POST'), giftsEnv(db))
    const r = await handleGifts(sessionReq(t2, `/api/gifts/${highPid}/heart`, 'POST'), giftsEnv(db))

    expect(r.status).toBe(200)
    expect((await r.json() as { rank: number }).rank).toBe(1)
  })
})
