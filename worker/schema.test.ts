// @vitest-environment node
// Tests for worker/schema.ts
import { describe, it, expect } from 'vitest'
import { SCHEMA, ensureSchema } from './schema.ts'
import { testDb } from './testDb.ts'
import type { D1Stmt } from './types.ts'

// ---- SCHEMA shape ----

describe('SCHEMA shape', () => {
  it('is a non-empty string array', () => {
    expect(Array.isArray(SCHEMA)).toBe(true)
    expect(SCHEMA.length).toBeGreaterThan(0)
    for (const s of SCHEMA) expect(typeof s).toBe('string')
  })

  it('every entry starts with CREATE TABLE IF NOT EXISTS (DDL) or INSERT/INSERT OR IGNORE (seeds)', () => {
    for (const s of SCHEMA) {
      expect(s.trim().toUpperCase()).toMatch(/^(CREATE TABLE IF NOT EXISTS|INSERT)\s/)
    }
  })

  it('covers teacher, card, and admin tables', () => {
    const names = SCHEMA.map((s) => {
      const m = s.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i)
      return m?.[1]?.toLowerCase() ?? ''
    })
    expect(names).toContain('teacher')
    expect(names).toContain('card')
    expect(names).toContain('admin')
  })
})

// ---- ensureSchema — creation ----

describe('ensureSchema — creation', () => {
  it('creates teacher, card, and admin tables on a fresh empty DB', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = rows.map((r) => r.name)
    expect(names).toContain('admin')
    expect(names).toContain('card')
    expect(names).toContain('teacher')
  })

  it('counts DDL statements in state.ddl only (not state.prepares)', async () => {
    const { db, state } = testDb({ schema: false })
    await ensureSchema(db)
    expect(state.ddl).toBe(SCHEMA.length)
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
    expect(state.ddl).toBe(SCHEMA.length) // only one batch worth of DDL
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
        "INSERT INTO teacher (token, name, subject, created_at) VALUES ('tok1234567890ab', 'T', 'S', datetime('now'))",
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
    // Run SCHEMA via sqlite.exec directly (bypasses the WeakMap cache) so we can re-run on
    // an already-populated DB and confirm IF NOT EXISTS truly leaves existing rows untouched.
    const { sqlite } = testDb({ schema: false })
    for (const sql of SCHEMA) sqlite.exec(sql)
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare(
        "INSERT INTO teacher (token, name, subject, created_at) VALUES ('tok1234567890ab', 'T', 'S', datetime('now'))",
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
    // Exactly SCHEMA.length DDL prepares — not 2× or 3×
    expect(state.ddl).toBe(SCHEMA.length)
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
    // p1 was evicted from the WeakMap — a new promise must be created
    const p2 = ensureSchema(db)
    expect(p2).not.toBe(p1)
    await expect(p2).resolves.toBeUndefined()
  })
})

// ---- ensureSchema — batch rollback ----

