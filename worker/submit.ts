/**
 * worker/submit.ts — student card submission endpoint.
 *
 * Handles: POST /api/cards
 *
 * Order: rate limit → method check → Content-Type → body size + parse →
 *        input validation (isToken, NFC, lengths, control chars, newlines) →
 *        ensureSchema → atomic INSERT…SELECT with caps → disambiguate on 0 changes.
 *
 * Never echoes the submitted card or logs student text.
 */
import { error, json } from './http.ts'
import { isToken, newToken } from './token.ts'
import { ensureSchema } from './schema.ts'
import {
  MAX_MESSAGE, MAX_FROM_NAME, MAX_FROM_CLASS, MAX_NEWLINES,
  PENDING_CAP, PENDING_CAP_PER_TEACHER,
} from '../shared/api.ts'
import type { Env } from './types.ts'

// Invisible or text-direction characters that could hide or disguise content. U+200D (zero-width joiner)
// and variation selectors are allowed because emoji such as 👩‍🏫 and ❤️ need them.
const INVISIBLE = '\\u00AD\\u034F\\u061C\\u180E\\u200B\\u200C\\u200E\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2069\\u3164\\uFEFF\\uFFA0'
const REJECT_MSG_RE = new RegExp(`[\\x00-\\x09\\x0B-\\x1F\\x7F\\x80-\\x9F${INVISIBLE}]|[\\u{E0000}-\\u{E007F}]`, 'u')
/** Reject all control characters and format characters in name/class fields. */
const REJECT_NAME_RE = new RegExp(`[\\x00-\\x1F\\x7F\\x80-\\x9F${INVISIBLE}]|[\\u{E0000}-\\u{E007F}]`, 'u')

/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Known top-level keys in the submit body. */
const KNOWN_KEYS = new Set(['teacherPublicId', 'templateId', 'message', 'fromName', 'fromClass', 'anonymous'])

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

  // 6. anonymous must be boolean if present
  if ('anonymous' in body2 && typeof body2.anonymous !== 'boolean') return error('bad_request')

  // 7. teacherPublicId must have the exact token shape before any DB statement
  //    here because test seed public_ids are 15 chars; production tokens are 16.
  const teacherPublicId = typeof body2.teacherPublicId === 'string' ? body2.teacherPublicId : ''
  if (!isToken(teacherPublicId)) return error('bad_request')

  // 8. templateId must be a number
  if (typeof body2.templateId !== 'number' || !Number.isInteger(body2.templateId) || body2.templateId < 1) {
    return error('bad_request')
  }
  const templateId = body2.templateId as number

  // 9. NFC normalisation + trim
  const rawMessage = typeof body2.message === 'string' ? body2.message.normalize('NFC').trim() : ''
  const anonymous = typeof body2.anonymous === 'boolean' ? body2.anonymous : false
  // anonymous=true → store from_name as empty regardless
  const rawFromName = anonymous ? '' : (typeof body2.fromName === 'string' ? body2.fromName.normalize('NFC').trim() : '')
  const rawFromClass = typeof body2.fromClass === 'string' ? body2.fromClass.normalize('NFC').trim() : ''

  // 10. Length checks (code points)
  if ([...rawMessage].length < 1 || [...rawMessage].length > MAX_MESSAGE) return error('bad_request')
  if ([...rawFromName].length > MAX_FROM_NAME) return error('bad_request')
  if ([...rawFromClass].length > MAX_FROM_CLASS) return error('bad_request')

  // 11. Control / format character rejection
  // Lone surrogates are not valid Unicode text and can fail at the database layer.
  if ([rawMessage, rawFromName, rawFromClass].some((v) => LONE_SURROGATE_RE.test(v))) return error('bad_request')
  if (REJECT_MSG_RE.test(rawMessage)) return error('bad_request')
  if (REJECT_NAME_RE.test(rawFromName)) return error('bad_request')
  if (REJECT_NAME_RE.test(rawFromClass)) return error('bad_request')

  // 12. Newline count (MAX_NEWLINES is the max allowed — reject if above)
  const newlines = (rawMessage.match(/\n/g) ?? []).length
  if (newlines > MAX_NEWLINES) return error('bad_request')

  // 13. ensureSchema
  await ensureSchema(env.DB)

  // 14. Atomic INSERT…SELECT with teacher exists + template active + global cap + per-teacher cap
  const now = new Date().toISOString()
  const anonInt = anonymous ? 1 : 0

  for (let attempt = 0; attempt < 3; attempt++) {
    const pid = newToken()
    try {
      const result = await env.DB
        .prepare(
          'INSERT INTO student_card ' +
          '(public_id, teacher_id, template_id, message, from_name, from_class, anonymous, status, created_at) ' +
          'SELECT ?, tp.teacher_id, ?, ?, ?, ?, ?, \'pending\', ? ' +
          'FROM teacher_profile tp ' +
          'WHERE tp.public_id = ? ' +
          '  AND EXISTS (SELECT 1 FROM template WHERE id = ? AND active = 1) ' +
          '  AND (SELECT COUNT(*) FROM student_card WHERE status = \'pending\') < ? ' +
          '  AND (SELECT COUNT(*) FROM student_card sc2 WHERE sc2.teacher_id = tp.teacher_id AND sc2.status = \'pending\') < ?',
        )
        .bind(
          pid, templateId, rawMessage, rawFromName, rawFromClass, anonInt, now,
          teacherPublicId, templateId, PENDING_CAP, PENDING_CAP_PER_TEACHER,
        )
        .run()

      if (result.meta.changes === 0) {
        // 15. Disambiguate: teacher not found → 404, inactive/missing template → 400, caps hit → 409
        const disambig = await env.DB
          .prepare(
            'SELECT ' +
            '(SELECT COUNT(*) FROM teacher_profile WHERE public_id = ?) AS teacher_exists, ' +
            '(SELECT active FROM template WHERE id = ?) AS template_active',
          )
          .bind(teacherPublicId, templateId)
          .first<{ teacher_exists: number; template_active: number | null }>()

        if (!disambig || disambig.teacher_exists === 0) return error('not_found')
        if (disambig.template_active !== 1) return error('bad_request')
        return error('conflict')
      }

      return json({ status: 'pending' }, 201)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('UNIQUE constraint failed: student_card.public_id')) continue // retry with new pid
      if (msg.includes('FOREIGN KEY') || msg.includes('CHECK constraint')) return error('bad_request')
      throw e
    }
  }

  // All 3 retries hit public_id collision (virtually impossible)
  console.error('submit: unavailable')
  return error('unavailable')
}
