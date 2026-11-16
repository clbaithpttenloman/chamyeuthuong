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

/** Minimal Cloudflare ExecutionContext (subset needed by the worker). */
export type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void
}

export type Env = {
  DB: D1
  ASSETS: { fetch(request: Request): Promise<Response> }
  CARD_IP_LIMIT: RateLimit
  ADMIN_FAIL_LIMIT: RateLimit
  /** Rate limit for public image fetches: 300 req/60 s per IP, namespace 2003. */
  IMAGE_IP_LIMIT: RateLimit
  /** Set to a specific email to restrict who can claim the first-admin bootstrap. */
  BOOTSTRAP_EMAIL?: string
  /** Set to '1' (only when BOOTSTRAP_EMAIL is unset) to allow any user to claim the first admin slot. */
  ALLOW_FIRST_CLAIM?: string
}
