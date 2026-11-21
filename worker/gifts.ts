/**
 * worker/gifts.ts — gift create/delete, hearts, and reports.
 *
 * Routes handled:
 *   POST   /api/campaigns/<slug>/gifts  — create a gift (AC-10, FR-19)
 *   DELETE /api/gifts/<publicId>        — owner deletes their own visible gift (ADR-8)
 *   POST   /api/gifts/<publicId>/heart  — give a heart (ADR-7)
 *   POST   /api/gifts/<publicId>/report — report a gift (ADR-8)
 *
 * Day bucket for hearts and daily gift limit:
 *   day = new Date(Date.now() + 7*3600_000).toISOString().slice(0, 10)
 *   Computed in JS so vi.useFakeTimers() in tests controls it correctly.
 *   SQLite `datetime('now','+7 hours')` is NOT used because it ignores the fake clock.
 *
 * Write path for hearts (one D1 batch, ADR-7):
 *   1. INSERT OR IGNORE INTO heart … SELECT … WHERE <all conditions>
 *   2. UPDATE gift SET heart_count = COUNT(heart) WHERE public_id = ?
 *   If batch[0].meta.changes === 0 → one diagnosis read in the specified order.
 *
 * Write path for gift create (Fix Group 8a item 5):
 *   Single conditional INSERT INTO gift … SELECT … WHERE (per-user count < limit) AND (daily count < limit).
 *   On 0 changes → diagnosis read to return limit_reached or daily_limit.
 *
 * Write path for reports (ADR-8, Fix Group 8a item 5):
 *   Single conditional INSERT OR IGNORE INTO report … SELECT … WHERE (gift visible AND campaign open).
 *   On 0 changes → diagnosis read to return specific error code.
 *
 * Public payloads NEVER include gift.id or user_id (ADR-8).
 */

import { ensureSchema } from './schema.ts'
import { readSession } from './session.ts'
import { newToken } from './token.ts'
import { error, json, readJson } from './http.ts'
import { isEffectivelyOpen } from '../shared/campaign.ts'
import { validateGiftText } from '../shared/gift.ts'
import { isLayout } from '../shared/layouts.ts'
import { isFont, isInkInput, normalizeInk } from '../shared/fonts.ts'
import type { D1 } from './types.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> }

export type GiftsEnv = {
  DB: D1
  GIFT_LIMIT: Limiter
  HEART_LIMIT: Limiter
  REPORT_LIMIT: Limiter
  /** Owner delete and report rate limit: 10/60 s per user (plan API section). */
  USER_WRITE_LIMIT?: Limiter
}

// Known fields in the gift create body — unknown fields → 400 (ADR-8).
const GIFT_BODY_FIELDS = new Set([
  'boxStyle', 'ornamentStyle', 'layout', 'backgroundTemplateId',
  'font', 'ink', 'message', 'nickname', 'className',
])

// Daily gift creation hard-cap (not from settings; create/delete loop guard per ADR-8).
const DAILY_CREATE_LIMIT = 6

// ── Main router ───────────────────────────────────────────────────────────────

export async function handleGifts(request: Request, env: GiftsEnv): Promise<Response> {
  const { pathname } = new URL(request.url)

  // POST /api/campaigns/:slug/gifts
  const createMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/gifts$/)
  if (createMatch && request.method === 'POST') {
    return handleCreateGift(createMatch[1]!, request, env)
  }

  // DELETE /api/gifts/:publicId
  const deleteMatch = pathname.match(/^\/api\/gifts\/([a-z0-9]+)$/)
  if (deleteMatch && request.method === 'DELETE') {
    return handleDeleteGift(deleteMatch[1]!, request, env)
  }

  // POST /api/gifts/:publicId/heart
  const heartMatch = pathname.match(/^\/api\/gifts\/([a-z0-9]+)\/heart$/)
  if (heartMatch && request.method === 'POST') {
    return handleHeart(heartMatch[1]!, request, env)
  }

  // POST /api/gifts/:publicId/report
  const reportMatch = pathname.match(/^\/api\/gifts\/([a-z0-9]+)\/report$/)
  if (reportMatch && request.method === 'POST') {
    return handleReport(reportMatch[1]!, request, env)
  }

  return error('not_found')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Vietnam day string (YYYY-MM-DD) using Date.now() so fake clocks work in tests. */
