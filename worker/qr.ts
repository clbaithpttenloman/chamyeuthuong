/**
 * worker/qr.ts — QR code endpoint (private teacher token → random approved card).
 *
 * Handles: GET /api/qr/:token
 *
 * Order: rate limit → method check → isToken → ensureSchema → DB.
 * Replaces the old GET /api/card/:token endpoint.
 */
import { error, json } from './http.ts'
import { isToken } from './token.ts'
import { ensureSchema } from './schema.ts'
import { formatFrom } from '../shared/api.ts'
import type { Env } from './types.ts'

export async function handleQr(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  // 1. Rate limit — always first
  const { success } = await env.CARD_IP_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  // 2. Method guard
  if (request.method !== 'GET') return error('method')

  // 3. Token validation — no DB for malformed tokens (test tokens are 15 chars, production 16)
  const segments = new URL(request.url).pathname.split('/')
  // Expect: ['', 'api', 'qr', '<token>'] (length 4)
  const token = segments.length === 4 ? segments[3] ?? '' : ''
  if (!isToken(token)) return error('not_found')

  // 4. ensureSchema then DB
  await ensureSchema(env.DB)

  // Look up teacher by private QR token
  const teacherRow = await env.DB
    .prepare(
      'SELECT t.id AS teacher_id, tp.public_id AS publicId, tt.title, t.name, t.subject, tp.department ' +
      'FROM teacher t ' +
      'JOIN teacher_profile tp ON tp.teacher_id = t.id ' +
      'LEFT JOIN teacher_title tt ON tt.teacher_id = t.id ' +
      'WHERE t.token = ?',
    )
    .bind(token)
    .first<{ teacher_id: number; publicId: string; title: string | null; name: string; subject: string; department: string }>()

  if (!teacherRow) return error('not_found')

  // Random approved card for this teacher
  const cardRow = await env.DB
    .prepare(
      'SELECT sc.public_id, sc.message, sc.from_name, sc.from_class, sc.anonymous, sc.created_at, ' +
      'sc.template_id, tmpl.layout ' +
      'FROM student_card sc ' +
      'JOIN template tmpl ON tmpl.id = sc.template_id ' +
      "WHERE sc.teacher_id = ? AND sc.status = 'approved' " +
      'ORDER BY random() LIMIT 1',
    )
    .bind(teacherRow.teacher_id)
    .first<{
      public_id: string; message: string; from_name: string; from_class: string
      anonymous: number; created_at: string; template_id: number; layout: string
    }>()

  // Total approved cards for this teacher
  const totalRow = await env.DB
    .prepare("SELECT COUNT(*) AS total FROM student_card WHERE teacher_id = ? AND status = 'approved'")
    .bind(teacherRow.teacher_id)
    .first<{ total: number }>()

  let card = null
  if (cardRow) {
    // Fetch template images
    const { results: imgRows } = await env.DB
      .prepare(
        'SELECT ti.slot, i.token FROM template_image ti JOIN image i ON i.id = ti.image_id WHERE ti.template_id = ?',
      )
      .bind(cardRow.template_id)
      .all<{ slot: string; token: string }>()
    const images: Record<string, string> = {}
    for (const r of imgRows) images[r.slot] = r.token

    card = {
      publicId: cardRow.public_id,
      layout: cardRow.layout,
      images,
      message: cardRow.message,
      from: formatFrom({
        fromName: cardRow.from_name,
        fromClass: cardRow.from_class,
        anonymous: cardRow.anonymous === 1,
      }),
      createdAt: cardRow.created_at,
    }
  }

  return json({
    teacher: {
      publicId: teacherRow.publicId,
      title: teacherRow.title,
      name: teacherRow.name,
      subject: teacherRow.subject,
      department: teacherRow.department,
    },
    card,
    total: totalRow?.total ?? 0,
  })
}
