// @vitest-environment node
/**
 * Tests for worker/schema.ts (does not exist yet — these tests will fail at import time
 * until Group 2 creates the module).
 */
import { describe, it, expect } from 'vitest'
import { SCHEMA, ensureSchema } from './schema.ts'
import { testDb } from './testDb.ts'

// ---- SCHEMA shape ----

describe('SCHEMA shape', () => {
  it('is a non-empty string array', () => {
    expect(Array.isArray(SCHEMA)).toBe(true)
    expect(SCHEMA.length).toBeGreaterThan(0)
    for (const s of SCHEMA) expect(typeof s).toBe('string')
  })

  it('every entry starts with CREATE TABLE IF NOT EXISTS', () => {
    for (const s of SCHEMA) {
      expect(s.trim().toUpperCase()).toMatch(/^CREATE TABLE IF NOT EXISTS\s/)
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

  it('stale rejection handler does not evict a newer cached promise (evict only if map entry === p)', async () => {
    // After p1 fails → evicted → p2 created and succeeds → p3 returns cached p2.
    // The guard `ready.get(db) === p` ensures p1's catch cannot evict p2 if it
    // fires late (defensive coding).
    const { db, state } = testDb({ schema: false })
    state.fail = true
    await expect(ensureSchema(db)).rejects.toThrow()

    state.fail = false
    const p2 = ensureSchema(db) // new promise after eviction
    const p3 = ensureSchema(db) // must return the same p2 (cached)
    expect(p3).toBe(p2) // guard: p2 is in cache, not prematurely evicted
    await p2

    // After success, further calls still use the cached promise (no second batch)
    const ddlNow = state.ddl
    await ensureSchema(db)
    expect(state.ddl).toBe(ddlNow)
  })
})

// ---- ensureSchema — batch rollback ----

describe('ensureSchema — batch rollback', () => {
  it('a failing batch leaves no tables (all-or-nothing transaction atomicity)', async () => {
    const { db, state, sqlite } = testDb({ schema: false })
    state.fail = true
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
