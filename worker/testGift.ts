// @vitest-environment node
/**
 * Shared test helpers for Phase 2: gifts, hearts, reports, gift moderation, deletion.
 *
 * createGiftTables(sqlite) — creates gift, heart, report, banned_identity tables on the
 * sqlite handle obtained from testDb(). This matches the Phase 2 DDL from plan.md "Data model".
 * Call this in beforeEach for any test that needs these tables.
 *
 * After Phase 2 implementation, these tables will be in SCHEMA so testDb() creates them
 * automatically; createGiftTables() will then be a safe no-op (IF NOT EXISTS).
 *
 * Env builders:
 *   giftsEnv(db, opts?)     → GiftsEnv  for handleGifts
 *   giftModerationEnv(db)   → GiftModerationEnv  for handleGiftModeration
 *   deletionMeEnv(db, opts?) → DeletionMeEnv  for handleMe DELETE (Phase 2)
 *
 * Seeders:
 *   seedGiftCampaign(db, opts?) → campaignId  (gift_tree campaign)
 *   seedTemplate(db, campaignId) → templateId  (active template linked to campaign)
 *   seedGift(db, userId, campaignId, templateId, opts?) → { id, publicId }
 */

import type { DatabaseSync } from 'node:sqlite'
import type { D1 } from './testDb.ts'
import { seedUser as _seedUser, seedSession as _seedSession, SESSION_COOKIE_NAME } from './testGoogle.ts'

export { SESSION_COOKIE_NAME }
export { seedUser, seedSession } from './testGoogle.ts'

// ── Phase 2 DDL ───────────────────────────────────────────────────────────────

/**
 * Creates the Phase 2 gift-game tables on a sqlite handle from testDb().
 * Mirrors plan.md "Data model" exactly (gift, heart, report, banned_identity).
 * Safe to call multiple times (IF NOT EXISTS).
 */
