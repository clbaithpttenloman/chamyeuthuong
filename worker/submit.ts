/**
 * worker/submit.ts — student card submission endpoint.
 *
 * Handles: POST /api/cards
 *
 * Accepts exactly one of:
 *   teacherId (positive integer): only teachers with show_on_home = 1
 *   teacherToken (16-char QR token): any teacher (for /gui-thiep?t=<token> flow)
 * Providing both or neither → 400.
 *
 * Order: rate limit → method check → Content-Type → body size + parse →
 *        input validation → ensureSchema → atomic INSERT with caps.
 *
 * Never echoes the submitted card or logs student text.
 * Text validation uses shared/text.ts helpers.
 */
import { error, json } from './http.ts'
import { isToken, newToken } from './token.ts'
import { ensureSchema } from './schema.ts'
import { DEFAULT_FONT, DEFAULT_INK, isFont, isInkInput, normalizeInk } from '../shared/fonts.ts'
import {
  hasControlCharsSingleLine,
  hasControlCharsMultiline,
  hasLoneSurrogate,
} from '../shared/text.ts'
import {
  MAX_MESSAGE, MAX_FROM_NAME, MAX_FROM_CLASS, MAX_NEWLINES,
  PENDING_CAP, PENDING_CAP_PER_TEACHER,
} from '../shared/api.ts'
import { isEffectivelyOpen } from '../shared/campaign.ts'
import type { Env } from './types.ts'

/** Known top-level keys in the submit body. */
const KNOWN_KEYS = new Set(['teacherId', 'teacherToken', 'templateId', 'message', 'fromName', 'fromClass', 'anonymous', 'font', 'ink'])

/**
 * POST /api/cards — submit a student card.
 */