function vietnamDay(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
}

/** Second-precision ISO string (YYYY-MM-DDTHH:MM:SSZ) for SQL BETWEEN comparisons.
 *  Avoids the string-ordering edge where '...T10:00:00.100Z' < '...T10:00:00Z' because
 *  '.' (ASCII 46) < 'Z' (ASCII 90), causing the BETWEEN check to fail in the first
 *  millisecond of the campaign window.
 */
function nowSecond(): string {
  return new Date(Date.now()).toISOString().slice(0, 19) + 'Z'
}

function csrfGuard(request: Request): Response | null {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return error('forbidden')
  if (request.method !== 'GET' && request.headers.get('X-Requested-With') !== 'fetch') {
    return error('forbidden')
  }
  return null
}

// ── POST /api/campaigns/:slug/gifts ──────────────────────────────────────────

async function handleCreateGift(slug: string, request: Request, env: GiftsEnv): Promise<Response> {
  const csrf = csrfGuard(request)
  if (csrf) return csrf

  await ensureSchema(env.DB)

  // Auth
  const session = await readSession(request, env.DB)
  if (!session) return error('unauthorized')
  const userId = session.userId

  // Rate limit (keyed by user id, per plan API section)
  const { success: giftOk } = await env.GIFT_LIMIT.limit({ key: String(userId) })
  if (!giftOk) return json({ error: 'rate_limited' }, 429)

  // Parse body
  let body: Record<string, unknown>
  try {
    body = await readJson<Record<string, unknown>>(request, 8192)
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  // Unknown fields check (ADR-8)
  for (const key of Object.keys(body)) {
    if (!GIFT_BODY_FIELDS.has(key)) return json({ error: 'bad_request' }, 400)
  }

  // Field validation (reuses card v3 rules per docs/tech.md)
  const { boxStyle, ornamentStyle, layout, backgroundTemplateId, font, ink, message, nickname, className } = body

  if (typeof boxStyle !== 'number' || !Number.isInteger(boxStyle) || boxStyle < 1 || boxStyle > 6) {
    return json({ error: 'bad_request' }, 400)
  }
  if (typeof ornamentStyle !== 'number' || !Number.isInteger(ornamentStyle) || ornamentStyle < 1 || ornamentStyle > 6) {
    return json({ error: 'bad_request' }, 400)
  }
  if (typeof layout !== 'string' || !isLayout(layout)) {
    return json({ error: 'bad_request' }, 400)
  }
  if (typeof backgroundTemplateId !== 'number' || !Number.isInteger(backgroundTemplateId) || backgroundTemplateId < 1) {
    return json({ error: 'bad_request' }, 400)
  }
  if (typeof font !== 'string' || !isFont(font)) {
    return json({ error: 'bad_request' }, 400)
  }
  if (typeof ink !== 'string' || !isInkInput(ink)) {
    return json({ error: 'bad_request' }, 400)
  }

  // Text validation — shared/gift.ts (NFC + trim, code-point lengths, control/bidi/surrogate).
  // All three fields validated in one call; field name identifies the failing field.
  const textResult = validateGiftText({
    message: typeof message === 'string' ? message : '',
    nickname: typeof nickname === 'string' ? nickname : '',
    className: typeof className === 'string' ? className : (className === undefined ? '' : null as unknown as string),
  })
  if (!textResult.ok) return json({ error: 'bad_request' }, 400)
  const { message: validMessage, nickname: validNickname, className: validClassName } = textResult.value

  // Load campaign (must be gift_tree kind)
  const campaign = await env.DB
    .prepare('SELECT id, kind, status, starts_at, ends_at, settings FROM campaign WHERE slug = ?')
    .bind(slug)
    .first<{ id: number; kind: string; status: string; starts_at: string; ends_at: string; settings: string }>()

  if (!campaign || campaign.kind !== 'gift_tree') return error('not_found')

  // Campaign must be effectively open
  const now = new Date()
  if (!isEffectivelyOpen({ status: campaign.status as 'draft' | 'active' | 'closed', starts_at: campaign.starts_at, ends_at: campaign.ends_at }, now)) {
    return json({ error: 'campaign_closed' }, 409)
  }

  // Parse campaign settings for limits
  let settings: { gifts_per_user?: number } = {}
  try { settings = JSON.parse(campaign.settings) } catch { /* use defaults */ }
  const giftsPerUser = typeof settings.gifts_per_user === 'number' ? settings.gifts_per_user : 3

  // User banned check
  const user = await env.DB
    .prepare('SELECT banned FROM app_user WHERE id = ?')
    .bind(userId)
    .first<{ banned: number }>()
  if (!user) return error('unauthorized')
  if (user.banned) return json({ error: 'banned' }, 403)

  // Template must be active and belong to this campaign
  const tmpl = await env.DB
    .prepare('SELECT id FROM template WHERE id = ? AND campaign_id = ? AND active = 1')
    .bind(backgroundTemplateId, campaign.id)
    .first<{ id: number }>()
  if (!tmpl) return json({ error: 'bad_request' }, 400)

  // Single conditional INSERT (item 5): per-user limit and daily limit are inside the WHERE
  // so concurrent POSTs cannot race past either limit.
  const publicId = newToken()
  const createdAt = new Date().toISOString()
  const normalizedInk = normalizeInk(ink as string)
  const day = vietnamDay()

  const result = await env.DB
    .prepare(
      'INSERT INTO gift ' +
      '(public_id, campaign_id, user_id, box_style, ornament_style, layout, background_template_id, ' +
      ' font, ink, message, nickname, class_name, heart_count, report_count, status, created_at) ' +
      "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'visible', ? " +
      'WHERE ' +
      '  (SELECT COUNT(*) FROM gift WHERE user_id = ? AND campaign_id = ? AND status != \'deleted\') < ? ' +
      '  AND (SELECT COUNT(*) FROM gift WHERE user_id = ? AND campaign_id = ? ' +
      "       AND substr(datetime(created_at, '+7 hours'), 1, 10) = ?) < ?",
    )
    .bind(
      publicId, campaign.id, userId,
      boxStyle, ornamentStyle, layout as string, backgroundTemplateId as number,
      font as string, normalizedInk,
      validMessage, validNickname, validClassName,
      createdAt,
      // per-user count check
      userId, campaign.id, giftsPerUser,
      // daily count check
      userId, campaign.id, day, DAILY_CREATE_LIMIT,
    )
    .run()

  if (result.meta.changes === 0) {
    // Diagnose which limit was hit
    const limitRow = await env.DB
      .prepare(
        'SELECT ' +
        "  (SELECT COUNT(*) FROM gift WHERE user_id = ? AND campaign_id = ? AND status != 'deleted') AS per_user, " +
        "  (SELECT COUNT(*) FROM gift WHERE user_id = ? AND campaign_id = ? " +
        "   AND substr(datetime(created_at, '+7 hours'), 1, 10) = ?) AS daily",
      )
      .bind(userId, campaign.id, userId, campaign.id, day)
      .first<{ per_user: number; daily: number }>()

    // Diagnosis order: per-user limit first, then daily limit
    if ((limitRow?.per_user ?? 0) >= giftsPerUser) return json({ error: 'limit_reached' }, 409)
    if ((limitRow?.daily ?? 0) >= DAILY_CREATE_LIMIT) return json({ error: 'daily_limit' }, 429)
    // Fallback (shouldn't happen in practice — race between diagnosis and re-check)
    return json({ error: 'limit_reached' }, 409)
  }

  return json({ publicId }, 201)
}

// ── DELETE /api/gifts/:publicId ───────────────────────────────────────────────

async function handleDeleteGift(publicId: string, request: Request, env: GiftsEnv): Promise<Response> {
  const csrf = csrfGuard(request)
  if (csrf) return csrf

  await ensureSchema(env.DB)

  const session = await readSession(request, env.DB)
  if (!session) return error('unauthorized')
  const userId = session.userId

  // USER_WRITE_LIMIT for owner delete (plan API section; item 6)
  if (env.USER_WRITE_LIMIT) {
    const { success } = await env.USER_WRITE_LIMIT.limit({ key: String(userId) })
    if (!success) return json({ error: 'rate_limited' }, 429)
  }

  // Load gift + campaign_id (need campaign for the closed-campaign check)
  const gift = await env.DB
    .prepare('SELECT id, user_id, status, campaign_id FROM gift WHERE public_id = ?')
    .bind(publicId)
    .first<{ id: number; user_id: number; status: string; campaign_id: number }>()

  // 404 for not found or already deleted (deleted is treated as not found)
  if (!gift || gift.status === 'deleted') return error('not_found')

  // 404 for someone else's gift (don't reveal existence)
  if (gift.user_id !== userId) return error('not_found')

  // 409 pending_review for hidden gifts (ADR-8: evidence cannot be removed)
  if (gift.status === 'hidden_auto' || gift.status === 'hidden_admin') {
    return json({ error: 'pending_review' }, 409)
  }

  // 409 campaign_closed: owner may not delete after the campaign ends (FR-28: frozen leaderboard).
  // Only moderation may change the final order.
  const campaignRow = await env.DB
    .prepare('SELECT status, starts_at, ends_at FROM campaign WHERE id = ?')
    .bind(gift.campaign_id)
    .first<{ status: string; starts_at: string; ends_at: string }>()
  if (!campaignRow || !isEffectivelyOpen({ status: campaignRow.status as 'draft' | 'active' | 'closed', starts_at: campaignRow.starts_at, ends_at: campaignRow.ends_at }, new Date())) {
    return json({ error: 'campaign_closed' }, 409)
  }

  // Update status to deleted (only if visible — the check above already guarantees this)
  await env.DB
    .prepare("UPDATE gift SET status = 'deleted' WHERE id = ? AND user_id = ? AND status = 'visible'")
    .bind(gift.id, userId)
    .run()

  return json({ ok: true })
}

// ── POST /api/gifts/:publicId/heart ──────────────────────────────────────────

async function handleHeart(publicId: string, request: Request, env: GiftsEnv): Promise<Response> {
  const csrf = csrfGuard(request)
  if (csrf) return csrf

  await ensureSchema(env.DB)

  const session = await readSession(request, env.DB)
  if (!session) return error('unauthorized')
  const userId = session.userId

  // Rate limit
  const { success: heartOk } = await env.HEART_LIMIT.limit({ key: String(userId) })
  if (!heartOk) return json({ error: 'rate_limited' }, 429)

  const day = vietnamDay()
  // Second-precision ISO string to avoid SQL BETWEEN edge where '...T10:00:00.100Z' < '...T10:00:00Z'
  // (ASCII '.' = 46 < 'Z' = 90). Without truncation, a request at 100ms into the campaign window
  // would appear outside the window. (item 11)
  const nowDt = nowSecond()

  // One D1 batch (ADR-7): INSERT OR IGNORE + recount
  //
  // The INSERT SELECT uses bound params for day and nowDt so fake clocks work in tests.
  // Conditions in the WHERE:
  //   - gift must be visible
  //   - campaign must be active AND now BETWEEN starts_at AND ends_at
  //   - gifter must not be the owner
  //   - gifter must not be banned
  //   - gifter's daily heart count < hearts_per_day
  // The PRIMARY KEY (gift_id, user_id) on heart handles the already_hearted case (INSERT OR IGNORE).
  const batch = await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO heart (gift_id, user_id, day, created_at) ' +
      'SELECT g.id, ?, ?, ? ' +
      'FROM gift g ' +
      'JOIN campaign c ON c.id = g.campaign_id ' +
      'JOIN app_user u ON u.id = ? ' +
      'WHERE g.public_id = ? ' +
      "  AND g.status = 'visible' " +
      "  AND c.status = 'active' AND ? BETWEEN c.starts_at AND c.ends_at " +
      '  AND g.user_id != ? ' +
      '  AND u.banned = 0 ' +
      '  AND (SELECT COUNT(*) FROM heart h WHERE h.user_id = ? AND h.day = ?) < ' +
      "      COALESCE(json_extract(c.settings, '$.hearts_per_day'), 5)",
    ).bind(userId, day, nowDt, userId, publicId, nowDt, userId, userId, day),
    env.DB.prepare(
      'UPDATE gift SET heart_count = (SELECT COUNT(*) FROM heart WHERE gift_id = id) WHERE public_id = ?',
    ).bind(publicId),
  ])

  if (batch[0]!.meta.changes === 0) {
    // Diagnosis read — returns specific error in ADR-7 order:
    // gift_not_found → campaign_closed → banned → own_gift → already_hearted → hearts_exhausted
    const diag = await env.DB
      .prepare(
        'SELECT g.id, g.status, g.user_id, ' +
        '       c.status AS camp_status, c.starts_at, c.ends_at, ' +
        "       COALESCE(json_extract(c.settings, '$.hearts_per_day'), 5) AS hearts_per_day, " +
        '       u.banned, ' +
        '       (SELECT COUNT(*) FROM heart h WHERE h.gift_id = g.id AND h.user_id = ?) AS heart_exists, ' +
        '       (SELECT COUNT(*) FROM heart h WHERE h.user_id = ? AND h.day = ?) AS day_hearts ' +
        'FROM gift g ' +
        'JOIN campaign c ON c.id = g.campaign_id ' +
        'JOIN app_user u ON u.id = ? ' +
        'WHERE g.public_id = ?',
      )
      .bind(userId, userId, day, userId, publicId)
      .first<{
        id: number; status: string; user_id: number;
        camp_status: string; starts_at: string; ends_at: string; hearts_per_day: number;
        banned: number; heart_exists: number; day_hearts: number;
      }>()

    if (!diag || diag.status !== 'visible') return json({ error: 'gift_not_found' }, 404)

    const campOpen = isEffectivelyOpen(
      { status: diag.camp_status as 'draft' | 'active' | 'closed', starts_at: diag.starts_at, ends_at: diag.ends_at },
      new Date(),
    )
    if (!campOpen) return json({ error: 'campaign_closed' }, 409)
    if (diag.banned) return json({ error: 'banned' }, 403)
    if (diag.user_id === userId) return json({ error: 'own_gift' }, 403)
    if (diag.heart_exists > 0) return json({ error: 'already_hearted' }, 409)
    if (diag.day_hearts >= diag.hearts_per_day) return json({ error: 'hearts_exhausted' }, 429)

    // Fallback (shouldn't happen in practice)
    return json({ error: 'gift_not_found' }, 404)
  }

  // Success — read heartCount, heartsLeft, rank in one query
  const result = await env.DB
    .prepare(
      'SELECT g.heart_count, ' +
      "       (COALESCE(json_extract(c.settings, '$.hearts_per_day'), 5) - " +
      '        (SELECT COUNT(*) FROM heart h WHERE h.user_id = ? AND h.day = ?)) AS hearts_left, ' +
      '       (SELECT COUNT(*) + 1 FROM gift g2 ' +
      '        WHERE g2.campaign_id = g.campaign_id ' +
      "          AND g2.status = 'visible' " +
      '          AND (g2.heart_count > g.heart_count ' +
      '               OR (g2.heart_count = g.heart_count AND g2.created_at < g.created_at) ' +
      '               OR (g2.heart_count = g.heart_count AND g2.created_at = g.created_at AND g2.id < g.id))) AS rank ' +
      'FROM gift g ' +
      'JOIN campaign c ON c.id = g.campaign_id ' +
      'WHERE g.public_id = ?',
    )
    .bind(userId, day, publicId)
    .first<{ heart_count: number; hearts_left: number; rank: number }>()

  if (!result) return json({ error: 'gift_not_found' }, 404)

  return json({ heartCount: result.heart_count, heartsLeft: result.hearts_left, rank: result.rank })
}