export function createGiftTables(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS gift (
      id                     INTEGER PRIMARY KEY,
      public_id              TEXT    UNIQUE NOT NULL,
      campaign_id            INTEGER NOT NULL REFERENCES campaign(id),
      user_id                INTEGER NOT NULL REFERENCES app_user(id),
      box_style              INTEGER NOT NULL CHECK (box_style BETWEEN 1 AND 6),
      ornament_style         INTEGER NOT NULL CHECK (ornament_style BETWEEN 1 AND 6),
      layout                 TEXT    NOT NULL DEFAULT '',
      background_template_id INTEGER REFERENCES template(id),
      font                   TEXT    NOT NULL DEFAULT '',
      ink                    TEXT    NOT NULL DEFAULT '',
      message                TEXT    NOT NULL CHECK (length(message) BETWEEN 1 AND 300),
      nickname               TEXT    NOT NULL CHECK (length(nickname) BETWEEN 1 AND 30),
      class_name             TEXT    NOT NULL DEFAULT '' CHECK (length(class_name) <= 10),
      heart_count            INTEGER NOT NULL DEFAULT 0,
      report_count           INTEGER NOT NULL DEFAULT 0,
      status                 TEXT    NOT NULL DEFAULT 'visible'
                             CHECK (status IN ('visible','hidden_auto','hidden_admin','deleted')),
      status_before_ban      TEXT,
      created_at             TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gift_rank ON gift(campaign_id, status, heart_count DESC, created_at);

    CREATE TABLE IF NOT EXISTS heart (
      gift_id    INTEGER NOT NULL REFERENCES gift(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      day        TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      PRIMARY KEY (gift_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS heart_user_day ON heart(user_id, day);

    CREATE TABLE IF NOT EXISTS report (
      gift_id      INTEGER NOT NULL REFERENCES gift(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      reason       TEXT    NOT NULL CHECK (reason IN ('inappropriate','spam','other')),
      acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0,1)),
      created_at   TEXT    NOT NULL,
      PRIMARY KEY (gift_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS banned_identity (
      sub_hmac   TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
  `)
}

// ── Rate-limiter fakes ────────────────────────────────────────────────────────

type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> }
const fakeLimit = (): Limiter => ({ limit: async () => ({ success: true }) })
const fakeLimitFail = (): Limiter => ({ limit: async () => ({ success: false }) })

// ── GiftsEnv ──────────────────────────────────────────────────────────────────

/**
 * Env for handleGifts (worker/gifts.ts, to be created in Phase 2).
 *
 * Rate-limit bindings (plan API section):
 *   GIFT_LIMIT   — 6/60 s per user (namespace 2011 prod / 3011 staging)
 *   HEART_LIMIT  — 20/60 s per user (namespace 2012 / 3012)
 *   REPORT_LIMIT — 10/60 s per user (namespace 2013 / 3013)
 */
export type GiftsEnv = {
  DB: D1
  GIFT_LIMIT: Limiter
  HEART_LIMIT: Limiter
  REPORT_LIMIT: Limiter
}

export function giftsEnv(
  db: D1,
  opts: {
    giftLimitFail?: boolean
    heartLimitFail?: boolean
    reportLimitFail?: boolean
  } = {},
): GiftsEnv {
  return {
    DB: db,
    GIFT_LIMIT: opts.giftLimitFail ? fakeLimitFail() : fakeLimit(),
    HEART_LIMIT: opts.heartLimitFail ? fakeLimitFail() : fakeLimit(),
    REPORT_LIMIT: opts.reportLimitFail ? fakeLimitFail() : fakeLimit(),
  }
}

// ── GiftModerationEnv ─────────────────────────────────────────────────────────

/**
 * Env for handleGiftModeration (new function to be added to worker/moderation.ts in Phase 2).
 *
 * handleGiftModeration calls requireAdmin without opts.legacy — Google session required.
 * Passing ADMIN_LEGACY_LOGIN: '1' + a typed email header still returns 401.
 */
export type GiftModerationEnv = {
  DB: D1
  ADMIN_FAIL_LIMIT: Limiter
  ADMIN_LEGACY_LOGIN?: string
  BOOTSTRAP_EMAIL?: string
  ALLOW_FIRST_CLAIM?: string
}

export function giftModerationEnv(
  db: D1,
  opts: {
    failLimit?: boolean
    legacyLogin?: string
  } = {},
): GiftModerationEnv {
  return {
    DB: db,
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: !opts.failLimit }) },
    // Keep the flag on so we can test that typed email is still rejected
    ADMIN_LEGACY_LOGIN: 'legacyLogin' in opts ? opts.legacyLogin : '1',
  }
}

// ── DeletionEnv ───────────────────────────────────────────────────────────────

/**
 * Extended env for handleMe DELETE (Phase 2 behavior).
 * Adds SUB_HMAC_KEY over the Phase 1 MeTestEnv.
 *
 * The handler uses SUB_HMAC_KEY to compute HMAC(sub) before writing banned_identity.
 * Missing key MUST fail closed (refuse the deletion for banned users).
 */
export type DeletionEnv = {
  DB: D1
  GOOGLE_CLIENT_ID: string
  NONCE_KEY: string
  AUTH_LIMIT: Limiter
  ADMIN_FAIL_LIMIT: Limiter
  ADMIN_LEGACY_LOGIN?: string
  /** Required for banned-user deletion. Missing → fail closed. */
  SUB_HMAC_KEY?: string
}

export const TEST_SUB_HMAC_KEY = 'test-sub-hmac-key-32bytes-padded'

export function deletionEnv(
  db: D1,
  opts: {
    subHmacKey?: string
    legacyLogin?: string
  } = {},
): DeletionEnv {
  return {
    DB: db,
    GOOGLE_CLIENT_ID: 'test-client-123.apps.googleusercontent.com',
    NONCE_KEY: 'test-nonce-key-32bytes-paddingXX',
    AUTH_LIMIT: fakeLimit(),
    ADMIN_FAIL_LIMIT: fakeLimit(),
    ADMIN_LEGACY_LOGIN: 'legacyLogin' in opts ? opts.legacyLogin : '1',
    SUB_HMAC_KEY: 'subHmacKey' in opts ? opts.subHmacKey : TEST_SUB_HMAC_KEY,
  }
}

// ── Campaign seeder ───────────────────────────────────────────────────────────

/**
 * Seed a gift_tree campaign. Defaults to id=2 / slug='noel-2026' / active / wide-open dates.
 * Uses INSERT OR REPLACE so the caller can re-seed in beforeEach without duplicates.
 */
export async function seedGiftCampaign(
  db: D1,
  opts: {
    id?: number
    slug?: string
    status?: 'draft' | 'active' | 'closed'
    startsAt?: string
    endsAt?: string
    settings?: {
      report_threshold?: number
      hearts_per_day?: number
      gifts_per_user?: number
      tree_slots?: number
      ground_slots?: number
    }
  } = {},
): Promise<number> {
  const {
    id = 2,
    slug = 'noel-2026',
    status = 'active',
    startsAt = '2000-01-01T00:00:00Z',
    endsAt = '2099-12-31T23:59:59Z',
    settings = {},
  } = opts
  const defaults = {
    report_threshold: 3,
    hearts_per_day: 5,
    gifts_per_user: 3,
    tree_slots: 15,
    ground_slots: 10,
  }
  // Mirror activateCampaign: close any existing active campaign before inserting another active.
  // This prevents the one_active partial-unique index from deleting campaign 1 via INSERT OR REPLACE.
  if (status === 'active') {
    await db
      .prepare("UPDATE campaign SET status = 'closed' WHERE status = 'active' AND id != ?")
      .bind(id)
      .run()
  }
  await db
    .prepare(
      'INSERT OR REPLACE INTO campaign ' +
      '(id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) ' +
      "VALUES (?, ?, 'gift_tree', 'Noel 2026', 'Treo ước nguyện', '{}', '{}', ?, ?, ?, ?, datetime('now'), 'test')",
    )
    .bind(id, slug, JSON.stringify({ ...defaults, ...settings }), startsAt, endsAt, status)
    .run()
  return id
}

// ── Template seeder ───────────────────────────────────────────────────────────

/**
 * Seed an active template linked to a campaign. Returns the template id.
 * Requires campaign_id column on template (applied by CAMPAIGN_UPGRADE_SQLS in testDb).
 */
export async function seedTemplate(db: D1, campaignId: number): Promise<number> {
  const now = new Date().toISOString()
  // Insert OR IGNORE to tolerate re-seeding in beforeEach.
  await db
    .prepare(
      'INSERT INTO template (name, layout, active, created_at, created_by, campaign_id) VALUES (?, ?, 1, ?, ?, ?)',
    )
    .bind(`Template-${campaignId}-${Date.now()}`, 'doc-giua', now, 'test', campaignId)
    .run()
  const row = await db
    .prepare('SELECT MAX(id) AS id FROM template')
    .first<{ id: number }>()
  return row!.id
}

// ── Gift seeder ───────────────────────────────────────────────────────────────

/**
 * Seed a gift row. background_template_id is linked to the given templateId.
 * Returns { id, publicId }.
 */
export async function seedGift(
  db: D1,
  userId: number,
  campaignId: number,
  templateId: number,
  opts: {
    publicId?: string
    status?: 'visible' | 'hidden_auto' | 'hidden_admin' | 'deleted'
    heartCount?: number
    reportCount?: number
    statusBeforeBan?: 'visible' | null
    createdAt?: string
  } = {},
): Promise<{ id: number; publicId: string }> {
  // Use a stable token-shaped public id (16 chars [a-z0-9])
  const publicId = opts.publicId ?? `gft${Date.now().toString(36).slice(-13)}`
  const now = opts.createdAt ?? new Date().toISOString()
  await db
    .prepare(
      'INSERT INTO gift ' +
      '(public_id, campaign_id, user_id, box_style, ornament_style, layout, background_template_id, ' +
      ' font, ink, message, nickname, class_name, heart_count, report_count, status, status_before_ban, created_at) ' +
      'VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      publicId, campaignId, userId, 'doc-giua', templateId,
      'patrick-hand', '#1d3fa6',
      'Chúc mừng Noel', 'TestUser', '11A',
      opts.heartCount ?? 0,
      opts.reportCount ?? 0,
      opts.status ?? 'visible',
      opts.statusBeforeBan ?? null,
      now,
    )
    .run()
  const row = await db
    .prepare('SELECT id FROM gift WHERE public_id = ?')
    .bind(publicId)
    .first<{ id: number }>()
  return { id: row!.id, publicId }
}

// ── Request builders ──────────────────────────────────────────────────────────

/** Build an authenticated request (session cookie). */
export function sessionReq(
  token: string,
  path: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT',
  body?: unknown,
): Request {
  const headers: Record<string, string> = {
    'CF-Connecting-IP': '1.2.3.4',
    Cookie: `${SESSION_COOKIE_NAME}=${token}`,
  }
  if (method !== 'GET') {
    headers['X-Requested-With'] = 'fetch'
    if (body !== undefined) headers['Content-Type'] = 'application/json'
  }
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

/** Build an unauthenticated request. */
export function anonReq(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' = 'GET',
  body?: unknown,
): Request {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '1.2.3.4' }
  if (method !== 'GET') {
    headers['X-Requested-With'] = 'fetch'
    if (body !== undefined) headers['Content-Type'] = 'application/json'
  }
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

/** Build a legacy X-Admin-Email request (for Google-only gate tests). */
export function legacyAdminReq(
  email: string,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
): Request {
  const headers: Record<string, string> = {
    'CF-Connecting-IP': '1.2.3.4',
    'X-Admin-Email': email,
  }
  if (method !== 'GET') {
    headers['X-Requested-With'] = 'fetch'
    if (body !== undefined) headers['Content-Type'] = 'application/json'
  }
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}
