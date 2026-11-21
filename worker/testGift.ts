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
import type { GiftsEnv } from './gifts.ts'

export { SESSION_COOKIE_NAME }
export { seedUser, seedSession } from './testGoogle.ts'
export type { GiftsEnv }

// ── Phase 2 DDL ───────────────────────────────────────────────────────────────

/**
 * No-op: gift, heart, report, and banned_identity are now in SCHEMA (worker/schema.ts),
 * so testDb() creates them automatically via ensureSchema/SCHEMA DDL.
 * Kept as a function for call-site compatibility with existing test helpers.
 * The IF NOT EXISTS DDL is equivalent to the SCHEMA DDL, so calling it is a safe no-op.
 */
export function createGiftTables(_sqlite: DatabaseSync): void {
  // Tables are created by SCHEMA via testDb(). This function is a no-op.
  // Any test calling testDb() already has gift/heart/report/banned_identity.
}

// ── Rate-limiter fakes ────────────────────────────────────────────────────────

type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> }
const fakeLimit = (): Limiter => ({ limit: async () => ({ success: true }) })
const fakeLimitFail = (): Limiter => ({ limit: async () => ({ success: false }) })

// ── GiftsEnv ──────────────────────────────────────────────────────────────────

/**
 * Env for handleGifts (worker/gifts.ts).
 *
 * Rate-limit bindings (plan API section):
 *   GIFT_LIMIT        — 6/60 s per user (namespace 2011 prod / 3011 staging)
 *   HEART_LIMIT       — 20/60 s per user (namespace 2012 / 3012)
 *   REPORT_LIMIT      — 10/60 s per user (namespace 2013 / 3013)
 *   USER_WRITE_LIMIT  — 10/60 s per user (plan API section; also covers owner delete)
 */
export function giftsEnv(
  db: D1,
  opts: {
    giftLimitFail?: boolean
    heartLimitFail?: boolean
    reportLimitFail?: boolean
    userWriteLimitFail?: boolean
  } = {},
): GiftsEnv {
  return {
    DB: db,
    GIFT_LIMIT: opts.giftLimitFail ? fakeLimitFail() : fakeLimit(),
    HEART_LIMIT: opts.heartLimitFail ? fakeLimitFail() : fakeLimit(),
    REPORT_LIMIT: opts.reportLimitFail ? fakeLimitFail() : fakeLimit(),
    USER_WRITE_LIMIT: opts.userWriteLimitFail ? fakeLimitFail() : fakeLimit(),
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
  /** Required for unban tombstone removal. Missing → fail closed. */
  SUB_HMAC_KEY?: string
}

export function giftModerationEnv(
  db: D1,
  opts: {
    failLimit?: boolean
    legacyLogin?: string
    subHmacKey?: string
  } = {},
): GiftModerationEnv {
  return {
    DB: db,
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: !opts.failLimit }) },
    // Keep the flag on so we can test that typed email is still rejected
    ADMIN_LEGACY_LOGIN: 'legacyLogin' in opts ? opts.legacyLogin : '1',
    SUB_HMAC_KEY: 'subHmacKey' in opts ? opts.subHmacKey : TEST_SUB_HMAC_KEY,
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
