// @vitest-environment node
// Tests for worker/schema.ts
import { describe, it, expect, vi } from 'vitest'
import { SCHEMA, UPGRADE_SQL, SEED_STATEMENT_COUNT, ensureSchema } from './schema.ts'
import { SEED_IMAGES } from './seedImages.ts'
import { checkDimensions, magicOk } from './images.ts'
import { LAYOUTS } from '../shared/layouts.ts'
import { ROLES } from '../shared/api.ts'
import { SEEDS } from './seed.ts'
import { testDb } from './testDb.ts'
import type { D1Stmt } from './types.ts'

// Statements a fresh (unseeded) database prepares on its first ensureSchema: the SCHEMA batch,
// one column probe per upgradable table (teacher_profile, student_card), the seed-flag probe,
// and the seed batch.
const FRESH_COLD_START = SCHEMA.length + 3 + SEED_STATEMENT_COUNT

// ---- SCHEMA shape ----

describe('SCHEMA shape', () => {
  it('is a non-empty string array', () => {
    expect(Array.isArray(SCHEMA)).toBe(true)
    expect(SCHEMA.length).toBeGreaterThan(0)
    for (const s of SCHEMA) expect(typeof s).toBe('string')
  })

  it('every entry is idempotent DDL (CREATE TABLE/INDEX IF NOT EXISTS) or a seed INSERT', () => {
    for (const s of SCHEMA) {
      expect(s.trim().toUpperCase()).toMatch(/^(CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|INSERT)\s/)
    }
  })

  it('covers teacher and admin tables', () => {
    const names = SCHEMA.map((s) => {
      const m = s.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i)
      return m?.[1]?.toLowerCase() ?? ''
    })
    expect(names).toContain('teacher')
    expect(names).toContain('admin')
  })
})

// ---- ensureSchema — creation ----

describe('ensureSchema — creation', () => {
  it('creates teacher and admin tables on a fresh empty DB', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = rows.map((r) => r.name)
    expect(names).toContain('admin')
    expect(names).toContain('teacher')
  })

  it('counts DDL statements in state.ddl only (not state.prepares)', async () => {
    const { db, state } = testDb({ schema: false })
    await ensureSchema(db)
    expect(state.ddl).toBe(FRESH_COLD_START)
    expect(state.prepares).toBe(0)
  })
})

// ---- ensureSchema — idempotency ----

describe('ensureSchema — idempotency', () => {
  it('second call on the same db object returns the cached promise (no new DDL)', async () => {
    const { db, state } = testDb({ schema: false })
    const p1 = ensureSchema(db)
    const p2 = ensureSchema(db)
    expect(p1).toBe(p2) // same promise — cache hit
    await p1
    expect(state.ddl).toBe(FRESH_COLD_START)
  })

  it('awaiting twice on the same db issues no extra DDL', async () => {
    const { db, state } = testDb({ schema: false })
    await ensureSchema(db)
    const ddlAfterFirst = state.ddl
    await ensureSchema(db)
    expect(state.ddl).toBe(ddlAfterFirst) // no new DDL
  })

  it('pre-seeded rows survive a second ensureSchema call (IF NOT EXISTS is a no-op)', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare(
        "INSERT INTO teacher (token, name, subject, created_at) VALUES ('tok1234567890abc', 'T', 'S', datetime('now'))",
      )
      .run()
    const before = (
      sqlite.prepare('SELECT COUNT(*) as c FROM teacher').get() as { c: number }
    ).c
    await ensureSchema(db) // cached promise — no-op
    const after = (
      sqlite.prepare('SELECT COUNT(*) as c FROM teacher').get() as { c: number }
    ).c
    expect(after).toBe(before)
  })

  it('re-running every SCHEMA statement on a populated DB leaves rows intact (real DDL idempotency)', async () => {
    const { sqlite } = testDb({ schema: false })
    for (const sql of SCHEMA) sqlite.exec(sql)
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare(
        "INSERT INTO teacher (token, name, subject, created_at) VALUES ('tok1234567890abc', 'T', 'S', datetime('now'))",
      )
      .run()
    // Re-run every SCHEMA statement — IF NOT EXISTS → no structural change
    for (const sql of SCHEMA) sqlite.exec(sql)
    const count = (
      sqlite.prepare('SELECT COUNT(*) as c FROM teacher').get() as { c: number }
    ).c
    expect(count).toBe(1)
  })
})

// ---- ensureSchema — concurrency ----

describe('ensureSchema — concurrency', () => {
  it('concurrent calls share one promise and issue exactly one batch of DDL', async () => {
    const { db, state } = testDb({ schema: false })
    const [r1, r2, r3] = await Promise.all([
      ensureSchema(db),
      ensureSchema(db),
      ensureSchema(db),
    ])
    expect(r1).toBeUndefined()
    expect(r2).toBeUndefined()
    expect(r3).toBeUndefined()
    expect(state.ddl).toBe(FRESH_COLD_START)
  })
})

// ---- ensureSchema — failure and retry ----

describe('ensureSchema — failure and retry', () => {
  it('a failing batch rejects the returned promise', async () => {
    const { db, state } = testDb({ schema: false })
    state.fail = true
    await expect(ensureSchema(db)).rejects.toThrow()
  })

  it('cache is evicted on rejection so the next call retries and succeeds', async () => {
    const { db, state } = testDb({ schema: false })
    state.fail = true
    const p1 = ensureSchema(db)
    await expect(p1).rejects.toThrow()
    state.fail = false
    const p2 = ensureSchema(db)
    expect(p2).not.toBe(p1)
    await expect(p2).resolves.toBeUndefined()
  })
})

// ---- ensureSchema — batch rollback ----

describe('ensureSchema — batch rollback', () => {
  it('batch rejected before BEGIN (state.fail fires before sqlite BEGIN) leaves no tables', async () => {
    const { db, state, sqlite } = testDb({ schema: false })
    state.fail = true
    await expect(ensureSchema(db)).rejects.toThrow()
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    expect(tables).toHaveLength(0)
  })

  it('mid-batch failure leaves zero tables (transaction atomicity: ROLLBACK undoes partial DDL)', async () => {
    const { sqlite } = testDb({ schema: false })
    let runCount = 0
    const makeStmt = (sql: string): D1Stmt => ({
      bind: (..._v: unknown[]) => makeStmt(sql),
      run: async (): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }> => {
        runCount++
        if (runCount === 2) throw new Error('D1_ERROR: mid-batch')
        sqlite.prepare(sql).run()
        return { success: true, meta: { changes: 1, last_row_id: 0 } }
      },
      first: async <T>() => null as T | null,
      all: async <T>() => ({ results: [] as T[] }),
    })
    const db = {
      prepare: makeStmt,
      batch: async (statements: D1Stmt[]): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }[]> => {
        sqlite.exec('BEGIN')
        try {
          const out: { success: boolean; meta: { changes: number; last_row_id: number } }[] = []
          for (const s of statements) out.push(await s.run())
          sqlite.exec('COMMIT')
          return out
        } catch (e) {
          sqlite.exec('ROLLBACK')
          throw e
        }
      },
    }
    await expect(ensureSchema(db)).rejects.toThrow()
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    expect(tables).toHaveLength(0)
  })
})

// ---- SCHEMA parity — table structure ----

