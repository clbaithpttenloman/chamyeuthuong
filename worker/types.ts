/** Minimal D1 binding types (no @cloudflare/workers-types). */
export type D1Stmt = {
  bind(...values: unknown[]): D1Stmt
  run(): Promise<{ success: boolean; meta: { changes: number } }>
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}

export type D1 = {
  prepare(sql: string): D1Stmt
  batch(statements: D1Stmt[]): Promise<{ success: boolean; meta: { changes: number } }[]>
}

export type RateLimit = {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export type Env = {
  DB: D1
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** Google OAuth client ID — must end with .apps.googleusercontent.com. */
  GOOGLE_CLIENT_ID: string
  /** Set to '1' in .dev.vars to enable the local JWKS override for dev/smoke testing. */
  AUTH_DEV_MODE?: string
  /** Local JWKS server URL — honored only when AUTH_DEV_MODE === '1'. Must be http://127.0.0.1:<port>/<path>. */
  AUTH_DEV_JWKS_URL?: string
  CARD_IP_LIMIT: RateLimit
  ADMIN_FAIL_LIMIT: RateLimit
  /** Set to a specific email to restrict who can claim the first-admin bootstrap. */
  BOOTSTRAP_EMAIL?: string
  /** Set to '1' (only when BOOTSTRAP_EMAIL is unset) to allow any verified user to claim the first admin slot. */
  ALLOW_FIRST_CLAIM?: string
}