export async function handleSubmit(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  // 1. Rate limit — first, before any other work
  const { success } = await env.SUBMIT_IP_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  // 2. Method guard
  if (request.method !== 'POST') return error('method')

  // 3. Content-Type: must be application/json (optional ; charset=utf-8)
  const rawCt = request.headers.get('Content-Type') ?? ''
  const mediaType = rawCt.split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') return error('bad_request')

  // 4. Body size check (≤ 2 KB) + parse
  const body = request.body
  if (!body) return error('bad_request')
  const reader = body.getReader()
  let total = 0
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > 2048) {
      reader.cancel().catch(() => {})
      return error('bad_request')
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength }

  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder().decode(all)) } catch { return error('bad_request') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return error('bad_request')
  const body2 = parsed as Record<string, unknown>

  // 5. Known keys only
  for (const key of Object.keys(body2)) {
    if (!KNOWN_KEYS.has(key)) return error('bad_request')
  }

  // 6. Exactly one of teacherId or teacherToken must be present
  const hasTeacherId = 'teacherId' in body2
  const hasTeacherToken = 'teacherToken' in body2
  if (hasTeacherId === hasTeacherToken) return error('bad_request') // both or neither

  // 7. Validate the teacher identifier
  let teacherId: number | null = null
  let teacherToken: string | null = null

  if (hasTeacherId) {
    const tid = body2.teacherId
    if (typeof tid !== 'number' || !Number.isInteger(tid) || tid < 1) return error('bad_request')
    teacherId = tid
  } else {
    const tok = body2.teacherToken
    if (typeof tok !== 'string' || !isToken(tok)) return error('bad_request')
    teacherToken = tok
  }

  // 8. templateId must be a positive integer
  if (typeof body2.templateId !== 'number' || !Number.isInteger(body2.templateId) || body2.templateId < 1) {
    return error('bad_request')
  }
  const templateId = body2.templateId as number

  // 9. anonymous must be boolean if present
  if ('anonymous' in body2 && typeof body2.anonymous !== 'boolean') return error('bad_request')

  // 9b. Student's font and ink (they end up in an inline style, so only exact values pass).
  // Absent → default. Present → must be valid (null and non-strings included → 400).
  if ('font' in body2 && !isFont(body2.font)) return error('bad_request')
  if ('ink' in body2 && !isInkInput(body2.ink)) return error('bad_request')
  const font = 'font' in body2 ? (body2.font as string) : DEFAULT_FONT
  const ink = 'ink' in body2 ? normalizeInk(body2.ink as string) : DEFAULT_INK

  // 10. NFC normalisation + trim
  const rawMessage = typeof body2.message === 'string' ? body2.message.normalize('NFC').trim() : ''
  const anonymous = typeof body2.anonymous === 'boolean' ? body2.anonymous : false
  const rawFromName = anonymous ? '' : (typeof body2.fromName === 'string' ? body2.fromName.normalize('NFC').trim() : '')
  const rawFromClass = typeof body2.fromClass === 'string' ? body2.fromClass.normalize('NFC').trim() : ''

  // 11. Length checks (code points)
  if ([...rawMessage].length < 1 || [...rawMessage].length > MAX_MESSAGE) return error('bad_request')
  if ([...rawFromName].length > MAX_FROM_NAME) return error('bad_request')
  if ([...rawFromClass].length > MAX_FROM_CLASS) return error('bad_request')

  // 12. Control / format character rejection (using shared/text.ts helpers)
  if ([rawMessage, rawFromName, rawFromClass].some((v) => hasLoneSurrogate(v))) return error('bad_request')
  if (hasControlCharsMultiline(rawMessage)) return error('bad_request')
  if (hasControlCharsSingleLine(rawFromName)) return error('bad_request')
  if (hasControlCharsSingleLine(rawFromClass)) return error('bad_request')

  // 13. Newline count
  const newlines = (rawMessage.match(/\n/g) ?? []).length
  if (newlines > MAX_NEWLINES) return error('bad_request')

  // 14. ensureSchema
  await ensureSchema(env.DB)

  // 14b. Campaign 1 (slug '20-11') must be effectively open.
  // Treats missing campaign as closed — foreign users cannot submit to a non-existent campaign.
  const campaign1 = await env.DB
    .prepare("SELECT status, starts_at, ends_at FROM campaign WHERE slug = '20-11' LIMIT 1")
    .first<{ status: 'draft' | 'active' | 'closed'; starts_at: string; ends_at: string }>()
  if (!campaign1 || !isEffectivelyOpen(campaign1, new Date())) {
    return new Response(JSON.stringify({ error: 'campaign_closed' }), {
      status: 409,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex',
      },
    })
  }

  // 15. Atomic INSERT with teacher exists + template active + global cap + per-teacher cap
  const now = new Date().toISOString()
  const anonInt = anonymous ? 1 : 0

  for (let attempt = 0; attempt < 3; attempt++) {
    const pid = newToken()
    try {
      let result: { meta: { changes: number } }

      if (teacherId !== null) {
        // teacherId path: teacher must exist AND show_on_home = 1
        result = await env.DB
          .prepare(
            'INSERT INTO student_card ' +
            '(public_id, teacher_id, template_id, message, from_name, from_class, anonymous, status, created_at, font, ink) ' +
            'SELECT ?, t.id, ?, ?, ?, ?, ?, \'pending\', ?, ?, ? ' +
            'FROM teacher t ' +
            'JOIN teacher_profile tp ON tp.teacher_id = t.id ' +
            'WHERE t.id = ? AND tp.show_on_home = 1 ' +
            '  AND EXISTS (SELECT 1 FROM template WHERE id = ? AND active = 1) ' +
            '  AND (SELECT COUNT(*) FROM student_card WHERE status = \'pending\') < ? ' +
            '  AND (SELECT COUNT(*) FROM student_card sc2 WHERE sc2.teacher_id = t.id AND sc2.status = \'pending\') < ?',
          )
          .bind(pid, templateId, rawMessage, rawFromName, rawFromClass, anonInt, now, font, ink,
            teacherId, templateId, PENDING_CAP, PENDING_CAP_PER_TEACHER)
          .run()
      } else {
        // teacherToken path: any teacher (including hidden)
        result = await env.DB
          .prepare(
            'INSERT INTO student_card ' +
            '(public_id, teacher_id, template_id, message, from_name, from_class, anonymous, status, created_at, font, ink) ' +
            'SELECT ?, t.id, ?, ?, ?, ?, ?, \'pending\', ?, ?, ? ' +
            'FROM teacher t ' +
            'WHERE t.token = ? ' +
            '  AND EXISTS (SELECT 1 FROM template WHERE id = ? AND active = 1) ' +
            '  AND (SELECT COUNT(*) FROM student_card WHERE status = \'pending\') < ? ' +
            '  AND (SELECT COUNT(*) FROM student_card sc2 WHERE sc2.teacher_id = t.id AND sc2.status = \'pending\') < ?',
          )
          .bind(pid, templateId, rawMessage, rawFromName, rawFromClass, anonInt, now, font, ink,
            teacherToken, templateId, PENDING_CAP, PENDING_CAP_PER_TEACHER)
          .run()
      }

      if (result.meta.changes === 0) {
        // Disambiguate: teacher not found → 404, inactive/missing template → 400, caps hit → 409
        let teacherExists = 0
        if (teacherId !== null) {
          const row = await env.DB
            .prepare(
              'SELECT COUNT(*) AS c FROM teacher t JOIN teacher_profile tp ON tp.teacher_id = t.id ' +
              'WHERE t.id = ? AND tp.show_on_home = 1',
            )
            .bind(teacherId)
            .first<{ c: number }>()
          teacherExists = row?.c ?? 0
        } else {
          const row = await env.DB
            .prepare('SELECT COUNT(*) AS c FROM teacher WHERE token = ?')
            .bind(teacherToken)
            .first<{ c: number }>()
          teacherExists = row?.c ?? 0
        }
        if (teacherExists === 0) return error('not_found')

        const tmplRow = await env.DB
          .prepare('SELECT active FROM template WHERE id = ?')
          .bind(templateId)
          .first<{ active: number | null }>()
        if (!tmplRow || tmplRow.active !== 1) return error('bad_request')
        return error('conflict')
      }

      return json({ status: 'pending' }, 201)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('UNIQUE constraint failed: student_card.public_id')) continue
      if (msg.includes('FOREIGN KEY') || msg.includes('CHECK constraint')) return error('bad_request')
      throw e
    }
  }

  // All 3 retries hit public_id collision (virtually impossible)
  console.error('submit: unavailable')
  return error('unavailable')
}
