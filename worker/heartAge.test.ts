// @vitest-environment node
/**
 * Heart waiting period (ADR-9, FR-41): an account younger than heart_min_account_age_hours
 * (default 24) gets 403 account_too_new when it tries to give a heart. Diagnosis runs after
 * banned and before own_gift.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { handleGifts } from './gifts.ts'
import { testDb, type D1 } from './testDb.ts'
import { createNewTables, seedUser, seedSession, makeRawToken } from './testGoogle.ts'
import {
  createGiftTables,
  giftsEnv,
  seedGiftCampaign,
  seedGift,
  seedTemplate,
  sessionReq,
} from './testGift.ts'

let db: D1
let sqlite: ReturnType<typeof testDb>['sqlite']

beforeEach(() => {
  ;({ db, sqlite } = testDb())
  createNewTables(sqlite)
  createGiftTables(sqlite)
})

async function heartAs(userId: number, publicId: string) {
  const token = makeRawToken()
  await seedSession(db, userId, token)
  return handleGifts(sessionReq(token, `/api/gifts/${publicId}/heart`, 'POST'), giftsEnv(db))
}

describe('heart waiting period', () => {
  it('default 24 h: an account created now → 403 account_too_new', async () => {
    const campaignId = await seedGiftCampaign(db, { slug: 'noel-age-a', settings: { hearts_per_day: 5 } })
    const templateId = await seedTemplate(db, campaignId)
    const ownerId = await seedUser(db, { sub: 'age-owner-1', email: 'o1@gmail.com' })
    const gifterId = await seedUser(db, { sub: 'age-gifter-1', email: 'g1@gmail.com' })
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await heartAs(gifterId, publicId)
    expect(r.status).toBe(403)
    expect((await r.json() as { error: string }).error).toBe('account_too_new')
  })

  it('default 24 h: an account created 25 h ago can give a heart', async () => {
    const campaignId = await seedGiftCampaign(db, { slug: 'noel-age-b', settings: { hearts_per_day: 5 } })
    const templateId = await seedTemplate(db, campaignId)
    const ownerId = await seedUser(db, { sub: 'age-owner-2', email: 'o2@gmail.com' })
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString()
    const gifterId = await seedUser(db, { sub: 'age-gifter-2', email: 'g2@gmail.com', createdAt: old })
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await heartAs(gifterId, publicId)
    expect(r.status).toBe(200)
  })

  it('setting 0 h: a new account can give a heart at once', async () => {
    const campaignId = await seedGiftCampaign(db, { slug: 'noel-age-c', settings: { hearts_per_day: 5, heart_min_account_age_hours: 0 } })
    const templateId = await seedTemplate(db, campaignId)
    const ownerId = await seedUser(db, { sub: 'age-owner-3', email: 'o3@gmail.com' })
    const gifterId = await seedUser(db, { sub: 'age-gifter-3', email: 'g3@gmail.com' })
    const { publicId } = await seedGift(db, ownerId, campaignId, templateId)
    const r = await heartAs(gifterId, publicId)
    expect(r.status).toBe(200)
  })
})
