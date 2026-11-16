import { error, json } from './http.ts'
import { isToken } from './token.ts'
import { ensureSchema } from './schema.ts'
import type { Env } from './types.ts'

type PublishedCard = { name: string; subject: string; message: string }

/**
 * GET /api/card/:token — returns { name, subject, message } for a published card.
 * Unknown token, draft card, and malformed token all return the same 404.
 * Per-IP rate limit is applied before token validation (plan § Decision: Public API).
 */
export async function handleCard(request: Request, env: Pick<Env, 'DB' | 'CARD_IP_LIMIT'>): Promise<Response> {
  if (request.method !== 'GET') return error('method')

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  // Rate limit checked BEFORE token validation — blunts scanners (plan § Decision)
  const { success } = await env.CARD_IP_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  const token = new URL(request.url).pathname.split('/')[3] ?? ''

  // Malformed token returns 404 (not 400) — no information leak about format (plan § Threat Model)
  if (!isToken(token)) return error('not_found')

  await ensureSchema(env.DB)

  const row = await env.DB.prepare(
    'SELECT t.name, t.subject, c.message FROM teacher t ' +
    "JOIN card c ON c.teacher_id = t.id WHERE t.token = ? AND c.status = 'published'",
  )
    .bind(token)
    .first<PublishedCard>()

  if (!row) return error('not_found')

  // Return only name/subject/message — never token, id, created_at, status (plan § Threat Model)
  return json({ name: row.name, subject: row.subject, message: row.message })
}
