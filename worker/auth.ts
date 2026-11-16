import { normalizeEmail } from './email.ts'
import { error } from './http.ts'
import { ensureSchema } from './schema.ts'
import type { Env } from './types.ts'

/**
 * Guards every /api/admin/* request using a typed email header + DB admin table.
 *
 * Returns `{ email }` when the request may proceed, or a Response on any failure.
 * Order: (1) rate limit → (2) X-Admin-Email (normalise, validate) →
 *        (3) CSRF checks (Sec-Fetch-Site, X-Requested-With) →
 *        (4) ensureSchema → (5) DB lookup / claim gate / atomic bootstrap.
 *
 * The email is never logged — fixed-string logs only.
 */
export async function requireAdmin(
  request: Request,
  env: Pick<Env, 'ADMIN_FAIL_LIMIT' | 'DB' | 'BOOTSTRAP_EMAIL' | 'ALLOW_FIRST_CLAIM'>,
): Promise<{ email: string } | Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  // 1. Rate limit — always checked first; prevents any work on flooded IPs.
  const { success } = await env.ADMIN_FAIL_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  // 2. X-Admin-Email — normalise (trim, lower-case, ASCII pattern, ≤ 254 chars).
  //    Headers.get() on a duplicated header returns a comma-joined value → normalizeEmail returns null.
  const rawEmail = request.headers.get('X-Admin-Email')
  const email = normalizeEmail(rawEmail)
  if (email === null) return error('unauthorized')

  // 3. CSRF checks (after email, before DB):
  //    - Sec-Fetch-Site: cross-site → 403 for every method.
  //    - Non-GET without X-Requested-With: fetch → 403.
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return error('forbidden')
  if (request.method !== 'GET' && request.headers.get('X-Requested-With') !== 'fetch') {
    return error('forbidden')
  }

  // 4. DB lookup: single query checks caller membership AND whether the table has any admins.
  //    This avoids a second round-trip and keeps bootstrap-path prepares at exactly 1 SELECT + 1 INSERT.
  await ensureSchema(env.DB)
  const check = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM admin WHERE email = ?) AS is_caller,' +
    ' (SELECT COUNT(*) FROM admin) AS total_admins',
  ).bind(email).first<{ is_caller: number; total_admins: number }>()

  if ((check?.is_caller ?? 0) > 0) return { email }

  // Caller is not an admin. If the table already has admins (just not this caller), deny silently.
  if ((check?.total_admins ?? 0) > 0) return error('unauthorized')

  // ---- Bootstrap path: table is empty ----

  // Bootstrap write requires X-Requested-With: fetch on every method (including GET).
  // Standard CSRF (above) only guards non-GET; this guard covers GET specifically for bootstrap.
  if (request.headers.get('X-Requested-With') !== 'fetch') return error('forbidden')

  // Gate evaluation: BOOTSTRAP_EMAIL present (even empty string) takes precedence
  // over ALLOW_FIRST_CLAIM. Only if BOOTSTRAP_EMAIL is undefined does ALLOW_FIRST_CLAIM apply.
  const rawBootstrapEmail = env.BOOTSTRAP_EMAIL
  if (rawBootstrapEmail !== undefined) {
    // BOOTSTRAP_EMAIL is set; normalise and compare. Empty or mismatch → 401.
    const bootstrapEmail = rawBootstrapEmail.trim().toLowerCase()
    if (!bootstrapEmail || bootstrapEmail !== email) return error('unauthorized')
    // Match: proceed to INSERT.
  } else if (env.ALLOW_FIRST_CLAIM !== '1') {
    // Neither BOOTSTRAP_EMAIL nor ALLOW_FIRST_CLAIM configured for empty table.
    console.error('admin: misconfigured')
    return error('unauthorized')
  }
  // else: BOOTSTRAP_EMAIL undefined AND ALLOW_FIRST_CLAIM === '1' → open claim, proceed.

  // 5. Bootstrap INSERT: exactly one prepare() call, atomic WHERE NOT EXISTS.
  //    If two simultaneous first requests arrive, only one INSERT wins (D1/SQLite serialises writes).
  const now = new Date().toISOString()
  const result = await env.DB
    .prepare(
      "INSERT INTO admin (email, created_at, created_by) SELECT ?, ?, 'bootstrap' WHERE NOT EXISTS (SELECT 1 FROM admin)",
    )
    .bind(email, now)
    .run()

  if (result.meta.changes === 1) {
    // This caller inserted the first admin row.
    console.error('admin: bootstrap')
    return { email }
  }

  // changes === 0: someone else won the race (admin table is now non-empty).
  // Re-SELECT to check if the winner used this same email (same user, two parallel requests).
  const reCheck = await env.DB.prepare('SELECT 1 FROM admin WHERE email = ?').bind(email).first()
  if (reCheck) return { email }

  // A different user won the first-admin slot; this caller is not an admin.
  return error('unauthorized')
}
