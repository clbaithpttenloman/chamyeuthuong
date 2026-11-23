import { error, json, readJson, HttpError } from './http.ts'
import { normalizeUsername } from '../shared/username.ts'
import { generateTempPassword, hashPassword } from './password.ts'
import type { D1, Env } from './types.ts'

/** Acting admin as returned by requireAdmin (ADR-9). */
export type AdminAuth = { userId: number; actor: string }

/** Validates `:id` path segment: 1–9 digits, value ≥ 1. Shared with admin.ts. */
export function parseId(s: string): number | null {
  if (!/^\d{1,9}$/.test(s)) return null
  const id = parseInt(s, 10)
  return id >= 1 ? id : null
}

/** Temporary passwords expire after this many hours (plan.md, admin reset). */
const TEMP_HOURS = 72

async function audit(db: D1, actorUserId: number, action: string, targetUserId: number | null, at: string) {
  await db
    .prepare('INSERT INTO admin_audit (actor_user_id, action, target_user_id, at) VALUES (?, ?, ?, ?)')
    .bind(actorUserId, action, targetUserId, at)
    .run()
}

async function listAdmins(db: D1): Promise<Response> {
  const { results } = await db
    .prepare(
      'SELECT a.user_id AS userId, ui.subject AS username, u.nickname, a.granted_at AS grantedAt, a.granted_by AS grantedBy' +
        " FROM admin_role a JOIN app_user u ON u.id = a.user_id" +
        " LEFT JOIN user_identity ui ON ui.user_id = u.id AND ui.provider = 'password'" +
        ' ORDER BY a.granted_at, a.user_id',
    )
    .all()
  return json(results)
}

async function grantAdmin(request: Request, db: D1, auth: AdminAuth): Promise<Response> {
  let body: { username?: unknown }
  try {
    body = await readJson<{ username?: unknown }>(request, 1024)
  } catch (e) {
    if (e instanceof HttpError) return error(e.code)
    throw e
  }
  const username = normalizeUsername(body.username)
  if (!username.ok) return error('bad_request')

  const target = await db
    .prepare("SELECT user_id AS userId FROM user_identity WHERE provider = 'password' AND subject = ?")
    .bind(username.value)
    .first<{ userId: number }>()
  if (!target) return error('not_found')

  const now = new Date().toISOString()
  const inserted = await db
    .prepare(
      'INSERT INTO admin_role (user_id, granted_at, granted_by) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admin_role WHERE user_id = ?)',
    )
    .bind(target.userId, now, auth.actor, target.userId)
    .run()
  if (inserted.meta.changes !== 1) return error('conflict')

  await audit(db, auth.userId, 'grant_admin', target.userId, now)
  return json({ userId: target.userId, username: username.value }, 201)
}

async function revokeAdmin(db: D1, id: number, auth: AdminAuth): Promise<Response> {
  const exists = await db.prepare('SELECT 1 AS x FROM admin_role WHERE user_id = ?').bind(id).first()
  if (!exists) return error('not_found')
  const count = await db.prepare('SELECT COUNT(*) AS c FROM admin_role').first<{ c: number }>()
  if ((count?.c ?? 0) <= 1) return json({ error: 'last_admin' }, 409)
  if (id === auth.userId) return json({ error: 'cannot_revoke_self' }, 409)

  // Conditional delete: refused when this is the last admin row. Concurrent revokes cannot both
  // pass, because the check and the delete are one statement.
  const now = new Date().toISOString()
  const removed = await db
    .prepare('DELETE FROM admin_role WHERE user_id = ? AND (SELECT COUNT(*) FROM admin_role) > 1')
    .bind(id)
    .run()
  if (removed.meta.changes !== 1) return json({ error: 'last_admin' }, 409)

  await audit(db, auth.userId, 'revoke_admin', id, now)
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}

async function resetPassword(db: D1, env: Pick<Env, 'PASSWORD_PEPPER'>, targetId: number, auth: AdminAuth): Promise<Response> {
  if (targetId === auth.userId) return error('bad_request')
  const target = await db.prepare('SELECT 1 AS x FROM app_user WHERE id = ?').bind(targetId).first()
  if (!target) return error('not_found')
  if (!env.PASSWORD_PEPPER) return error('unavailable')

  const temp = generateTempPassword()
  const cred = await hashPassword(temp, env.PASSWORD_PEPPER)
  const now = new Date()
  const nowIso = now.toISOString()
  const expires = new Date(now.getTime() + TEMP_HOURS * 60 * 60 * 1000).toISOString()

  await db.batch([
    db
      .prepare(
        'UPDATE password_credential SET hash = ?, salt = ?, iterations = ?, must_change = 1, temp_expires_at = ?,' +
          ' failed_count = 0, locked_until = NULL, updated_at = ? WHERE user_id = ?',
      )
      .bind(cred.hash, cred.salt, cred.iterations, expires, nowIso, targetId),
    db.prepare('DELETE FROM session WHERE user_id = ?').bind(targetId),
    db
      .prepare('INSERT INTO admin_audit (actor_user_id, action, target_user_id, at) VALUES (?, ?, ?, ?)')
      .bind(auth.userId, 'reset_password', targetId, nowIso),
  ])
  return json({ tempPassword: temp })
}

async function listAudit(db: D1): Promise<Response> {
  const { results } = await db
    .prepare(
      'SELECT id, actor_user_id AS actor, action, target_user_id AS targetUserId, at' +
        ' FROM admin_audit ORDER BY at DESC, id DESC LIMIT 200',
    )
    .all()
  return json(results)
}

/**
 * Admin routes that manage roles, resets and the audit log (ADR-9). The caller has already passed
 * requireAdmin and passes the acting user in `auth`.
 *   GET    /api/admin/admins                 → list admin_role holders
 *   POST   /api/admin/admins {username}      → grant (404 unknown, 409 already)
 *   DELETE /api/admin/admins/<userId>        → revoke (409 self, 409 last_admin)
 *   POST   /api/admin/users/<id>/password    → temporary password, shown once
 *   GET    /api/admin/audit                  → newest 200 audit rows
 */
export async function handleAdmins(request: Request, env: Env, auth: AdminAuth): Promise<Response> {
  const { pathname } = new URL(request.url)
  const parts = pathname.split('/').filter(Boolean) // ['api','admin', ...]
  const db = env.DB
  const method = request.method

  if (parts.length === 3 && parts[2] === 'admins') {
    if (method === 'GET') return listAdmins(db)
    if (method === 'POST') return grantAdmin(request, db, auth)
    return error('method')
  }
  if (parts.length === 4 && parts[2] === 'admins') {
    const id = parseId(parts[3]!)
    if (id === null) return error('bad_request')
    if (method !== 'DELETE') return error('method')
    return revokeAdmin(db, id, auth)
  }
  if (parts.length === 5 && parts[2] === 'users' && parts[4] === 'password') {
    const id = parseId(parts[3]!)
    if (id === null) return error('bad_request')
    if (method !== 'POST') return error('method')
    return resetPassword(db, env, id, auth)
  }
  if (parts.length === 3 && parts[2] === 'audit') {
    if (method !== 'GET') return error('method')
    return listAudit(db)
  }
  return error('not_found')
}
