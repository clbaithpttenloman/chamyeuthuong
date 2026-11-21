/** Minimal D1 binding types (no @cloudflare/workers-types). */
export type D1Stmt = {
  bind(...values: unknown[]): D1Stmt
  run(): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }>
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}

export type D1 = {
  prepare(sql: string): D1Stmt
  batch(statements: D1Stmt[]): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }[]>
}

export type RateLimit = {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/** Minimal Cloudflare ExecutionContext (subset needed by the worker). */
export type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void
}

export type Env = {
  DB: D1
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** Rate limit for public read endpoints: 120 req/60 s per IP, namespace 2004. */
  PUBLIC_IP_LIMIT: RateLimit
  /** Rate limit for student card submissions: 20 req/60 s per IP, namespace 2005. */
  SUBMIT_IP_LIMIT: RateLimit
  CARD_IP_LIMIT: RateLimit
  ADMIN_FAIL_LIMIT: RateLimit
  /** Rate limit for public image fetches: 300 req/60 s per IP, namespace 2003. */
  IMAGE_IP_LIMIT: RateLimit
  /** Rate limit for auth endpoints (failures): 300 req/60 s per IP. Auth_LIMIT counts failures only on sign-in; counts all requests on nonce. */
  AUTH_LIMIT?: RateLimit
  /** Per-sub rate limit on successful sign-ins: 10 req/60 s per sub, namespace 2009. */
  AUTH_SUB_LIMIT?: RateLimit
  /** Rate limit for session reads (GET /api/me, /api/me/gifts): 120 req/60 s per user. */
  USER_READ_LIMIT?: RateLimit
  /** Rate limit for session writes (PUT /api/me, DELETE, logout): 10 req/60 s per user. */
  USER_WRITE_LIMIT?: RateLimit
  /** Rate limit for public campaign reads (cache misses): 3,000 req/60 s per IP, namespace 2010. */
  PUBLIC_READ_LIMIT?: RateLimit
  /** Set to a specific email to restrict who can claim the first-admin bootstrap. */
  BOOTSTRAP_EMAIL?: string
  /** Set to '1' (only when BOOTSTRAP_EMAIL is unset) to allow any user to claim the first admin slot. */
  ALLOW_FIRST_CLAIM?: string
  // ---- Phase 1: Google sign-in + sessions ----
  /** Google OAuth client ID. Must end with .apps.googleusercontent.com. */
  GOOGLE_CLIENT_ID?: string
  /** Secret for HMAC-signing nonces (32+ bytes). Set via `wrangler secret put NONCE_KEY`. */
  NONCE_KEY?: string
  /** Secret for HMAC-hashing Google subs in ban tombstones. Set via `wrangler secret put SUB_HMAC_KEY`. */
  SUB_HMAC_KEY?: string
  /** Secret for HMAC-hashing IP addresses. Set via `wrangler secret put IP_HMAC_KEY`. */
  IP_HMAC_KEY?: string
  /** Set to '1' in Phase 1 to allow legacy X-Admin-Email login on 20/11 routes (transition only). */
  ADMIN_LEGACY_LOGIN?: string
}
