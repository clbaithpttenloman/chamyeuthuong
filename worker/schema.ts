import type { D1 } from './types.ts'
import { SEEDS } from './seed.ts'
import { aboutSeedSql } from './aboutSeed.ts'

// DDL for all tables, converted to CREATE TABLE IF NOT EXISTS so each run is idempotent.
// SHORTCUT: idempotent CREATE only — IF NOT EXISTS cannot alter or drop existing columns;
//   for the first column change, add a schema_version table or move to wrangler d1 migrations.
export const SCHEMA: string[] = [
  // ---- Core tables ----
  `CREATE TABLE IF NOT EXISTS teacher (
  id         INTEGER PRIMARY KEY,
  token      TEXT    UNIQUE NOT NULL,
  name       TEXT           NOT NULL,
  subject    TEXT           NOT NULL DEFAULT '',
  created_at TEXT           NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS teacher_title (
  teacher_id INTEGER PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL CHECK (title IN ('Thầy','Cô'))
)`,
  `CREATE TABLE IF NOT EXISTS teacher_profile (
  teacher_id   INTEGER PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE,
  department   TEXT    NOT NULL DEFAULT '',
  show_on_home INTEGER NOT NULL DEFAULT 1 CHECK (show_on_home IN (0,1))
)`,
  `CREATE TABLE IF NOT EXISTS admin (
  id         INTEGER PRIMARY KEY,
  email      TEXT    UNIQUE NOT NULL,
  created_at TEXT           NOT NULL,
  created_by TEXT           NOT NULL,
  CHECK (email = lower(email) AND length(email) <= 254)
)`,
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
  `CREATE TABLE IF NOT EXISTS template (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  layout     TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT    NOT NULL,
  created_by TEXT    NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS template_image (
  template_id INTEGER NOT NULL REFERENCES template(id) ON DELETE CASCADE,
  slot        TEXT    NOT NULL CHECK (slot IN ('background','banner')),
  image_id    INTEGER NOT NULL REFERENCES image(id) ON DELETE RESTRICT,
  PRIMARY KEY (template_id, slot)
)`,
  `CREATE TABLE IF NOT EXISTS student_card (
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
)`,
  `CREATE INDEX IF NOT EXISTS idx_student_card_teacher_status ON student_card (teacher_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_student_card_status_created ON student_card (status, created_at)`,
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
  `CREATE TABLE IF NOT EXISTS site_content (
  key        TEXT PRIMARY KEY CHECK (key IN ('about')),
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
)`,
  // ---- Seeds: 12 example wishes + meta flag (run once, guarded by meta flag) ----
  ...SEEDS,
  // ---- About seed (INSERT OR IGNORE — idempotent) ----
  aboutSeedSql(),
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
