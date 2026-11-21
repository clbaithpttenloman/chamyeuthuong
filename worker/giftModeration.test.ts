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

import { handleAuth, handleMe } from './me.ts'
import {
  makeNonce,
  validToken,
  localJwks,
  TEST_NONCE_KEY,
  NONCE_COOKIE_NAME,
} from './testGoogle.ts'
import { deletionEnv, TEST_SUB_HMAC_KEY } from './testGift.ts'

// ── Item 1: unban removes banned_identity tombstone ───────────────────────────

describe('handleGiftModeration — unban removes banned_identity tombstone (item 1)', () => {
  let tombstoneDb: ReturnType<typeof testDb>['db']
  let tombstoneSqlite: ReturnType<typeof testDb>['sqlite']
  let adminToken: string
  let targetUserId: number
  const TARGET_SUB = 'target-tombstone-sub'
  const TARGET_EMAIL = 'target-tombstone@gmail.com'

  function makeSignInReq(credential: string, nonceCookie: string): Request {
    return new Request('https://x/api/auth/google', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'Content-Type': 'application/json',
        'X-Requested-With': 'fetch',
        Cookie: `${NONCE_COOKIE_NAME}=${nonceCookie}`,
      },
      body: JSON.stringify({ credential }),
    })
  }

  beforeEach(async () => {
    ;({ db: tombstoneDb, sqlite: tombstoneSqlite } = testDb())
    createNewTables(tombstoneSqlite)
    createGiftTables(tombstoneSqlite)
    adminToken = await seedGiftAdminSession(tombstoneDb)
    targetUserId = await seedUser(tombstoneDb, { sub: TARGET_SUB, email: TARGET_EMAIL })
    const targetToken = makeRawToken()
    await seedSession(tombstoneDb, targetUserId, targetToken)
  })

  it('unban removes the tombstone so the user can sign in normally (ADR-8)', async () => {
    const authEnv = {
      ...deletionEnv(tombstoneDb, { subHmacKey: TEST_SUB_HMAC_KEY }),
      GOOGLE_CLIENT_ID: 'test-client-123.apps.googleusercontent.com',
      NONCE_KEY: TEST_NONCE_KEY,
    }
    const modEnv = giftModerationEnv(tombstoneDb, { subHmacKey: TEST_SUB_HMAC_KEY })

    // Step 1: Ban the target user
    await handleGiftModeration(
      gSessionReq(adminToken, `/api/admin/users/${targetUserId}`, 'PATCH', { banned: true }),
      modEnv,
    )

    // Step 2: User deletes their account (creates tombstone because they're banned)
    const userToken = makeRawToken()
    await seedSession(tombstoneDb, targetUserId, userToken)
    await handleMe(
      new Request('https://x/api/me', {
        method: 'DELETE',
        headers: {
          Cookie: `__Host-cyt_s=${userToken}`,
          'X-Requested-With': 'fetch',
          'CF-Connecting-IP': '1.2.3.4',
        },
      }),
      authEnv,
    )

    // Tombstone should exist
    const tombstoneCount = (tombstoneSqlite
      .prepare('SELECT COUNT(*) AS c FROM banned_identity')
      .get() as { c: number }).c
    expect(tombstoneCount).toBe(1)

    // Step 3: Sign in with the same sub → recreated as banned (tombstone check)
    const { nonceValue: nonce1 } = await makeNonce(TEST_NONCE_KEY)
    const credential1 = await validToken({ nonce: nonce1, sub: TARGET_SUB, email: TARGET_EMAIL }, {})
    await handleAuth(makeSignInReq(credential1, nonce1), authEnv, { keys: await localJwks() })

    const banCheck = tombstoneSqlite
      .prepare('SELECT banned FROM app_user WHERE google_sub = ?')
      .get(TARGET_SUB) as { banned: number } | undefined
    expect(banCheck?.banned).toBe(1)

    // Step 4: Admin unbans the user → tombstone must be removed in the same batch
    const newTargetId = (tombstoneSqlite
      .prepare('SELECT id FROM app_user WHERE google_sub = ?')
      .get(TARGET_SUB) as { id: number }).id
    const unbanResp = await handleGiftModeration(
      gSessionReq(adminToken, `/api/admin/users/${newTargetId}`, 'PATCH', { banned: false }),
      modEnv,
    )
    expect(unbanResp.status).toBe(200)

    // Tombstone must be gone
    const tombstoneAfterUnban = (tombstoneSqlite
      .prepare('SELECT COUNT(*) AS c FROM banned_identity')
      .get() as { c: number }).c
    expect(tombstoneAfterUnban).toBe(0)

    // Step 5: Sign in again with same sub → user created as NOT banned
    const { nonceValue: nonce2 } = await makeNonce(TEST_NONCE_KEY)
    const credential2 = await validToken({ nonce: nonce2, sub: TARGET_SUB, email: TARGET_EMAIL }, {})
    await handleAuth(makeSignInReq(credential2, nonce2), authEnv, { keys: await localJwks() })

    const finalCheck = tombstoneSqlite
      .prepare('SELECT banned FROM app_user WHERE google_sub = ?')
      .get(TARGET_SUB) as { banned: number } | undefined
    expect(finalCheck?.banned).toBe(0)
  })

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
    expect(unbannedResp.status).toBe(500)
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
    rc4CampId = await seedGiftCampaign(rc4Db, { id: 25, slug: 'noel-rcount-test', settings: { report_threshold: 5 } })
    rc4TmplId = await seedTemplate(rc4Db, rc4CampId)
    rc4OwnerId = await seedUser(rc4Db, { sub: 'rc4-owner-001', email: 'rc4owner@gmail.com' })
    const { id: gid } = await seedGift(rc4Db, rc4OwnerId, rc4CampId, rc4TmplId, {
      publicId: 'rcountgifttest123',
      reportCount: 0,
    })
    rc4GiftId = gid
    rc4ReporterId = await seedUser(rc4Db, { sub: 'rc4-reporter-001', email: 'rc4reporter@gmail.com' })
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
