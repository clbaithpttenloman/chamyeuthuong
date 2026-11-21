/**
 * worker/giftModeration.ts — Phase 2 gift moderation (admin-only, Google session required).
 *
 * Routes:
 *   GET  /api/admin/gifts?status=reported|hidden
 *        → 200 [{ id, publicId, campaignId, userId, status, reportCount, ... }]
 *        Reporter identity is never included. reportCount (aggregate) is included.
 *
 *   PATCH /api/admin/gifts/<id>  { status: 'visible'|'hidden_admin'|'deleted' }
 *        → 200 { ok: true }
 *        restore (→ visible): marks existing reports acknowledged=1, resets report_count=0
 *
 *   PATCH /api/admin/users/<id>  { banned: true|false }
 *        → 200 { ok: true }
 *        ban=true:  saves status_before_ban, hides visible gifts to hidden_admin, deletes
 *                   the user's hearts with recounts for every affected gift, revokes sessions.
 *                   Admin cannot ban themselves (403).
 *        ban=false: restores gift status from status_before_ban; hearts NOT restored.
 *
 * Auth: requireAdmin without opts.legacy (Google session only).
 *       Typed X-Admin-Email + ADMIN_LEGACY_LOGIN='1' → 401.
 *
 * Every lifecycle change is one D1 batch with recounts (ADR-8 / task Group 4 Constraints).
 */

import { requireAdmin } from './auth.ts'
import { ensureSchema } from './schema.ts'
import { json, error, readJson } from './http.ts'
import type { D1 } from './types.ts'

type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> }

export type GiftModerationEnv = {
  DB: D1
  ADMIN_FAIL_LIMIT: Limiter
  ADMIN_LEGACY_LOGIN?: string
  BOOTSTRAP_EMAIL?: string
  ALLOW_FIRST_CLAIM?: string
}

