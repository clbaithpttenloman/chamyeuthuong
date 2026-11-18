// @vitest-environment node
// Tests for worker/schema.ts
import { describe, it, expect } from 'vitest'
import { SCHEMA, UPGRADE_SQL, ensureSchema } from './schema.ts'
import { ROLES } from '../shared/api.ts'
import { SEEDS } from './seed.ts'
import { testDb } from './testDb.ts'
import type { D1Stmt } from './types.ts'

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
    expect(state.ddl).toBe(SCHEMA.length + 1) // + the teacher_profile upgrade probe
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
    expect(state.ddl).toBe(SCHEMA.length + 1) // one batch of DDL + one upgrade probe
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
    expect(state.ddl).toBe(SCHEMA.length + 1) // one batch + one upgrade probe
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
    expect(state.ddl).toBe(SCHEMA.length + 1) // + the teacher_profile upgrade probe
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

  it('slot CHECK accepts background, banner', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    for (const slot of ['background', 'banner']) {
      const imgTok = `img${slot.slice(0,3)}12345678901`
      sqlite.prepare(`INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('${imgTok}','x.jpg','image/jpeg',100,'d','2024-01-01','a@b.com')`).run()
      const imgId = (sqlite.prepare('SELECT id FROM image WHERE token=?').get(imgTok) as { id: number }).id
      expect(() => {
        sqlite.prepare(`INSERT INTO template_image (template_id, slot, image_id) VALUES (${tmplId}, '${slot}', ${imgId})`).run()
      }).not.toThrow()
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

describe('template_image slot CHECK — only background/banner', () => {
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

  it('slot CHECK still accepts background and banner after the new CHECK', () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.prepare("INSERT INTO template (name, layout, active, created_at, created_by) VALUES ('T','classic',1,'2024-01-01','a@b.com')").run()
    const tmplId = (sqlite.prepare('SELECT id FROM template WHERE name=?').get('T') as { id: number }).id
    for (const slot of ['background', 'banner']) {
      const imgTok = `img${slot.slice(0, 3)}12345678901`
      sqlite.prepare(`INSERT OR IGNORE INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('${imgTok}','x.jpg','image/jpeg',100,'d','2024-01-01','a@b.com')`).run()
      const imgId = (sqlite.prepare('SELECT id FROM image WHERE token=?').get(imgTok) as { id: number }).id
      expect(() => {
        sqlite.prepare(`INSERT INTO template_image (template_id, slot, image_id) VALUES (${tmplId}, '${slot}', ${imgId})`).run()
      }).not.toThrow()
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
    expect(state.ddl).toBe(SCHEMA.length + 1) // SCHEMA + probe, no rebuild statements
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
