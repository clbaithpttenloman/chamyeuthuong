import { error } from './http.ts'
import { ensureSchema } from './schema.ts'
import { readSession } from './session.ts'
import type { Env } from './types.ts'

/**
 * Guards every /api/admin/* request (ADR-9).
 *
 * Order: rate limit → session → CSRF → banned → must_change → admin_role row.
 * Admin is a row in `admin_role`, nothing else. Typed email headers are not accepted.
 * Returns { userId, actor } on success, where actor is the label written to created_by,
 * granted_by and admin_audit (username when there is a password identity).
 */
export async function requireAdmin(
  request: Request,
  env: Pick<Env, 'ADMIN_FAIL_LIMIT' | 'DB'>,
): Promise<{ userId: number; actor: string } | Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  const { success } = await env.ADMIN_FAIL_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  await ensureSchema(env.DB)
  // Admins must be able to sign in and see the change-password prompt, so `must_change` is not
  // checked here; the admin routes below refuse it (default-deny, plan.md).
  const session = await readSession(request, env.DB)
  if (!session) return error('unauthorized')

  // CSRF after the session check, so an anonymous caller learns nothing from the status code.
  if (request.method !== 'GET' && request.headers.get('X-Requested-With') !== 'fetch') {
    return error('forbidden')
  }
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return error('forbidden')


  const row = await env.DB
    .prepare(
      'SELECT u.banned, pc.must_change, ui.subject AS username, (SELECT 1 FROM admin_role a WHERE a.user_id = u.id) AS is_admin' +
        " FROM app_user u LEFT JOIN user_identity ui ON ui.user_id = u.id AND ui.provider = 'password'" +
        ' LEFT JOIN password_credential pc ON pc.user_id = u.id WHERE u.id = ?',
    )
    .bind(session.userId)
    .first<{ banned: number; must_change: number | null; username: string | null; is_admin: number | null }>()
  if (!row) return error('unauthorized')
  if (row.banned === 1) return error('forbidden')
  if (row.must_change === 1) return json403('password_change_required')
  if (row.is_admin !== 1) return error('forbidden')

  return {
    userId: session.userId,
    actor: row.username ? `user:${row.username}` : `user#${session.userId}`,
  }
}

/** 403 with an arbitrary code (used for password_change_required, which is not an ErrorCode). */
function json403(code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status: 403,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
  })
}