describe('SCHEMA parity — table structure', () => {
  it('admin CHECK rejects an email with uppercase characters', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO admin (email, created_at, created_by) VALUES ('Bad@Example.com', datetime('now'), 'test')",
        )
        .run()
    }).toThrow()
  })

  it('admin CHECK rejects an email longer than 254 characters', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const longEmail = 'a'.repeat(247) + '@example.com'
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO admin (email, created_at, created_by) VALUES ('${longEmail}', datetime('now'), 'test')`,
        )
        .run()
    }).toThrow()
  })

  it('admin CHECK accepts a valid lowercase email ≤ 254 chars', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO admin (email, created_at, created_by) VALUES ('admin@example.com', datetime('now'), 'test')",
        )
        .run()
    }).not.toThrow()
  })
})

// ---- image table: CHECK constraints ----

describe('image table CHECK constraints', () => {
  it('mime CHECK accepts image/jpeg', async () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('imgabc1234567890','test.jpg','image/jpeg',100,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).not.toThrow()
  })

  it('mime CHECK rejects image/gif', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890abc','t.gif','image/gif',100,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).toThrow()
  })

  it('mime CHECK rejects image/svg+xml', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890abc','t.svg','image/svg+xml',100,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).toThrow()
  })

  it('mime CHECK accepts image/png', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890abc','t.png','image/png',100,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).not.toThrow()
  })

  it('mime CHECK accepts image/webp', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890abc','t.webp','image/webp',100,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).not.toThrow()
  })

  it('size CHECK rejects size = 0', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890abc','t.png','image/png',0,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).toThrow()
  })

  it('size CHECK rejects size > 307200', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890abc','t.png','image/png',307201,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).toThrow()
  })

  it('size CHECK accepts size = 1', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890abc','t.png','image/png',1,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).not.toThrow()
  })

  it('size CHECK accepts size = 307200', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890abc','t.webp','image/webp',307200,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).not.toThrow()
  })
})

// ---- Seeds: 12 wishes inserted once ----

describe('SCHEMA seeds — 12 example wishes', () => {
  it('ensureSchema inserts 12 wishes on a fresh DB', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const count = (sqlite.prepare('SELECT COUNT(*) as c FROM wish').get() as { c: number }).c
    expect(count).toBe(12)
  })

  it('wishes have non-empty title and body', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const rows = sqlite.prepare('SELECT title, body FROM wish').all() as Array<{ title: string; body: string }>
    for (const r of rows) {
      expect(r.title.length).toBeGreaterThan(0)
      expect(r.body.length).toBeGreaterThan(0)
    }
  })

  it('meta(wishes_seeded) flag is set after ensureSchema', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const row = sqlite.prepare("SELECT value FROM meta WHERE key='wishes_seeded'").get() as { value: string } | undefined
    expect(row?.value).toBe('1')
  })

  it('seeds never re-inserted after deleting wishes and running raw SCHEMA batch again', async () => {
    const { sqlite } = testDb({ schema: false })
    for (const sql of SCHEMA) sqlite.exec(sql)
    sqlite.exec('DELETE FROM wish')
    expect((sqlite.prepare('SELECT COUNT(*) as c FROM wish').get() as { c: number }).c).toBe(0)
    for (const sql of SCHEMA) sqlite.exec(sql)
    expect((sqlite.prepare('SELECT COUNT(*) as c FROM wish').get() as { c: number }).c).toBe(0)
  })

  it('seeds are counted as DDL by testDb state.ddl', async () => {
    const { db, state } = testDb({ schema: false })
    await ensureSchema(db)
    expect(state.ddl).toBe(FRESH_COLD_START)
    expect(state.prepares).toBe(0)
  })
})

// ===================================================================
// New for honorific plan: teacher_title table
// ===================================================================

describe('teacher_title table exists', () => {
  it('ensureSchema creates teacher_title table on a fresh DB', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(rows.map((r) => r.name)).toContain('teacher_title')
  })

  it('SCHEMA covers teacher_title', () => {
    const names = SCHEMA.map((s) => {
      const m = s.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i)
      return m?.[1]?.toLowerCase() ?? ''
    })
    expect(names).toContain('teacher_title')
  })
})

describe('teacher_title CHECK and FK constraints', () => {
  it('title CHECK accepts Thầy', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')")
      .run()
    const tid = (
      sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }
    ).id
    expect(() => {
      sqlite.prepare(`INSERT INTO teacher_title (teacher_id, title) VALUES (${tid}, 'Thầy')`).run()
    }).not.toThrow()
  })

  it('title CHECK accepts Cô', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')")
      .run()
    const tid = (
      sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }
    ).id
    expect(() => {
      sqlite.prepare(`INSERT INTO teacher_title (teacher_id, title) VALUES (${tid}, 'Cô')`).run()
    }).not.toThrow()
  })

  it('title CHECK rejects lowercase thầy', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')")
      .run()
    const tid = (
      sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }
    ).id
    expect(() => {
      sqlite.prepare(`INSERT INTO teacher_title (teacher_id, title) VALUES (${tid}, 'thầy')`).run()
    }).toThrow()
  })

  it('title CHECK rejects empty string', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')")
      .run()
    const tid = (
      sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }
    ).id
    expect(() => {
      sqlite.prepare(`INSERT INTO teacher_title (teacher_id, title) VALUES (${tid}, '')`).run()
    }).toThrow()
  })

  it('deleting a teacher cascades to teacher_title row', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')")
      .run()
    const tid = (
      sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }
    ).id
    sqlite.prepare(`INSERT INTO teacher_title (teacher_id, title) VALUES (${tid}, 'Thầy')`).run()
    sqlite.prepare(`DELETE FROM teacher WHERE id=${tid}`).run()
    const row = sqlite.prepare(`SELECT * FROM teacher_title WHERE teacher_id=${tid}`).get()
    expect(row).toBeUndefined()
  })
})

// ===================================================================
// Seeds — no hard-coded thầy/cô before name placeholder
// ===================================================================

describe('Seeds — no hard-coded thầy/cô before name placeholder', () => {
  it('no seed SQL contains "thầy {tên}" (lowercase thầy hard-coded before name)', () => {
    for (const sql of SEEDS) {
      expect(sql, sql.slice(0, 80)).not.toContain('thầy {tên}')
    }
  })

  it('no seed SQL contains "cô {tên}" (lowercase cô hard-coded before name)', () => {
    for (const sql of SEEDS) {
      expect(sql, sql.slice(0, 80)).not.toContain('cô {tên}')
    }
  })

  it('every seed that uses {tên} also uses {Thầy/Cô} or {thầy/cô}', () => {
    for (const sql of SEEDS) {
      if (sql.includes('{tên}')) {
        const hasTitle = sql.includes('{Thầy/Cô}') || sql.includes('{thầy/cô}')
        expect(hasTitle, `seed missing title placeholder: ${sql.slice(0, 80)}`).toBe(true)
      }
    }
  })
})

// ===================================================================
// testDb — 100-parameter guard (passes immediately, guard already in testDb.ts)
// ===================================================================

describe('testDb — 100-parameter guard', () => {
  it('binding exactly 100 params does not throw', () => {
    const { db } = testDb()
    const params = Array.from({ length: 100 }, () => '?').join(', ')
    expect(() => {
      db.prepare(`SELECT ${params}`).bind(...Array.from({ length: 100 }, (_, i) => i))
    }).not.toThrow()
  })

  it('binding 101 params throws "too many SQL variables"', () => {
    const { db } = testDb()
    const params = Array.from({ length: 101 }, () => '?').join(', ')
    expect(() => {
      db.prepare(`SELECT ${params}`).bind(...Array.from({ length: 101 }, (_, i) => i))
    }).toThrow('too many SQL variables')
  })

  it('binding 200 params throws "too many SQL variables"', () => {
    const { db } = testDb()
    const params = Array.from({ length: 200 }, () => '?').join(', ')
    expect(() => {
      db.prepare(`SELECT ${params}`).bind(...Array.from({ length: 200 }, (_, i) => i))
    }).toThrow('too many SQL variables')
  })
})

// ===================================================================
// ===================================================================

describe('SCHEMA covers new tables', () => {
  it('covers teacher_profile, template, template_image, student_card, image, wish, meta', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = rows.map((r) => r.name)
    expect(names).toContain('teacher_profile')
    expect(names).toContain('template')
    expect(names).toContain('template_image')
    expect(names).toContain('student_card')
    expect(names).toContain('image')
    expect(names).toContain('wish')
    expect(names).toContain('meta')
  })

  it('card, card_style, card_image are NOT in SCHEMA (removed tables)', () => {
    const names = SCHEMA.map((s) => {
      const m = s.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i)
      return m?.[1]?.toLowerCase() ?? ''
    })
    expect(names).not.toContain('card')
    expect(names).not.toContain('card_style')
    expect(names).not.toContain('card_image')
  })
})

describe('teacher_profile table constraints', () => {
  it('ensureSchema creates teacher_profile on a fresh DB', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const names = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name)
    expect(names).toContain('teacher_profile')
  })

  it('show_on_home CHECK accepts 0 and 1', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')").run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }).id
    expect(() => {
      sqlite.prepare(`INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (${tid}, '', 1)`).run()
    }).not.toThrow()
  })

  it('show_on_home CHECK rejects 2', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')").run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }).id
    expect(() => {
      sqlite.prepare(`INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (${tid}, '', 2)`).run()
    }).toThrow()
  })

  it('deleting a teacher cascades to teacher_profile row', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')").run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }).id
    sqlite.prepare(`INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (${tid}, '', 1)`).run()
    sqlite.prepare(`DELETE FROM teacher WHERE id=${tid}`).run()
    const row = sqlite.prepare(`SELECT * FROM teacher_profile WHERE teacher_id=${tid}`).get()
    expect(row).toBeUndefined()
  })
})

describe('template table constraints', () => {
  it('ensureSchema creates template on a fresh DB', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const names = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name)
    expect(names).toContain('template')
  })

  it('active CHECK accepts 0 and 1', () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    }).not.toThrow()
    expect(() => {
      sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T2','classic',0,'2024-01-01','a@b.com')").run()
    }).not.toThrow()
  })

  it('active CHECK rejects 2', () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',2,'2024-01-01','a@b.com')").run()
    }).toThrow()
  })
})

describe('template_image table constraints', () => {
  it('ensureSchema creates template_image on a fresh DB', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const names = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name)
    expect(names).toContain('template_image')
  })

  it('slot CHECK accepts background and rejects banner (card v3)', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    for (const slot of ['background', 'banner']) {
      const imgTok = `img${slot.slice(0,3)}12345678901`
      sqlite.prepare(`INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('${imgTok}','x.jpg','image/jpeg',100,'d','2024-01-01','a@b.com')`).run()
      const imgId = (sqlite.prepare('SELECT id FROM image WHERE token=?').get(imgTok) as { id: number }).id
      const insert = () => sqlite.prepare(`INSERT INTO template_image (template_id, slot, image_id) VALUES (${tmplId}, '${slot}', ${imgId})`).run()
      if (slot === 'background') expect(insert).not.toThrow()
      else expect(insert).toThrow(/CHECK/)
    }
  })

  it('slot CHECK rejects unknown slot', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    sqlite.prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('imgabc1234567890','x.jpg','image/jpeg',100,'d','2024-01-01','a@b.com')").run()
    const imgId = (sqlite.prepare('SELECT id FROM image WHERE token=?').get('imgabc1234567890') as { id: number }).id
    expect(() => {
      sqlite.prepare(`INSERT INTO template_image (template_id, slot, image_id) VALUES (${tmplId}, 'unknown', ${imgId})`).run()
    }).toThrow()
  })

  it('template_image.image_id ON DELETE RESTRICT prevents deleting an image in use', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    sqlite.prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('imgabc1234567890','x.jpg','image/jpeg',100,'d','2024-01-01','a@b.com')").run()
    const imgId = (sqlite.prepare('SELECT id FROM image WHERE token=?').get('imgabc1234567890') as { id: number }).id
    sqlite.prepare(`INSERT INTO template_image (template_id, slot, image_id) VALUES (${tmplId}, 'background', ${imgId})`).run()
    expect(() => {
      sqlite.prepare(`DELETE FROM image WHERE id=${imgId}`).run()
    }).toThrow()
  })

  it('deleting a template cascades to template_image rows', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    sqlite.prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('imgabc1234567890','x.jpg','image/jpeg',100,'d','2024-01-01','a@b.com')").run()
    const imgId = (sqlite.prepare('SELECT id FROM image WHERE token=?').get('imgabc1234567890') as { id: number }).id
    sqlite.prepare(`INSERT INTO template_image (template_id, slot, image_id) VALUES (${tmplId}, 'background', ${imgId})`).run()
    sqlite.prepare(`DELETE FROM template WHERE id=${tmplId}`).run()
    const rows = sqlite.prepare(`SELECT * FROM template_image WHERE template_id=${tmplId}`).all()
    expect(rows).toHaveLength(0)
  })
})

describe('student_card table constraints', () => {
  it('ensureSchema creates student_card on a fresh DB', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const names = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name)
    expect(names).toContain('student_card')
  })

  it('status CHECK accepts pending, approved, hidden', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')").run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }).id
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    for (const status of ['pending', 'approved', 'hidden']) {
      const pid = `pub${status.slice(0,3)}123456789`
      expect(() => {
        sqlite.prepare(`INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES ('${pid}',${tid},${tmplId},'msg','','',0,'${status}','2024-01-01')`).run()
      }).not.toThrow()
    }
  })

  it('status CHECK rejects unknown status', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')").run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }).id
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    expect(() => {
      sqlite.prepare(`INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES ('pub1234567890abc',${tid},${tmplId},'msg','','',0,'published','2024-01-01')`).run()
    }).toThrow()
  })

  it('message length CHECK rejects length 0', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')").run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }).id
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    expect(() => {
      sqlite.prepare(`INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES ('pub1234567890abc',${tid},${tmplId},'','','',0,'pending','2024-01-01')`).run()
    }).toThrow()
  })

  it('anonymous CHECK rejects value 2', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')").run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }).id
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    expect(() => {
      sqlite.prepare(`INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES ('pub1234567890abc',${tid},${tmplId},'msg','','',2,'pending','2024-01-01')`).run()
    }).toThrow()
  })

  it('template FK ON DELETE RESTRICT — cannot delete template with cards', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')").run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }).id
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    sqlite.prepare(`INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES ('pub1234567890abc',${tid},${tmplId},'msg','','',0,'pending','2024-01-01')`).run()
    expect(() => {
      sqlite.prepare(`DELETE FROM template WHERE id=${tmplId}`).run()
    }).toThrow()
  })

  it('teacher FK ON DELETE CASCADE — deleting teacher cascades to student_card', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890abc','T','','2024-01-01')").run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890abc') as { id: number }).id
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    sqlite.prepare(`INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES ('pub1234567890abc',${tid},${tmplId},'msg','','',0,'pending','2024-01-01')`).run()
    sqlite.prepare(`DELETE FROM teacher WHERE id=${tid}`).run()
    const rows = sqlite.prepare(`SELECT * FROM student_card WHERE teacher_id=${tid}`).all()
    expect(rows).toHaveLength(0)
  })

  it('indexes exist on student_card for (teacher_id, status) and (status, created_at)', () => {
    const { sqlite } = testDb()
    const indexList = sqlite.prepare('PRAGMA index_list(student_card)').all() as Array<{ name: string; unique: number }>
    // The two planned composite indexes are non-unique (the UNIQUE public_id adds its own autoindex).
    const planned = indexList.filter((r) => !r.name.startsWith('sqlite_autoindex'))
    expect(planned.length).toBeGreaterThanOrEqual(2)
    for (const idx of planned) {
      expect(idx.unique).toBe(0)
    }
    // Verify at least one index covers teacher_id
    const teacherIdx = indexList.find((r) => {
      const cols = (sqlite.prepare(`PRAGMA index_info(${r.name})`).all() as Array<{ name: string }>).map((c) => c.name)
      return cols.includes('teacher_id')
    })
    expect(teacherIdx).toBeDefined()
    // Verify at least one index covers status
    const statusIdx = indexList.find((r) => {
      const cols = (sqlite.prepare(`PRAGMA index_info(${r.name})`).all() as Array<{ name: string }>).map((c) => c.name)
      return cols.includes('status')
    })
    expect(statusIdx).toBeDefined()
  })
})

// ===================================================================
// ===================================================================

describe('template_image slot CHECK — background only on a fresh DB', () => {
  it('slot CHECK rejects photo (removed slot)', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    sqlite.prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('imgabc1234567890','x.jpg','image/jpeg',100,'d','2024-01-01','a@b.com')").run()
    const imgId = (sqlite.prepare('SELECT id FROM image WHERE token=?').get('imgabc1234567890') as { id: number }).id
    expect(() => {
      sqlite.prepare(`INSERT INTO template_image (template_id, slot, image_id) VALUES (${tmplId}, 'photo', ${imgId})`).run()
    }).toThrow()
  })

  it('slot CHECK on a fresh DB: background only (banner removed in card v3)', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    for (const slot of ['background', 'banner']) {
      const imgTok = `img${slot.slice(0, 3)}12345678901`
      sqlite.prepare(`INSERT OR IGNORE INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('${imgTok}','x.jpg','image/jpeg',100,'d','2024-01-01','a@b.com')`).run()
      const imgId = (sqlite.prepare('SELECT id FROM image WHERE token=?').get(imgTok) as { id: number }).id
      const insert = () => sqlite.prepare(`INSERT INTO template_image (template_id, slot, image_id) VALUES (${tmplId}, '${slot}', ${imgId})`).run()
      if (slot === 'background') expect(insert).not.toThrow()
      else expect(insert).toThrow(/CHECK/)
    }
  })
})

describe('teacher_profile — no public_id column', () => {
  it('teacher_profile has no public_id column in DDL', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const cols = (sqlite.prepare("PRAGMA table_info(teacher_profile)").all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).not.toContain('public_id')
  })
})

describe('site_content table', () => {
  it('ensureSchema creates site_content table', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const names = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name)
    expect(names).toContain('site_content')
  })

  it('site_content key CHECK only allows "about"', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    // Should fail for unknown keys
    expect(() => {
      sqlite.prepare("INSERT INTO site_content (key, value, updated_at, updated_by) VALUES ('unknown', '{}', datetime('now'), 'test')").run()
    }).toThrow()
  })

  it('about seed row is present on a fresh DB', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const row = sqlite.prepare("SELECT value FROM site_content WHERE key = 'about'").get() as { value: string } | undefined
    expect(row).toBeDefined()
    // The seed value must be valid JSON
    expect(() => JSON.parse(row!.value)).not.toThrow()
  })

  it('about seed contains member name "Vũ Ngọc Diệp"', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const row = sqlite.prepare("SELECT value FROM site_content WHERE key = 'about'").get() as { value: string } | undefined
    expect(row?.value).toContain('Vũ Ngọc Diệp')
  })

  it('about seed contains member name "Kiro Coding Agent"', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const row = sqlite.prepare("SELECT value FROM site_content WHERE key = 'about'").get() as { value: string } | undefined
    expect(row?.value).toContain('Kiro Coding Agent')
  })

  it('about seed has at least 8 steps', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const row = sqlite.prepare("SELECT value FROM site_content WHERE key = 'about'").get() as { value: string } | undefined
    if (!row) return // fails at the previous test
    const parsed = JSON.parse(row.value) as { steps?: unknown[] }
    expect(Array.isArray(parsed.steps)).toBe(true)
    expect((parsed.steps ?? []).length).toBeGreaterThanOrEqual(8)
  })

  it('about seed INSERT uses OR IGNORE (idempotent)', async () => {
    const { sqlite } = testDb({ schema: false })
    for (const sql of SCHEMA) sqlite.exec(sql)
    // Run every SCHEMA statement twice — the about seed must not fail on the second run
    expect(() => {
      for (const sql of SCHEMA) sqlite.exec(sql)
    }).not.toThrow()
  })
})

// ---- Upgrade: databases created before plan 2026-11-18 (deployed at 4d3a5df) ----

// teacher_profile exactly as deployed at 4d3a5df (public_id UNIQUE NOT NULL)
const OLD_TEACHER_PROFILE = `CREATE TABLE teacher_profile (
  teacher_id   INTEGER PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE,
  public_id    TEXT    UNIQUE NOT NULL,
  department   TEXT    NOT NULL DEFAULT '',
  show_on_home INTEGER NOT NULL DEFAULT 1 CHECK (show_on_home IN (0,1))
)`

function oldDb() {
  const t = testDb()
  t.sqlite.exec('DROP TABLE teacher_profile')
  t.sqlite.exec(OLD_TEACHER_PROFILE)
  t.sqlite.exec(`INSERT INTO teacher (id, token, name, subject, created_at) VALUES (1, 'tok1234567890abc', 'Khoa', 'Toán', '2026-11-17')`)
  t.sqlite.exec(`INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES (1, 'pub1234567890abc', 'Tổ Toán', 0)`)
  return t
}

const cols = (sqlite: ReturnType<typeof testDb>['sqlite']) =>
  (sqlite.prepare("PRAGMA table_info('teacher_profile')").all() as { name: string }[]).map((c) => c.name)

describe('ensureSchema — upgrades teacher_profile from the 4d3a5df shape', () => {
  it('drops public_id so new teachers can be inserted', async () => {
    const { db, sqlite } = oldDb()
    await ensureSchema(db)
    expect(cols(sqlite)).toEqual(['teacher_id', 'department', 'show_on_home', 'role'])
    sqlite.exec(`INSERT INTO teacher (id, token, name, created_at) VALUES (2, 'tok2234567890abc', 'Lan', '2026-11-18')`)
    expect(() => sqlite.exec(`INSERT INTO teacher_profile (teacher_id, department) VALUES (2, '')`)).not.toThrow()
  })

  it('keeps existing department and show_on_home values', async () => {
    const { db, sqlite } = oldDb()
    await ensureSchema(db)
    expect(sqlite.prepare('SELECT teacher_id, department, show_on_home FROM teacher_profile').all())
      .toEqual([{ teacher_id: 1, department: 'Tổ Toán', show_on_home: 0 }])
  })

  it('keeps the CASCADE from teacher and the show_on_home CHECK', async () => {
    const { db, sqlite } = oldDb()
    await ensureSchema(db)
    expect(() => sqlite.exec('UPDATE teacher_profile SET show_on_home = 2')).toThrow()
    sqlite.exec('DELETE FROM teacher WHERE id = 1')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM teacher_profile').get()).toEqual({ n: 0 })
  })

  it('leaves an already-current database untouched (no rebuild)', async () => {
    const { db, sqlite, state } = testDb()
    sqlite.exec(`INSERT INTO teacher (id, token, name, created_at) VALUES (1, 'tok1234567890abc', 'Khoa', '2026-11-17')`)
    sqlite.exec(`INSERT INTO teacher_profile (teacher_id, department) VALUES (1, 'x')`)
    const before = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'teacher_profile'").get()
    await ensureSchema(db)
    expect(sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'teacher_profile'").get()).toEqual(before)
    expect(state.ddl).toBe(SCHEMA.length + 3) // SCHEMA + 2 table probes + seed probe, no rebuild
  })

  it('running the rebuild twice keeps the same rows', async () => {
    const { db, sqlite } = oldDb()
    await ensureSchema(db)
    // Second isolate whose probe ran before the first committed: replays the rebuild batch only.
    for (const q of UPGRADE_SQL.filter((q) => /teacher_profile_new|DROP TABLE teacher_profile/.test(q))) sqlite.exec(q)
    expect(cols(sqlite)).toEqual(['teacher_id', 'department', 'show_on_home', 'role'])
    expect(sqlite.prepare('SELECT teacher_id, department, show_on_home FROM teacher_profile').all())
      .toEqual([{ teacher_id: 1, department: 'Tổ Toán', show_on_home: 0 }])
  })

  it('a failed rebuild rolls back (old table and rows intact) and the next call retries', async () => {
    const { db, sqlite } = oldDb()
    sqlite.exec('CREATE TABLE teacher_profile_new (x INTEGER)') // makes the rebuild batch fail
    await expect(ensureSchema(db)).rejects.toThrow()
    expect(cols(sqlite)).toContain('public_id')
    expect(sqlite.prepare('SELECT public_id FROM teacher_profile').all()).toEqual([{ public_id: 'pub1234567890abc' }])
    sqlite.exec('DROP TABLE teacher_profile_new')
    await ensureSchema(db) // cache entry was evicted → retried
    expect(cols(sqlite)).toEqual(['teacher_id', 'department', 'show_on_home', 'role'])
  })

  it('new rows get the show_on_home DEFAULT 1 after the rebuild', async () => {
    const { db, sqlite } = oldDb()
    await ensureSchema(db)
    sqlite.exec(`INSERT INTO teacher (id, token, name, created_at) VALUES (2, 'tok2234567890abc', 'Lan', '2026-11-18')`)
    sqlite.exec(`INSERT INTO teacher_profile (teacher_id) VALUES (2)`)
    expect(sqlite.prepare('SELECT department, show_on_home FROM teacher_profile WHERE teacher_id = 2').get())
      .toEqual({ department: '', show_on_home: 1 })
  })
})

// ---- Upgrade: teacher_profile.role (chức vụ) ----

const ROLE_CHECK_FAILS = (sqlite: ReturnType<typeof testDb>['sqlite']) =>
  () => sqlite.exec("UPDATE teacher_profile SET role = 'x'")

// Post-privacy shape: no public_id, no role
const NO_ROLE_TEACHER_PROFILE = `CREATE TABLE teacher_profile (
  teacher_id   INTEGER PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE,
  department   TEXT    NOT NULL DEFAULT '',
  show_on_home INTEGER NOT NULL DEFAULT 1 CHECK (show_on_home IN (0,1))
)`

describe('ensureSchema — teacher_profile.role', () => {
  it('fresh DB: role column exists with DEFAULT Giáo viên and the CHECK', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    expect(cols(sqlite)).toEqual(['teacher_id', 'department', 'show_on_home', 'role'])
    sqlite.exec(`INSERT INTO teacher (id, token, name, created_at) VALUES (1, 'tok1234567890abc', 'A', '2026-11-18')`)
    sqlite.exec('INSERT INTO teacher_profile (teacher_id) VALUES (1)')
    expect(sqlite.prepare('SELECT role FROM teacher_profile').get()).toEqual({ role: 'Giáo viên' })
    expect(ROLE_CHECK_FAILS(sqlite)).toThrow(/CHECK/)
    for (const r of ROLES) { // DDL CHECK labels match shared ROLES
      expect(() => sqlite.exec(`UPDATE teacher_profile SET role = '${r}'`)).not.toThrow()
    }
  })

  it('4d3a5df shape (public_id, no role): rows kept, public_id gone, every row Giáo viên', async () => {
    const { db, sqlite } = oldDb()
    sqlite.exec(`INSERT INTO teacher (id, token, name, created_at) VALUES (2, 'tok2234567890abc', 'Lan', '2026-11-17')`)
    sqlite.exec(`INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES (2, 'pub2234567890abc', '', 1)`)
    await ensureSchema(db)
    expect(cols(sqlite)).toEqual(['teacher_id', 'department', 'show_on_home', 'role'])
    expect(sqlite.prepare('SELECT teacher_id, department, show_on_home, role FROM teacher_profile ORDER BY teacher_id').all()).toEqual([
      { teacher_id: 1, department: 'Tổ Toán', show_on_home: 0, role: 'Giáo viên' },
      { teacher_id: 2, department: '', show_on_home: 1, role: 'Giáo viên' },
    ])
    expect(ROLE_CHECK_FAILS(sqlite)).toThrow(/CHECK/)
  })

  it('post-privacy shape (no public_id, no role): ADD COLUMN only, rows kept, Giáo viên', async () => {
    const t = testDb()
    t.sqlite.exec('DROP TABLE teacher_profile')
    t.sqlite.exec(NO_ROLE_TEACHER_PROFILE)
    t.sqlite.exec(`INSERT INTO teacher (id, token, name, created_at) VALUES (1, 'tok1234567890abc', 'Khoa', '2026-11-17')`)
    t.sqlite.exec(`INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (1, 'Tổ Toán', 0)`)
    await ensureSchema(t.db)
    expect(cols(t.sqlite)).toEqual(['teacher_id', 'department', 'show_on_home', 'role'])
    expect(t.sqlite.prepare('SELECT teacher_id, department, show_on_home, role FROM teacher_profile').all())
      .toEqual([{ teacher_id: 1, department: 'Tổ Toán', show_on_home: 0, role: 'Giáo viên' }])
    expect(ROLE_CHECK_FAILS(t.sqlite)).toThrow(/CHECK/)
  })

  it('current shape: a stored Hiệu trưởng survives ensureSchema (no rebuild, no reset)', async () => {
    const { db, sqlite } = testDb()
    sqlite.exec(`INSERT INTO teacher (id, token, name, created_at) VALUES (1, 'tok1234567890abc', 'A', '2026-11-18')`)
    sqlite.exec(`INSERT INTO teacher_profile (teacher_id, role) VALUES (1, 'Hiệu trưởng')`)
    await ensureSchema(db)
    expect(sqlite.prepare('SELECT role FROM teacher_profile').get()).toEqual({ role: 'Hiệu trưởng' })
  })

  it('public_id rebuild does not run when role already exists (stale-probe guard)', async () => {
    // Impossible in production, but a stale probe must never reset role via the 3-column copy.
    const t = testDb()
    t.sqlite.exec(`ALTER TABLE teacher_profile ADD COLUMN public_id TEXT`)
    t.sqlite.exec(`INSERT INTO teacher (id, token, name, created_at) VALUES (1, 'tok1234567890abc', 'A', '2026-11-18')`)
    t.sqlite.exec(`INSERT INTO teacher_profile (teacher_id, role, public_id) VALUES (1, 'Hiệu trưởng', 'p')`)
    await ensureSchema(t.db)
    expect(t.sqlite.prepare('SELECT role FROM teacher_profile').get()).toEqual({ role: 'Hiệu trưởng' })
  })
})

// ===================================================================
// Card v3: student_card.font / ink, legacy slots, one-time image seed
// ===================================================================

// student_card exactly as before card v3 (no font, no ink)
const OLD_STUDENT_CARD = `CREATE TABLE student_card (
  id          INTEGER PRIMARY KEY,
  public_id   TEXT    UNIQUE NOT NULL,
  teacher_id  INTEGER NOT NULL REFERENCES teacher(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES template(id) ON DELETE RESTRICT,
  message     TEXT    NOT NULL CHECK (length(message) BETWEEN 1 AND 300),
  from_name   TEXT    NOT NULL DEFAULT '' CHECK (length(from_name) <= 40),
  from_class  TEXT    NOT NULL DEFAULT '' CHECK (length(from_class) <= 10),
  anonymous   INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0,1)),
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','hidden')),
  created_at  TEXT    NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
)`
// template_image as before card v3 (banner allowed)
const OLD_TEMPLATE_IMAGE = `CREATE TABLE template_image (
  template_id INTEGER NOT NULL REFERENCES template(id) ON DELETE CASCADE,
  slot        TEXT    NOT NULL CHECK (slot IN ('background','banner')),
  image_id    INTEGER NOT NULL REFERENCES image(id) ON DELETE RESTRICT,
  PRIMARY KEY (template_id, slot)
)`

type Sqlite = ReturnType<typeof testDb>['sqlite']
const cardCols = (sqlite: Sqlite) =>
  (sqlite.prepare("PRAGMA table_info('student_card')").all() as { name: string }[]).map((c) => c.name)

/** Old card table + one teacher, template and existing card. */
function withOldCards(t: ReturnType<typeof testDb>) {
  t.sqlite.exec('DROP INDEX IF EXISTS idx_student_card_teacher_status')
  t.sqlite.exec('DROP INDEX IF EXISTS idx_student_card_status_created')
  t.sqlite.exec('DROP TABLE student_card')
  t.sqlite.exec(OLD_STUDENT_CARD)
  t.sqlite.exec(`INSERT OR IGNORE INTO teacher (id, token, name, created_at) VALUES (1, 'tok1234567890abc', 'Khoa', '2026-11-17')`)
  t.sqlite.exec(`INSERT INTO template (id, name, layout, active, created_at, created_by) VALUES (1, 'Cũ', 'classic', 1, '2026-11-17', 'a@b.c')`)
  t.sqlite.exec(`INSERT INTO student_card (public_id, teacher_id, template_id, message, created_at) VALUES ('card123456789012', 1, 1, 'Chúc thầy', '2026-11-17')`)
  return t
}

describe('ensureSchema — student_card.font / ink', () => {
  it('fresh DB: both columns with defaults and CHECKs', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    expect(cardCols(sqlite)).toEqual(expect.arrayContaining(['font', 'ink']))
    const ins = (font: string, ink: string) => sqlite.exec(
      `INSERT INTO teacher (token, name, created_at) VALUES ('t${Math.random().toString(36).slice(2, 17).padEnd(15, 'x')}', 'A', 'x');` +
      `INSERT INTO student_card (public_id, teacher_id, template_id, message, created_at, font, ink) VALUES ('p${Math.random().toString(36).slice(2, 17).padEnd(15, 'x')}', last_insert_rowid(), (SELECT MIN(id) FROM template), 'm', 'x', '${font}', '${ink}')`)
    expect(() => ins('lora', '#6b21a8')).not.toThrow()
    for (const bad of ['#ZZZZZZ', 'red', '#ABCDEF', '#abc', '#abcdef0']) expect(() => ins('lora', bad)).toThrow(/CHECK/)
    expect(() => ins('x'.repeat(33), '#000000')).toThrow(/CHECK/)
  })

  it('pre-v3 DB: ADD COLUMN path; existing card gets Bút bi + blue; ink CHECK enforced (real SQLite)', async () => {
    const t = withOldCards(testDb())
    await ensureSchema(t.db)
    expect(cardCols(t.sqlite)).toEqual(expect.arrayContaining(['font', 'ink']))
    expect(t.sqlite.prepare('SELECT font, ink FROM student_card').get()).toEqual({ font: 'patrick-hand', ink: '#1d3fa6' })
    expect(() => t.sqlite.exec("UPDATE student_card SET ink = 'red'")).toThrow(/CHECK/)
    expect(() => t.sqlite.exec("UPDATE student_card SET ink = '#ZZZZZZ'")).toThrow(/CHECK/)
  })

  it('DB with font but not ink: only ink is added', async () => {
    const t = withOldCards(testDb())
    t.sqlite.exec("ALTER TABLE student_card ADD COLUMN font TEXT NOT NULL DEFAULT 'lora'")
    await ensureSchema(t.db)
    expect(t.sqlite.prepare('SELECT font, ink FROM student_card').get()).toEqual({ font: 'lora', ink: '#1d3fa6' })
  })

  it('current DB: one probe per table, no upgrade statements', async () => {
    const { db, state } = testDb()
    await ensureSchema(db)
    // SCHEMA batch + teacher_profile probe + student_card probe + seed-flag probe
    expect(state.ddl).toBe(SCHEMA.length + 3)
    expect(state.prepares).toBe(0)
  })
})

describe('ensureSchema — 4d3a5df fixture through every step', () => {
  function fixture() {
    const t = oldDb() // teacher_profile with public_id, no role; teacher 1
    withOldCards(t)
    t.sqlite.exec('DROP TABLE template_image')
    t.sqlite.exec(OLD_TEMPLATE_IMAGE)
    t.sqlite.exec(`INSERT INTO image (id, token, name, mime, size, data, created_at, created_by) VALUES
      (1, 'img0000000000001', 'bg', 'image/png', 1, 'AA==', 'x', 'a'),
      (2, 'img0000000000002', 'banner only', 'image/png', 1, 'AA==', 'x', 'a')`)
    t.sqlite.exec(`INSERT INTO template_image (template_id, slot, image_id) VALUES (1, 'background', 1), (1, 'banner', 2)`)
    return t
  }

  it('ends with the current shape and keeps all rows (run twice)', async () => {
    const t = fixture()
    await ensureSchema(t.db)
    await ensureSchema(testDb({ shareWith: t.sqlite }).db) // a later isolate
    expect(cols(t.sqlite)).toEqual(['teacher_id', 'department', 'show_on_home', 'role'])
    expect(cardCols(t.sqlite)).toEqual(expect.arrayContaining(['font', 'ink']))
    expect(t.sqlite.prepare('SELECT font, ink FROM student_card').get()).toEqual({ font: 'patrick-hand', ink: '#1d3fa6' })
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM template_image WHERE slot = 'banner'").get()).toEqual({ n: 1 }) // legacy link left in place
  })

  it('two isolates racing: both settle, the end state is the same', async () => {
    const t = fixture()
    const b = testDb({ shareWith: t.sqlite })
    const results = await Promise.allSettled([ensureSchema(t.db), ensureSchema(b.db)])
    // A loser of the ADD COLUMN race may reject once; its retry must succeed.
    for (const [i, r] of results.entries()) if (r.status === 'rejected') await ensureSchema(i === 0 ? t.db : b.db)
    expect(cardCols(t.sqlite)).toEqual(expect.arrayContaining(['font', 'ink']))
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM student_card').get()).toEqual({ n: 1 })
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'images_seeded'").get()).toEqual({ n: 1 })
  })
})

describe('ensureSchema — one-time image seed', () => {
  const count = (sqlite: Sqlite, sql: string) => (sqlite.prepare(sql).get() as { n: number }).n

  it('fresh DB: 6 seed images, 6 example templates linked by token, flag set', async () => {
    const { db, sqlite } = testDb({ seeded: false })
    await ensureSchema(db)
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM image WHERE created_by = 'seed'")).toBe(6)
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM template WHERE created_by = 'seed' AND active = 1")).toBe(6)
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM template_image ti JOIN template t ON t.id = ti.template_id JOIN image i ON i.id = ti.image_id WHERE t.created_by = 'seed' AND i.created_by = 'seed' AND ti.slot = 'background' AND t.name = i.name")).toBe(6)
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM meta WHERE key = 'images_seeded'")).toBe(1)
    for (const s of SEED_IMAGES) {
      expect(sqlite.prepare('SELECT layout FROM template WHERE name = ?').get(s.name)).toEqual({ layout: s.layout })
      expect(sqlite.prepare('SELECT size, mime FROM image WHERE token = ?').get(s.token)).toEqual({ size: s.size, mime: 'image/webp' })
    }
  })

  it('a second run (new isolate) adds nothing', async () => {
    const { db, sqlite } = testDb({ seeded: false })
    await ensureSchema(db)
    await ensureSchema(testDb({ shareWith: sqlite }).db)
    expect(count(sqlite, 'SELECT COUNT(*) AS n FROM image')).toBe(6)
    expect(count(sqlite, 'SELECT COUNT(*) AS n FROM template')).toBe(6)
    expect(count(sqlite, 'SELECT COUNT(*) AS n FROM template_image')).toBe(6)
  })

  it('existing admin images and templates are untouched; seed rows are added', async () => {
    const { db, sqlite } = testDb({ seeded: false })
    sqlite.exec(`INSERT INTO image (token, name, mime, size, data, created_at, created_by) VALUES ('adm0000000000001', 'Ảnh admin', 'image/png', 1, 'AA==', 'x', 'a@b.c')`)
    sqlite.exec(`INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('Mẫu admin', 'lotus', 0, 'x', 'a@b.c')`)
    await ensureSchema(db)
    expect(sqlite.prepare("SELECT name, mime, data FROM image WHERE token = 'adm0000000000001'").get()).toEqual({ name: 'Ảnh admin', mime: 'image/png', data: 'AA==' })
    expect(sqlite.prepare("SELECT layout, active FROM template WHERE name = 'Mẫu admin'").get()).toEqual({ layout: 'lotus', active: 0 })
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM template WHERE created_by = 'seed'")).toBe(6)
  })

  it('an image already holding a seed token is kept unchanged (and still linked by token)', async () => {
    const { db, sqlite } = testDb({ seeded: false })
    sqlite.exec(`INSERT INTO image (token, name, mime, size, data, created_at, created_by) VALUES ('${SEED_IMAGES[0].token}', 'giữ nguyên', 'image/png', 1, 'AA==', 'x', 'a@b.c')`)
    await ensureSchema(db)
    expect(sqlite.prepare('SELECT name, data FROM image WHERE token = ?').get(SEED_IMAGES[0].token)).toEqual({ name: 'giữ nguyên', data: 'AA==' })
    expect(sqlite.prepare('SELECT i.token FROM template_image ti JOIN template t ON t.id = ti.template_id JOIN image i ON i.id = ti.image_id WHERE t.name = ?').get(SEED_IMAGES[0].name))
      .toEqual({ token: SEED_IMAGES[0].token })
  })

  it('an admin template that happens to use a seed name is never linked', async () => {
    const { db, sqlite } = testDb({ seeded: false })
    sqlite.exec(`INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('${SEED_IMAGES[0].name}', 'lotus', 1, 'x', 'a@b.c')`)
    await ensureSchema(db)
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM template_image ti JOIN template t ON t.id = ti.template_id WHERE t.created_by <> 'seed'")).toBe(0)
  })

  it('flag already set → no seed statement is prepared', async () => {
    const { db, sqlite, state } = testDb()
    await ensureSchema(db)
    expect(state.ddl).toBe(SCHEMA.length + 3)
    expect(count(sqlite, 'SELECT COUNT(*) AS n FROM image')).toBe(0)
  })

  it('two isolates racing the seed: exactly 6/6/6 and one flag', async () => {
    const a = testDb({ seeded: false })
    const b = testDb({ shareWith: a.sqlite })
    await Promise.all([ensureSchema(a.db), ensureSchema(b.db)])
    expect(count(a.sqlite, 'SELECT COUNT(*) AS n FROM image')).toBe(6)
    expect(count(a.sqlite, 'SELECT COUNT(*) AS n FROM template')).toBe(6)
    expect(count(a.sqlite, 'SELECT COUNT(*) AS n FROM template_image')).toBe(6)
    expect(count(a.sqlite, "SELECT COUNT(*) AS n FROM meta WHERE key = 'images_seeded'")).toBe(1)
  })

  it('seed batch failure: ensureSchema still resolves, fixed log, nothing written, attempted once per isolate', async () => {
    const t = testDb({ seeded: false })
    let seedBatches = 0
    const db = {
      prepare: t.db.prepare,
      batch: (stmts: Parameters<typeof t.db.batch>[0]) => {
        if (stmts.length === SEED_STATEMENT_COUNT) { seedBatches++; return Promise.reject(new Error('D1_ERROR: seed')) }
        return t.db.batch(stmts)
      },
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(ensureSchema(db)).resolves.toBeUndefined()
    await expect(ensureSchema(db)).resolves.toBeUndefined()
    expect(seedBatches).toBe(1)
    expect(spy).toHaveBeenCalledWith('schema: seed images failed')
    expect(spy.mock.calls.flat().join(' ')).not.toMatch(/D1_ERROR/) // fixed string only
    expect(count(t.sqlite, 'SELECT COUNT(*) AS n FROM image')).toBe(0)
    expect(count(t.sqlite, "SELECT COUNT(*) AS n FROM meta WHERE key = 'images_seeded'")).toBe(0)
    spy.mockRestore()
  })
})

describe('seed images — shipped files are safe', () => {
  const decode = (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64'))
  const chunks = (b: Uint8Array) => {
    const out: string[] = []
    for (let i = 12; i + 8 <= b.length;) {
      const n = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)
      out.push(String.fromCharCode(...b.slice(i, i + 4)))
      i += 8 + n + (n & 1)
    }
    return out
  }
  it('SEED_STATEMENT_COUNT matches the seed (image + template + link per image, plus the flag)', () => {
    expect(SEED_STATEMENT_COUNT).toBe(SEED_IMAGES.length * 3 + 1)
  })

  it('six images, one per layout, unique seed tokens', () => {
    expect(SEED_IMAGES.map((s) => s.layout)).toEqual(LAYOUTS.map((l) => l.id))
    expect(new Set(SEED_IMAGES.map((s) => s.token)).size).toBe(6)
    for (const s of SEED_IMAGES) expect(s.token).toMatch(/^seedbg\d{10}$/)
  })
  it('each is a plain WebP ≤ 300 KB whose size matches, passes the uploader checks, no metadata chunks', () => {
    for (const s of SEED_IMAGES) {
      const b = decode(s.data)
      expect(b.length).toBe(s.size)
      expect(b.length).toBeLessThanOrEqual(307200)
      expect(magicOk('image/webp', b)).toBe(true)
      const dim = checkDimensions('image/webp', b)
      const portrait = s.layout.startsWith('doc')
      expect(dim).toEqual(portrait ? { w: 960, h: 1280 } : { w: 1280, h: 960 })
      expect(chunks(b)).toEqual(['VP8 '])
    }
  })
})

// ===================================================================
// Campaign platform (Phase 1) — schema tests (red phase)
// ===================================================================
//
// Fixtures: deployedDb() — current deployed shape (font/ink present, no campaign/campaign_id)
//           olderDeployedDb() — pre-card-v3 + pre-privacy (old teacher_profile, old student_card),
//                               still without campaign/campaign_id.
// Both use hardcoded pre-campaign DDL so the fixture is stable after implementation adds
// campaign DDL to SCHEMA.

// --- Pre-campaign DDL constants (snapshot of the tables as deployed, without campaign_id) ---

const PRE_CAMPAIGN_TEMPLATE_DDL = `CREATE TABLE template (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  layout     TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT    NOT NULL,
  created_by TEXT    NOT NULL
)`

const PRE_CAMPAIGN_WISH_DDL = `CREATE TABLE wish (
  id         INTEGER PRIMARY KEY,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  created_by TEXT    NOT NULL
)`

const PRE_CAMPAIGN_STUDENT_CARD_DDL = `CREATE TABLE student_card (
  id          INTEGER PRIMARY KEY,
  public_id   TEXT    UNIQUE NOT NULL,
  teacher_id  INTEGER NOT NULL REFERENCES teacher(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES template(id) ON DELETE RESTRICT,
  message     TEXT    NOT NULL CHECK (length(message) BETWEEN 1 AND 300),
  from_name   TEXT    NOT NULL DEFAULT '' CHECK (length(from_name) <= 40),
  from_class  TEXT    NOT NULL DEFAULT '' CHECK (length(from_class) <= 10),
  anonymous   INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0,1)),
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','hidden')),
  created_at  TEXT    NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  font        TEXT    NOT NULL DEFAULT 'patrick-hand' CHECK (length(font) <= 32),
  ink         TEXT    NOT NULL DEFAULT '#1d3fa6' CHECK (ink GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
)`

// --- Content expected in campaign 1 after upgrade (from src/content/site.json .home) ---
// Inlined to avoid a top-level import in the appended section.
const SITE_HOME = {
  kicker: 'Ngày Nhà giáo Việt Nam 20/11/2026',
  heading: 'Gửi thầy cô muôn vàn lời tri ân',
  body: 'Hãy chọn mẫu thiệp đẹp, chọn thầy cô bạn muốn gửi, và viết lời chúc từ trái tim. Mỗi lời chúc được CLB AI duyệt trước khi hiển thị — để thầy cô nhận được những tình cảm chân thành nhất.',
}

/**
 * Builds a DB shaped like the current deployed schema (61107f8 era):
 * all current non-campaign tables intact, but template/wish/student_card have NO campaign_id,
 * and no campaign table exists. Stable before and after implementation.
 */
function deployedDb(): ReturnType<typeof testDb> {
  const t = testDb({ schema: false })
  // Apply all current SCHEMA statements; after implementation this includes campaign DDL,
  // which we immediately strip away below.
  for (const sql of SCHEMA) t.sqlite.exec(sql)
  t.sqlite.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('images_seeded', 'test')")

  // Strip campaign-related things (a no-op before implementation, mandatory after).
  t.sqlite.exec('DROP INDEX IF EXISTS idx_template_campaign_id')
  t.sqlite.exec('DROP INDEX IF EXISTS idx_wish_campaign_id')
  t.sqlite.exec('DROP INDEX IF EXISTS idx_student_card_campaign_id')
  t.sqlite.exec('DROP TABLE IF EXISTS campaign')
  t.sqlite.exec('DROP INDEX IF EXISTS idx_student_card_teacher_status')
  t.sqlite.exec('DROP INDEX IF EXISTS idx_student_card_status_created')
  t.sqlite.exec('DROP TABLE IF EXISTS student_card')
  t.sqlite.exec('DROP TABLE IF EXISTS template_image')
  t.sqlite.exec('DROP TABLE IF EXISTS template')
  t.sqlite.exec('DROP TABLE IF EXISTS wish')
  // Recreate in pre-campaign form
  t.sqlite.exec(PRE_CAMPAIGN_TEMPLATE_DDL)
  t.sqlite.exec(PRE_CAMPAIGN_WISH_DDL)
  t.sqlite.exec(PRE_CAMPAIGN_STUDENT_CARD_DDL)
  t.sqlite.exec('CREATE INDEX IF NOT EXISTS idx_student_card_teacher_status ON student_card (teacher_id, status)')
  t.sqlite.exec('CREATE INDEX IF NOT EXISTS idx_student_card_status_created ON student_card (status, created_at)')

  // Seed representative data
  t.sqlite.exec("INSERT OR IGNORE INTO teacher (id, token, name, subject, created_at) VALUES (1, 'tok1234567890abc', 'Thầy Khoa', 'Toán', '2026-11-01')")
  t.sqlite.exec("INSERT OR IGNORE INTO teacher_profile (teacher_id, department, show_on_home) VALUES (1, 'Tổ Toán', 1)")
  t.sqlite.exec("INSERT INTO template (id, name, layout, active, created_at, created_by) VALUES (1, 'Mẫu thiệp', 'classic', 1, '2026-11-01', 'admin@test.com')")
  t.sqlite.exec("INSERT INTO wish (id, title, body, created_at, created_by) VALUES (1, 'Chúc mừng', 'Chúc thầy cô sức khỏe', '2026-11-01', 'seed')")
  t.sqlite.exec("INSERT INTO student_card (public_id, teacher_id, template_id, message, from_name, from_class, anonymous, status, created_at) VALUES ('card123456789012', 1, 1, 'Chúc thầy', 'Học sinh A', '10A1', 0, 'pending', '2026-11-17')")
  return t
}

/**
 * Builds a DB shaped like a much older deployment:
 * old teacher_profile (with public_id, no role) + old student_card (no font/ink) +
 * no campaign/campaign_id. Uses the existing OLD_TEACHER_PROFILE and OLD_STUDENT_CARD
 * constants defined earlier in this file.
 */
function olderDeployedDb(): ReturnType<typeof testDb> {
  const t = testDb({ schema: false })
  for (const sql of SCHEMA) t.sqlite.exec(sql)
  t.sqlite.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('images_seeded', 'test')")

  // Strip campaign-related things
  t.sqlite.exec('DROP INDEX IF EXISTS idx_template_campaign_id')
  t.sqlite.exec('DROP INDEX IF EXISTS idx_wish_campaign_id')
  t.sqlite.exec('DROP INDEX IF EXISTS idx_student_card_campaign_id')
  t.sqlite.exec('DROP TABLE IF EXISTS campaign')
  t.sqlite.exec('DROP INDEX IF EXISTS idx_student_card_teacher_status')
  t.sqlite.exec('DROP INDEX IF EXISTS idx_student_card_status_created')
  t.sqlite.exec('DROP TABLE IF EXISTS student_card')
  t.sqlite.exec('DROP TABLE IF EXISTS template_image')
  t.sqlite.exec('DROP TABLE IF EXISTS template')
  t.sqlite.exec('DROP TABLE IF EXISTS wish')

  // Revert teacher_profile to 4d3a5df shape (public_id, no role)
  t.sqlite.exec('DROP TABLE teacher_profile')
  t.sqlite.exec(OLD_TEACHER_PROFILE)

  // Recreate pre-campaign tables in pre-card-v3 form
  t.sqlite.exec(PRE_CAMPAIGN_TEMPLATE_DDL)
  t.sqlite.exec(PRE_CAMPAIGN_WISH_DDL)
  t.sqlite.exec(OLD_STUDENT_CARD) // no font, no ink, no campaign_id
  t.sqlite.exec('CREATE INDEX IF NOT EXISTS idx_student_card_teacher_status ON student_card (teacher_id, status)')
  t.sqlite.exec('CREATE INDEX IF NOT EXISTS idx_student_card_status_created ON student_card (status, created_at)')

  // Seed representative data
  t.sqlite.exec("INSERT OR IGNORE INTO teacher (id, token, name, subject, created_at) VALUES (1, 'tok1234567890abc', 'Thầy Khoa', 'Toán', '2026-11-01')")
  t.sqlite.exec("INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES (1, 'pub1234567890abc', 'Tổ Toán', 1)")
  t.sqlite.exec("INSERT INTO template (id, name, layout, active, created_at, created_by) VALUES (1, 'Mẫu thiệp', 'classic', 1, '2026-11-01', 'admin@test.com')")
  t.sqlite.exec("INSERT INTO wish (id, title, body, created_at, created_by) VALUES (1, 'Chúc mừng', 'Chúc thầy cô sức khỏe', '2026-11-01', 'seed')")
  t.sqlite.exec("INSERT INTO student_card (public_id, teacher_id, template_id, message, from_name, from_class, anonymous, status, created_at) VALUES ('card123456789012', 1, 1, 'Chúc thầy', 'Học sinh A', '10A1', 0, 'pending', '2026-11-17')")
  return t
}

// --- campaign table structure — fresh DB ---

describe('campaign table — ensureSchema creates it on a fresh DB', () => {
  it('campaign table exists after ensureSchema', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const names = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(names).toContain('campaign')
  })
})

describe('campaign table — slug CHECK', () => {
  it('slug CHECK rejects underscore (a_b)', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    // Valid slug insertion first — fails NOW because no campaign table, which makes the test red
    sqlite
      .prepare(
        "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES ('ab', 'teacher_cards', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
      )
      .run()
    // Invalid slug must throw CHECK constraint
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
            "VALUES ('a_b', 'teacher_cards', 'N2', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
        )
        .run()
    }).toThrow()
  })

  it('slug CHECK rejects uppercase (A)', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    sqlite
      .prepare(
        "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES ('ab', 'teacher_cards', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
      )
      .run()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
            "VALUES ('Ab', 'teacher_cards', 'N2', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
        )
        .run()
    }).toThrow()
  })

  it('slug CHECK rejects single char (x — too short)', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    sqlite
      .prepare(
        "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES ('ab', 'teacher_cards', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
      )
      .run()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
            "VALUES ('x', 'teacher_cards', 'N2', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
        )
        .run()
    }).toThrow()
  })

  it('slug CHECK rejects 33-char slug (too long)', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    sqlite
      .prepare(
        "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES ('ab', 'teacher_cards', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
      )
      .run()
    const long = 'a'.repeat(33)
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) ` +
            `VALUES ('${long}', 'teacher_cards', 'N2', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')`,
        )
        .run()
    }).toThrow()
  })

  it('slug CHECK rejects space (a b)', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    sqlite
      .prepare(
        "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES ('ab', 'teacher_cards', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
      )
      .run()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
            "VALUES ('a b', 'teacher_cards', 'N2', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
        )
        .run()
    }).toThrow()
  })

  it('slug CHECK accepts 2-char valid slug', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
            "VALUES ('ab', 'teacher_cards', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
        )
        .run()
    }).not.toThrow()
  })

  it('slug CHECK accepts 32-char valid slug (maximum length)', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const slug32 = 'a'.repeat(32)
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) ` +
            `VALUES ('${slug32}', 'teacher_cards', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')`,
        )
        .run()
    }).not.toThrow()
  })

  it('kind CHECK accepts teacher_cards and gift_tree', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    for (const [slug, kind] of [['tc', 'teacher_cards'], ['gt', 'gift_tree']] as [string, string][]) {
      expect(() => {
        sqlite
          .prepare(
            `INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) ` +
              `VALUES ('${slug}', '${kind}', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')`,
          )
          .run()
      }).not.toThrow()
    }
  })

  it('kind CHECK rejects unknown kind', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    // Valid insert first (makes test red if campaign table missing)
    sqlite
      .prepare(
        "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES ('ab', 'teacher_cards', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
      )
      .run()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
            "VALUES ('cd', 'unknown_kind', 'N2', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
        )
        .run()
    }).toThrow()
  })

  it('status CHECK accepts draft, active, closed', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    for (const [slug, status] of [['s1', 'draft'], ['s2', 'closed']] as [string, string][]) {
      expect(() => {
        sqlite
          .prepare(
            `INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) ` +
              `VALUES ('${slug}', 'teacher_cards', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', '${status}', datetime('now'), 'test')`,
          )
          .run()
      }).not.toThrow()
    }
  })

  it('status CHECK rejects unknown status', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    sqlite
      .prepare(
        "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES ('ab', 'teacher_cards', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
      )
      .run()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
            "VALUES ('cd', 'teacher_cards', 'N2', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'published', datetime('now'), 'test')",
        )
        .run()
    }).toThrow()
  })
})

