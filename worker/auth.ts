import { normalizeEmail } from './email.ts'
import { error } from './http.ts'
import { ensureSchema } from './schema.ts'
import { readSession, getCookieValue, SESSION_COOKIE } from './session.ts'
import { isGoogleAuthoritative } from './google.ts'
import type { Env } from './types.ts'

/**
 * Guards every /api/admin/* request.
 *
 * Authentication order:
 *   1. Rate limit (always first).
 *   2. If a session cookie is present: Google session path.
 *      Verifies the user's email is in the admin list, that Google is authoritative
 *      for it, and pins admin.google_sub on first Google admin sign-in.
 *   3. No session cookie — email header path.
 *      a. Normalise X-Admin-Email header; if absent/invalid → 401.
 *      b. CSRF checks (Sec-Fetch-Site: cross-site, non-GET without X-Requested-With).
 *      c. DB lookup: if email found in admin table →
 *           - opts.legacy AND ADMIN_LEGACY_LOGIN='1' → { email }, log 'admin: legacy login used'
 *           - ALLOW_FIRST_CLAIM='1' OR BOOTSTRAP_EMAIL matches → { email }
 *           - otherwise → 401 (email header requires explicit legacy mode in Phase 1)
 *         if email not found, table non-empty → 401
 *         if table empty → bootstrap (requires X-Requested-With: fetch):
 *           BOOTSTRAP_EMAIL or ALLOW_FIRST_CLAIM='1' → INSERT → { email }
 *
 * Returns `{ email }` on success or a Response on any failure.
 * Email and sub are never logged.
 */
export async function requireAdmin(
  request: Request,
  env: Pick<Env,
    | 'ADMIN_FAIL_LIMIT' | 'DB'
    | 'BOOTSTRAP_EMAIL' | 'ALLOW_FIRST_CLAIM'
    | 'ADMIN_LEGACY_LOGIN'>,
  opts?: { legacy?: boolean },
): Promise<{ email: string } | Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  // 1. Rate limit — always checked first.
  const { success } = await env.ADMIN_FAIL_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  // ── Google session path ──────────────────────────────────────────────────
  const sessionToken = getCookieValue(request, SESSION_COOKIE)
  if (sessionToken) {
    // CSRF for the session path (same rules as email path)
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return error('forbidden')
    if (request.method !== 'GET' && request.headers.get('X-Requested-With') !== 'fetch') {
      return error('forbidden')
    }

    await ensureSchema(env.DB)
    const session = await readSession(request, env.DB)
    if (!session) return error('unauthorized')

    const userRow = await env.DB
      .prepare('SELECT email, google_sub, hd FROM app_user WHERE id = ?')
      .bind(session.userId)
      .first<{ email: string; google_sub: string; hd: string | null }>()
    if (!userRow) return error('unauthorized')

    const adminRow = await env.DB
      .prepare('SELECT google_sub FROM admin WHERE lower(email) = ?')
      .bind(userRow.email.toLowerCase())
      .first<{ google_sub: string | null }>()
    if (!adminRow) return error('forbidden')

    if (!isGoogleAuthoritative(userRow.email, userRow.hd ?? undefined)) return error('forbidden')

    if (adminRow.google_sub === null) {
      // Pin only while still unpinned; a racing sign-in by a different sub loses here.
      const pinned = await env.DB
        .prepare('UPDATE admin SET google_sub = ? WHERE lower(email) = ? AND google_sub IS NULL')
        .bind(userRow.google_sub, userRow.email.toLowerCase())
        .run()
      if (!pinned.meta?.changes) {
        const now = await env.DB
          .prepare('SELECT google_sub FROM admin WHERE lower(email) = ?')
          .bind(userRow.email.toLowerCase())
          .first<{ google_sub: string | null }>()
        if (now?.google_sub !== userRow.google_sub) return error('forbidden')
      }
    } else if (adminRow.google_sub !== userRow.google_sub) {
      return error('forbidden')
    }

    return { email: userRow.email }
  }

  // ── Email header path ────────────────────────────────────────────────────
  // Only the old 20/11 admin routes opt in (opts.legacy). Google-only routes never accept the
  // typed email, whatever BOOTSTRAP_EMAIL / ALLOW_FIRST_CLAIM say (smoke F1).
  if (!opts?.legacy) return error('unauthorized')

  // 2a. Normalise X-Admin-Email (trim, lower-case, ASCII pattern, ≤ 254 chars).
  const rawEmail = request.headers.get('X-Admin-Email')
  const email = normalizeEmail(rawEmail)
  if (email === null) return error('unauthorized')

  // 2b. CSRF checks (after email, before DB).
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return error('forbidden')
  if (request.method !== 'GET' && request.headers.get('X-Requested-With') !== 'fetch') {
    return error('forbidden')
  }

  // 2c. DB lookup.
  await ensureSchema(env.DB)
  const check = await env.DB
    .prepare(
      'SELECT (SELECT COUNT(*) FROM admin WHERE email = ?) AS is_caller,' +
      ' (SELECT COUNT(*) FROM admin) AS total_admins',
    )
    .bind(email)
    .first<{ is_caller: number; total_admins: number }>()

  if ((check?.is_caller ?? 0) > 0) {
    // Email is in the admin table. Decide which gate allows it.

    // Legacy login: flag on. BOOTSTRAP_EMAIL / ALLOW_FIRST_CLAIM are inert once the row exists.
    if (env.ADMIN_LEGACY_LOGIN === '1') {
      console.error('admin: legacy login used')
      return { email }
    }
    return error('unauthorized')
  }

  // Email not in admin table.
  if ((check?.total_admins ?? 0) > 0) return error('unauthorized')

  // ── Bootstrap path: table is empty ──────────────────────────────────────
  // Security item 5: bootstrap also requires ADMIN_LEGACY_LOGIN = "1" (staging has it unset).
  if (env.ADMIN_LEGACY_LOGIN !== '1') return error('unauthorized')

  // Bootstrap write requires X-Requested-With: fetch on every method (including GET).
  if (request.headers.get('X-Requested-With') !== 'fetch') return error('forbidden')

  const rawBootstrapEmail = env.BOOTSTRAP_EMAIL
  if (rawBootstrapEmail !== undefined) {
    const bootstrapEmail = rawBootstrapEmail.trim().toLowerCase()
    if (!bootstrapEmail || bootstrapEmail !== email) return error('unauthorized')
  } else if (env.ALLOW_FIRST_CLAIM !== '1') {
    console.error('admin: misconfigured')
    return error('unauthorized')
  }

  const now = new Date().toISOString()
  const result = await env.DB
    .prepare(
      "INSERT INTO admin (email, created_at, created_by) SELECT ?, ?, 'bootstrap'" +
      ' WHERE NOT EXISTS (SELECT 1 FROM admin)',
    )
    .bind(email, now)
    .run()

  if (result.meta.changes === 1) {
    console.error('admin: bootstrap')
    return { email }
  }

  const reCheck = await env.DB.prepare('SELECT 1 FROM admin WHERE email = ?').bind(email).first()
  if (reCheck) return { email }
  return error('unauthorized')
}