export async function handleGiftModeration(request: Request, env: GiftModerationEnv): Promise<Response> {
  await ensureSchema(env.DB)

  // Google session only — no opts.legacy (new admin routes require Google, ADR-3)
  const admin = await requireAdmin(request, env)
  if (admin instanceof Response) return admin

  const { pathname } = new URL(request.url)

  // ── GET /api/admin/gifts?status=reported|hidden ──────────────────────────────
  if (request.method === 'GET' && pathname === '/api/admin/gifts') {
    const statusParam = new URL(request.url).searchParams.get('status')
    if (statusParam !== 'reported' && statusParam !== 'hidden') {
      return json({ error: 'bad_request' }, 400)
    }

    let rows: Array<{
      id: number; public_id: string; campaign_id: number; user_id: number; status: string
      report_count: number; heart_count: number; nickname: string; class_name: string
      message: string; created_at: string
      layout: string; font: string; ink: string; background_template_id: number | null
    }>

    if (statusParam === 'reported') {
      // Gifts with at least 1 report (not deleted) — admin sees all with report_count ≥ 1
      ;({ results: rows } = await env.DB
        .prepare(
          'SELECT g.id, g.public_id, g.campaign_id, g.user_id, g.status, g.report_count,' +
          '       g.heart_count, g.nickname, g.class_name, g.message, g.created_at,' +
          '       g.layout, g.font, g.ink, g.background_template_id ' +
          "FROM gift g WHERE g.report_count > 0 AND g.status != 'deleted' " +
          'ORDER BY g.report_count DESC, g.created_at ASC',
        )
        .all<typeof rows[number]>())
    } else {
      // status === 'hidden': hidden_auto or hidden_admin
      ;({ results: rows } = await env.DB
        .prepare(
          'SELECT g.id, g.public_id, g.campaign_id, g.user_id, g.status, g.report_count,' +
          '       g.heart_count, g.nickname, g.class_name, g.message, g.created_at,' +
          '       g.layout, g.font, g.ink, g.background_template_id ' +
          "FROM gift g WHERE g.status IN ('hidden_auto','hidden_admin') " +
          'ORDER BY g.created_at DESC',
        )
        .all<typeof rows[number]>())
    }

    // Unacknowledged reports by reason for the listed gifts (counts only, no reporter identity).
    // Reports from banned users are left out, as in report_count.
    const reasons = new Map<number, { inappropriate: number; spam: number; other: number }>()
    for (const g of rows) reasons.set(g.id, { inappropriate: 0, spam: 0, other: 0 })
    if (rows.length > 0) {
      const ids = rows.map((g) => g.id)
      // SHORTCUT: one IN list; D1 allows 100 bound params, so chunk past ~90 rows if the queue grows.
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90)
        const { results } = await env.DB
          .prepare(
            'SELECT r.gift_id, r.reason, COUNT(*) AS n FROM report r JOIN app_user u ON u.id = r.user_id ' +
            `WHERE r.acknowledged = 0 AND u.banned = 0 AND r.gift_id IN (${chunk.map(() => '?').join(',')}) ` +
            'GROUP BY r.gift_id, r.reason',
          )
          .bind(...chunk)
          .all<{ gift_id: number; reason: 'inappropriate' | 'spam' | 'other'; n: number }>()
        for (const x of results) {
          const entry = reasons.get(x.gift_id)
          if (entry && x.reason in entry) entry[x.reason] = x.n
        }
      }
    }

    // Reporter identity is NEVER included (ADR-8: never return reporter identities except to admin,
    // and only what the tests require — which is the aggregate count, not individual identities).
    return json(
      rows.map((g) => ({
        id: g.id,
        publicId: g.public_id,
        campaignId: g.campaign_id,
        userId: g.user_id,
        status: g.status,
        reportCount: g.report_count,
        heartCount: g.heart_count,
        nickname: g.nickname,
        className: g.class_name,
        message: g.message,
        createdAt: g.created_at,
        layout: g.layout,
        font: g.font,
        ink: g.ink,
        backgroundTemplateId: g.background_template_id,
        reportReasons: reasons.get(g.id),
      })),
    )
  }

  // ── PATCH /api/admin/gifts/<id> ──────────────────────────────────────────────
  const giftPatchMatch = pathname.match(/^\/api\/admin\/gifts\/(\d+)$/)
  if (request.method === 'PATCH' && giftPatchMatch) {
    const giftId = parseInt(giftPatchMatch[1]!, 10)

    let body: Record<string, unknown>
    try {
      body = await readJson<Record<string, unknown>>(request, 1024)
    } catch {
      return json({ error: 'bad_request' }, 400)
    }

    const { status } = body
    if (status !== 'visible' && status !== 'hidden_admin' && status !== 'deleted') {
      return json({ error: 'bad_request' }, 400)
    }

    if (status === 'visible') {
      // Restore: acknowledge all existing reports, reset report_count to 0, set status = visible.
      // One batch so the recount and status flip are atomic (ADR-8: "restore acknowledges reports
      // and resets report_count, so only new reports can re-hide it").
      await env.DB.batch([
        env.DB.prepare('UPDATE report SET acknowledged = 1 WHERE gift_id = ?').bind(giftId),
        env.DB.prepare(
          "UPDATE gift SET status = 'visible', report_count = 0 WHERE id = ?",
        ).bind(giftId),
      ])
    } else {
      // Hide or delete — single update (no recount needed; hearts untouched for hide/delete).
      await env.DB
        .prepare('UPDATE gift SET status = ? WHERE id = ?')
        .bind(status, giftId)
        .run()
    }

    return json({ ok: true })
  }

  // ── PATCH /api/admin/users/<id> ──────────────────────────────────────────────
  const userPatchMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/)
  if (request.method === 'PATCH' && userPatchMatch) {
    const targetUserId = parseInt(userPatchMatch[1]!, 10)

    let body: Record<string, unknown>
    try {
      body = await readJson<Record<string, unknown>>(request, 1024)
    } catch {
      return json({ error: 'bad_request' }, 400)
    }

    const { banned } = body
    if (typeof banned !== 'boolean') {
      return json({ error: 'bad_request' }, 400)
    }

    if (banned) {
      // Admin cannot ban themselves (compare admin's app_user.id via email).
      const adminUser = await env.DB
        .prepare('SELECT id FROM app_user WHERE lower(email) = lower(?)')
        .bind(admin.email)
        .first<{ id: number }>()
      if (adminUser && adminUser.id === targetUserId) {
        return json({ error: 'forbidden' }, 403)
      }

      // Pre-fetch gift IDs this user has hearted so we can recount after deleting their hearts.
      // This read must happen before the batch (hearts not yet deleted at this point).
      const { results: heartRows } = await env.DB
        .prepare('SELECT DISTINCT gift_id FROM heart WHERE user_id = ?')
        .bind(targetUserId)
        .all<{ gift_id: number }>()
      const heartedGiftIds = heartRows.map((r) => r.gift_id)

      // One D1 batch for the entire ban lifecycle (ADR-8: "one batch each, counters recomputed
      // in the same batch"):
      //   1. Mark user banned.
      //   2. Save status_before_ban and hide visible gifts.
      //   3. Delete the user's hearts.
      //   4. Revoke sessions.
      //   5. Recount heart_count for every affected gift (after hearts are deleted in step 3).
      await env.DB.batch([
        env.DB.prepare('UPDATE app_user SET banned = 1 WHERE id = ?').bind(targetUserId),
        env.DB.prepare(
          "UPDATE gift SET status_before_ban = status, status = 'hidden_admin'" +
          " WHERE user_id = ? AND status = 'visible'",
        ).bind(targetUserId),
        env.DB.prepare('DELETE FROM heart WHERE user_id = ?').bind(targetUserId),
        env.DB.prepare('DELETE FROM session WHERE user_id = ?').bind(targetUserId),
        ...heartedGiftIds.map((giftId) =>
          env.DB.prepare(
            'UPDATE gift SET heart_count = (SELECT COUNT(*) FROM heart WHERE gift_id = ?) WHERE id = ?',
          ).bind(giftId, giftId),
        ),
      ])
    } else {
      // Unban: restore previous gift status from status_before_ban; hearts NOT restored (ADR-8).
      // One batch: clear banned flag + restore gifts.
      await env.DB.batch([
        env.DB.prepare('UPDATE app_user SET banned = 0 WHERE id = ?').bind(targetUserId),
        env.DB.prepare(
          'UPDATE gift SET status = status_before_ban, status_before_ban = NULL ' +
          "WHERE user_id = ? AND status = 'hidden_admin' AND status_before_ban IS NOT NULL",
        ).bind(targetUserId),
      ])
    }

    return json({ ok: true })
  }

  return error('not_found')
}
