/**
 * worker/giftModeration.ts — Phase 2 gift moderation (admin-only, Google session required).
 *
 * Routes:
 *   GET  /api/admin/gifts?status=reported|hidden
 *        → 200 [{ id, publicId, campaignId, userId, userBanned, status, reportCount, ... }]
 *        Reporter identity is never included. reportCount (aggregate) is included.
 *        LIMIT 200 to cap queue size (item 10).
 *
 *   PATCH /api/admin/gifts/<id>  { status: 'visible'|'hidden_admin'|'deleted' }
 *        → 200 { ok: true }  |  404 (unknown id or deleted gift)
 *        restore (→ visible): marks existing reports acknowledged=1, resets report_count=0,
 *                              clears status_before_ban (item 3)
 *        hide/delete: sets status, clears status_before_ban (item 3), 404 on 0 changes
 *
 *   PATCH /api/admin/users/<id>  { banned: true|false }
 *        → 200 { ok: true }
 *        ban=true:  saves status_before_ban, hides visible gifts to hidden_admin, deletes
 *                   the user's hearts with in-batch recounts (no pre-read, item 4), recounts
 *                   report_count for affected gifts (item 4), revokes sessions.
 *                   Admin cannot ban themselves (403).
 *        ban=false: restores gift status from status_before_ban; hearts NOT restored;
 *                   recounts report_count for affected gifts (item 4); removes tombstone (item 1).
 *                   Fails closed without SUB_HMAC_KEY (item 1).
 *
 *   GET  /api/admin/tombstones        → 200 [{ id, createdAt }]  (sub_hmac never returned)
 *   DELETE /api/admin/tombstones/<id> → 200 { ok: true }
 *
 * Auth: requireAdmin (session with admin_role, ADR-9). Typed email headers are never accepted.
 *
 * Every lifecycle change is one D1 batch with recounts (ADR-8 / task Group 4 Constraints).
 */

import { requireAdmin } from './auth.ts'
import { ensureSchema } from './schema.ts'
import { json, error, readJson } from './http.ts'
import { hmacSha256Hex } from './session.ts'
import type { D1 } from './types.ts'

type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> }

export type GiftModerationEnv = {
  DB: D1
  ADMIN_FAIL_LIMIT: Limiter
  /** Required for unban tombstone removal. Missing → fail closed for unban. */
  SUB_HMAC_KEY?: string
}