describe('campaign table — partial unique index (at most one active)', () => {
  it('inserting a second active campaign fails', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    // First active insert
    sqlite
      .prepare(
        "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES ('c1', 'teacher_cards', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'active', datetime('now'), 'test')",
      )
      .run()
    // Second active insert must fail
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
            "VALUES ('c2', 'teacher_cards', 'N2', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'active', datetime('now'), 'test')",
        )
        .run()
    }).toThrow()
  })

  it('two drafts or two closed can coexist without violating the index', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    sqlite
      .prepare(
        "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES ('d1', 'teacher_cards', 'N', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
      )
      .run()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
            "VALUES ('d2', 'teacher_cards', 'N2', '', '{}', '{}', '{}', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
        )
        .run()
    }).not.toThrow()
  })
})

// --- campaign_id columns on template / wish / student_card (fresh DB via ensureSchema) ---

describe('campaign_id columns on template, wish, student_card — fresh DB', () => {
  it('template has campaign_id column after ensureSchema', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const cols = (
      sqlite.prepare("PRAGMA table_info('template')").all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toContain('campaign_id')
  })

  it('wish has campaign_id column after ensureSchema', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const cols = (
      sqlite.prepare("PRAGMA table_info('wish')").all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toContain('campaign_id')
  })

  it('student_card has campaign_id column after ensureSchema', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const cols = (
      sqlite.prepare("PRAGMA table_info('student_card')").all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toContain('campaign_id')
  })

  it('index exists on template(campaign_id)', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const indexes = (
      sqlite.prepare('PRAGMA index_list(template)').all() as Array<{ name: string }>
    ).map((r) => r.name)
    const hasCampaignIdx = indexes.some((name) => {
      const cols = (
        sqlite.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>
      ).map((c) => c.name)
      return cols.includes('campaign_id')
    })
    expect(hasCampaignIdx).toBe(true)
  })

  it('index exists on wish(campaign_id)', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const indexes = (
      sqlite.prepare('PRAGMA index_list(wish)').all() as Array<{ name: string }>
    ).map((r) => r.name)
    const hasCampaignIdx = indexes.some((name) => {
      const cols = (
        sqlite.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>
      ).map((c) => c.name)
      return cols.includes('campaign_id')
    })
    expect(hasCampaignIdx).toBe(true)
  })

  it('index exists on student_card(campaign_id)', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const indexes = (
      sqlite.prepare('PRAGMA index_list(student_card)').all() as Array<{ name: string }>
    ).map((r) => r.name)
    const hasCampaignIdx = indexes.some((name) => {
      const cols = (
        sqlite.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>
      ).map((c) => c.name)
      return cols.includes('campaign_id')
    })
    expect(hasCampaignIdx).toBe(true)
  })
})

