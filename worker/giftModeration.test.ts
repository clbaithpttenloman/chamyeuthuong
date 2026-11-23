// @vitest-environment node
/**
 * Tests for worker/giftModeration.ts (Phase 2 admin gift moderation; Google admins only).
 * The 20/11 card moderation lives in worker/moderation.ts and is tested in moderation.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { handleGiftModeration } from './giftModeration.ts'
import { testDb } from './testDb.ts'

// ===================================================================
// Phase 2: Gift moderation (RED-PHASE — worker/giftModeration.ts does not exist yet)
//
// Module contract assumed (implementers follow these):
//
//   New export: handleGiftModeration(request: Request, env: GiftModerationEnv): Promise<Response>
//
//   Auth: requireAdmin without opts.legacy (Google session only).
//         Typed X-Admin-Email + ADMIN_LEGACY_LOGIN='1' → 401 (new endpoints require Google).
//
//   Routes:
//     GET  /api/admin/gifts?status=reported|hidden
//           → 200 [{ id, publicId, campaignId, userId, status, reportCount, ... }]
//           reporter IDENTITY is NEVER included in the response
//           reportCount (aggregate) is included
//
//     PATCH /api/admin/gifts/<id>  { status: 'visible'|'hidden_admin'|'deleted' }
//           → 200 { ok: true }
//           restore (→ visible): marks existing reports acknowledged=1, resets report_count=0
//
//     PATCH /api/admin/users/<id>  { banned: true|false }
//           → 200 { ok: true }
//           ban=true: hides visible gifts, deletes hearts with recounts, revokes sessions
//           ban=false: restores gift status_before_ban, hearts NOT restored
//           admin cannot ban themselves (403)
//
//   GiftModerationEnv: {
//     DB, ADMIN_FAIL_LIMIT: Limiter, ADMIN_LEGACY_LOGIN?: string
//   }
//
// All new tests fail NOW because handleGiftModeration is not exported from moderation.ts.
// ===================================================================

import {
  createNewTables,
  seedUser,
  seedSession,
  seedAdminEmail,
  pinAdminSub,
  makeRawToken,
  TEST_EMAIL as GOOGLE_TEST_EMAIL,
  TEST_SUB as GOOGLE_TEST_SUB,
} from './testGoogle.ts'
import {
  createGiftTables,
  giftModerationEnv,
  seedGiftCampaign,
  seedTemplate,
  seedGift,
  sessionReq as gSessionReq,
  legacyAdminReq,
} from './testGift.ts'

// ── Gift moderation helpers ───────────────────────────────────────────────────

async function seedGiftAdminSession(
  db: ReturnType<typeof testDb>['db'],
): Promise<string> {
  await seedAdminEmail(db, GOOGLE_TEST_EMAIL)
  const adminId = await seedUser(db, { sub: GOOGLE_TEST_SUB, email: GOOGLE_TEST_EMAIL })
  await pinAdminSub(db, GOOGLE_TEST_EMAIL, GOOGLE_TEST_SUB)
  const rawToken = makeRawToken()
  await seedSession(db, adminId, rawToken)
  return rawToken
}

// ── Phase 2 gift-moderation: Google-only gate ─────────────────────────────────

describe('handleGiftModeration — Google-only gate (new admin routes require Google session)', () => {
  let giftDb: ReturnType<typeof testDb>['db']
  let giftSqlite: ReturnType<typeof testDb>['sqlite']
  let giftAdminToken: string

  beforeEach(async () => {
    ;({ db: giftDb, sqlite: giftSqlite } = testDb())
    createNewTables(giftSqlite)
    createGiftTables(giftSqlite)
    giftAdminToken = await seedGiftAdminSession(giftDb)
  })

  it('X-Admin-Email with ADMIN_LEGACY_LOGIN=1 → 401 (typed email not accepted)', async () => {
    const r = await handleGiftModeration(
      legacyAdminReq(GOOGLE_TEST_EMAIL, '/api/admin/gifts?status=reported'),
      giftModerationEnv(giftDb, { legacyLogin: '1' }),
    )
    expect(r.status).toBe(401)
  })

  it('no credentials → 401', async () => {
    const r = await handleGiftModeration(
      new Request('https://x/api/admin/gifts?status=reported', {
        headers: { 'CF-Connecting-IP': '1.2.3.4' },
      }),
      giftModerationEnv(giftDb),
    )
    expect(r.status).toBe(401)
  })

  it('valid Google session admin → 200', async () => {
    const r = await handleGiftModeration(
      gSessionReq(giftAdminToken, '/api/admin/gifts?status=reported', 'GET'),
      giftModerationEnv(giftDb),
    )
    expect(r.status).toBe(200)
  })

  it('non-admin Google session → 403', async () => {
    const noAdminId = await seedUser(giftDb, { sub: 'nonadmin-gift-99', email: 'nonadmingift@gmail.com' })
    const noAdminToken = makeRawToken()
    await seedSession(giftDb, noAdminId, noAdminToken)
    const r = await handleGiftModeration(
      gSessionReq(noAdminToken, '/api/admin/gifts?status=reported', 'GET'),
      giftModerationEnv(giftDb),
    )
    expect(r.status).toBe(403)
  })
})

// ── Phase 2 gift-moderation: GET gifts ───────────────────────────────────────

describe('handleGiftModeration — GET /api/admin/gifts', () => {
  let giftDb2: ReturnType<typeof testDb>['db']
  let giftSqlite2: ReturnType<typeof testDb>['sqlite']
  let adminTok2: string
  let campId: number
  let tmplId: number
  let ownId: number

  beforeEach(async () => {
    ;({ db: giftDb2, sqlite: giftSqlite2 } = testDb())
    createNewTables(giftSqlite2)
    createGiftTables(giftSqlite2)
    adminTok2 = await seedGiftAdminSession(giftDb2)
    campId = await seedGiftCampaign(giftDb2)
    tmplId = await seedTemplate(giftDb2, campId)
    ownId = await seedUser(giftDb2, { sub: 'gift-mod-own-01', email: 'giftmodowner@gmail.com' })
  })

  it('?status=reported returns gifts with report_count ≥ 1', async () => {
    const { publicId } = await seedGift(giftDb2, ownId, campId, tmplId, {
      publicId: 'g2reportedgift123',
      reportCount: 1,
    })
    const r = await handleGiftModeration(
      gSessionReq(adminTok2, '/api/admin/gifts?status=reported', 'GET'),
      giftModerationEnv(giftDb2),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Array<Record<string, unknown>>
    expect(Array.isArray(body)).toBe(true)
    const found = body.find((g) => g['publicId'] === publicId || g['id'] !== undefined)
    expect(found).toBeDefined()
  })

  it('response does NOT include reporter identity', async () => {
    await seedGift(giftDb2, ownId, campId, tmplId, {
      publicId: 'g2noidgift1234567',
      reportCount: 1,
    })
    const r = await handleGiftModeration(
      gSessionReq(adminTok2, '/api/admin/gifts?status=reported', 'GET'),
      giftModerationEnv(giftDb2),
    )
    const body = await r.json() as Array<Record<string, unknown>>
    for (const item of body) {
      expect(item).not.toHaveProperty('reporterUserId')
      expect(item).not.toHaveProperty('reporterEmail')
      expect(item).not.toHaveProperty('reporterSub')
    }
  })

  it('?status=hidden returns hidden gifts', async () => {
    const { publicId: autoHiddenPid } = await seedGift(giftDb2, ownId, campId, tmplId, {
      publicId: 'g2autohidengift123',
      status: 'hidden_auto',
    })
    const r = await handleGiftModeration(
      gSessionReq(adminTok2, '/api/admin/gifts?status=hidden', 'GET'),
      giftModerationEnv(giftDb2),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Array<Record<string, unknown>>
    const pids = body.map((g) => g['publicId'] as string)
    expect(pids).toContain(autoHiddenPid)
  })
})

// ── Phase 2 gift-moderation: PATCH gifts ─────────────────────────────────────

describe('handleGiftModeration — PATCH gifts/<id>', () => {
  let giftDb3: ReturnType<typeof testDb>['db']
  let giftSqlite3: ReturnType<typeof testDb>['sqlite']
  let adminTok3: string
  let campId3: number
  let tmplId3: number
  let ownId3: number

  beforeEach(async () => {
    ;({ db: giftDb3, sqlite: giftSqlite3 } = testDb())
    createNewTables(giftSqlite3)
    createGiftTables(giftSqlite3)
    adminTok3 = await seedGiftAdminSession(giftDb3)
    campId3 = await seedGiftCampaign(giftDb3)
    tmplId3 = await seedTemplate(giftDb3, campId3)
    ownId3 = await seedUser(giftDb3, { sub: 'gift-mod3-own-01', email: 'giftmod3owner@gmail.com' })
  })

  it('restore → gift becomes visible, reports acknowledged, report_count = 0', async () => {
    const { id: giftId } = await seedGift(giftDb3, ownId3, campId3, tmplId3, {
      publicId: 'g3restoregift12345',
      status: 'hidden_auto',
      reportCount: 2,
    })
    const now = new Date().toISOString()
    const r1 = await seedUser(giftDb3, { sub: 'g3-ack-r1', email: 'g3ackr1@gmail.com' })
    const r2 = await seedUser(giftDb3, { sub: 'g3-ack-r2', email: 'g3ackr2@gmail.com' })
    giftSqlite3.prepare('INSERT INTO report (gift_id,user_id,reason,acknowledged,created_at) VALUES (?,?,?,0,?)').run(giftId, r1, 'spam', now)
    giftSqlite3.prepare('INSERT INTO report (gift_id,user_id,reason,acknowledged,created_at) VALUES (?,?,?,0,?)').run(giftId, r2, 'other', now)

    const r = await handleGiftModeration(
      gSessionReq(adminTok3, `/api/admin/gifts/${giftId}`, 'PATCH', { status: 'visible' }),
      giftModerationEnv(giftDb3),
    )
    expect(r.status).toBe(200)
    const row = giftSqlite3.prepare('SELECT status, report_count FROM gift WHERE id = ?').get(giftId) as { status: string; report_count: number }
    expect(row.status).toBe('visible')
    expect(row.report_count).toBe(0)
    const unacked = (giftSqlite3.prepare('SELECT COUNT(*) AS c FROM report WHERE gift_id = ? AND acknowledged = 0').get(giftId) as { c: number }).c
    expect(unacked).toBe(0)
  })

  it('hide → gift becomes hidden_admin', async () => {
    const { id: giftId } = await seedGift(giftDb3, ownId3, campId3, tmplId3, {
      publicId: 'g3hideadmingift123',
    })
    const r = await handleGiftModeration(
      gSessionReq(adminTok3, `/api/admin/gifts/${giftId}`, 'PATCH', { status: 'hidden_admin' }),
      giftModerationEnv(giftDb3),
    )
    expect(r.status).toBe(200)
    const row = giftSqlite3.prepare('SELECT status FROM gift WHERE id = ?').get(giftId) as { status: string }
    expect(row.status).toBe('hidden_admin')
  })

  it('delete → gift becomes deleted', async () => {
    const { id: giftId } = await seedGift(giftDb3, ownId3, campId3, tmplId3, {
      publicId: 'g3deletegift12345',
    })
    const r = await handleGiftModeration(
      gSessionReq(adminTok3, `/api/admin/gifts/${giftId}`, 'PATCH', { status: 'deleted' }),
      giftModerationEnv(giftDb3),
    )
    expect(r.status).toBe(200)
    const row = giftSqlite3.prepare('SELECT status FROM gift WHERE id = ?').get(giftId) as { status: string }
    expect(row.status).toBe('deleted')
  })

  it('invalid status → 400', async () => {
    const { id: giftId } = await seedGift(giftDb3, ownId3, campId3, tmplId3, {
      publicId: 'g3invalstatgift12',
    })
    const r = await handleGiftModeration(
      gSessionReq(adminTok3, `/api/admin/gifts/${giftId}`, 'PATCH', { status: 'pending' }),
      giftModerationEnv(giftDb3),
    )
    expect(r.status).toBe(400)
  })
})

// ── Phase 2 gift-moderation: PATCH users (ban/unban) ─────────────────────────

describe('handleGiftModeration — PATCH users/<id> ban/unban (ADR-8)', () => {
  let giftDb4: ReturnType<typeof testDb>['db']
  let giftSqlite4: ReturnType<typeof testDb>['sqlite']
  let adminTok4: string
  let campId4: number
  let tmplId4: number
  let ownId4: number

  beforeEach(async () => {
    ;({ db: giftDb4, sqlite: giftSqlite4 } = testDb())
    createNewTables(giftSqlite4)
    createGiftTables(giftSqlite4)
    adminTok4 = await seedGiftAdminSession(giftDb4)
    campId4 = await seedGiftCampaign(giftDb4)
    tmplId4 = await seedTemplate(giftDb4, campId4)
    ownId4 = await seedUser(giftDb4, { sub: 'gift-ban-own-01', email: 'giftbanowner@gmail.com' })
  })

  it('ban: sets app_user.banned = 1, hides visible gifts, deletes hearts, recounts, revokes sessions', async () => {
    const { id: giftId } = await seedGift(giftDb4, ownId4, campId4, tmplId4, {
      publicId: 'g4bangift12345678',
      status: 'visible',
    })
    const gifterSub = 'g4-gifter-001'
    const gifterEmail = 'g4gifter@gmail.com'
    const gifterId = await seedUser(giftDb4, { sub: gifterSub, email: gifterEmail })
    const gifterTok = makeRawToken()
    await seedSession(giftDb4, gifterId, gifterTok)
    const now = new Date().toISOString()
    giftSqlite4.prepare('INSERT INTO heart (gift_id,user_id,day,created_at) VALUES (?,?,?,?)').run(giftId, gifterId, '2026-12-10', now)
    giftSqlite4.prepare('UPDATE gift SET heart_count = 1 WHERE id = ?').run(giftId)

    const r = await handleGiftModeration(
      gSessionReq(adminTok4, `/api/admin/users/${gifterId}`, 'PATCH', { banned: true }),
      giftModerationEnv(giftDb4),
    )
    expect(r.status).toBe(200)

    const user = giftSqlite4.prepare('SELECT banned FROM app_user WHERE id = ?').get(gifterId) as { banned: number }
    expect(user.banned).toBe(1)

    const sessions = (giftSqlite4.prepare('SELECT COUNT(*) AS c FROM session WHERE user_id = ?').get(gifterId) as { c: number }).c
    expect(sessions).toBe(0)

    const heartCount = (giftSqlite4.prepare('SELECT COUNT(*) AS c FROM heart WHERE user_id = ?').get(gifterId) as { c: number }).c
    expect(heartCount).toBe(0)

    const gift = giftSqlite4.prepare('SELECT heart_count FROM gift WHERE id = ?').get(giftId) as { heart_count: number }
    const actual = (giftSqlite4.prepare('SELECT COUNT(*) AS c FROM heart WHERE gift_id = ?').get(giftId) as { c: number }).c
    expect(gift.heart_count).toBe(actual)
  })

  it('ban: visible gifts get hidden_admin + status_before_ban = visible', async () => {
    const { id: giftId } = await seedGift(giftDb4, ownId4, campId4, tmplId4, {
      publicId: 'g4banvis12345678x',
      status: 'visible',
    })
    await handleGiftModeration(
      gSessionReq(adminTok4, `/api/admin/users/${ownId4}`, 'PATCH', { banned: true }),
      giftModerationEnv(giftDb4),
    )
    const row = giftSqlite4.prepare('SELECT status, status_before_ban FROM gift WHERE id = ?').get(giftId) as { status: string; status_before_ban: string | null }
    expect(row.status).toBe('hidden_admin')
    expect(row.status_before_ban).toBe('visible')
  })

  it('unban: restores gifts, hearts not restored', async () => {
    const { id: giftId } = await seedGift(giftDb4, ownId4, campId4, tmplId4, {
      publicId: 'g4unbanrestor1234',
      status: 'visible',
    })
    // Ban then unban
    await handleGiftModeration(
      gSessionReq(adminTok4, `/api/admin/users/${ownId4}`, 'PATCH', { banned: true }),
      giftModerationEnv(giftDb4),
    )
    await handleGiftModeration(
      gSessionReq(adminTok4, `/api/admin/users/${ownId4}`, 'PATCH', { banned: false }),
      giftModerationEnv(giftDb4),
    )
    const user = giftSqlite4.prepare('SELECT banned FROM app_user WHERE id = ?').get(ownId4) as { banned: number }
    expect(user.banned).toBe(0)
    const row = giftSqlite4.prepare('SELECT status, status_before_ban FROM gift WHERE id = ?').get(giftId) as { status: string; status_before_ban: string | null }
    expect(row.status).toBe('visible')
    expect(row.status_before_ban).toBeNull()
  })

  // Phase 1 "admin cannot ban themselves" test removed: it used google_sub lookup.
  // Replacement: "ban of admin_role user → 409 is_admin" is in the Phase 2b describe block below.
})

// Orchestrator addition: moderators need the card fields and the reasons, not just a count.
describe('GET /api/admin/gifts — card fields and report reasons', () => {
  it('each item carries layout, font, ink, backgroundTemplateId and unacknowledged reasons by type', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const token = await seedGiftAdminSession(db)
    const campaignId = await seedGiftCampaign(db)
    const templateId = await seedTemplate(db, campaignId)
    const owner = await seedUser(db, { sub: 'owner-sub-1', email: 'owner@gmail.com' })
    const { id: giftId } = await seedGift(db, owner, campaignId, templateId, { publicId: 'reasons000000001', reportCount: 3 })
    const now = new Date().toISOString()
    const reporters = [] as number[]
    for (let i = 0; i < 4; i++) reporters.push(await seedUser(db, { sub: `rep-sub-${i}`, email: `rep${i}@gmail.com` }))
    const ins = (u: number, reason: string, ack: number) =>
      sqlite.prepare('INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?, ?, ?, ?, ?)').run(giftId, u, reason, ack, now)
    ins(reporters[0]!, 'inappropriate', 0)
    ins(reporters[1]!, 'inappropriate', 0)
    ins(reporters[2]!, 'spam', 0)
    ins(reporters[3]!, 'other', 1) // acknowledged by an earlier restore: not counted

    const r = await handleGiftModeration(gSessionReq(token, '/api/admin/gifts?status=reported', 'GET'), giftModerationEnv(db))
    expect(r.status).toBe(200)
    const items = (await r.json()) as Array<Record<string, unknown>>
    const item = items.find((g) => g.publicId === 'reasons000000001')!
    expect(item).toMatchObject({ layout: 'doc-giua', font: 'patrick-hand', ink: '#1d3fa6', backgroundTemplateId: templateId })
    expect(item.reportReasons).toEqual({ inappropriate: 2, spam: 1, other: 0 })
    expect(JSON.stringify(items)).not.toMatch(/rep\d@gmail|rep-sub-/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Fix Group 8a — new tests for items 1, 3, 4, 10
// ═════════════════════════════════════════════════════════════════════════════

import { TEST_SUB_HMAC_KEY } from './testGift.ts'

// ── Item 1: unban removes banned_identity tombstone ───────────────────────────

describe('handleGiftModeration — unban removes banned_identity tombstone (item 1)', () => {
  let tombstoneDb: ReturnType<typeof testDb>['db']
  let tombstoneSqlite: ReturnType<typeof testDb>['sqlite']
  let adminToken: string
  let targetUserId: number
  const TARGET_SUB = 'target-tombstone-sub'
  const TARGET_EMAIL = 'target-tombstone@gmail.com'


  beforeEach(async () => {
    ;({ db: tombstoneDb, sqlite: tombstoneSqlite } = testDb())
    createNewTables(tombstoneSqlite)
    createGiftTables(tombstoneSqlite)
    adminToken = await seedGiftAdminSession(tombstoneDb)
    targetUserId = await seedUser(tombstoneDb, { sub: TARGET_SUB, email: TARGET_EMAIL })
    const targetToken = makeRawToken()
    await seedSession(tombstoneDb, targetUserId, targetToken)
  })

  // Phase 1 "unban removes tombstone" test removed: it used app_user.google_sub in assertions.
  // Phase 2b replacement tests are in the "Phase 2b tombstone" describe block below.

  it('unban fails closed without SUB_HMAC_KEY (tombstone cannot be cleared)', async () => {
    // Ban user
    await handleGiftModeration(
      gSessionReq(adminToken, `/api/admin/users/${targetUserId}`, 'PATCH', { banned: true }),
      giftModerationEnv(tombstoneDb, { subHmacKey: TEST_SUB_HMAC_KEY }),
    )

    // Attempt unban without SUB_HMAC_KEY
    const unbannedResp = await handleGiftModeration(
      gSessionReq(adminToken, `/api/admin/users/${targetUserId}`, 'PATCH', { banned: false }),
      giftModerationEnv(tombstoneDb, { subHmacKey: undefined }),
    )
    // Cycle-2 suggestion: must be exactly 500 (misconfigured), not just non-200
    expect(unbannedResp.status).toBe(503)
    // Cycle-2 suggestion: app_user.banned must still be 1 (unban did not proceed)
    const bannedCheck = tombstoneSqlite
      .prepare('SELECT banned FROM app_user WHERE id = ?')
      .get(targetUserId) as { banned: number } | undefined
    expect(bannedCheck?.banned).toBe(1)
  })
})

// ── Item 1: tombstone list routes ─────────────────────────────────────────────

describe('handleGiftModeration — GET /api/admin/tombstones + DELETE /api/admin/tombstones/<id> (item 1)', () => {
  let tsDb: ReturnType<typeof testDb>['db']
  let tsSqlite: ReturnType<typeof testDb>['sqlite']
  let tsAdminToken: string

  beforeEach(async () => {
    ;({ db: tsDb, sqlite: tsSqlite } = testDb())
    createNewTables(tsSqlite)
    createGiftTables(tsSqlite)
    tsAdminToken = await seedGiftAdminSession(tsDb)
  })

  it('GET /api/admin/tombstones → 200 array (id, created_at only — no sub_hmac)', async () => {
    // Insert a tombstone directly
    const now = new Date().toISOString()
    tsSqlite.prepare('INSERT INTO banned_identity (sub_hmac, created_at) VALUES (?, ?)').run('testhash123', now)

    const r = await handleGiftModeration(
      gSessionReq(tsAdminToken, '/api/admin/tombstones', 'GET'),
      giftModerationEnv(tsDb),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Array<Record<string, unknown>>
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    // Response must have id and created_at but NOT sub_hmac (privacy)
    const item = body[0]!
    expect(typeof item.id).toBe('number')
    expect(typeof item.createdAt).toBe('string')
    expect('subHmac' in item || 'sub_hmac' in item).toBe(false)
  })

  it('DELETE /api/admin/tombstones/<id> → 200 removes the tombstone', async () => {
    const now = new Date().toISOString()
    tsSqlite.prepare('INSERT INTO banned_identity (sub_hmac, created_at) VALUES (?, ?)').run('testhash456', now)
    const { id: tsId } = tsSqlite.prepare('SELECT rowid AS id FROM banned_identity WHERE sub_hmac = ?').get('testhash456') as { id: number }

    const r = await handleGiftModeration(
      gSessionReq(tsAdminToken, `/api/admin/tombstones/${tsId}`, 'DELETE'),
      giftModerationEnv(tsDb),
    )
    expect(r.status).toBe(200)

    const gone = tsSqlite.prepare('SELECT rowid FROM banned_identity WHERE rowid = ?').get(tsId)
    expect(gone).toBeUndefined()
  })

  it('GET /api/admin/tombstones requires Google session (typed email → 401)', async () => {
    const r = await handleGiftModeration(
      legacyAdminReq(GOOGLE_TEST_EMAIL, '/api/admin/tombstones', 'GET'),
      giftModerationEnv(tsDb, { legacyLogin: '1' }),
    )
    expect(r.status).toBe(401)
  })
})

// ── Item 3: PATCH gift — refuse deleted, 404 unknown id, clear status_before_ban ─────

describe('handleGiftModeration — PATCH gifts/<id>: status checks (item 3)', () => {
  let mod3Db: ReturnType<typeof testDb>['db']
  let mod3Sqlite: ReturnType<typeof testDb>['sqlite']
  let mod3Token: string
  let mod3OwnerId: number
  let mod3CampId: number
  let mod3TmplId: number

  beforeEach(async () => {
    ;({ db: mod3Db, sqlite: mod3Sqlite } = testDb())
    createNewTables(mod3Sqlite)
    createGiftTables(mod3Sqlite)
    mod3Token = await seedGiftAdminSession(mod3Db)
    mod3CampId = await seedGiftCampaign(mod3Db, { id: 20, slug: 'noel-patch-checks' })
    mod3TmplId = await seedTemplate(mod3Db, mod3CampId)
    mod3OwnerId = await seedUser(mod3Db, { sub: 'patch-chk-owner', email: 'patchchkowner@gmail.com' })
  })

  it('PATCH deleted gift → 404 not_found (ADR-8: cannot resurrect deleted gifts)', async () => {
    const { id: giftId } = await seedGift(mod3Db, mod3OwnerId, mod3CampId, mod3TmplId, {
      publicId: 'patchdelgift12345',
      status: 'deleted',
    })
    const r = await handleGiftModeration(
      gSessionReq(mod3Token, `/api/admin/gifts/${giftId}`, 'PATCH', { status: 'visible' }),
      giftModerationEnv(mod3Db),
    )
    expect(r.status).toBe(404)
  })

  it('PATCH unknown gift id → 404 not_found', async () => {
    const r = await handleGiftModeration(
      gSessionReq(mod3Token, '/api/admin/gifts/9999999', 'PATCH', { status: 'visible' }),
      giftModerationEnv(mod3Db),
    )
    expect(r.status).toBe(404)
  })

  it('PATCH restore clears status_before_ban on the gift', async () => {
    // A gift with status_before_ban set (from a previous ban)
    const { id: giftId } = await seedGift(mod3Db, mod3OwnerId, mod3CampId, mod3TmplId, {
      publicId: 'patchrestclr12345',
      status: 'hidden_admin',
      statusBeforeBan: 'visible',
    })
    await handleGiftModeration(
      gSessionReq(mod3Token, `/api/admin/gifts/${giftId}`, 'PATCH', { status: 'visible' }),
      giftModerationEnv(mod3Db),
    )
    const row = mod3Sqlite.prepare('SELECT status_before_ban FROM gift WHERE id = ?').get(giftId) as { status_before_ban: string | null }
    expect(row.status_before_ban).toBeNull()
  })

  it('PATCH hide clears status_before_ban to prevent stale restore', async () => {
    // A gift with status_before_ban set, then admin hides it
    const { id: giftId } = await seedGift(mod3Db, mod3OwnerId, mod3CampId, mod3TmplId, {
      publicId: 'patchhideclr12345',
      status: 'visible',
      statusBeforeBan: 'visible',
    })
    await handleGiftModeration(
      gSessionReq(mod3Token, `/api/admin/gifts/${giftId}`, 'PATCH', { status: 'hidden_admin' }),
      giftModerationEnv(mod3Db),
    )
    const row = mod3Sqlite.prepare('SELECT status_before_ban FROM gift WHERE id = ?').get(giftId) as { status_before_ban: string | null }
    expect(row.status_before_ban).toBeNull()
  })
})

// ── Item 4: ban/unban recompute report_count without pre-read ─────────────────

describe('handleGiftModeration — ban/unban recompute report_count in-batch (item 4)', () => {
  let rc4Db: ReturnType<typeof testDb>['db']
  let rc4Sqlite: ReturnType<typeof testDb>['sqlite']
  let rc4AdminToken: string
  let rc4GiftId: number
  let rc4CampId: number
  let rc4TmplId: number
  let rc4OwnerId: number
  let rc4ReporterId: number

  beforeEach(async () => {
    ;({ db: rc4Db, sqlite: rc4Sqlite } = testDb())
    createNewTables(rc4Sqlite)
    createGiftTables(rc4Sqlite)
    rc4AdminToken = await seedGiftAdminSession(rc4Db)
    rc4CampId = await seedGiftCampaign(rc4Db, { id: 25, slug: 'noel-rcount-test', settings: { report_threshold: 5, heart_min_account_age_hours: 0 } })
    rc4TmplId = await seedTemplate(rc4Db, rc4CampId)
    rc4OwnerId = await seedUser(rc4Db, { sub: 'rc4-owner-001', email: 'rc4owner@gmail.com' })
    const { id: gid } = await seedGift(rc4Db, rc4OwnerId, rc4CampId, rc4TmplId, {
      publicId: 'rcountgifttest123',
      reportCount: 0,
    })
    rc4GiftId = gid
    rc4ReporterId = await seedUser(rc4Db, { sub: 'rc4-reporter-001', email: 'rc4reporter@gmail.com', createdAt: new Date(Date.now() - 25 * 3600_000).toISOString() })
  })

  it('ban reduces report_count: reporter gets banned → their report no longer counts', async () => {
    // Insert a report from rc4ReporterId
    const now = new Date().toISOString()
    rc4Sqlite.prepare('INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(rc4GiftId, rc4ReporterId, 'spam', now)
    // Recount manually to set it to 1
    rc4Sqlite.prepare('UPDATE gift SET report_count = 1 WHERE id = ?').run(rc4GiftId)

    // Ban the reporter → report should not count anymore → report_count = 0
    await handleGiftModeration(
      gSessionReq(rc4AdminToken, `/api/admin/users/${rc4ReporterId}`, 'PATCH', { banned: true }),
      giftModerationEnv(rc4Db),
    )

    const gift = rc4Sqlite.prepare('SELECT report_count FROM gift WHERE id = ?').get(rc4GiftId) as { report_count: number }
    const actual = (rc4Sqlite.prepare(
      'SELECT COUNT(*) AS c FROM report r JOIN app_user u ON u.id = r.user_id WHERE r.gift_id = ? AND r.acknowledged = 0 AND u.banned = 0',
    ).get(rc4GiftId) as { c: number }).c

    expect(gift.report_count).toBe(actual)
    expect(actual).toBe(0)
  })

  it('unban increases report_count: reporter unbanned → their report counts again', async () => {
    // Reporter is pre-banned; they have a report on the gift
    rc4Sqlite.prepare('UPDATE app_user SET banned = 1 WHERE id = ?').run(rc4ReporterId)
    const now = new Date().toISOString()
    rc4Sqlite.prepare('INSERT INTO report (gift_id, user_id, reason, acknowledged, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(rc4GiftId, rc4ReporterId, 'other', now)
    rc4Sqlite.prepare('UPDATE gift SET report_count = 0 WHERE id = ?').run(rc4GiftId)

    // Unban the reporter → their report now counts → report_count = 1
    await handleGiftModeration(
      gSessionReq(rc4AdminToken, `/api/admin/users/${rc4ReporterId}`, 'PATCH', { banned: false }),
      giftModerationEnv(rc4Db),
    )

    const gift = rc4Sqlite.prepare('SELECT report_count FROM gift WHERE id = ?').get(rc4GiftId) as { report_count: number }
    const actual = (rc4Sqlite.prepare(
      'SELECT COUNT(*) AS c FROM report r JOIN app_user u ON u.id = r.user_id WHERE r.gift_id = ? AND r.acknowledged = 0 AND u.banned = 0',
    ).get(rc4GiftId) as { c: number }).c

    expect(gift.report_count).toBe(actual)
    expect(actual).toBe(1)
  })

  it('ban heart recount uses in-batch subquery (no pre-read drift under concurrency)', async () => {
    // User X hearts a gift via handler; then we ban user X
    // After ban, heart_count must equal COUNT(heart)
    const gifterSub = 'rc4-gifter-inbatch'
    const gifterId = await seedUser(rc4Db, { sub: gifterSub, email: 'rc4gifterinbatch@gmail.com' })
    const gifterToken = makeRawToken()
    await seedSession(rc4Db, gifterId, gifterToken)

    const ownerToken = makeRawToken()
    await seedSession(rc4Db, rc4OwnerId, ownerToken)

    // Import handleGifts to give the heart via handler
    const { handleGifts } = await import('./gifts.ts')
    const { giftsEnv } = await import('./testGift.ts')
    await handleGifts(
      gSessionReq(gifterToken, `/api/gifts/rcountgifttest123/heart`, 'POST'),
      giftsEnv(rc4Db),
    )

    // Verify heart is there
    const beforeBan = rc4Sqlite.prepare('SELECT heart_count FROM gift WHERE id = ?').get(rc4GiftId) as { heart_count: number }
    expect(beforeBan.heart_count).toBe(1)

    // Ban the gifter → heart removed, recount
    await handleGiftModeration(
      gSessionReq(rc4AdminToken, `/api/admin/users/${gifterId}`, 'PATCH', { banned: true }),
      giftModerationEnv(rc4Db),
    )

    const afterBan = rc4Sqlite.prepare('SELECT heart_count FROM gift WHERE id = ?').get(rc4GiftId) as { heart_count: number }
    const actual = (rc4Sqlite.prepare('SELECT COUNT(*) AS c FROM heart WHERE gift_id = ?').get(rc4GiftId) as { c: number }).c

    expect(afterBan.heart_count).toBe(actual)
    expect(actual).toBe(0)
  })
})

// ── Item 10: GET /api/admin/gifts gains userBanned ────────────────────────────

describe('GET /api/admin/gifts — userBanned field (item 10)', () => {
  let mod10Db: ReturnType<typeof testDb>['db']
  let mod10Sqlite: ReturnType<typeof testDb>['sqlite']
  let mod10AdminToken: string
  let mod10CampId: number
  let mod10TmplId: number

  beforeEach(async () => {
    ;({ db: mod10Db, sqlite: mod10Sqlite } = testDb())
    createNewTables(mod10Sqlite)
    createGiftTables(mod10Sqlite)
    mod10AdminToken = await seedGiftAdminSession(mod10Db)
    mod10CampId = await seedGiftCampaign(mod10Db, { id: 30, slug: 'noel-userbanned' })
    mod10TmplId = await seedTemplate(mod10Db, mod10CampId)
  })

  it('response items have userBanned field (false for non-banned owner)', async () => {
    const ownerId = await seedUser(mod10Db, { sub: 'ub10-owner-not-ban', email: 'ub10notban@gmail.com' })
    await seedGift(mod10Db, ownerId, mod10CampId, mod10TmplId, {
      publicId: 'ub10notbangift123',
      reportCount: 1,
    })

    const r = await handleGiftModeration(
      gSessionReq(mod10AdminToken, '/api/admin/gifts?status=reported', 'GET'),
      giftModerationEnv(mod10Db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Array<Record<string, unknown>>
    const item = body.find((g) => g.publicId === 'ub10notbangift123')!
    expect(item).toBeDefined()
    expect('userBanned' in item).toBe(true)
    expect(item.userBanned).toBe(false)
  })

  it('response items have userBanned = true when the gift owner is banned', async () => {
    const bannedOwnerId = await seedUser(mod10Db, { sub: 'ub10-owner-banned', email: 'ub10banned@gmail.com', banned: true })
    await seedGift(mod10Db, bannedOwnerId, mod10CampId, mod10TmplId, {
      publicId: 'ub10bangift123456',
      status: 'hidden_admin',
    })

    const r = await handleGiftModeration(
      gSessionReq(mod10AdminToken, '/api/admin/gifts?status=hidden', 'GET'),
      giftModerationEnv(mod10Db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Array<Record<string, unknown>>
    const item = body.find((g) => g.publicId === 'ub10bangift123456')!
    expect(item).toBeDefined()
    expect(item.userBanned).toBe(true)
  })

  it('response LIMIT 200: only 200 gifts returned when more exist', async () => {
    // The result should not contain more than 200 items even if the DB has more
    const ownerId = await seedUser(mod10Db, { sub: 'ub10-owner-limit', email: 'ub10limit@gmail.com' })
    // Seed 201 gifts with report_count >= 1
    for (let i = 0; i < 201; i++) {
      const pid = `ub10lim${String(i).padStart(9, '0')}`
      await seedGift(mod10Db, ownerId, mod10CampId, mod10TmplId, {
        publicId: pid,
        reportCount: 1,
      })
    }
    const r = await handleGiftModeration(
      gSessionReq(mod10AdminToken, '/api/admin/gifts?status=reported', 'GET'),
      giftModerationEnv(mod10Db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Array<Record<string, unknown>>
    expect(body.length).toBeLessThanOrEqual(200)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2b additions — ban of an admin + tombstone
//
// testAccounts.ts cannot be imported here because it depends on worker/password.ts
// (not yet implemented). All Phase 2b schema setup and user seeding is done inline.
// Tests that require worker/accounts.ts use dynamic imports so only the specific
// test fails at runtime (not the whole file at import time).
// ═════════════════════════════════════════════════════════════════════════════

import { hmacSha256Hex } from './session.ts'

// Cookie name constant (same as SESSION_COOKIE from session.ts)
const SESSION_COOKIE_P2B = '__Host-cyt_s'

// ── Inline Phase 2b schema/seed helpers ───────────────────────────────────────

/**
 * Upgrade a fresh testDb() Phase-1 app_user (has google_sub) to Phase-2b shape (no
 * google_sub), and create user_identity, admin_role, admin_audit, password_credential
 * tables.  Safe to call when Phase 2b SCHEMA is live (IF NOT EXISTS / no google_sub).
 */