export async function handleGiftModeration(request: Request, env: GiftModerationEnv): Promise<Response> {
  await ensureSchema(env.DB)

  // Admin session with admin_role (ADR-9). requireAdmin returns the acting user id.
  const admin = await requireAdmin(request, env)
  if (admin instanceof Response) return admin
  const adminUserId = admin.userId

  const { pathname } = new URL(request.url)

  // ── GET /api/admin/gifts?status=reported|hidden ──────────────────────────────
  if (request.method === 'GET' && pathname === '/api/admin/gifts') {
    const statusParam = new URL(request.url).searchParams.get('status')
    if (statusParam !== 'reported' && statusParam !== 'hidden') {
      return json({ error: 'bad_request' }, 400)
    }

    // Alias for the join type
    type GiftWithUser = {
      id: number; public_id: string; campaign_id: number; user_id: number; status: string
      report_count: number; heart_count: number; nickname: string; class_name: string
      message: string; created_at: string
      layout: string; font: string; ink: string; background_template_id: number | null
      user_banned: number  // item 10: owning user's banned flag
    }
    let rows: GiftWithUser[]

    // LIMIT 200 to cap the queue (item 10 suggestion)
    if (statusParam === 'reported') {
      ;({ results: rows } = await env.DB
        .prepare(
          'SELECT g.id, g.public_id, g.campaign_id, g.user_id, g.status, g.report_count,' +
          '       g.heart_count, g.nickname, g.class_name, g.message, g.created_at,' +
          '       g.layout, g.font, g.ink, g.background_template_id,' +
          '       COALESCE(u.banned, 0) AS user_banned ' +
          'FROM gift g ' +
          'LEFT JOIN app_user u ON u.id = g.user_id ' +
          "WHERE g.report_count > 0 AND g.status != 'deleted' " +
          'ORDER BY g.report_count DESC, g.created_at ASC ' +
          'LIMIT 200',
        )
        .all<GiftWithUser>())
    } else {
      ;({ results: rows } = await env.DB
        .prepare(
          'SELECT g.id, g.public_id, g.campaign_id, g.user_id, g.status, g.report_count,' +
          '       g.heart_count, g.nickname, g.class_name, g.message, g.created_at,' +
          '       g.layout, g.font, g.ink, g.background_template_id,' +
          '       COALESCE(u.banned, 0) AS user_banned ' +
          'FROM gift g ' +
          'LEFT JOIN app_user u ON u.id = g.user_id ' +
          "WHERE g.status IN ('hidden_auto','hidden_admin') " +
          'ORDER BY g.created_at DESC ' +
          'LIMIT 200',
        )
        .all<GiftWithUser>())
    }

    // Unacknowledged reports by reason for the listed gifts (counts only, no reporter identity).
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

    // Count reports from accounts < 24 h old at the time of the report (security cycle 1).
    // Counts only — no reporter identities.
    const newAccountCounts = new Map<number, number>()
    for (const g of rows) newAccountCounts.set(g.id, 0)
    if (rows.length > 0) {
      const ids = rows.map((g) => g.id)
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90)
        const { results: naRows } = await env.DB
          .prepare(
            'SELECT r.gift_id, COUNT(*) AS n FROM report r ' +
            'JOIN app_user u ON u.id = r.user_id ' +
            'WHERE r.acknowledged = 0 ' +
            '  AND (strftime(\'%s\', r.created_at) - strftime(\'%s\', u.created_at)) < 86400 ' +
            `  AND r.gift_id IN (${chunk.map(() => '?').join(',')}) ` +
            'GROUP BY r.gift_id',
          )
          .bind(...chunk)
          .all<{ gift_id: number; n: number }>()
        for (const x of naRows) newAccountCounts.set(x.gift_id, x.n)
      }
    }

    // Reporter identity is NEVER included (ADR-8).
    // X-Truncated: 1 is set when the result was capped at 200 rows (the response shape is a
    // bare array and must not change, so we signal truncation via a header — cycle-2 suggestion).
    const payload = rows.map((g) => ({
      id: g.id,
      publicId: g.public_id,
      campaignId: g.campaign_id,
      userId: g.user_id,
      userBanned: Boolean(g.user_banned),  // item 10: owning user's banned flag
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
      reportsFromNewAccounts: newAccountCounts.get(g.id) ?? 0,
    }))
    const resp = json(payload)
    if (rows.length === 200) resp.headers.set('X-Truncated', '1')
    return resp
  }

  // ── GET /api/admin/tombstones ─────────────────────────────────────────────────
  // Returns tombstone list (id, created_at only — sub_hmac never returned) for admin
  // to identify and remove ("Gỡ khóa") tombstones for already-deleted users. (item 1 / ADR-8)
  if (request.method === 'GET' && pathname === '/api/admin/tombstones') {
    const { results } = await env.DB
      .prepare('SELECT rowid AS id, created_at FROM banned_identity ORDER BY created_at DESC')
      .all<{ id: number; created_at: string }>()
    return json(results.map((r) => ({ id: r.id, createdAt: r.created_at })))
  }

  // ── DELETE /api/admin/tombstones/<id> ─────────────────────────────────────────
  const tombstoneDeleteMatch = pathname.match(/^\/api\/admin\/tombstones\/(\d+)$/)
  if (request.method === 'DELETE' && tombstoneDeleteMatch) {
    const tombstoneId = parseInt(tombstoneDeleteMatch[1]!, 10)
    await env.DB.batch([
      env.DB.prepare('DELETE FROM banned_identity WHERE rowid = ?').bind(tombstoneId),
      env.DB.prepare(
        'INSERT INTO admin_audit (actor_user_id, action, target_user_id, at) VALUES (?, ?, NULL, ?)',
      ).bind(adminUserId, 'remove_tombstone', new Date().toISOString()),
    ])
    return json({ ok: true })
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
      // Refuse restoring a gift whose owner is currently banned (security cycle 1).
      // Restoring a banned user's gift would publish content that moderation is overseeing.
      const ownerBanned = await env.DB
        .prepare(
          'SELECT u.banned FROM gift g JOIN app_user u ON u.id = g.user_id WHERE g.id = ? LIMIT 1',
        )
        .bind(giftId)
        .first<{ banned: number }>()
      if (ownerBanned?.banned) return json({ error: 'owner_banned' }, 409)

      // Restore: acknowledge all existing reports, reset report_count to 0, set status = visible,
      // clear status_before_ban (item 3: prevent stale restore on later unban).
      // Refuse deleted gifts (ADR-8: cannot resurrect deleted gifts) and unknown ids.
      // Gate the acknowledge UPDATE so it only runs when the gift exists and is non-deleted
      // (a 404 must write nothing — cycle-2 suggestion).
      const result = await env.DB.batch([
        env.DB.prepare(
          "UPDATE report SET acknowledged = 1 WHERE gift_id = ? " +
          "  AND EXISTS (SELECT 1 FROM gift WHERE id = ? AND status != 'deleted')",
        ).bind(giftId, giftId),
        env.DB.prepare(
          "UPDATE gift SET status = 'visible', report_count = 0, status_before_ban = NULL " +
          "WHERE id = ? AND status != 'deleted'",
        ).bind(giftId),
      ])
      // Check the gift UPDATE result (index 1) for 0 changes → 404
      if (result[1]!.meta.changes === 0) return json({ error: 'not_found' }, 404)
    } else {
      // Hide or delete: set status, clear status_before_ban (item 3: prevents a later unban
      // from using a stale saved status), 404 on 0 changes (unknown id or deleted gift).
      const result = await env.DB
        .prepare(
          "UPDATE gift SET status = ?, status_before_ban = NULL WHERE id = ? AND status != 'deleted'",
        )
        .bind(status, giftId)
        .run()
      if (result.meta.changes === 0) return json({ error: 'not_found' }, 404)
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
      // Admin cannot ban themselves — compare target with the session user id directly
      // (session userId is unambiguous; email lookup is non-unique across app_user rows).
      if (adminUserId !== undefined && adminUserId === targetUserId) {
        return json({ error: 'forbidden' }, 403)
      }
      // An admin cannot be banned; revoke the admin role first (ADR-9, AC-25).
      const targetIsAdmin = await env.DB
        .prepare('SELECT 1 AS x FROM admin_role WHERE user_id = ?')
        .bind(targetUserId)
        .first()
      if (targetIsAdmin) return json({ error: 'is_admin' }, 409)

      // One D1 batch for the entire ban lifecycle (ADR-8):
      //   1. Mark user banned.
      //   2. Save status_before_ban and hide visible gifts.
      //   3. Delete the user's hearts.
      //   4. Revoke sessions.
      //   5. In-batch recount heart_count for every gift they hearted (item 4: no pre-read).
      //      Uses an UPDATE WHERE id IN (SELECT gift_id FROM heart WHERE user_id = ?) BEFORE
      //      the delete, counting other users' hearts (excluding the banned user's).
      //   6. Recount report_count for every gift they reported (item 4: reporters now banned
      //      so their reports no longer count toward the threshold).
      await env.DB.batch([
        env.DB.prepare('UPDATE app_user SET banned = 1 WHERE id = ?').bind(targetUserId),
        env.DB.prepare(
          "UPDATE gift SET status_before_ban = status, status = 'hidden_admin'" +
          " WHERE user_id = ? AND status = 'visible'",
        ).bind(targetUserId),
        // Heart recount BEFORE the delete (item 4): exclude the user's own hearts in the subcount,
        // so the result equals COUNT(heart) after the delete completes in the same batch.
        env.DB.prepare(
          'UPDATE gift SET heart_count = (' +
          '  SELECT COUNT(*) FROM heart h WHERE h.gift_id = gift.id AND h.user_id != ?' +
          ') WHERE id IN (SELECT DISTINCT gift_id FROM heart WHERE user_id = ?)',
        ).bind(targetUserId, targetUserId),
        env.DB.prepare('DELETE FROM heart WHERE user_id = ?').bind(targetUserId),
        env.DB.prepare('DELETE FROM session WHERE user_id = ?').bind(targetUserId),
        env.DB.prepare(
          'INSERT INTO admin_audit (actor_user_id, action, target_user_id, at) VALUES (?, ?, ?, ?)',
        ).bind(adminUserId, 'ban', targetUserId, new Date().toISOString()),
        // Report recount for gifts this user reported (item 4): their reports now excluded.
        env.DB.prepare(
          'UPDATE gift SET report_count = (' +
          '  SELECT COUNT(*) FROM report r ' +
          '  JOIN app_user u ON u.id = r.user_id ' +
          '  WHERE r.gift_id = gift.id AND r.acknowledged = 0 AND u.banned = 0' +
          '  AND (strftime(\'%s\', r.created_at) - strftime(\'%s\', u.created_at)) >= 86400' +
          ') WHERE id IN (SELECT DISTINCT gift_id FROM report WHERE user_id = ?)',
        ).bind(targetUserId),
      ])
    } else {
      // Unban: restore previous gift status from status_before_ban; hearts NOT restored (ADR-8).
      // Also:
      //   - Recounts report_count for gifts this user reported (item 4: their reports now count).
      //   - Removes their banned_identity tombstone (item 1: so they can sign in normally).
      //     Fails closed without SUB_HMAC_KEY.

      // Tombstones are per identity (provider:subject), ADR-9. Fail closed without SUB_HMAC_KEY.
      if (!env.SUB_HMAC_KEY) {
        console.error('giftModeration: SUB_HMAC_KEY missing; unban refused (tombstone cannot be cleared)')
        return json({ error: 'misconfigured' }, 503)
      }
      const identities = await env.DB
        .prepare('SELECT provider, subject FROM user_identity WHERE user_id = ?')
        .bind(targetUserId)
        .all<{ provider: string; subject: string }>()
      const tombstoneKeys: string[] = []
      for (const id of identities.results) {
        tombstoneKeys.push(await hmacSha256Hex(env.SUB_HMAC_KEY, `${id.provider}:${id.subject}`))
      }

      await env.DB.batch([
        env.DB.prepare('UPDATE app_user SET banned = 0 WHERE id = ?').bind(targetUserId),
        env.DB.prepare(
          'UPDATE gift SET status = status_before_ban, status_before_ban = NULL ' +
          "WHERE user_id = ? AND status = 'hidden_admin' AND status_before_ban IS NOT NULL",
        ).bind(targetUserId),
        // Report recount for gifts this user reported (item 4): their reports now count again.
        env.DB.prepare(
          'UPDATE gift SET report_count = (' +
          '  SELECT COUNT(*) FROM report r ' +
          '  JOIN app_user u ON u.id = r.user_id ' +
          '  WHERE r.gift_id = gift.id AND r.acknowledged = 0 AND u.banned = 0' +
          '  AND (strftime(\'%s\', r.created_at) - strftime(\'%s\', u.created_at)) >= 86400' +
          ') WHERE id IN (SELECT DISTINCT gift_id FROM report WHERE user_id = ?)',
        ).bind(targetUserId),
        // Remove every tombstone of this user's identities (ADR-8), atomically with the unban.
        ...tombstoneKeys.map((k) => env.DB.prepare('DELETE FROM banned_identity WHERE sub_hmac = ?').bind(k)),
        env.DB.prepare(
          'INSERT INTO admin_audit (actor_user_id, action, target_user_id, at) VALUES (?, ?, ?, ?)',
        ).bind(adminUserId, 'unban', targetUserId, new Date().toISOString()),
      ])
    }

    return json({ ok: true })
  }

  return error('not_found')
}
