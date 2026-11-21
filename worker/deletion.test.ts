// @vitest-environment node
/**
 * RED-PHASE tests for DELETE /api/me (account deletion, Phase 2 extensions).
 *
 * Module contract (worker/me.ts — existing module, Phase 2 adds DELETE behavior):
 *
 *   DELETE /api/me
 *     Auth: session cookie required (401 if missing)
 *     Rate-limit: USER_WRITE_LIMIT (10/60 s per user)
 *
 *   Phase 1 behavior (already shipped):
 *     Deletes user row + all sessions.
 *
 *   Phase 2 extensions (NOT yet implemented — tests below fail because of this):
 *
 *   1. Full cascade:
 *      Deletes user's gifts (status → 'deleted'), hearts, and reports.
 *      Recounts heart_count for every gift the user had hearted.
 *      Deletes user's sessions.
 *      Deletes user row.
 *
 *   2. Refused while pending_review (ADR-8, AC-14):
 *      If the user owns any gift with status 'hidden_auto' or 'hidden_admin',
 *      DELETE /api/me returns 409 { error: 'pending_review' }.
 *      The user cannot delete evidence while a gift is under review.
 *
 *   3. Banned-user tombstone (ADR-8, AC-14):
 *      If the user is banned (banned = 1), before deleting:
 *        a. Compute HMAC-SHA256(SUB_HMAC_KEY, google_sub) as hex.
 *        b. INSERT OR IGNORE INTO banned_identity (sub_hmac, created_at) VALUES (...).
 *      Then delete normally (gifts, hearts, reports, sessions, user).
 *
 *   4. Missing SUB_HMAC_KEY fails closed (security: no tombstone skip on misconfiguration):
 *      If SUB_HMAC_KEY is absent/empty and the user is banned, DELETE /api/me FAILS with
 *      a non-200 response (e.g. 500). The deletion does not proceed.
 *
 *   5. Sign-in after tombstone recreates the user as banned (ADR-8):
 *      POST /api/auth/google with a google_sub whose HMAC is in banned_identity
 *      creates the user row but sets banned = 1 immediately.
 *
 *   These Phase 2 behaviors fail because:
 *     - The gift/heart/report tables don't exist in the current DB
 *     - The pending_review gate is not implemented
 *     - The tombstone logic is not implemented
 *     - SUB_HMAC_KEY is not checked
 *
 *   DeletionEnv (from testGift.ts) extends MeTestEnv with:
 *     SUB_HMAC_KEY?: string
 */
import { describe, it, expect, beforeEach } from 'vitest'

// ── handleMe and handleAuth from existing worker/me.ts ───────────────────────
// (the module exists; Phase 2 behavior is what's missing)
import { handleMe, handleAuth } from './me.ts'
import { testDb } from './testDb.ts'
import {
  createNewTables,
  seedUser,
  seedSession,
  makeRawToken,
  validToken,
  localJwks,
  makeNonce,
  TEST_SUB,
  TEST_NONCE_KEY,
} from './testGoogle.ts'
import {
  createGiftTables,
  deletionEnv,
  TEST_SUB_HMAC_KEY,
  seedGiftCampaign,
  seedTemplate,
  seedGift,
  sessionReq,
  anonReq,
} from './testGift.ts'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSignInReq(credential: string, nonceCookie: string): Request {
  return new Request('https://x/api/auth/google', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': '1.2.3.4',
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch',
      Cookie: `__Host-cyt_n=${nonceCookie}`,
    },
    body: JSON.stringify({ credential }),
  })
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let db: ReturnType<typeof testDb>['db']
let sqlite: ReturnType<typeof testDb>['sqlite']
let campaignId: number
let templateId: number
let userId: number
let rawToken: string