function createP2bSchema(sqlite: ReturnType<typeof testDb>['sqlite']): void {
  const cols = (
    sqlite.prepare('PRAGMA table_info(app_user)').all() as Array<{ name: string }>
  ).map((c) => c.name)
  if (cols.includes('google_sub')) {
    sqlite.exec('DROP TABLE IF EXISTS session')
    sqlite.exec('DROP TABLE IF EXISTS app_user')
    sqlite.exec(`CREATE TABLE app_user (
      id           INTEGER PRIMARY KEY,
      nickname     TEXT    NOT NULL DEFAULT '',
      class_name   TEXT    NOT NULL DEFAULT '',
      banned       INTEGER NOT NULL DEFAULT 0 CHECK (banned IN (0,1)),
      created_at   TEXT    NOT NULL,
      last_seen_at TEXT    NOT NULL
    )`)
    sqlite.exec(`CREATE TABLE session (
      token_hash TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      expires_at TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      ip_hash    TEXT    NOT NULL DEFAULT ''
    )`)
  }
  sqlite.exec(`CREATE TABLE IF NOT EXISTS user_identity (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    provider     TEXT    NOT NULL CHECK (provider IN ('password','google')),
    subject      TEXT    NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
    ip_hash      TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL,
    last_used_at TEXT    NOT NULL,
    UNIQUE (provider, subject)
  )`)
  sqlite.exec(`CREATE TABLE IF NOT EXISTS admin_role (
    user_id    INTEGER PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    granted_at TEXT    NOT NULL,
    granted_by TEXT    NOT NULL
  )`)
  sqlite.exec(`CREATE TABLE IF NOT EXISTS admin_audit (
    id             INTEGER PRIMARY KEY,
    actor_user_id  INTEGER,
    action         TEXT    NOT NULL,
    target_user_id INTEGER,
    at             TEXT    NOT NULL
  )`)
  sqlite.exec(`CREATE TABLE IF NOT EXISTS password_credential (
    user_id         INTEGER PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    hash            TEXT    NOT NULL,
    salt            TEXT    NOT NULL,
    iterations      INTEGER NOT NULL,
    must_change     INTEGER NOT NULL DEFAULT 0 CHECK (must_change IN (0,1)),
    temp_expires_at TEXT,
    failed_count    INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    updated_at      TEXT    NOT NULL
  )`)
}