// --- Upgrade from deployed schema (61107f8 era): font/ink present, no campaign/campaign_id ---

describe('ensureSchema — campaign upgrade from deployed schema (61107f8: font/ink, no campaign_id)', () => {
  it('creates campaign 1 (slug=20-11, kind=teacher_cards, status=active)', async () => {
    const { db, sqlite } = deployedDb()
    await ensureSchema(db)
    const row = sqlite
      .prepare('SELECT slug, kind, status FROM campaign WHERE id = 1')
      .get() as { slug: string; kind: string; status: string } | undefined
    expect(row).toBeDefined()
    expect(row?.slug).toBe('20-11')
    expect(row?.kind).toBe('teacher_cards')
    expect(row?.status).toBe('active')
  })

  it('campaign 1 content round-trips home object from site.json exactly', async () => {
    const { db, sqlite } = deployedDb()
    await ensureSchema(db)
    const row = sqlite
      .prepare('SELECT content FROM campaign WHERE id = 1')
      .get() as { content: string } | undefined
    expect(row).toBeDefined()
    expect(() => JSON.parse(row!.content)).not.toThrow()
    expect(JSON.parse(row!.content)).toEqual(SITE_HOME)
  })

  it('campaign 1 is effectively open on 2026-11-20T12:00:00Z (starts_at ≤ now ≤ ends_at)', async () => {
    const { db, sqlite } = deployedDb()
    await ensureSchema(db)
    const row = sqlite
      .prepare('SELECT status, starts_at, ends_at FROM campaign WHERE id = 1')
      .get() as { status: string; starts_at: string; ends_at: string } | undefined
    expect(row).toBeDefined()
    expect(row!.status).toBe('active')
    const now = new Date('2026-11-20T12:00:00Z')
    const starts = new Date(row!.starts_at)
    const ends = new Date(row!.ends_at)
    expect(now >= starts && now <= ends).toBe(true)
  })

  it('all existing template rows have campaign_id = 1 after upgrade', async () => {
    const { db, sqlite } = deployedDb()
    await ensureSchema(db)
    const rows = sqlite.prepare('SELECT campaign_id FROM template').all() as Array<{ campaign_id: number }>
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.campaign_id).toBe(1)
  })

  it('all existing wish rows have campaign_id = 1 after upgrade', async () => {
    const { db, sqlite } = deployedDb()
    await ensureSchema(db)
    const rows = sqlite.prepare('SELECT campaign_id FROM wish').all() as Array<{ campaign_id: number }>
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.campaign_id).toBe(1)
  })

  it('all existing student_card rows have campaign_id = 1 after upgrade', async () => {
    const { db, sqlite } = deployedDb()
    await ensureSchema(db)
    const rows = sqlite
      .prepare('SELECT campaign_id FROM student_card')
      .all() as Array<{ campaign_id: number }>
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.campaign_id).toBe(1)
  })

  it('existing student_card content (message, from_name) is unchanged after upgrade', async () => {
    const { db, sqlite } = deployedDb()
    await ensureSchema(db)
    const row = sqlite
      .prepare('SELECT message, from_name FROM student_card WHERE public_id = ?')
      .get('card123456789012') as { message: string; from_name: string } | undefined
    expect(row?.message).toBe('Chúc thầy')
    expect(row?.from_name).toBe('Học sinh A')
  })

  it('ensureSchema twice on the same db settles with exactly one campaign row', async () => {
    const { db, sqlite } = deployedDb()
    await ensureSchema(db)
    await ensureSchema(db) // second call: cached promise, no-op
    const count = (
      sqlite.prepare('SELECT COUNT(*) AS c FROM campaign').get() as { c: number }
    ).c
    expect(count).toBe(1)
  })

  it('two concurrent D1 objects (shareWith) settle with exactly one campaign row (AC-1 concurrency)', async () => {
    const { db: db1, sqlite } = deployedDb()
    const { db: db2 } = testDb({ shareWith: sqlite })
    await Promise.allSettled([ensureSchema(db1), ensureSchema(db2)])
    // One may have failed with duplicate-column-name or UNIQUE; that's acceptable.
    const count = (
      sqlite.prepare('SELECT COUNT(*) AS c FROM campaign').get() as { c: number }
    ).c
    expect(count).toBe(1)
  })
})