describe('ensureSchema — batch rollback', () => {
  it('batch rejected before BEGIN (state.fail fires before sqlite BEGIN) leaves no tables', async () => {
    // state.fail causes db.batch() to throw before sqlite.exec('BEGIN') runs in testDb —
    // so this tests the "batch never starts" path, not mid-batch atomicity.
    const { db, state, sqlite } = testDb({ schema: false })
    state.fail = true
    await expect(ensureSchema(db)).rejects.toThrow()
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    expect(tables).toHaveLength(0)
  })

  it('mid-batch failure leaves zero tables (transaction atomicity: ROLLBACK undoes partial DDL)', async () => {
    // Build a minimal D1 that shares the sqlite handle but throws on the 2nd statement.run()
    // — after sqlite BEGIN, before COMMIT — to verify the ROLLBACK undoes the first table.
    const { sqlite } = testDb({ schema: false })
    let runCount = 0
    const makeStmt = (sql: string): D1Stmt => ({
      bind: (..._v: unknown[]) => makeStmt(sql),
      run: async (): Promise<{ success: boolean; meta: { changes: number } }> => {
        runCount++
        if (runCount === 2) throw new Error('D1_ERROR: mid-batch')
        sqlite.prepare(sql).run()
        return { success: true, meta: { changes: 1 } }
      },
      first: async <T>() => null as T | null,
      all: async <T>() => ({ results: [] as T[] }),
    })
    const db = {
      prepare: makeStmt,
      batch: async (statements: D1Stmt[]): Promise<{ success: boolean; meta: { changes: number } }[]> => {
        sqlite.exec('BEGIN')
        try {
          const out: { success: boolean; meta: { changes: number } }[] = []
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
    // 247 + '@example.com' (12) = 259 chars (> 254)
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

  it('deleting a teacher cascades to its card (ON DELETE CASCADE)', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare(
        "INSERT INTO teacher (token, name, subject, created_at) VALUES ('tok1234567890ab', 'T', 'S', datetime('now'))",
      )
      .run()
    const row = sqlite
      .prepare("SELECT id FROM teacher WHERE token = 'tok1234567890ab'")
      .get() as { id: number }
    sqlite
      .prepare(
        `INSERT INTO card (teacher_id, message, status, updated_at) VALUES (${row.id}, 'msg', 'draft', datetime('now'))`,
      )
      .run()
    sqlite.prepare(`DELETE FROM teacher WHERE id = ${row.id}`).run()
    const cards = sqlite
      .prepare(`SELECT * FROM card WHERE teacher_id = ${row.id}`)
      .all()
    expect(cards).toHaveLength(0)
  })

  it('PRAGMA foreign_key_list(card) shows ON DELETE CASCADE for teacher_id', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const fkList = sqlite.prepare('PRAGMA foreign_key_list(card)').all() as Array<
      Record<string, unknown>
    >
    expect(fkList.length).toBeGreaterThan(0)
    expect(fkList.some((r) => r['on_delete'] === 'CASCADE')).toBe(true)
  })
})

// ===================================================================
// New tables (Group 2 adds them to SCHEMA — these tests fail until then)
// ===================================================================

describe('SCHEMA covers new tables (failing until Group 2)', () => {
  it('covers image, card_style, card_image, wish, meta tables', async () => {
    const { db, sqlite } = testDb({ schema: false })
    await ensureSchema(db)
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = rows.map((r) => r.name)
    expect(names).toContain('image')
    expect(names).toContain('card_style')
    expect(names).toContain('card_image')
    expect(names).toContain('wish')
    expect(names).toContain('meta')
  })
})

// ---- image table: CHECK constraints ----

describe('image table CHECK constraints (failing until Group 2)', () => {
  it('mime CHECK accepts image/jpeg', async () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO teacher (token, name, subject, created_at) VALUES ('tok1234567890ab','T','','2024-01-01')",
        )
        .run()
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
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890ab','t.gif','image/gif',100,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).toThrow()
  })

  it('mime CHECK rejects image/svg+xml', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890ab','t.svg','image/svg+xml',100,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).toThrow()
  })

  it('mime CHECK accepts image/png', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890ab','t.png','image/png',100,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).not.toThrow()
  })

  it('mime CHECK accepts image/webp', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890ab','t.webp','image/webp',100,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).not.toThrow()
  })

  it('size CHECK rejects size = 0', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890ab','t.png','image/png',0,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).toThrow()
  })

  it('size CHECK rejects size = -1', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890ab','t.png','image/png',-1,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).toThrow()
  })

  it('size CHECK rejects size > 307200', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890ab','t.png','image/png',307201,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).toThrow()
  })

  it('size CHECK accepts size = 1', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890ab','t.png','image/png',1,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).not.toThrow()
  })

  it('size CHECK accepts size = 307200', async () => {
    const { sqlite } = testDb()
    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('tok1234567890ab','t.webp','image/webp',307200,'data','2024-01-01','a@b.com')",
        )
        .run()
    }).not.toThrow()
  })
})

// ---- card_image table: CHECK and FK constraints ----

