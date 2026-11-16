// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Minimal D1 binding types (no @cloudflare/workers-types). Matches worker/types.ts. */
export type D1Stmt = {
  bind(...values: unknown[]): D1Stmt
  run(): Promise<{ success: boolean; meta: { changes: number } }>
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}
export type D1 = {
  prepare(sql: string): D1Stmt
  batch(statements: D1Stmt[]): Promise<{ success: boolean; meta: { changes: number } }[]>
}

/**
 * Node's built-in node:sqlite behind the D1 API shape, with all migrations/*.sql applied from
 * disk in sorted order so tests run the real schema. state.fail makes every call throw
 * (D1 outage simulation). state.prepares counts db.prepare() calls (for atomicity assertions).
 */
export function testDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')

  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations')
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8')
    sqlite.exec(sql)
  }

  const state = { writes: 0, reads: 0, fail: false, prepares: 0 }

  const stmt = (sql: string, values: unknown[] = []): D1Stmt => {
    const exec = async <T>(fn: () => T): Promise<T> => {
      if (state.fail) throw new Error('D1_ERROR: simulated failure')
      return fn()
    }
    const args = values as (string | number | null)[]
    return {
      bind: (...v: unknown[]) => stmt(sql, v),
      run: () =>
        exec(() => {
          const r = sqlite.prepare(sql).run(...args)
          state.writes += Number(r.changes)
          return { success: true, meta: { changes: Number(r.changes) } }
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
      state.prepares++
      return stmt(sql)
    },
    batch: async (statements) => {
      if (state.fail) throw new Error('D1_ERROR: simulated failure')
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

  return { db, sqlite, state }
}