// ── POST /api/gifts/:publicId/report ─────────────────────────────────────────

async function handleReport(publicId: string, request: Request, env: GiftsEnv): Promise<Response> {
  const csrf = csrfGuard(request)
  if (csrf) return csrf

  await ensureSchema(env.DB)

  const session = await readSession(request, env.DB)
  if (!session) return error('unauthorized')
  const userId = session.userId

  // Rate limit
  const { success: reportOk } = await env.REPORT_LIMIT.limit({ key: String(userId) })
  if (!reportOk) return json({ error: 'rate_limited' }, 429)

  // Parse and validate body
  let body: Record<string, unknown>
  try {
    body = await readJson<Record<string, unknown>>(request, 1024)
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  const { reason } = body
  if (reason !== 'inappropriate' && reason !== 'spam' && reason !== 'other') {
    return json({ error: 'bad_request' }, 400)
  }

  // Preliminary read: gift + campaign + user + existing report (for specific error codes).
  // The INSERT below is conditional so a race between this read and the INSERT returns 0 changes.
  const state = await env.DB
    .prepare(
      'SELECT g.id AS gift_id, g.status AS gift_status, ' +
      '       c.status AS camp_status, c.starts_at, c.ends_at, c.settings, ' +
      '       u.banned, ' +
      '       (SELECT COUNT(*) FROM report r WHERE r.gift_id = g.id AND r.user_id = ?) AS already_rep ' +
      'FROM gift g ' +
      'JOIN campaign c ON c.id = g.campaign_id ' +
      'JOIN app_user u ON u.id = ? ' +
      'WHERE g.public_id = ?',
    )
    .bind(userId, userId, publicId)
    .first<{
      gift_id: number; gift_status: string;
      camp_status: string; starts_at: string; ends_at: string; settings: string;
      banned: number; already_rep: number;
    }>()

  if (!state || state.gift_status !== 'visible') return json({ error: 'gift_not_found' }, 404)

  const campOpen = isEffectivelyOpen(
    { status: state.camp_status as 'draft' | 'active' | 'closed', starts_at: state.starts_at, ends_at: state.ends_at },
    new Date(),
  )
  if (!campOpen) return json({ error: 'campaign_closed' }, 409)
  if (state.banned) return json({ error: 'banned' }, 403)
  if (state.already_rep > 0) return json({ error: 'already_reported' }, 409)

  // Parse threshold from settings
  let settings: { report_threshold?: number } = {}
  try { settings = JSON.parse(state.settings) } catch { /* use default */ }
  const threshold = typeof settings.report_threshold === 'number' ? settings.report_threshold : 3

  const nowDt = nowSecond()

  // Single conditional INSERT (item 5): checks gift still visible and campaign still open,
  // so a concurrent gift-delete or campaign-close between the read and the INSERT is handled.
  // INSERT OR IGNORE guards the PK so a concurrent duplicate report doesn't double-insert.
  await env.DB.batch([
    // 1. Conditional INSERT: only if gift still visible + campaign still open + not yet reported
    env.DB.prepare(
      'INSERT OR IGNORE INTO report (gift_id, user_id, reason, acknowledged, created_at) ' +
      'SELECT g.id, ?, ?, 0, ? ' +
      'FROM gift g ' +
      'JOIN campaign c ON c.id = g.campaign_id ' +
      "WHERE g.id = ? AND g.status = 'visible' " +
      "  AND c.status = 'active' AND ? BETWEEN c.starts_at AND c.ends_at " +
      '  AND NOT EXISTS (SELECT 1 FROM report WHERE gift_id = g.id AND user_id = ?)',
    ).bind(userId, reason, nowDt, state.gift_id, nowDt, userId),
    // 2. Recount: only non-banned, unacknowledged reports
    env.DB.prepare(
      'UPDATE gift SET report_count = (' +
      '  SELECT COUNT(*) FROM report r ' +
      '  JOIN app_user u ON u.id = r.user_id ' +
      '  WHERE r.gift_id = ? AND r.acknowledged = 0 AND u.banned = 0' +
      ') WHERE id = ?',
    ).bind(state.gift_id, state.gift_id),
    // 3. Auto-hide if threshold reached (same batch, atomic)
    env.DB.prepare(
      "UPDATE gift SET status = 'hidden_auto' WHERE id = ? AND status = 'visible' AND report_count >= ?",
    ).bind(state.gift_id, threshold),
  ])

  return json({ ok: true })
}
