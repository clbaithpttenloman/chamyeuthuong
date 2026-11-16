import { error } from './http.ts'
import type { Env } from './types.ts'

/** SHA-256 hash of a UTF-8 string, returned as Uint8Array. */
async function sha256(s: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return new Uint8Array(buf)
}

/**
 * Constant-time string comparison via SHA-256 + XOR accumulate.
 * Not using crypto.subtle.timingSafeEqual (non-standard Workers extension; plan § Constraints).
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)])
  let acc = 0
  for (let i = 0; i < ha.length; i++) acc |= (ha[i] ?? 0) ^ (hb[i] ?? 0)
  return acc === 0
}

/**
 * Guards every /api/admin/* request.
 * Returns a Response on failure (rate-limited, misconfigured, or wrong token), undefined on success.
 * Order per plan: rate limit checked before token comparison.
 */
export async function requireAdmin(
  request: Request,
  env: Pick<Env, 'ADMIN_TOKEN' | 'ADMIN_FAIL_LIMIT'>,
): Promise<Response | undefined> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  // 1. Rate limit — counted before token comparison (plan § Decision: Admin auth)
  const { success } = await env.ADMIN_FAIL_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  // 2. ADMIN_TOKEN must be configured and ≥ 32 chars (shorter means misconfigured)
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) {
    console.error('admin: misconfigured')
    return error('unauthorized')
  }

  // 3. Authorization: Bearer <token>
  const auth = request.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return error('unauthorized')
  const provided = auth.slice(7)

  // 4. Constant-time comparison
  if (!(await safeEqual(provided, env.ADMIN_TOKEN))) return error('unauthorized')

  return undefined
}