// --- Upgrade from older deployed shape (pre-card-v3: no font/ink, old teacher_profile) ---

describe('ensureSchema — campaign upgrade from pre-card-v3 shape (old teacher_profile + old student_card)', () => {
  it('creates campaign 1 from an older DB fixture', async () => {
    const { db, sqlite } = olderDeployedDb()
    await ensureSchema(db)
    const row = sqlite
      .prepare('SELECT slug, kind, status FROM campaign WHERE id = 1')
      .get() as { slug: string; kind: string; status: string } | undefined
    expect(row?.slug).toBe('20-11')
    expect(row?.kind).toBe('teacher_cards')
    expect(row?.status).toBe('active')
  })

  it('all rows in older fixture have campaign_id = 1 after upgrade', async () => {
    const { db, sqlite } = olderDeployedDb()
    await ensureSchema(db)
    for (const table of ['template', 'wish', 'student_card'] as const) {
      const rows = sqlite
        .prepare(`SELECT campaign_id FROM ${table}`)
        .all() as Array<{ campaign_id: number }>
      expect(rows.length, `${table} should have rows`).toBeGreaterThan(0)
      for (const r of rows) {
        expect(r.campaign_id, `${table}.campaign_id`).toBe(1)
      }
    }
  })

  it('pre-v3 card message is unchanged after upgrade (font/ink/campaign_id added, content intact)', async () => {
    const { db, sqlite } = olderDeployedDb()
    await ensureSchema(db)
    const row = sqlite
      .prepare('SELECT message, from_name, font, ink, campaign_id FROM student_card WHERE public_id = ?')
      .get('card123456789012') as {
        message: string
        from_name: string
        font: string
        ink: string
        campaign_id: number
      } | undefined
    expect(row?.message).toBe('Chúc thầy')
    expect(row?.from_name).toBe('Học sinh A')
    // font and ink got defaults via ADD COLUMN DEFAULT
    expect(row?.font).toBe('patrick-hand')
    expect(row?.ink).toBe('#1d3fa6')
    expect(row?.campaign_id).toBe(1)
  })

  it('teacher_profile is rebuilt (old public_id gone, role present) during same ensureSchema', async () => {
    const { db, sqlite } = olderDeployedDb()
    await ensureSchema(db)
    const cols = (
      sqlite.prepare("PRAGMA table_info('teacher_profile')").all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).not.toContain('public_id')
    expect(cols).toContain('role')
  })
})