beforeEach(async () => {
  ;({ db, sqlite } = testDb())
  createNewTables(sqlite)
  createGiftTables(sqlite)
  userId = await seedUser(db, { sub: TEST_SUB, email: 'del-user@gmail.com' })
  rawToken = makeRawToken()
  await seedSession(db, userId, rawToken)
  campaignId = await seedGiftCampaign(db)
  templateId = await seedTemplate(db, campaignId)
})

// ── DELETE /api/me — authentication ──────────────────────────────────────────

describe('DELETE /api/me — authentication', () => {
  it('unauthenticated request → 401', async () => {
    const r = await handleMe(
      anonReq('/api/me', 'DELETE'),
      deletionEnv(db),
    )
    expect(r.status).toBe(401)
  })
})

// ── DELETE /api/me — full cascade (Phase 2) ───────────────────────────────────

describe('DELETE /api/me — full cascade (Phase 2)', () => {
  it('deletes user row', async () => {
    const r = await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db),
    )
    expect(r.status).toBe(200)
    const row = sqlite.prepare('SELECT id FROM app_user WHERE id = ?').get(userId)
    expect(row).toBeUndefined()
  })

  it('deletes all user sessions', async () => {
    // Add a second session
    const rawToken2 = makeRawToken()
    await seedSession(db, userId, rawToken2)
    await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db),
    )
    const sessions = (sqlite
      .prepare('SELECT COUNT(*) AS c FROM session WHERE user_id = ?')
      .get(userId) as { c: number }).c
    expect(sessions).toBe(0)
  })

  it('deletes user gifts (marks as deleted)', async () => {
    const { id: giftId } = await seedGift(db, userId, campaignId, templateId, {
      publicId: 'deletemegift12345',
    })
    await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db),
    )
    const gift = sqlite
      .prepare('SELECT status FROM gift WHERE id = ?')
      .get(giftId) as { status: string } | undefined
    // Gift should either be deleted or not visible
    expect(gift === undefined || gift.status === 'deleted').toBe(true)
  })

  it('deletes user hearts and recounts heart_count for affected gifts', async () => {
    // Another user's gift that userId hearted
    const otherId = await seedUser(db, { sub: 'del-other-001', email: 'delother@gmail.com' })
    const { id: giftId } = await seedGift(db, otherId, campaignId, templateId, {
      publicId: 'deletehear1234567',
    })
    // Insert a heart from userId
    const now = new Date().toISOString()
    sqlite
      .prepare('INSERT INTO heart (gift_id,user_id,day,created_at) VALUES (?,?,?,?)')
      .run(giftId, userId, '2026-12-10', now)
    sqlite.prepare('UPDATE gift SET heart_count = 1 WHERE id = ?').run(giftId)

    await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db),
    )

    // userId's heart should be gone
    const heartCount = (sqlite
      .prepare('SELECT COUNT(*) AS c FROM heart WHERE user_id = ?')
      .get(userId) as { c: number }).c
    expect(heartCount).toBe(0)

    // heart_count should be recounted (= 0)
    const gift = sqlite
      .prepare('SELECT heart_count FROM gift WHERE id = ?')
      .get(giftId) as { heart_count: number } | undefined
    if (gift) {
      const actual = (sqlite
        .prepare('SELECT COUNT(*) AS c FROM heart WHERE gift_id = ?')
        .get(giftId) as { c: number }).c
      expect(gift.heart_count).toBe(actual)
    }
  })

  it('deletes user reports', async () => {
    const otherId = await seedUser(db, { sub: 'del-other-r-001', email: 'delorepother@gmail.com' })
    const { id: giftId } = await seedGift(db, otherId, campaignId, templateId, {
      publicId: 'deletereport12345',
    })
    const now = new Date().toISOString()
    sqlite
      .prepare('INSERT INTO report (gift_id,user_id,reason,acknowledged,created_at) VALUES (?,?,?,0,?)')
      .run(giftId, userId, 'spam', now)

    await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db),
    )

    const repCount = (sqlite
      .prepare('SELECT COUNT(*) AS c FROM report WHERE user_id = ?')
      .get(userId) as { c: number }).c
    expect(repCount).toBe(0)
  })
})

