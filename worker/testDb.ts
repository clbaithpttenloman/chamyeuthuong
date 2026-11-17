// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA } from './schema.ts'

/** Minimal D1 binding types (no @cloudflare/workers-types). Matches worker/types.ts. */
export type D1Stmt = {
  bind(...values: unknown[]): D1Stmt
  run(): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }>
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}
export type D1 = {
  prepare(sql: string): D1Stmt
  batch(statements: D1Stmt[]): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }[]>
}

/**
 * Node's built-in node:sqlite behind the D1 API shape.
 *
 * Schema source: SCHEMA from worker/schema.ts (single source of truth for all DDL).
 * Pass { schema: false } to get a fully empty database (useful for testing ensureSchema itself
 * or early-exit paths that must leave the DB untouched).
 *
 * state.fail   — when true, every batch and stmt op throws (D1 outage simulation).
 * state.ddl    — counts db.prepare() calls whose sql is a member of SCHEMA.
 * state.prepares — counts db.prepare() calls for all other (non-DDL) sql strings.
 *
 * The batch is genuinely transactional: BEGIN before the first run(), COMMIT on success,
 * ROLLBACK on any error.
 */
export function testDb(opts: { schema?: false } = {}) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')

  // Apply schema via sqlite.exec() directly so the initialisation is invisible to state
  // tracking (state.ddl / state.prepares start at 0 for the caller's assertions).
  if (opts.schema !== false) {
    for (const sql of SCHEMA) {
      sqlite.exec(sql)
    }
  }

  const state = { writes: 0, reads: 0, fail: false, prepares: 0, ddl: 0 }

  const stmt = (sql: string, values: unknown[] = []): D1Stmt => {
    const exec = async <T>(fn: () => T): Promise<T> => {
      if (state.fail) throw new Error('D1_ERROR: simulated failure')
      return fn()
    }
    const args = values as (string | number | null)[]
    return {
      bind: (...v: unknown[]) => {
        if (v.length > 100) throw new Error('too many SQL variables')
        return stmt(sql, v)
      },
      run: () =>
        exec(() => {
          const r = sqlite.prepare(sql).run(...args)
          state.writes += Number(r.changes)
          return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid ?? 0) } }
        }),
      first: <T>(column?: string) =>
        exec(() => {
          const row = sqlite.prepare(sql).get(...args) as Record<string, unknown> | undefined
          state.reads += row ? 1 : 0
          return (row ? (column !== undefined ? row[column] : { ...row }) : null) as T | null
        }),
      all: <T>() =>
        exec(() => {
          const results = sqlite.prepare(sql).all(...args).map((r) => ({ ...r })) as T[]
          state.reads += results.length
          return { results }
        }),
    }
  }

  const db: D1 = {
    prepare: (sql) => {
      // DDL statements (members of SCHEMA) are counted separately so atomicity tests that
      // count non-DDL prepare() calls remain stable across ensureSchema integration.
      if (SCHEMA.includes(sql)) {
        state.ddl++
      } else {
        state.prepares++
      }
      return stmt(sql)
    },
    batch: async (statements) => {
      if (state.fail) throw new Error('D1_ERROR: simulated failure')
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

  return { db, sqlite, state }
}
