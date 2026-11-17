import { error, json } from './http.ts'
import { isToken } from './token.ts'
import { ensureSchema } from './schema.ts'
import { DEFAULT_LAYOUT, SLOTS } from '../shared/layouts.ts'
import type { Env } from './types.ts'

type PublishedCard = {
  name: string
  subject: string
  message: string
  layout: string
  images: Record<string, string>
  title: 'Thầy' | 'Cô' | null
}

/**
 * GET /api/card/:token — returns { name, subject, message, layout, images } for a published card.
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
    'SELECT t.name, t.subject, c.message, t.id AS teacher_id, ' +
    `COALESCE(cs.layout, '${DEFAULT_LAYOUT}') AS layout, tt.title ` +
    'FROM teacher t ' +
    'JOIN card c ON c.teacher_id = t.id ' +
    'LEFT JOIN card_style cs ON cs.teacher_id = t.id ' +
    'LEFT JOIN teacher_title tt ON tt.teacher_id = t.id ' +
    "WHERE t.token = ? AND c.status = 'published'",
  )
    .bind(token)
    .first<{ name: string; subject: string; message: string; teacher_id: number; layout: string; title: string | null }>()

  if (!row) return error('not_found')

  // Fetch image tokens for each attached slot
  const { results: imgRows } = await env.DB
    .prepare(
      'SELECT ci.slot, i.token FROM card_image ci ' +
      'JOIN image i ON i.id = ci.image_id ' +
      'WHERE ci.teacher_id = ?',
    )
    .bind(row.teacher_id)
    .all<{ slot: string; token: string }>()

  // Build images map; only include valid slot names
  const images: Record<string, string> = {}
  for (const r of imgRows) {
    if ((SLOTS as readonly string[]).includes(r.slot)) {
      images[r.slot] = r.token
    }
  }

  // Return only public fields — never teacher_id, token, id, created_at, status
  return json({
    name: row.name,
    subject: row.subject,
    message: row.message,
    layout: row.layout,
    title: (row.title ?? null) as 'Thầy' | 'Cô' | null,
    images,
  } satisfies PublishedCard)
}