// ── DELETE /api/me — refused while pending_review (Phase 2) ──────────────────

describe('DELETE /api/me — refused 409 pending_review while gift is under review (AC-14)', () => {
  it('hidden_auto gift → 409 pending_review', async () => {
    await seedGift(db, userId, campaignId, templateId, {
      publicId: 'pendingauto1234567',
      status: 'hidden_auto',
    })
    const r = await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('pending_review')
  })

  it('hidden_admin gift → 409 pending_review', async () => {
    await seedGift(db, userId, campaignId, templateId, {
      publicId: 'pendingadmin1234567',
      status: 'hidden_admin',
    })
    const r = await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('pending_review')
  })

  it('visible gift does NOT block deletion', async () => {
    await seedGift(db, userId, campaignId, templateId, {
      publicId: 'visiblegiftdel1234',
      status: 'visible',
    })
    const r = await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db),
    )
    // Should succeed (not 409)
    expect(r.status).not.toBe(409)
  })

  it('deleted gift does NOT block deletion', async () => {
    await seedGift(db, userId, campaignId, templateId, {
      publicId: 'deletedgiftdel1234',
      status: 'deleted',
    })
    const r = await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db),
    )
    expect(r.status).not.toBe(409)
  })

  it('user row is preserved when deletion is refused', async () => {
    await seedGift(db, userId, campaignId, templateId, {
      publicId: 'preservedpending12',
      status: 'hidden_auto',
    })
    await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db),
    )
    const row = sqlite.prepare('SELECT id FROM app_user WHERE id = ?').get(userId)
    expect(row).toBeDefined()
  })
})

// ── DELETE /api/me — banned user tombstone (ADR-8, AC-14) ────────────────────

describe('DELETE /api/me — banned user writes banned_identity tombstone (ADR-8)', () => {
  it('banned user deletion writes sub_hmac to banned_identity', async () => {
    // Mark user as banned
    sqlite.prepare('UPDATE app_user SET banned = 1 WHERE id = ?').run(userId)

    await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db, { subHmacKey: TEST_SUB_HMAC_KEY }),
    )

    // A tombstone should exist
    const tombstone = sqlite
      .prepare('SELECT sub_hmac FROM banned_identity')
      .get() as { sub_hmac: string } | undefined
    expect(tombstone).toBeDefined()
    expect(typeof tombstone?.sub_hmac).toBe('string')
    expect(tombstone!.sub_hmac.length).toBeGreaterThan(0)
  })

  it('non-banned user deletion does NOT write banned_identity', async () => {
    // userId is not banned (default)
    await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db, { subHmacKey: TEST_SUB_HMAC_KEY }),
    )

    const tombstones = (sqlite
      .prepare('SELECT COUNT(*) AS c FROM banned_identity')
      .get() as { c: number }).c
    expect(tombstones).toBe(0)
  })

  it('tombstone sub_hmac is HMAC(SUB_HMAC_KEY, google_sub) — repeatable', async () => {
    // The same sub + same key always produces the same hmac → idempotent tombstone
    sqlite.prepare('UPDATE app_user SET banned = 1 WHERE id = ?').run(userId)
    await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db, { subHmacKey: TEST_SUB_HMAC_KEY }),
    )
    const t1 = sqlite
      .prepare('SELECT sub_hmac FROM banned_identity')
      .get() as { sub_hmac: string }

    // Recreate user with same sub and delete again
    const newId = await seedUser(db, { sub: TEST_SUB, email: 'del-user2@gmail.com', banned: true })
    const newToken = makeRawToken()
    await seedSession(db, newId, newToken)
    await handleMe(
      sessionReq(newToken, '/api/me', 'DELETE'),
      deletionEnv(db, { subHmacKey: TEST_SUB_HMAC_KEY }),
    )

    // INSERT OR IGNORE: same sub_hmac so only one tombstone row
    const count = (sqlite.prepare('SELECT COUNT(*) AS c FROM banned_identity').get() as { c: number }).c
    expect(count).toBe(1)
    // The hash is the same
    const t2 = sqlite.prepare('SELECT sub_hmac FROM banned_identity').get() as { sub_hmac: string }
    expect(t2.sub_hmac).toBe(t1.sub_hmac)
  })
})

