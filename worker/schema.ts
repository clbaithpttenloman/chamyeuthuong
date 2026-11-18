import type { D1 } from './types.ts'
import { SEEDS } from './seed.ts'
import { aboutSeedSql } from './aboutSeed.ts'

// DDL for all tables, converted to CREATE TABLE IF NOT EXISTS so each run is idempotent.
// IF NOT EXISTS never alters an existing table: any column change also needs an upgrade
// step in UPGRADES below, or databases created by an older deploy keep the old shape.
// SHORTCUT: probe-and-rebuild upgrades — move to a schema_version table or
//   wrangler d1 migrations once there are more than a few of them.
// Chức vụ column; the same definition is used by CREATE and by the ADD COLUMN upgrade.
// Labels must match ROLES in shared/api.ts (tested).
const ROLE_COLUMN =
  "TEXT NOT NULL DEFAULT 'Giáo viên' CHECK (role IN ('Giáo viên','Hiệu trưởng','Phó hiệu trưởng'))"

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
  show_on_home INTEGER NOT NULL DEFAULT 1 CHECK (show_on_home IN (0,1)),
  role         ${ROLE_COLUMN}
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

const TEACHER_PROFILE_DDL = SCHEMA.find((q) => q.includes('IF NOT EXISTS teacher_profile ('))!

const PROFILE_COLUMNS_SQL = "PRAGMA table_info('teacher_profile')"

/**
 * In-place upgrades for databases created by older deploys, run in order. Each entry checks
 * the live teacher_profile columns and, only if the table is old, runs its SQL in one batch
 * (one D1 transaction, so a failure rolls back and the next request retries).
 */
const UPGRADES: { needed(cols: Set<string>): boolean; sql: string[] }[] = [
  {
    // 4d3a5df had teacher_profile.public_id TEXT UNIQUE NOT NULL; the column was removed in
    // plan 2026-11-18-privacy-about. SQLite cannot DROP a UNIQUE column, so copy the table.
    // Nothing references teacher_profile, so dropping it violates no foreign key.
    // The new table comes from the current DDL, so copied rows get role's default.
    // `!role` stops the re-probe inside runUpgrades from repeating the copy. It cannot stop an
    // isolate whose probe ran before another isolate's rebuild committed; that replay resets
    // role to the default, which only matters if an admin set a role in that same instant.
    needed: (cols) => cols.has('public_id') && !cols.has('role'),
    sql: [
      TEACHER_PROFILE_DDL.replace('IF NOT EXISTS teacher_profile (', 'teacher_profile_new ('),
      'INSERT INTO teacher_profile_new (teacher_id, department, show_on_home) ' +
        'SELECT teacher_id, department, show_on_home FROM teacher_profile',
      'DROP TABLE teacher_profile',
      'ALTER TABLE teacher_profile_new RENAME TO teacher_profile',
    ],
  },
  {
    // Chức vụ added in plan 2026-11-18-teacher-role. Existing rows get 'Giáo viên'.
    // Two isolates racing here: the loser fails with "duplicate column name", returns one 503,
    // and the retry sees the column and skips.
    needed: (cols) => !cols.has('role'),
    sql: [`ALTER TABLE teacher_profile ADD COLUMN role ${ROLE_COLUMN}`],
  },
]

/** Every SQL string the upgrade step can prepare (probes included); testDb counts these as DDL. */
export const UPGRADE_SQL: string[] = [PROFILE_COLUMNS_SQL, ...UPGRADES.flatMap((u) => u.sql)]

async function profileColumns(db: D1): Promise<Set<string>> {
  const { results } = await db.prepare(PROFILE_COLUMNS_SQL).all<{ name: string }>()
  return new Set(results.map((c) => c.name))
}

async function runUpgrades(db: D1): Promise<void> {
  // One probe on an up-to-date database; re-probe only after a step changed the table.
  let cols = await profileColumns(db)
  for (const u of UPGRADES) {
    if (!u.needed(cols)) continue
    // Fixed string only: tells an operator this 503 is a failed upgrade, not a D1 outage.
    await db.batch(u.sql.map((q) => db.prepare(q))).catch((e: unknown) => {
      console.error('schema: upgrade failed')
      throw e
    })
    cols = await profileColumns(db)
  }
}

// Per-isolate cache: one Promise<void> per D1 binding object.
// WeakMap keys are the D1 binding instances so they are garbage-collected with the binding.
const _ready = new WeakMap<D1, Promise<void>>()

/**
 * Ensures SCHEMA tables exist by running a single D1 batch, then applies any needed
 * UPGRADES, once per D1 binding per isolate.
 * Concurrent callers share the same promise. On rejection the cache entry is evicted
 * (only if the map still holds that exact promise) so the next request retries.
 * Never logs.
 */
export function ensureSchema(db: D1): Promise<void> {
  const cached = _ready.get(db)
  if (cached !== undefined) return cached

  const p: Promise<void> = db
    .batch(SCHEMA.map((sql) => db.prepare(sql)))
    .then(() => runUpgrades(db))

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
