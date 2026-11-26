import { error } from './http.ts'
import { ensureSchema } from './schema.ts'
import { getCookieValue, readSession, SESSION_COOKIE, sha256Hex } from './session.ts'
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

  // Cross-site and state-changing requests are refused before any lookup. OPTIONS gets 401 for
  // anonymous callers (below), so its header check waits for the session.
  const stateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
  const site = request.headers.get('Sec-Fetch-Site')
  if (site !== null && site !== 'same-origin' && (stateChanging || site === 'cross-site')) return error('forbidden')
  if (stateChanging && request.headers.get('X-Requested-With') !== 'fetch') return error('forbidden')

  await ensureSchema(env.DB)
  // Admins must be able to sign in and see the change-password prompt, so `must_change` is not
  // checked here; the admin routes below refuse it (default-deny, plan.md).
  const session = await readSession(request, env.DB)
  if (!session) return error('unauthorized')
  if (request.method === 'OPTIONS' && request.headers.get('X-Requested-With') !== 'fetch') {
    return error('forbidden')
  }

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

/** Routes a must_change session may still call (plan.md, default-deny). */
const MUST_CHANGE_ALLOWED: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/me' },
  { method: 'POST', path: '/api/me/password' },
  { method: 'POST', path: '/api/auth/logout' },
]

/** Routes that never read the session, whatever the method (anonymous by design). */
const PUBLIC_ANY_PREFIXES = [
  '/api/image/', '/api/theme-image/', '/api/wall', '/api/templates', '/api/wishes', '/api/about',
  '/api/auth/', '/api/campaigns/active', '/api/cards', '/api/qr/',
]

/** Read-only public routes: GET is anonymous, other methods need a session. */
const PUBLIC_GET_PREFIXES = ['/api/campaigns/', '/api/gifts/']

/**
 * Router-level default-deny for a password-change-required session (ADR-9, AC-25a).
 * Returns a 403 Response to send instead of routing, or null to continue. Only consults the
 * database when a session cookie is present, so anonymous traffic costs nothing extra.
 */
export async function mustChangeGate(request: Request, db: Env['DB']): Promise<Response | null> {
  const token = getCookieValue(request, SESSION_COOKIE)
  if (!token) return null
  const { pathname } = new URL(request.url)
  const method = request.method
  if (MUST_CHANGE_ALLOWED.some((r) => r.method === method && r.path === pathname)) return null
  if (PUBLIC_ANY_PREFIXES.some((p) => pathname.startsWith(p))) return null
  if (method === 'GET' && PUBLIC_GET_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null
  }

  const row = await db
    .prepare(
      'SELECT pc.must_change FROM session s JOIN password_credential pc ON pc.user_id = s.user_id' +
        ' WHERE s.token_hash = ? AND s.expires_at > ?',
    )
    .bind(await sha256Hex(token), new Date().toISOString())
    .first<{ must_change: number }>()
  if (!row || row.must_change !== 1) return null
  return json403('password_change_required')
}
