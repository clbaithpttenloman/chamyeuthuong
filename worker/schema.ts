import type { D1 } from './types.ts'
import { SEEDS } from './seed.ts'
import { aboutSeedSql } from './aboutSeed.ts'
import SITE_CONTENT from '../src/content/site.json'

// DDL for all tables, converted to CREATE TABLE IF NOT EXISTS so each run is idempotent.
// IF NOT EXISTS never alters an existing table: any column change also needs an upgrade
// step in UPGRADES below, or databases created by an older deploy keep the old shape.
// SHORTCUT: probe-and-rebuild upgrades — move to a schema_version table or
//   wrangler d1 migrations once there are more than a few of them.
// Card v3 columns on student_card (also used by the ADD COLUMN upgrades). Font ids are checked
// in the app (shared/fonts.ts) so the list can change without a table rebuild; only the length
// is bounded here. Ink is always stored as lowercase #rrggbb.
const FONT_COLUMN = "TEXT NOT NULL DEFAULT 'patrick-hand' CHECK (length(font) <= 32)"
const INK_COLUMN =
  "TEXT NOT NULL DEFAULT '#1d3fa6' CHECK (ink GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')"

// Chức vụ column; the same definition is used by CREATE and by the ADD COLUMN upgrade.
// Labels must match ROLES in shared/api.ts (tested).
const ROLE_COLUMN =
  "TEXT NOT NULL DEFAULT 'Giáo viên' CHECK (role IN ('Giáo viên','Hiệu trưởng','Phó hiệu trưởng'))"

// campaign_id column added to template, wish, student_card via ALTER TABLE (ADR-2).
// SQLite rejects ADD COLUMN … REFERENCES … DEFAULT <non-null>, so there is no FK here.
// campaign 1 is inserted before every ADD COLUMN so the DEFAULT 1 is always valid.
const CAMPAIGN_ID_COLUMN = 'INTEGER NOT NULL DEFAULT 1'

// Content for campaign 1 (20/11) is derived from src/content/site.json .home.
const CAMPAIGN_1_CONTENT = JSON.stringify((SITE_CONTENT as { home: unknown }).home).replace(/'/g, "''")

/** SQL for the campaign upgrade: conditional INSERT for campaign 1 then per-table ADD COLUMN + index.
 *  The INSERT uses WHERE EXISTS (SELECT 1 FROM template) so a fresh empty DB does not
 *  get an active campaign (which would break the partial-unique-index tests).
 *  Exported so testDb() can apply them directly to represent a fully-upgraded live DB baseline.
 */
export const CAMPAIGN_UPGRADE_SQLS: string[] = [
  // Insert campaign 1 only when old data exists (ADR-2). INSERT OR IGNORE is safe for concurrent runs.
  `INSERT OR IGNORE INTO campaign (id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) ` +
    `SELECT 1, '20-11', 'teacher_cards', 'Ngày 20/11', 'Tri ân thầy cô', '${CAMPAIGN_1_CONTENT}', '{}', '{}', '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z', 'active', datetime('now'), 'upgrade' ` +
    `WHERE EXISTS (SELECT 1 FROM template)`,
  'ALTER TABLE template ADD COLUMN campaign_id ' + CAMPAIGN_ID_COLUMN,
  'CREATE INDEX IF NOT EXISTS idx_template_campaign_id ON template(campaign_id)',
  'ALTER TABLE wish ADD COLUMN campaign_id ' + CAMPAIGN_ID_COLUMN,
  'CREATE INDEX IF NOT EXISTS idx_wish_campaign_id ON wish(campaign_id)',
  'ALTER TABLE student_card ADD COLUMN campaign_id ' + CAMPAIGN_ID_COLUMN,
  'CREATE INDEX IF NOT EXISTS idx_student_card_campaign_id ON student_card(campaign_id)',
]

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
  slot        TEXT    NOT NULL CHECK (slot IN ('background')),
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
  reviewed_by TEXT,
  font        ${FONT_COLUMN},
  ink         ${INK_COLUMN}
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
  // ---- Campaign platform (ADR-1, ADR-2) ----
  // campaign_id on template/wish/student_card is added via UPGRADES (ALTER TABLE), not here,
  // because the SCHEMA batch runs on old DBs too and CREATE INDEX on a column that does not
  // yet exist would fail. See CAMPAIGN_UPGRADE_SQLS below.
  `CREATE TABLE IF NOT EXISTS campaign (
  id          INTEGER PRIMARY KEY,
  slug        TEXT    UNIQUE NOT NULL
              CHECK (length(slug) BETWEEN 2 AND 32 AND NOT slug GLOB '*[^a-z0-9-]*'),
  kind        TEXT    NOT NULL CHECK (kind IN ('teacher_cards','gift_tree')),
  name        TEXT    NOT NULL DEFAULT '',
  tagline     TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL DEFAULT '{}',
  theme_colors TEXT   NOT NULL DEFAULT '{}',
  settings    TEXT    NOT NULL DEFAULT '{}',
  starts_at   TEXT    NOT NULL,
  ends_at     TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','active','closed')),
  created_at  TEXT    NOT NULL,
  created_by  TEXT    NOT NULL
)`,
  // Partial unique index: at most one active campaign at a time (FR-2 / ADR-1).
  `CREATE UNIQUE INDEX IF NOT EXISTS one_active ON campaign(status) WHERE status = 'active'`,
  // ---- Seeds: 12 example wishes + meta flag (run once, guarded by meta flag) ----
  ...SEEDS,
  // ---- About seed (INSERT OR IGNORE — idempotent) ----
  aboutSeedSql(),
]

