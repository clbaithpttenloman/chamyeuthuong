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

  it('admin cannot ban themselves → 403', async () => {
    const adminUser = giftSqlite4.prepare('SELECT id FROM app_user WHERE google_sub = ?').get(GOOGLE_TEST_SUB) as { id: number } | undefined
    expect(adminUser).toBeDefined()
    const r = await handleGiftModeration(
      gSessionReq(adminTok4, `/api/admin/users/${adminUser!.id}`, 'PATCH', { banned: true }),
      giftModerationEnv(giftDb4),
    )
    expect(r.status).toBe(403)
  })
})