let _p2bUserSeq = 0

/** Seed a Phase-2b user (app_user + user_identity('password', username) + optional admin_role). */
async function seedP2bUser(
  db: ReturnType<typeof testDb>['db'],
  opts: { username?: string; admin?: boolean; banned?: boolean } = {},
): Promise<{ userId: number; username: string }> {
  const username = (opts.username ?? `p2b${Date.now()}${++_p2bUserSeq}`).toLowerCase()
  const now = new Date().toISOString()
  await db
    .prepare(
      'INSERT INTO app_user (nickname, class_name, banned, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind('Test', '11A', opts.banned ? 1 : 0, now, now)
    .run()
  const { id: userId } = (await db
    .prepare('SELECT MAX(id) AS id FROM app_user')
    .first<{ id: number }>())!
  await db
    .prepare(
      'INSERT INTO user_identity (user_id, provider, subject, ip_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(userId, 'password', username, '', now, now)
    .run()
  if (opts.admin) {
    await db
      .prepare('INSERT INTO admin_role (user_id, granted_at, granted_by) VALUES (?, ?, ?)')
      .bind(userId, now, 'test-seed')
      .run()
  }
  return { userId, username }
}

/** Create a session for a Phase-2b user; returns the raw token. */
async function createP2bSession(
  db: ReturnType<typeof testDb>['db'],
  userId: number,
): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const raw = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  const hash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  const now = new Date().toISOString()
  await db
    .prepare(
      'INSERT INTO session (token_hash, user_id, expires_at, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(hash, userId, '9999-12-31T23:59:59.000Z', now, '')
    .run()
  return raw
}

/** Minimal env for Phase-2b handleAccounts (no testAccounts dependency). */
function makeP2bAccountsEnv(db: ReturnType<typeof testDb>['db']): Record<string, unknown> {
  const allow = { limit: async () => ({ success: true }) }
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    PUBLIC_IP_LIMIT: allow, SUBMIT_IP_LIMIT: allow, CARD_IP_LIMIT: allow,
    ADMIN_FAIL_LIMIT: allow, IMAGE_IP_LIMIT: allow, AUTH_LIMIT: allow,
    AUTH_SUB_LIMIT: allow, USER_READ_LIMIT: allow, USER_WRITE_LIMIT: allow,
    PUBLIC_READ_LIMIT: allow, REGISTER_LIMIT: allow, GIFT_LIMIT: allow,
    HEART_LIMIT: allow, REPORT_LIMIT: allow, TREE_READ_LIMIT: allow,
    LIST_READ_LIMIT: allow,
    PASSWORD_PEPPER: 'test-password-pepper-32bytesx!',
    SUB_HMAC_KEY: TEST_SUB_HMAC_KEY,
    IP_HMAC_KEY: 'test-ip-hmac-key-32bytes-paddedx',
    NONCE_KEY: 'test-nonce-key-32bytes-paddingXX',
    REGISTER_IP_DAILY: '300',
    REGISTER_GLOBAL_DAILY: '2000',
    GOOGLE_CLIENT_ID: undefined,
  }
}

// ── Phase 2b — ban of an admin ────────────────────────────────────────────────

describe('handleGiftModeration — Phase 2b ban of an admin → 409 is_admin', () => {
  let baDb: ReturnType<typeof testDb>['db']
  let baSqlite: ReturnType<typeof testDb>['sqlite']
  let baAdminToken: string
  let baTargetId: number

  beforeEach(async () => {
    ;({ db: baDb, sqlite: baSqlite } = testDb())
    createP2bSchema(baSqlite)
    createGiftTables(baSqlite)
    const admin = await seedP2bUser(baDb, { admin: true })
    baAdminToken = await createP2bSession(baDb, admin.userId)
    const target = await seedP2bUser(baDb, { admin: true })
    baTargetId = target.userId
  })

  it('PATCH {banned:true} on a user with admin_role → 409 { error: "is_admin" }', async () => {
    const r = await handleGiftModeration(
      gSessionReq(baAdminToken, `/api/admin/users/${baTargetId}`, 'PATCH', { banned: true }),
      giftModerationEnv(baDb),
    )
    expect(r.status).toBe(409)
    const body = (await r.json()) as Record<string, unknown>
    expect(body.error).toBe('is_admin')
  })

  it('nothing changed: target user remains unbanned after rejected ban attempt', async () => {
    await handleGiftModeration(
      gSessionReq(baAdminToken, `/api/admin/users/${baTargetId}`, 'PATCH', { banned: true }),
      giftModerationEnv(baDb),
    )
    const user = baSqlite
      .prepare('SELECT banned FROM app_user WHERE id = ?')
      .get(baTargetId) as { banned: number }
    expect(user.banned).toBe(0)
  })
})

// ── Phase 2b tombstone ────────────────────────────────────────────────────────

describe('handleGiftModeration — Phase 2b tombstone', () => {
  let ptDb: ReturnType<typeof testDb>['db']
  let ptSqlite: ReturnType<typeof testDb>['sqlite']
  let ptAdminToken: string
  let ptAdminUserId: number

  beforeEach(async () => {
    ;({ db: ptDb, sqlite: ptSqlite } = testDb())
    createP2bSchema(ptSqlite)
    createGiftTables(ptSqlite)
    const admin = await seedP2bUser(ptDb, { admin: true })
    ptAdminUserId = admin.userId
    ptAdminToken = await createP2bSession(ptDb, ptAdminUserId)
  })

  // ── Tombstone creation on DELETE /api/me ─────────────────────────────────

  it('DELETE /api/me (banned user, password identity) writes one banned_identity row with correct sub_hmac', async () => {
    // Dynamic imports fail when these modules are not yet implemented (Phase 2b red phase).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { hashPassword } = (await import('./password.ts')) as any

    const username = `p2btomb${Date.now()}`.slice(0, 20)
    const password = 'TombPass123!'
    const pepper = 'test-password-pepper-32bytesx!'
    const now = new Date().toISOString()

    await ptDb.prepare(
      'INSERT INTO app_user (nickname, class_name, banned, created_at, last_seen_at) VALUES (?, ?, 1, ?, ?)',
    ).bind('Test', '11A', now, now).run()
    const { id: userId } = (await ptDb.prepare('SELECT MAX(id) AS id FROM app_user').first<{ id: number }>())!
    await ptDb.prepare(
      'INSERT INTO user_identity (user_id, provider, subject, ip_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(userId, 'password', username, '', now, now).run()
    const cred = await hashPassword(password, pepper, { iterations: 10_000 })
    await ptDb.prepare(
      'INSERT INTO password_credential (user_id, hash, salt, iterations, must_change, failed_count, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?)',
    ).bind(userId, cred.hash, cred.salt, cred.iterations, now).run()
    const userToken = await createP2bSession(ptDb, userId)

    const { default: appWorker } = (await import('./index.ts')) as { default: { fetch: (r: Request, e: unknown) => Promise<Response> } }
    const r = await appWorker.fetch(
      new Request('https://x/api/me', {
        method: 'DELETE',
        headers: {
          'CF-Connecting-IP': '1.2.3.4',
          'X-Requested-With': 'fetch',
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE_P2B}=${userToken}`,
        },
        body: JSON.stringify({ password }),
      }),
      makeP2bAccountsEnv(ptDb),
    )
    expect([200, 204]).toContain(r.status)

    const expectedHmac = await hmacSha256Hex(TEST_SUB_HMAC_KEY, `password:${username}`)
    expect(
      ptSqlite
        .prepare('SELECT sub_hmac FROM banned_identity WHERE sub_hmac = ?')
        .get(expectedHmac),
    ).toBeDefined()
  })

  it('user with password AND google identity → two banned_identity rows on DELETE /api/me', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { hashPassword } = (await import('./password.ts')) as any

    const username = `p2btomb2${Date.now()}`.slice(0, 20)
    const googleSub = `tomb-g-${Date.now()}`
    const password = 'TombPass123!'
    const pepper = 'test-password-pepper-32bytesx!'
    const now = new Date().toISOString()

    await ptDb.prepare(
      'INSERT INTO app_user (nickname, class_name, banned, created_at, last_seen_at) VALUES (?, ?, 1, ?, ?)',
    ).bind('Test', '11A', now, now).run()
    const { id: userId } = (await ptDb.prepare('SELECT MAX(id) AS id FROM app_user').first<{ id: number }>())!
    await ptDb.prepare(
      'INSERT INTO user_identity (user_id, provider, subject, ip_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(userId, 'password', username, '', now, now).run()
    // Insert a google identity for the same user (second identity)
    await ptDb.prepare(
      'INSERT INTO user_identity (user_id, provider, subject, ip_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(userId, 'google', googleSub, '', now, now).run()
    const cred = await hashPassword(password, pepper, { iterations: 10_000 })
    await ptDb.prepare(
      'INSERT INTO password_credential (user_id, hash, salt, iterations, must_change, failed_count, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?)',
    ).bind(userId, cred.hash, cred.salt, cred.iterations, now).run()
    const userToken = await createP2bSession(ptDb, userId)

    const { default: appWorker2 } = (await import('./index.ts')) as { default: { fetch: (r: Request, e: unknown) => Promise<Response> } }
    await appWorker2.fetch(
      new Request('https://x/api/me', {
        method: 'DELETE',
        headers: {
          'CF-Connecting-IP': '1.2.3.4',
          'X-Requested-With': 'fetch',
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE_P2B}=${userToken}`,
        },
        body: JSON.stringify({ password }),
      }),
      makeP2bAccountsEnv(ptDb),
    )

    const hmacPw = await hmacSha256Hex(TEST_SUB_HMAC_KEY, `password:${username}`)
    const hmacGoog = await hmacSha256Hex(TEST_SUB_HMAC_KEY, `google:${googleSub}`)
    // Both identities must each produce one tombstone row.
    expect(
      ptSqlite.prepare('SELECT sub_hmac FROM banned_identity WHERE sub_hmac = ?').get(hmacPw),
    ).toBeDefined()
    expect(
      ptSqlite.prepare('SELECT sub_hmac FROM banned_identity WHERE sub_hmac = ?').get(hmacGoog),
    ).toBeDefined()
  })

  // ── Unban removes tombstones ──────────────────────────────────────────────

  it('unban of still-existing banned user removes all tombstones for their identities', async () => {
    const { userId, username } = await seedP2bUser(ptDb, { banned: true })
    const googleSub = `tomb-unban-g-${Date.now()}`
    const now = new Date().toISOString()
    // Insert a second identity so we can confirm both tombstones are removed.
    ptSqlite
      .prepare(
        'INSERT INTO user_identity (user_id, provider, subject, ip_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(userId, 'google', googleSub, '', now, now)

    // Manually insert tombstones (simulating a prior delete+recreate cycle).
    const hmacPw = await hmacSha256Hex(TEST_SUB_HMAC_KEY, `password:${username}`)
    const hmacG = await hmacSha256Hex(TEST_SUB_HMAC_KEY, `google:${googleSub}`)
    ptSqlite.prepare('INSERT INTO banned_identity (sub_hmac, created_at) VALUES (?, ?)').run(hmacPw, now)
    ptSqlite.prepare('INSERT INTO banned_identity (sub_hmac, created_at) VALUES (?, ?)').run(hmacG, now)

    const r = await handleGiftModeration(
      gSessionReq(ptAdminToken, `/api/admin/users/${userId}`, 'PATCH', { banned: false }),
      giftModerationEnv(ptDb),
    )
    expect(r.status).toBe(200)

    expect(
      ptSqlite.prepare('SELECT sub_hmac FROM banned_identity WHERE sub_hmac = ?').get(hmacPw),
    ).toBeUndefined()
    expect(
      ptSqlite.prepare('SELECT sub_hmac FROM banned_identity WHERE sub_hmac = ?').get(hmacG),
    ).toBeUndefined()
  })

  // ── DELETE /api/admin/tombstones/<id> with Phase 2b admin ────────────────

  it('DELETE /api/admin/tombstones/<id> removes tombstone (Phase 2b admin)', async () => {
    const now = new Date().toISOString()
    ptSqlite
      .prepare('INSERT INTO banned_identity (sub_hmac, created_at) VALUES (?, ?)')
      .run('p2b-del-ts-hmac', now)
    const { id: tsId } = ptSqlite
      .prepare('SELECT rowid AS id FROM banned_identity WHERE sub_hmac = ?')
      .get('p2b-del-ts-hmac') as { id: number }

    const r = await handleGiftModeration(
      gSessionReq(ptAdminToken, `/api/admin/tombstones/${tsId}`, 'DELETE'),
      giftModerationEnv(ptDb),
    )
    expect(r.status).toBe(200)
    expect(
      ptSqlite.prepare('SELECT rowid FROM banned_identity WHERE rowid = ?').get(tsId),
    ).toBeUndefined()
  })

  // ── admin_audit rows ──────────────────────────────────────────────────────

  it('ban writes admin_audit row (action=ban, actor=admin user id, target=banned user id, no password in row)', async () => {
    const { userId: targetId } = await seedP2bUser(ptDb)
    await handleGiftModeration(
      gSessionReq(ptAdminToken, `/api/admin/users/${targetId}`, 'PATCH', { banned: true }),
      giftModerationEnv(ptDb),
    )
    const audit = ptSqlite
      .prepare(
        "SELECT actor_user_id, action, target_user_id FROM admin_audit WHERE action = 'ban' AND target_user_id = ?",
      )
      .get(targetId) as
      | { actor_user_id: number; action: string; target_user_id: number }
      | undefined
    expect(audit).toBeDefined()
    expect(audit!.actor_user_id).toBe(ptAdminUserId)
    expect(audit!.target_user_id).toBe(targetId)
    expect(JSON.stringify(audit).toLowerCase()).not.toMatch(/password/)
  })

  it('unban writes admin_audit row (action=unban, actor=admin, target=unbanned user)', async () => {
    const { userId: targetId } = await seedP2bUser(ptDb, { banned: true })
    await handleGiftModeration(
      gSessionReq(ptAdminToken, `/api/admin/users/${targetId}`, 'PATCH', { banned: false }),
      giftModerationEnv(ptDb),
    )
    const audit = ptSqlite
      .prepare(
        "SELECT actor_user_id, action, target_user_id FROM admin_audit WHERE action = 'unban' AND target_user_id = ?",
      )
      .get(targetId) as
      | { actor_user_id: number; action: string; target_user_id: number }
      | undefined
    expect(audit).toBeDefined()
    expect(audit!.actor_user_id).toBe(ptAdminUserId)
    expect(audit!.target_user_id).toBe(targetId)
  })

  it('remove_tombstone (DELETE /api/admin/tombstones/<id>) writes admin_audit row', async () => {
    const now = new Date().toISOString()
    ptSqlite
      .prepare('INSERT INTO banned_identity (sub_hmac, created_at) VALUES (?, ?)')
      .run('p2b-audit-rm-hmac', now)
    const { id: tsId } = ptSqlite
      .prepare('SELECT rowid AS id FROM banned_identity WHERE sub_hmac = ?')
      .get('p2b-audit-rm-hmac') as { id: number }

    await handleGiftModeration(
      gSessionReq(ptAdminToken, `/api/admin/tombstones/${tsId}`, 'DELETE'),
      giftModerationEnv(ptDb),
    )
    const audit = ptSqlite
      .prepare("SELECT actor_user_id, action FROM admin_audit WHERE action = 'remove_tombstone'")
      .get() as { actor_user_id: number; action: string } | undefined
    expect(audit).toBeDefined()
    expect(audit!.actor_user_id).toBe(ptAdminUserId)
  })
})