const TEACHER_PROFILE_DDL = SCHEMA.find((q) => q.includes('IF NOT EXISTS teacher_profile ('))!

type Table = 'teacher_profile' | 'student_card'
const columnsSql = (t: Table) => `PRAGMA table_info('${t}')`
const TABLES: Table[] = ['teacher_profile', 'student_card']

/**
 * In-place upgrades for databases created by older deploys, run in order. Each entry checks
 * the live columns of its own table and, only if they are old, runs its SQL in one batch
 * (one D1 transaction, so a failure rolls back and the next request retries).
 * Entries with `runFn` run per-SQL instead of as a single batch (used when partial state
 * is possible, e.g. when only some tables may need the new column).
 */
const UPGRADES: {
  table: Table
  needed(cols: Set<string>): boolean
  sql: string[]
  runFn?: (db: D1) => Promise<void>
}[] = [
  {
    // 4d3a5df had teacher_profile.public_id TEXT UNIQUE NOT NULL; the column was removed in
    // plan 2026-11-18-privacy-about. SQLite cannot DROP a UNIQUE column, so copy the table.
    // Nothing references teacher_profile, so dropping it violates no foreign key.
    // The new table comes from the current DDL, so copied rows get role's default.
    // `!role` stops the re-probe inside runUpgrades from repeating the copy. It cannot stop an
    // isolate whose probe ran before another isolate's rebuild committed; that replay resets
    // role to the default, which only matters if an admin set a role in that same instant.
    table: 'teacher_profile',
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
    // Two isolates racing an ADD COLUMN: the loser fails with "duplicate column name",
    // returns one 503, and the retry sees the column and skips. Same for font and ink.
    table: 'teacher_profile',
    needed: (cols) => !cols.has('role'),
    sql: [`ALTER TABLE teacher_profile ADD COLUMN role ${ROLE_COLUMN}`],
  },
  {
    // Card v3: the student's font and ink. Existing cards get Bút bi and blue.
    table: 'student_card',
    needed: (cols) => !cols.has('font'),
    sql: [`ALTER TABLE student_card ADD COLUMN font ${FONT_COLUMN}`],
  },
  {
    table: 'student_card',
    needed: (cols) => !cols.has('ink'),
    sql: [`ALTER TABLE student_card ADD COLUMN ink ${INK_COLUMN}`],
  },
  {
    // ADR-2: add campaign_id (DEFAULT 1) to the three legacy tables, preceded by an
    // INSERT OR IGNORE for campaign 1 so the default value is always valid.
    // The `sql` field lists all 7 statements so UPGRADE_SQL includes them for the testDb
    // ddl counter. The `runFn` runs each SQL individually, catching only "duplicate column
    // name" so a partially-upgraded DB (template/wish already have campaign_id but
    // student_card does not) is handled without failing the whole batch.
    table: 'student_card',
    needed: (cols) => !cols.has('campaign_id'),
    sql: CAMPAIGN_UPGRADE_SQLS,
    runFn: async (db: D1) => {
      for (const sql of CAMPAIGN_UPGRADE_SQLS) {
        await db.batch([db.prepare(sql)]).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e)
          // ALTER TABLE … ADD COLUMN fails with "duplicate column name: campaign_id" if the
          // column was already added by a concurrent isolate or a prior partial upgrade.
          // CREATE INDEX … IF NOT EXISTS never throws on a duplicate; INSERT OR IGNORE never
          // fails on a PK conflict. Any other error is a real failure that must propagate.
          if (msg.includes('duplicate column name')) return
          throw e
        })
      }
    },
  },
]

// ---- One-time seed: six mockup backgrounds + one example template each (card v3) ----
// Guarded by a meta flag; every statement repeats the guard so a racing isolate inserts
// nothing, and the flag is written last in the same batch. INSERT-only: never updates or
// deletes an image or template. Data is bound, so the 100 KB SQL-text limit does not apply.