describe('card_image table constraints (failing until Group 2)', () => {
  it('slot CHECK rejects an unknown slot', async () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    expect(() => {
      // Need teacher + image rows first
      sqlite
        .prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890ab','T','','2024-01-01')")
        .run()
      const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890ab') as { id: number }).id
      sqlite
        .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('imgabc1234567890','t.jpg','image/jpeg',100,'d','2024-01-01','a@b.com')")
        .run()
      const iid = (sqlite.prepare('SELECT id FROM image WHERE token=?').get('imgabc1234567890') as { id: number }).id
      sqlite.prepare(`INSERT INTO card_image (teacher_id,slot,image_id) VALUES (${tid},'unknown_slot',${iid})`).run()
    }).toThrow()
  })

  it('slot CHECK accepts background, banner, photo', async () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890ab','T','','2024-01-01')")
      .run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890ab') as { id: number }).id
    sqlite
      .prepare("INSERT INTO card (teacher_id,message,status,updated_at) VALUES (?,'','draft','2024-01-01')")
      .run(tid)
    for (const slot of ['background', 'banner', 'photo']) {
      const imgToken = `img${slot.slice(0, 4)}123456789`
      sqlite
        .prepare(`INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('${imgToken}','t.jpg','image/jpeg',100,'d','2024-01-01','a@b.com')`)
        .run()
      const iid = (sqlite.prepare('SELECT id FROM image WHERE token=?').get(imgToken) as { id: number }).id
      expect(() => {
        sqlite.prepare(`INSERT INTO card_image (teacher_id,slot,image_id) VALUES (${tid},'${slot}',${iid})`).run()
      }).not.toThrow()
    }
  })

  it('card_image.image_id ON DELETE RESTRICT prevents deleting an image in use', async () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890ab','T','','2024-01-01')")
      .run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890ab') as { id: number }).id
    sqlite
      .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('imgabc1234567890','t.jpg','image/jpeg',100,'d','2024-01-01','a@b.com')")
      .run()
    const iid = (sqlite.prepare('SELECT id FROM image WHERE token=?').get('imgabc1234567890') as { id: number }).id
    sqlite.prepare(`INSERT INTO card_image (teacher_id,slot,image_id) VALUES (${tid},'background',${iid})`).run()
    expect(() => {
      sqlite.prepare(`DELETE FROM image WHERE id=${iid}`).run()
    }).toThrow()
  })

  it('deleting a teacher cascades to card_image rows', async () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890ab','T','','2024-01-01')")
      .run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890ab') as { id: number }).id
    sqlite
      .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES ('imgabc1234567890','t.jpg','image/jpeg',100,'d','2024-01-01','a@b.com')")
      .run()
    const iid = (sqlite.prepare('SELECT id FROM image WHERE token=?').get('imgabc1234567890') as { id: number }).id
    sqlite.prepare(`INSERT INTO card_image (teacher_id,slot,image_id) VALUES (${tid},'background',${iid})`).run()
    sqlite.prepare(`DELETE FROM teacher WHERE id=${tid}`).run()
    const rows = sqlite.prepare(`SELECT * FROM card_image WHERE teacher_id=${tid}`).all()
    expect(rows).toHaveLength(0)
  })
})

// ---- card_style: FK cascade ----

describe('card_style table constraints (failing until Group 2)', () => {
  it('deleting a teacher cascades to card_style row', async () => {
    const { sqlite } = testDb()
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite
      .prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES ('tok1234567890ab','T','','2024-01-01')")
      .run()
    const tid = (sqlite.prepare('SELECT id FROM teacher WHERE token=?').get('tok1234567890ab') as { id: number }).id
    sqlite.prepare(`INSERT INTO card_style (teacher_id,layout) VALUES (${tid},'lotus')`).run()
    sqlite.prepare(`DELETE FROM teacher WHERE id=${tid}`).run()
    const row = sqlite.prepare(`SELECT * FROM card_style WHERE teacher_id=${tid}`).get()
    expect(row).toBeUndefined()
  })
})

// ---- Seeds: 12 wishes inserted once ----

describe('SCHEMA seeds — 12 example wishes (failing until Group 2)', () => {
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
    // Run SCHEMA once via sqlite.exec (bypasses WeakMap) so seeds run
    const { sqlite } = testDb({ schema: false })
    for (const sql of SCHEMA) sqlite.exec(sql)
    // Delete all wishes
    sqlite.exec('DELETE FROM wish')
    expect((sqlite.prepare('SELECT COUNT(*) as c FROM wish').get() as { c: number }).c).toBe(0)
    // Run SCHEMA again — seeds should not fire because meta flag is set
    for (const sql of SCHEMA) sqlite.exec(sql)
    expect((sqlite.prepare('SELECT COUNT(*) as c FROM wish').get() as { c: number }).c).toBe(0)
  })

  it('seeds are counted as DDL by testDb state.ddl', async () => {
    const { db, state } = testDb({ schema: false })
    await ensureSchema(db)
    // All SCHEMA entries (CREATE TABLE + seeds) must be counted
    expect(state.ddl).toBe(SCHEMA.length)
    expect(state.prepares).toBe(0)
  })
})
