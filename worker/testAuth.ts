/**
 * Test helpers for typed-email admin authentication.
 * Provides env builder, request builder adding X-Admin-Email + X-Requested-With on non-GET,
 * and seedAdmin.  No external auth dependencies.
 */
import { testDb, type D1 } from './testDb.ts'

// ---- Constants ----

/** Default test email (always lowercase, valid format). */
export const TEST_EMAIL = 'admin@example.com'

// ---- Env type and builder ----

/** Minimal env shape for requireAdmin (legacy path). */
export type AdminEnv = {
  ADMIN_FAIL_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  DB: D1
  BOOTSTRAP_EMAIL?: string
  ALLOW_FIRST_CLAIM?: string
  /** Phase 1: controls whether the legacy X-Admin-Email path is active. */
  ADMIN_LEGACY_LOGIN?: string
}

type AdminEnvOpts = {
  /** Whether the rate-limit check succeeds (default true). */
  failLimit?: boolean
  /** Provide a specific D1 instance. Defaults to a fresh empty testDb. */
  db?: D1
  /** Set BOOTSTRAP_EMAIL in env. */
  bootstrapEmail?: string
  /** Set ALLOW_FIRST_CLAIM in env. Pass '1' to enable open first-user claim. */
  allowFirstClaim?: string
  /**
   * Set ADMIN_LEGACY_LOGIN in env.
   * Default: '1' (so the existing tests that use X-Admin-Email keep passing;
   * the existing requireAdmin call sites are updated with opts.legacy:true in Phase 1).
   */
  legacyLogin?: string
}

/**
 * Build a minimal env for direct requireAdmin tests.
 * Example: requireAdmin(req, adminEnv({ db }))
 *
 * ADMIN_LEGACY_LOGIN defaults to '1' so existing tests that use X-Admin-Email keep
 * passing after Phase 1 (which requires opts.legacy:true + flag on for the email path).
 * Pass legacyLogin: undefined explicitly to test the flag-off code path.
 */
export function adminEnv(opts: AdminEnvOpts = {}): AdminEnv {
  return {
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: opts.failLimit ?? true }) },
    DB: opts.db ?? testDb().db,
    BOOTSTRAP_EMAIL: opts.bootstrapEmail,
    ALLOW_FIRST_CLAIM: opts.allowFirstClaim,
    // Default to '1' so existing legacy-path tests keep passing without each needing
    // to set the flag explicitly. Use `legacyLogin: undefined` to test flag-off.
    ADMIN_LEGACY_LOGIN: 'legacyLogin' in opts ? opts.legacyLogin : '1',
  }
}

// ---- Request builder ----

/**
 * Build a Request for /api/admin/teachers.
 * @param email  Admin email; placed in `X-Admin-Email` header, or null for no header.
 * @param opts   method (default GET), noXrw (suppress auto X-Requested-With on non-GET),
 *               xrw (force X-Requested-With on any method, needed for bootstrap GET),
 *               secFetchSite, ip.
 */
export function makeReq(
  email: string | null,
  opts: { method?: string; noXrw?: boolean; xrw?: boolean; secFetchSite?: string; ip?: string } = {},
): Request {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = { 'CF-Connecting-IP': opts.ip ?? '1.2.3.4' }
  if (email !== null) headers['X-Admin-Email'] = email
  // Add X-Requested-With for non-GET unless caller opts out (CSRF tests do this)
  if (method !== 'GET' && !opts.noXrw) headers['X-Requested-With'] = 'fetch'
  // Force X-Requested-With even for GET (bootstrap write requirement)
  if (opts.xrw) headers['X-Requested-With'] = 'fetch'
  if (opts.secFetchSite) headers['Sec-Fetch-Site'] = opts.secFetchSite
  return new Request('https://x/api/admin/teachers', { method, headers })
}

/**
 * Seed an admin row for the given email (default TEST_EMAIL) in a D1-compatible DB.
 * Use in beforeEach / test setup to simulate an already-registered admin.
 */
export async function seedAdmin(db: D1, email = TEST_EMAIL): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare('INSERT INTO admin (email, created_at, created_by) VALUES (?, ?, ?)')
    .bind(email.toLowerCase().trim(), now, 'test-seed')
    .run()
}
