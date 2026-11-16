import type { D1 } from './types.ts'

// DDL for the teacher, card, and admin tables, converted to CREATE TABLE IF NOT EXISTS
// so each run is idempotent (a no-op when the tables already exist).
// SHORTCUT: idempotent CREATE only — IF NOT EXISTS cannot alter or drop existing columns;
//   for the first column change, add a schema_version table or move to wrangler d1 migrations.
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS teacher (
  id         INTEGER PRIMARY KEY,
  token      TEXT    UNIQUE NOT NULL,
  name       TEXT           NOT NULL,
  subject    TEXT           NOT NULL DEFAULT '',
  created_at TEXT           NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS card (
  teacher_id INTEGER PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE,
  message    TEXT    NOT NULL,
  status     TEXT    NOT NULL CHECK (status IN ('draft', 'published')),
  updated_at TEXT    NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS admin (
  id         INTEGER PRIMARY KEY,
  email      TEXT    UNIQUE NOT NULL,
  created_at TEXT           NOT NULL,
  created_by TEXT           NOT NULL,
  CHECK (email = lower(email) AND length(email) <= 254)
)`,
]

// Per-isolate cache: one Promise<void> per D1 binding object.
// WeakMap keys are the D1 binding instances so they are garbage-collected with the binding.
const _ready = new WeakMap<D1, Promise<void>>()

/**
 * Ensures SCHEMA tables exist by running a single D1 batch, once per D1 binding per isolate.
 * Concurrent callers share the same promise. On rejection the cache entry is evicted
 * (only if the map still holds that exact promise) so the next request retries.
 * Never logs.
 */
export function ensureSchema(db: D1): Promise<void> {
  const cached = _ready.get(db)
  if (cached !== undefined) return cached

  const p: Promise<void> = db
    .batch(SCHEMA.map((sql) => db.prepare(sql)))
    .then(() => undefined)

  // Attach .catch to p itself (not to the returned promise) so callers still receive
  // the rejection while the side-effect evicts the cache entry.
  p.catch(() => {
    // Evict only if the map still holds this promise — guards against a race where a newer
    // call already installed a fresh promise before this catch fires.
    if (_ready.get(db) === p) _ready.delete(db)
  })

  _ready.set(db, p)
  return p
}
