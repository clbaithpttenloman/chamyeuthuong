import type { D1 } from './types.ts'
import { SEEDS } from './seed.ts'

// DDL for all tables, converted to CREATE TABLE IF NOT EXISTS so each run is idempotent.
// SHORTCUT: idempotent CREATE only — IF NOT EXISTS cannot alter or drop existing columns;
//   for the first column change, add a schema_version table or move to wrangler d1 migrations.
export const SCHEMA: string[] = [
  // ---- Original tables ----
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
  // ---- New tables (Group 2) ----
  `CREATE TABLE IF NOT EXISTS image (
  id         INTEGER PRIMARY KEY,
  token      TEXT    UNIQUE NOT NULL,
  name       TEXT           NOT NULL,
  mime       TEXT           NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  size       INTEGER        NOT NULL CHECK (size > 0 AND size <= 307200),
  data       TEXT           NOT NULL,
  created_at TEXT           NOT NULL,
  created_by TEXT           NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS card_style (
  teacher_id INTEGER PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE,
  layout     TEXT    NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS teacher_title (
  teacher_id INTEGER PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL CHECK (title IN ('Thầy','Cô'))
)`,
  `CREATE TABLE IF NOT EXISTS card_image (
  teacher_id INTEGER NOT NULL REFERENCES teacher(id) ON DELETE CASCADE,
  slot       TEXT    NOT NULL CHECK (slot IN ('background','banner','photo')),
  image_id   INTEGER NOT NULL REFERENCES image(id) ON DELETE RESTRICT,
  PRIMARY KEY (teacher_id, slot)
)`,
  `CREATE TABLE IF NOT EXISTS wish (
  id         INTEGER PRIMARY KEY,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  created_by TEXT    NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  // ---- Seeds: 12 example wishes + meta flag (run once, guarded by meta flag) ----
  ...SEEDS,
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
