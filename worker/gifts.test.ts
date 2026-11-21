// @vitest-environment node
/**
 * RED-PHASE tests for worker/gifts.ts (gift create, owner delete).
 *
 * Module contract assumed (implementers follow these):
 *
 *   File:      worker/gifts.ts
 *   Export:    handleGifts(request: Request, env: GiftsEnv): Promise<Response>
 *
 *   Routes:
 *     POST   /api/campaigns/<slug>/gifts  — create a gift
 *     DELETE /api/gifts/<publicId>        — owner deletes their own gift
 *     POST   /api/gifts/<publicId>/heart  — give a heart (hearts.test.ts)
 *     POST   /api/gifts/<publicId>/report — report (reports.test.ts)
 *
 *   GiftsEnv: {
 *     DB:           D1,
 *     GIFT_LIMIT:   { limit({key}): Promise<{success}> }  // 6/60 s per user, keyed by user id
 *     HEART_LIMIT:  { limit({key}): Promise<{success}> }  // 20/60 s per user
 *     REPORT_LIMIT: { limit({key}): Promise<{success}> }  // 10/60 s per user
 *   }
 *
 *   POST /api/campaigns/<slug>/gifts request body (JSON):
 *     { boxStyle: 1..6, ornamentStyle: 1..6, layout: string,
 *       backgroundTemplateId: number,  // must be active template of THIS campaign
 *       font: string, ink: string,
 *       message: string (1-300 chars, no control chars except \n, no bidi/zero-width),
 *       nickname: string (1-30, no control chars),
 *       className: string (0-10 chars, no control chars) }
 *     Unknown fields → 400
 *
 *   POST /api/campaigns/<slug>/gifts success response: 201 { publicId: string }
 *   The publicId comes from newToken() — 16 chars [a-z0-9].
 *   The gift is immediately visible (status = 'visible').
 *
 *   Error codes:
 *     401 — not signed in
 *     403 { error: 'banned' } — user is banned
 *     404 — campaign not found, or campaign kind != 'gift_tree'
 *     409 { error: 'campaign_closed' } — campaign status!=active or outside dates
 *     409 { error: 'limit_reached' }   — 4th non-deleted gift in this campaign
 *     429 { error: 'daily_limit' }     — 7th creation in one Vietnam day
 *     429 { error: 'rate_limited' }    — GIFT_LIMIT exhausted
 *     400 { error: 'bad_request' }     — validation failure
 *
 *   DELETE /api/gifts/<publicId>:
 *     Auth: session cookie required (401 if missing)
 *     Own visible gift  → 200 { ok: true }; slot freed (non-deleted count decreases)
 *     Hidden gift       → 409 { error: 'pending_review' }
 *     Other user's gift → 404
 *     Deleted gift      → 404
 *
 *   Template routes: tested in worker/campaignTemplates.test.ts (handleTree in worker/tree.ts).
 *
 * All tests fail NOW because worker/gifts.ts does not exist.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.mock('./token.ts', () => ({
  newToken: vi.fn(() => 'generatedgift123'),
  isToken: (t: string) => /^[a-z0-9]{16}$/.test(t),
}))

// ── Module under test: does not exist yet → all tests fail at import ──────────
import { handleGifts } from './gifts.ts'
import { newToken } from './token.ts'
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function validGiftBody(templateId: number): Record<string, unknown> {
  return {
    boxStyle: 2,
    ornamentStyle: 3,
    layout: 'doc-giua',
    backgroundTemplateId: templateId,
    font: 'patrick-hand',
    ink: '#1d3fa6',
    message: 'Chúc mừng Giáng sinh!',
    nickname: 'Học sinh',
    className: '11A',
  }
}

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
  vi.mocked(newToken).mockReturnValue('generatedgift123')
  campaignId = await seedGiftCampaign(db)
  templateId = await seedTemplate(db, campaignId)
  userId = await seedUser(db)
  rawToken = makeRawToken()
  await seedSession(db, userId, rawToken)
})

afterEach(() => {
  vi.useRealTimers()
})

// ── POST /api/campaigns/<slug>/gifts — valid create ───────────────────────────

describe('POST /api/campaigns/<slug>/gifts — valid create → 201', () => {
  it('valid body → 201 { publicId } matching the token format', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', validGiftBody(templateId)),
      giftsEnv(db),
    )
    expect(r.status).toBe(201)
    const body = await r.json() as { publicId?: string }
    expect(typeof body.publicId).toBe('string')
    expect(/^[a-z0-9]{16}$/.test(body.publicId!)).toBe(true)
  })

  it('created gift is immediately visible (status = visible)', async () => {
    await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', validGiftBody(templateId)),
      giftsEnv(db),
    )
    const gift = sqlite
      .prepare("SELECT status, public_id FROM gift WHERE status = 'visible'")
      .get() as { status: string; public_id: string } | undefined
    expect(gift?.status).toBe('visible')
  })

  it('public_id comes from newToken() (16 chars [a-z0-9])', async () => {
    vi.mocked(newToken).mockReturnValue('mytesttoken12345')
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', validGiftBody(templateId)),
      giftsEnv(db),
    )
    const body = await r.json() as { publicId: string }
    expect(body.publicId).toBe('mytesttoken12345')
  })

  it('no gift.id or user_id in the response body', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', validGiftBody(templateId)),
      giftsEnv(db),
    )
    const body = await r.json() as Record<string, unknown>
    expect(body).not.toHaveProperty('id')
    expect(body).not.toHaveProperty('userId')
    expect(body).not.toHaveProperty('user_id')
  })
})

// ── POST — authentication ─────────────────────────────────────────────────────

describe('POST /api/campaigns/<slug>/gifts — authentication', () => {
  it('no session cookie → 401', async () => {
    const r = await handleGifts(
      anonReq('/api/campaigns/noel-2026/gifts', 'POST', validGiftBody(templateId)),
      giftsEnv(db),
    )
    expect(r.status).toBe(401)
  })

  it('banned user → 403 banned', async () => {
    // Create a banned user
    const bannedId = await seedUser(db, { sub: 'banned-sub-999', email: 'banned@gmail.com', banned: true })
    const bannedToken = makeRawToken()
    await seedSession(db, bannedId, bannedToken)
    const r = await handleGifts(
      sessionReq(bannedToken, '/api/campaigns/noel-2026/gifts', 'POST', validGiftBody(templateId)),
      giftsEnv(db),
    )
    expect(r.status).toBe(403)
    expect((await r.json() as { error: string }).error).toBe('banned')
  })
})

// ── POST — campaign validation ────────────────────────────────────────────────

describe('POST /api/campaigns/<slug>/gifts — campaign checks', () => {
  it('unknown campaign slug → 404', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/no-such-campaign/gifts', 'POST', validGiftBody(templateId)),
      giftsEnv(db),
    )
    expect(r.status).toBe(404)
  })

  it('teacher_cards campaign (non-gift_tree kind) → 404', async () => {
    // Campaign 1 is teacher_cards
    const tmpl1 = await seedTemplate(db, 1)
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/20-11/gifts', 'POST', validGiftBody(tmpl1)),
      giftsEnv(db),
    )
    expect(r.status).toBe(404)
  })

  it('closed campaign → 409 campaign_closed', async () => {
    await seedGiftCampaign(db, { id: 3, slug: 'noel-closed', status: 'closed' })
    const tmpl = await seedTemplate(db, 3)
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-closed/gifts', 'POST', validGiftBody(tmpl)),
      giftsEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_closed')
  })

  it('active campaign outside dates → 409 campaign_closed (AC-3)', async () => {
    await seedGiftCampaign(db, {
      id: 4,
      slug: 'noel-past',
      status: 'active',
      startsAt: '2020-01-01T00:00:00Z',
      endsAt: '2020-12-31T23:59:59Z',
    })
    const tmpl = await seedTemplate(db, 4)
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-past/gifts', 'POST', validGiftBody(tmpl)),
      giftsEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_closed')
  })

  it('draft campaign → 409 campaign_closed', async () => {
    await seedGiftCampaign(db, { id: 5, slug: 'noel-draft', status: 'draft' })
    const tmpl = await seedTemplate(db, 5)
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-draft/gifts', 'POST', validGiftBody(tmpl)),
      giftsEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_closed')
  })
})

// ── POST — body validation ────────────────────────────────────────────────────

describe('POST /api/campaigns/<slug>/gifts — body validation → 400', () => {
  it('unknown field in body → 400 bad_request', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        unknownField: 'should be rejected',
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('boxStyle = 0 → 400', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        boxStyle: 0,
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('boxStyle = 7 → 400', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        boxStyle: 7,
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('ornamentStyle = 0 → 400', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        ornamentStyle: 0,
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('backgroundTemplateId not in this campaign → 400', async () => {
    // templateId belongs to campaign 2; campaign 1's template should be rejected
    const otherCampaignTemplate = await seedTemplate(db, 1)  // campaign 1 (teacher_cards)
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(otherCampaignTemplate),  // wrong campaign
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('backgroundTemplateId that is inactive → 400', async () => {
    // Deactivate the template
    await db.prepare('UPDATE template SET active = 0 WHERE id = ?').bind(templateId).run()
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', validGiftBody(templateId)),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('message empty string → 400', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        message: '',
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('message > 300 chars → 400', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        message: 'a'.repeat(301),
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('message with bidi-override character → 400', async () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE (bidi override)
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        message: 'Hello\u202Eworld',
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('message with zero-width space (U+200B) → 400', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        message: 'Hello\u200Bworld',
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('nickname empty string → 400', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        nickname: '',
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('nickname > 30 chars → 400', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        nickname: 'N'.repeat(31),
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('className > 10 chars → 400', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        className: 'C'.repeat(11),
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('nickname with control character → 400', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        nickname: 'Nick\x01name',
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })
})

// ── POST — per-user gift count limits (AC-10) ─────────────────────────────────

describe('POST /api/campaigns/<slug>/gifts — gift count limits (AC-10)', () => {
  it('4th non-deleted gift → 409 limit_reached', async () => {
    // gifts_per_user defaults to 3 in seedGiftCampaign
    for (let i = 0; i < 3; i++) {
      vi.mocked(newToken).mockReturnValueOnce(`gift${i}created1234567`.slice(0, 16))
      await handleGifts(
        sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', validGiftBody(templateId)),
        giftsEnv(db),
      )
    }
    vi.mocked(newToken).mockReturnValue('gift4blocked12345')
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', validGiftBody(templateId)),
      giftsEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('limit_reached')
  })

  it('delete a gift frees a slot (gifts_per_user slot count)', async () => {
    // Create 3 gifts (at limit), delete one, then create again → 201
    const tokens = ['gifta0created123', 'giftb0created123', 'giftc0created123']
    const publicIds: string[] = []
    for (const token of tokens) {
      vi.mocked(newToken).mockReturnValueOnce(token)
      await handleGifts(
        sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', validGiftBody(templateId)),
        giftsEnv(db),
      )
      publicIds.push(token)
    }
    // Delete one
    await handleGifts(
      sessionReq(rawToken, `/api/gifts/${publicIds[0]}`, 'DELETE'),
      giftsEnv(db),
    )
    // Now should succeed
    vi.mocked(newToken).mockReturnValue('giftd0after1234a')
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', validGiftBody(templateId)),
      giftsEnv(db),
    )
    expect(r.status).toBe(201)
  })

  it('7th creation in one Vietnam day (deletes included) → 429 daily_limit (AC-10)', async () => {
    // Use fake timers to pin the Vietnam day
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-12-10T10:00:00Z'))  // 17:00 Vietnam = same day
    // Campaign with higher gifts_per_user to avoid limit_reached
    await seedGiftCampaign(db, { id: 6, slug: 'noel-daily', settings: { gifts_per_user: 10 } })
    const tmpl = await seedTemplate(db, 6)
    for (let i = 0; i < 6; i++) {
      vi.mocked(newToken).mockReturnValueOnce(`daily${i}test1234561234`.slice(0, 16))
      const r = await handleGifts(
        sessionReq(rawToken, '/api/campaigns/noel-daily/gifts', 'POST', validGiftBody(tmpl)),
        giftsEnv(db),
      )
      // Optionally delete some to test "creations, not holdings"
      if (i < 3) {
        const { publicId } = await r.json() as { publicId: string }
        await handleGifts(
          sessionReq(rawToken, `/api/gifts/${publicId}`, 'DELETE'),
          giftsEnv(db),
        )
      }
    }
    // 7th creation this Vietnam day
    vi.mocked(newToken).mockReturnValue('daily7blocked12345')
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-daily/gifts', 'POST', validGiftBody(tmpl)),
      giftsEnv(db),
    )
    expect(r.status).toBe(429)
    expect((await r.json() as { error: string }).error).toBe('daily_limit')
  })
})

// ── POST — GIFT_LIMIT rate-limit ──────────────────────────────────────────────

describe('POST /api/campaigns/<slug>/gifts — GIFT_LIMIT', () => {
  it('GIFT_LIMIT exhausted → 429 rate_limited', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', validGiftBody(templateId)),
      giftsEnv(db, { giftLimitFail: true }),
    )
    expect(r.status).toBe(429)
    expect((await r.json() as { error: string }).error).toBe('rate_limited')
  })
})

// ── DELETE /api/gifts/<publicId> — owner delete ───────────────────────────────

describe('DELETE /api/gifts/<publicId> — owner delete', () => {
  it('own visible gift → 200 { ok: true }', async () => {
    const { publicId } = await seedGift(db, userId, campaignId, templateId)
    const r = await handleGifts(
      sessionReq(rawToken, `/api/gifts/${publicId}`, 'DELETE'),
      giftsEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { ok: boolean }).ok).toBe(true)
  })

  it('deleted gift has status = deleted in DB', async () => {
    const { publicId } = await seedGift(db, userId, campaignId, templateId)
    await handleGifts(
      sessionReq(rawToken, `/api/gifts/${publicId}`, 'DELETE'),
      giftsEnv(db),
    )
    const row = sqlite
      .prepare('SELECT status FROM gift WHERE public_id = ?')
      .get(publicId) as { status: string } | undefined
    expect(row?.status).toBe('deleted')
  })

  it('hidden_auto gift → 409 pending_review (ADR-8: evidence cannot be removed)', async () => {
    const { publicId } = await seedGift(db, userId, campaignId, templateId, { status: 'hidden_auto' })
    const r = await handleGifts(
      sessionReq(rawToken, `/api/gifts/${publicId}`, 'DELETE'),
      giftsEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('pending_review')
  })

  it('hidden_admin gift → 409 pending_review', async () => {
    const { publicId } = await seedGift(db, userId, campaignId, templateId, { status: 'hidden_admin' })
    const r = await handleGifts(
      sessionReq(rawToken, `/api/gifts/${publicId}`, 'DELETE'),
      giftsEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('pending_review')
  })

  it("another user's visible gift → 404", async () => {
    // Seed another user and their gift
    const otherId = await seedUser(db, { sub: 'other-sub-9999', email: 'other@gmail.com' })
    const { publicId } = await seedGift(db, otherId, campaignId, templateId)
    const r = await handleGifts(
      sessionReq(rawToken, `/api/gifts/${publicId}`, 'DELETE'),
      giftsEnv(db),
    )
    expect(r.status).toBe(404)
  })

  it('already-deleted gift → 404', async () => {
    const { publicId } = await seedGift(db, userId, campaignId, templateId, { status: 'deleted' })
    const r = await handleGifts(
      sessionReq(rawToken, `/api/gifts/${publicId}`, 'DELETE'),
      giftsEnv(db),
    )
    expect(r.status).toBe(404)
  })

  it('unauthenticated DELETE → 401', async () => {
    const { publicId } = await seedGift(db, userId, campaignId, templateId)
    const r = await handleGifts(
      anonReq(`/api/gifts/${publicId}`, 'DELETE'),
      giftsEnv(db),
    )
    expect(r.status).toBe(401)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Fix Group 8a — new tests for items 5 and 6
// ═════════════════════════════════════════════════════════════════════════════

// ── Item 5: concurrent creates cannot exceed gifts_per_user ───────────────────
//
// The old code uses SELECT-then-INSERT which allows parallel POSTs to race past the
// per-user limit. The fix: single INSERT ... SELECT ... WHERE with diagnosis on 0 changes.

describe('POST /api/campaigns/<slug>/gifts — concurrent create cannot exceed gifts_per_user (item 5)', () => {
  it('4 concurrent POSTs with gifts_per_user = 3: at most 3 succeed, never more', async () => {
    // Reset any mock
    vi.mocked(newToken)
      .mockReturnValueOnce('concurrgift000001')
      .mockReturnValueOnce('concurrgift000002')
      .mockReturnValueOnce('concurrgift000003')
      .mockReturnValueOnce('concurrgift000004')

    // Two DB bindings on the same SQLite connection
    const { db: db1, sqlite: shared } = testDb()
    createNewTables(shared)
    createGiftTables(shared)
    const { db: db2 } = testDb({ shareWith: shared })

    const campId = await seedGiftCampaign(db1, { id: 10, slug: 'noel-race-create', settings: { gifts_per_user: 3 } })
    const tmplId = await seedTemplate(db1, campId)
    const uid = await seedUser(db1, { sub: 'concurrent-creator', email: 'conc-create@gmail.com' })
    const tok = makeRawToken()
    await seedSession(db1, uid, tok)

    const env1 = giftsEnv(db1)
    const env2 = giftsEnv(db2)
    const body = {
      boxStyle: 1, ornamentStyle: 1, layout: 'doc-giua',
      backgroundTemplateId: tmplId,
      font: 'patrick-hand', ink: '#1d3fa6',
      message: 'Race test', nickname: 'Racer', className: '11A',
    }

    // Fire 4 concurrent create requests — only 3 can succeed (gifts_per_user = 3)
    const results = await Promise.all([
      handleGifts(sessionReq(tok, '/api/campaigns/noel-race-create/gifts', 'POST', body), env1),
      handleGifts(sessionReq(tok, '/api/campaigns/noel-race-create/gifts', 'POST', body), env1),
      handleGifts(sessionReq(tok, '/api/campaigns/noel-race-create/gifts', 'POST', body), env2),
      handleGifts(sessionReq(tok, '/api/campaigns/noel-race-create/gifts', 'POST', body), env2),
    ])

    const successes = results.filter((r) => r.status === 201).length
    expect(successes).toBeLessThanOrEqual(3)

    // Verify DB count matches — never more than gifts_per_user non-deleted gifts
    const count = (shared
      .prepare("SELECT COUNT(*) AS c FROM gift WHERE user_id = ? AND status != 'deleted'")
      .get(uid) as { c: number }).c
    expect(count).toBeLessThanOrEqual(3)
  })
})

// ── Item 6: owner delete — USER_WRITE_LIMIT and campaign_closed ────────────────

describe('DELETE /api/gifts/<publicId> — USER_WRITE_LIMIT (item 6)', () => {
  it('USER_WRITE_LIMIT exhausted → 429 rate_limited', async () => {
    const { publicId } = await seedGift(db, userId, campaignId, templateId)
    const r = await handleGifts(
      sessionReq(rawToken, `/api/gifts/${publicId}`, 'DELETE'),
      giftsEnv(db, { userWriteLimitFail: true }),
    )
    expect(r.status).toBe(429)
    expect((await r.json() as { error: string }).error).toBe('rate_limited')
  })
})

describe('DELETE /api/gifts/<publicId> — refused after campaign ends (item 6)', () => {
  it('delete after campaign ends → 409 campaign_closed (frozen leaderboard, FR-28)', async () => {
    // Seed a campaign that is "closed" (ended)
    await seedGiftCampaign(db, {
      id: 11,
      slug: 'noel-ended-del',
      status: 'closed',
      startsAt: '2020-01-01T00:00:00Z',
      endsAt: '2020-12-31T23:59:59Z',
    })
    const tmpl = await seedTemplate(db, 11)
    const { publicId } = await seedGift(db, userId, 11, tmpl, { publicId: 'closeddel12345678' })
    const r = await handleGifts(
      sessionReq(rawToken, `/api/gifts/${publicId}`, 'DELETE'),
      giftsEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_closed')
  })

  it('delete while campaign is active → 200 ok (normal case unaffected)', async () => {
    const { publicId } = await seedGift(db, userId, campaignId, templateId)
    const r = await handleGifts(
      sessionReq(rawToken, `/api/gifts/${publicId}`, 'DELETE'),
      giftsEnv(db),
    )
    expect(r.status).toBe(200)
  })
})

// ── Item 7: shared/gift.ts used by worker (NFC + trim + code-point lengths) ───
//
// The existing message/nickname/className checks in gifts.ts used UTF-16 .length.
// Now they must call validateGiftText from shared/gift.ts.

describe('POST /api/campaigns/<slug>/gifts — text rule uses shared/gift.ts (item 7)', () => {
  it('whitespace-only message → 400 (rejected after NFC + trim)', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        message: '   ',
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('whitespace-only nickname → 400 (rejected after NFC + trim)', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        nickname: '   ',  // only spaces — current code accepts (not control chars); fix trims → empty
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('300 emoji chars in message (600 UTF-16 units, 300 code points) → 201 (code-point counting)', async () => {
    vi.mocked(newToken).mockReturnValue('codepointtest123')
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        message: '🎄'.repeat(300),
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(201)
  })

  it('301 emoji chars in message → 400 (exceeds MAX_GIFT_MESSAGE by 1 code point)', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        message: '🎄'.repeat(301),
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Cycle-2 fix: non-string gift fields → 400, never 500
// Review finding [worker/gifts.ts:166]: null/number/object values for
// className, nickname, message must return 400 bad_request, not TypeError 500.
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/campaigns/<slug>/gifts — non-string text fields → 400 bad_request (cycle-2)', () => {
  it('className: null → 400 bad_request (not TypeError 500)', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        className: null,
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('className: 123 → 400 bad_request (not TypeError 500)', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        className: 123,
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('nickname: 5 → 400 bad_request (not TypeError 500)', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        nickname: 5,
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('message: null → 400 bad_request (not TypeError 500)', async () => {
    const r = await handleGifts(
      sessionReq(rawToken, '/api/campaigns/noel-2026/gifts', 'POST', {
        ...validGiftBody(templateId),
        message: null,
      }),
      giftsEnv(db),
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })
})