export const IMAGES_SEEDED_KEY = 'images_seeded'
const SEED_ABSENT = `NOT EXISTS (SELECT 1 FROM meta WHERE key = '${IMAGES_SEEDED_KEY}')`
const SEED_PROBE_SQL = `SELECT 1 AS done FROM meta WHERE key = '${IMAGES_SEEDED_KEY}'`
const SEED_IMAGE_SQL =
  'INSERT OR IGNORE INTO image (token, name, mime, size, data, created_at, created_by) ' +
  `SELECT ?, ?, 'image/webp', ?, ?, ?, 'seed' WHERE ${SEED_ABSENT}`
const SEED_TEMPLATE_SQL =
  'INSERT INTO template (name, layout, active, created_at, created_by) ' +
  `SELECT ?, ?, 1, ?, 'seed' WHERE ${SEED_ABSENT}`
// Links only a template created by the seed (created_by = 'seed') to the image with the seed token.
const SEED_LINK_SQL =
  'INSERT OR IGNORE INTO template_image (template_id, slot, image_id) ' +
  "SELECT t.id, 'background', i.id FROM template t JOIN image i ON i.token = ? " +
  `WHERE t.created_by = 'seed' AND t.name = ? AND ${SEED_ABSENT}`
const SEED_FLAG_SQL = `INSERT OR IGNORE INTO meta (key, value) VALUES ('${IMAGES_SEEDED_KEY}', ?)`

/** Statements in the seed batch: image + template + link per seed image, then the flag. */
export const SEED_STATEMENT_COUNT = 6 * 3 + 1

/**
 * Best-effort: a failure logs a fixed string and never rejects, so it cannot 503 the site.
 * It runs inside ensureSchema's cached promise, so each isolate attempts it at most once.
 */
async function seedImages(db: D1): Promise<void> {
  try {
    if (await db.prepare(SEED_PROBE_SQL).first()) return
    const { SEED_IMAGES } = await import('./seedImages.ts')
    const now = new Date().toISOString()
    const stmts = [
      ...SEED_IMAGES.map((s) => db.prepare(SEED_IMAGE_SQL).bind(s.token, s.name, s.size, s.data, now)),
      ...SEED_IMAGES.map((s) => db.prepare(SEED_TEMPLATE_SQL).bind(s.name, s.layout, now)),
      ...SEED_IMAGES.map((s) => db.prepare(SEED_LINK_SQL).bind(s.token, s.name)),
      db.prepare(SEED_FLAG_SQL).bind(now),
    ]
    await db.batch(stmts)
  } catch {
    console.error('schema: seed images failed')
  }
}

/** Every SQL string the upgrade and seed steps can prepare (probes included); testDb counts these as DDL. */
export const UPGRADE_SQL: string[] = [
  ...TABLES.map(columnsSql),
  ...UPGRADES.flatMap((u) => u.sql),
  SEED_PROBE_SQL, SEED_IMAGE_SQL, SEED_TEMPLATE_SQL, SEED_LINK_SQL, SEED_FLAG_SQL,
]

async function tableColumns(db: D1, table: Table): Promise<Set<string>> {
  const { results } = await db.prepare(columnsSql(table)).all<{ name: string }>()
  return new Set(results.map((c) => c.name))
}

async function runUpgrades(db: D1): Promise<void> {
  // One probe per table on an up-to-date database; re-probe a table only after one of its
  // steps changed it.
  const cols = new Map<Table, Set<string>>()
  for (const t of TABLES) cols.set(t, await tableColumns(db, t))
  for (const u of UPGRADES) {
    if (!u.needed(cols.get(u.table)!)) continue
    if (u.runFn) {
      // Per-SQL execution for entries that must tolerate partial state (e.g. some tables
      // already upgraded). The runFn is responsible for its own error handling.
      await u.runFn(db).catch((e: unknown) => {
        console.error('schema: upgrade failed')
        throw e
      })
    } else {
      // Fixed string only: tells an operator this 503 is a failed upgrade, not a D1 outage.
      await db.batch(u.sql.map((q) => db.prepare(q))).catch((e: unknown) => {
        console.error('schema: upgrade failed')
        throw e
      })
    }
    cols.set(u.table, await tableColumns(db, u.table))
  }
}

// Per-isolate cache: one Promise<void> per D1 binding object.
// WeakMap keys are the D1 binding instances so they are garbage-collected with the binding.
const _ready = new WeakMap<D1, Promise<void>>()

/**
 * Ensures SCHEMA tables exist by running a single D1 batch, then applies any needed
 * UPGRADES and the one-time image seed, once per D1 binding per isolate.
 * The seed is best-effort and never rejects.
 * Concurrent callers share the same promise. On rejection the cache entry is evicted
 * (only if the map still holds that exact promise) so the next request retries.
 * Logs only fixed strings: `schema: upgrade failed`, `schema: seed images failed`.
 */
export function ensureSchema(db: D1): Promise<void> {
  const cached = _ready.get(db)
  if (cached !== undefined) return cached

  const p: Promise<void> = db
    .batch(SCHEMA.map((sql) => db.prepare(sql)))
    .then(() => runUpgrades(db))
    .then(() => seedImages(db))

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