// ── Missing SUB_HMAC_KEY fails closed ─────────────────────────────────────────

describe('DELETE /api/me — missing SUB_HMAC_KEY fails closed for banned users', () => {
  it('banned user + no SUB_HMAC_KEY → non-200 response (not silently deleted)', async () => {
    sqlite.prepare('UPDATE app_user SET banned = 1 WHERE id = ?').run(userId)
    const r = await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db, { subHmacKey: undefined }),
    )
    // Must NOT be 200 — the deletion must be refused when the key is missing
    expect(r.status).not.toBe(200)
    // User row must still exist (deletion did not proceed)
    const row = sqlite.prepare('SELECT id FROM app_user WHERE id = ?').get(userId)
    expect(row).toBeDefined()
  })

  it('non-banned user + no SUB_HMAC_KEY → deletion proceeds (key not needed for non-banned)', async () => {
    const r = await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db, { subHmacKey: undefined }),
    )
    // Non-banned users don't need the key → succeeds
    expect(r.status).toBe(200)
  })
})

// ── Sign-in after banned tombstone recreates user as banned (ADR-8, AC-14) ───

describe('DELETE /api/me — sign-in with tombstoned sub recreates user banned', () => {
  it('POST /api/auth/google with tombstoned sub creates new user with banned = 1', async () => {
    // Mark user as banned
    sqlite.prepare('UPDATE app_user SET banned = 1 WHERE id = ?').run(userId)
    // Delete the user (writes tombstone)
    await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db, { subHmacKey: TEST_SUB_HMAC_KEY }),
    )
    // User is gone
    const gone = sqlite.prepare('SELECT id FROM app_user WHERE id = ?').get(userId)
    expect(gone).toBeUndefined()

    // Now sign in with the same Google sub
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })  // uses TEST_SUB
    const signInReq = makeSignInReq(credential, nonceValue)

    // handleAuth needs SUB_HMAC_KEY to check banned_identity
    const authEnv = {
      ...deletionEnv(db, { subHmacKey: TEST_SUB_HMAC_KEY }),
      NONCE_KEY: TEST_NONCE_KEY,
    }
    await handleAuth(signInReq, authEnv, { keys: await localJwks() })

    // The new account should be banned
    const newUser = sqlite
      .prepare('SELECT banned FROM app_user WHERE google_sub = ?')
      .get(TEST_SUB) as { banned: number } | undefined
    expect(newUser).toBeDefined()
    expect(newUser?.banned).toBe(1)
  })

  it('POST /api/auth/google with non-tombstoned sub creates normal (non-banned) user', async () => {
    // Normal deletion (user is not banned, no tombstone)
    await handleMe(
      sessionReq(rawToken, '/api/me', 'DELETE'),
      deletionEnv(db, { subHmacKey: TEST_SUB_HMAC_KEY }),
    )

    // Sign in again
    const { nonceValue } = await makeNonce(TEST_NONCE_KEY)
    const credential = await validToken({ nonce: nonceValue })
    const signInReq = makeSignInReq(credential, nonceValue)
    const authEnv = {
      ...deletionEnv(db, { subHmacKey: TEST_SUB_HMAC_KEY }),
      NONCE_KEY: TEST_NONCE_KEY,
    }
    await handleAuth(signInReq, authEnv, { keys: await localJwks() })

    // New account should NOT be banned
    const newUser = sqlite
      .prepare('SELECT banned FROM app_user WHERE google_sub = ?')
      .get(TEST_SUB) as { banned: number } | undefined
    expect(newUser?.banned).toBe(0)
  })
})
