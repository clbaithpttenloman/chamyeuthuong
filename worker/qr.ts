/**
 * worker/qr.ts — QR code endpoint (private teacher token → all approved cards).
 *
 * Handles: GET /api/qr/:token
 *
 * Response: { teacher: { id, title, name, subject, department, role }, cards: PublicCard[] (newest first, ≤200), total }
 *
 * Order: rate limit → method check → isToken → ensureSchema → DB.
 * http.ts BASE_HEADERS already set Cache-Control: no-store, X-Robots-Tag: noindex on all responses.
 */
import { error, json } from './http.ts'
import { isToken } from './token.ts'
import { ensureSchema } from './schema.ts'
import { cardWhere, fetchTemplateImages, toPublicCard, type CardRow } from './publicSql.ts'
import type { Env } from './types.ts'
import type { Role } from '../shared/api.ts'

export async function handleQr(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  // 1. Rate limit — always first
  const { success } = await env.CARD_IP_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  // 2. Method guard
  if (request.method !== 'GET') return error('method')

  // 3. Token validation — no DB for malformed tokens
  const segments = new URL(request.url).pathname.split('/')
  // Expect: ['', 'api', 'qr', '<token>'] (length 4)
  const token = segments.length === 4 ? segments[3] ?? '' : ''
  if (!isToken(token)) return error('not_found')

  // 4. ensureSchema then DB
  await ensureSchema(env.DB)

  // Look up teacher by private QR token; expose numeric id only (never the token)
  const teacherRow = await env.DB
    .prepare(
      'SELECT t.id, tt.title, t.name, t.subject, COALESCE(tp.department, \'\') AS department, ' +
      'COALESCE(tp.role, \'Giáo viên\') AS role ' +
      'FROM teacher t ' +
      'LEFT JOIN teacher_profile tp ON tp.teacher_id = t.id ' +
      'LEFT JOIN teacher_title tt ON tt.teacher_id = t.id ' +
      'WHERE t.token = ?',
    )
    .bind(token)
    .first<{ id: number; title: string | null; name: string; subject: string; department: string; role: Role }>()

  if (!teacherRow) return error('not_found')

  // All approved cards, newest first, capped at 200
  const { results: cardRows } = await env.DB
    .prepare(
      'SELECT sc.public_id, sc.message, sc.from_name, sc.from_class, sc.anonymous, sc.created_at, sc.font, sc.ink, ' +
      'sc.template_id, tmpl.layout ' +
      'FROM student_card sc ' +
      'JOIN template tmpl ON tmpl.id = sc.template_id ' +
      `WHERE sc.teacher_id = ? AND ${cardWhere('sc')} ` +
      'ORDER BY sc.created_at DESC, sc.id DESC ' +
      'LIMIT 200',
    )
    .bind(teacherRow.id)
    .all<CardRow>()

  // Total approved cards for this teacher (without the 200 cap)
  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS total FROM student_card sc WHERE sc.teacher_id = ? AND ${cardWhere('sc')}`)
    .bind(teacherRow.id)
    .first<{ total: number }>()

  const templateIds = [...new Set(cardRows.map((r) => r.template_id))]
  const imgMap = await fetchTemplateImages(env.DB, templateIds)

  const cards = cardRows.map((row) => toPublicCard(row, imgMap.get(row.template_id) ?? {}))

  return json({
    teacher: {
      id: teacherRow.id,
      title: teacherRow.title,
      name: teacherRow.name,
      subject: teacherRow.subject,
      department: teacherRow.department,
      role: teacherRow.role,
    },
    cards,
    total: totalRow?.total ?? 0,
  })
}
