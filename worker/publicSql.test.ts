// @vitest-environment node
/**
 * Tests for worker/publicSql.ts helpers.
 */
import { describe, it, expect } from 'vitest'
import { fetchTemplateImages, cardWhere, teacherWhere, toPublicCard } from './publicSql.ts'
import { testDb } from './testDb.ts'
import { TEST_EMAIL } from './testAuth.ts'

// ---- cardWhere / teacherWhere ----

describe('cardWhere', () => {
  it('returns approved status fragment for given alias', () => {
    expect(cardWhere('sc')).toBe("sc.status = 'approved'")
    expect(cardWhere('sc2')).toBe("sc2.status = 'approved'")
  })
})

describe('teacherWhere', () => {
  it('returns show_on_home=1 fragment for given alias', () => {
    expect(teacherWhere('tp')).toBe('tp.show_on_home = 1')
  })
})

// ---- fetchTemplateImages — unknown slots skipped ----

describe('fetchTemplateImages — skips unknown slots (failing until Group 2)', () => {
  it('returns empty map for empty templateIds', async () => {
    const { db } = testDb()
    const result = await fetchTemplateImages(db, [])
    expect(result.size).toBe(0)
  })

  it('returns slot→token map for known slots (background, banner)', async () => {
    const { db, sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    // Create template + images
    const now = new Date().toISOString()
    sqlite.prepare("INSERT INTO template (name,layout,active,created_at,created_by) VALUES ('T','classic',1,?,?)").run(now, TEST_EMAIL)
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    sqlite.prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('imgbg1234567890a','bg.jpg','image/jpeg',100,'d',?,?)").run(now, TEST_EMAIL)
    const bgId = (sqlite.prepare('SELECT id FROM image WHERE token=?').get('imgbg1234567890a') as { id: number }).id
    sqlite.prepare(`INSERT INTO template_image (template_id, slot, image_id) VALUES (${tmplId}, 'background', ${bgId})`).run()
    const result = await fetchTemplateImages(db, [tmplId])
    expect(result.has(tmplId)).toBe(true)
    expect(result.get(tmplId)!['background']).toBe('imgbg1234567890a')
  })

  it('skips slots not in SLOTS (photo) — FAILS until Group 2 makes fetchTemplateImages filter slots', async () => {
    // After Group 2: fetchTemplateImages filters results to only known SLOTS.
    // Before Group 2: photo rows pass through unchanged.
    // This test inserts a "photo" slot row (bypassing API validation at the DB level)
    // and checks the returned map does NOT include it.
    const { db, sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    const now = new Date().toISOString()
    sqlite.prepare("INSERT INTO template (name,layout,active,created_at,created_by) VALUES ('T','classic',1,?,?)").run(now, TEST_EMAIL)
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    sqlite.prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('imgph1234567890a','ph.jpg','image/jpeg',100,'d',?,?)").run(now, TEST_EMAIL)
    const phId = (sqlite.prepare('SELECT id FROM image WHERE token=?').get('imgph1234567890a') as { id: number }).id
    // Directly insert a "photo" slot row (bypassing the CHECK constraint by using raw SQLite)
    // This simulates old local DBs that have photo slot rows.
    sqlite.prepare(`INSERT INTO template_image (template_id, slot, image_id) VALUES (${tmplId}, 'photo', ${phId})`).run()
    // fetchTemplateImages should skip the unknown 'photo' slot
    const result = await fetchTemplateImages(db, [tmplId])
    const slotMap = result.get(tmplId) ?? {}
    // After Group 2: 'photo' should not appear. Before Group 2: it appears → FAIL.
    expect(Object.keys(slotMap)).not.toContain('photo')
  })
})

// ---- toPublicCard ----

describe('toPublicCard', () => {
  it('maps a card row to the public shape', () => {
    const row = {
      public_id: 'crd1234567890abc',
      layout: 'classic',
      message: 'Chúc mừng!',
      from_name: 'Nguyễn Văn A',
      from_class: '12A1',
      anonymous: 0 as number,
      created_at: '2024-01-01T00:00:00.000Z',
      template_id: 1,
    }
    const card = toPublicCard(row, { background: 'imgbg1234567890a' })
    expect(card.publicId).toBe('crd1234567890abc')
    expect(card.layout).toBe('classic')
    expect(card.images).toEqual({ background: 'imgbg1234567890a' })
    expect(card.message).toBe('Chúc mừng!')
    expect(card.from).toBe('Nguyễn Văn A · 12A1')
    expect(card.createdAt).toBe('2024-01-01T00:00:00.000Z')
  })

  it('formats anonymous=1 as "Một bạn học sinh"', () => {
    const row = {
      public_id: 'crd1234567890abc',
      layout: 'classic',
      message: 'msg',
      from_name: 'Ignored',
      from_class: '',
      anonymous: 1 as number,
      created_at: '2024-01-01T00:00:00.000Z',
      template_id: 1,
    }
    const card = toPublicCard(row, {})
    expect(card.from).toBe('Một bạn học sinh')
  })
})
