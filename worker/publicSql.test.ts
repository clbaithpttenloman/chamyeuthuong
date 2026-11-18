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

describe('fetchTemplateImages — skips unknown slots', () => {
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

  it('skips slots not in SLOTS (photo)', async () => {
    // fetchTemplateImages filters results to only known SLOTS.
    // We simulate an old local DB without the slot CHECK constraint.
    const { db } = testDb({ schema: false })
    const now = new Date().toISOString()
    // Create tables without the photo-rejecting CHECK so we can seed a photo row
    await db.prepare(`CREATE TABLE IF NOT EXISTS image (id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL)`).run()
    await db.prepare(`CREATE TABLE IF NOT EXISTS template (id INTEGER PRIMARY KEY, name TEXT NOT NULL, layout TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, created_by TEXT NOT NULL)`).run()
    // No slot CHECK — simulates old local DB
    await db.prepare(`CREATE TABLE IF NOT EXISTS template_image (template_id INTEGER NOT NULL, slot TEXT NOT NULL, image_id INTEGER NOT NULL, PRIMARY KEY (template_id, slot))`).run()

    await db.prepare("INSERT INTO template (name,layout,active,created_at,created_by) VALUES ('T','classic',1,?,?)").bind(now, TEST_EMAIL).run()
    const tmplId = (await db.prepare('SELECT id FROM template WHERE name=?').bind('T').first<{ id: number }>())!.id
    await db.prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('imgph1234567890a','ph.jpg','image/jpeg',100,'d',?,?)").bind(now, TEST_EMAIL).run()
    const phId = (await db.prepare('SELECT id FROM image WHERE token=?').bind('imgph1234567890a').first<{ id: number }>())!.id
    // Insert photo slot row — allowed in this no-CHECK DB, simulates old local DB
    await db.prepare(`INSERT INTO template_image (template_id, slot, image_id) VALUES (?, 'photo', ?)`).bind(tmplId, phId).run()
    // fetchTemplateImages must skip the 'photo' slot (not in SLOTS)
    const result = await fetchTemplateImages(db, [tmplId])
    const slotMap = result.get(tmplId) ?? {}
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
