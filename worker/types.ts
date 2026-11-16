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
  ADMIN_TOKEN: string
  CARD_IP_LIMIT: RateLimit
  ADMIN_FAIL_LIMIT: RateLimit
}
