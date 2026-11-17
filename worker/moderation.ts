/**
 * worker/moderation.ts — admin card moderation.
 *
 * Handles:
 *   GET    /api/admin/cards?status=pending|approved|hidden[&teacher=<id>][&after=<id>|&before=<id>]
 *   PUT    /api/admin/cards/:id          { status }
 *   POST   /api/admin/cards/review       { ids: number[], status: 'approved'|'hidden' }
 *   DELETE /api/admin/cards/:id
 *
 * Bulk review uses json_each so it always binds ≤ 4 params (never hits the 100-param guard).
 * Never echoes student text in logs.
 */
import { error, json, readJson, HttpError } from './http.ts'
import { parseId } from './admins.ts'
import { MAX_REVIEW_IDS } from '../shared/api.ts'
import type { Env } from './types.ts'

type AdminCardRow = {
  id: number
  public_id: string
  teacher_id: number
  template_id: number
  message: string
  from_name: string
  from_class: string
  anonymous: number
  status: string
  created_at: string
  reviewed_at: string | null
  reviewed_by: string | null
  teacher_id_ref: number
  teacher_public_id: string
  teacher_name: string
  teacher_title: string | null
  template_name: string
  template_layout: string
}

function toAdminCard(row: AdminCardRow) {
  return {
    id: row.id,
    publicId: row.public_id,
    teacherId: row.teacher_id,
    templateId: row.template_id,
    message: row.message,
    fromName: row.from_name,
    fromClass: row.from_class,
    anonymous: row.anonymous === 1,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at ?? null,
    reviewedBy: row.reviewed_by ?? null,
    teacher: {
      id: row.teacher_id_ref,
      publicId: row.teacher_public_id,
      name: row.teacher_name,
      title: row.teacher_title ?? null,
    },
    template: {
      id: row.template_id,
      name: row.template_name,
      layout: row.template_layout,
    },
  }
}

const CARD_SELECT =
  'SELECT sc.id, sc.public_id, sc.teacher_id, sc.template_id, sc.message, sc.from_name, sc.from_class, ' +
  'sc.anonymous, sc.status, sc.created_at, sc.reviewed_at, sc.reviewed_by, ' +
  't.id AS teacher_id_ref, tp.public_id AS teacher_public_id, t.name AS teacher_name, tt.title AS teacher_title, ' +
  'tmpl.name AS template_name, tmpl.layout AS template_layout ' +
  'FROM student_card sc ' +
  'JOIN teacher t ON t.id = sc.teacher_id ' +
  'LEFT JOIN teacher_profile tp ON tp.teacher_id = t.id ' +
  'LEFT JOIN teacher_title tt ON tt.teacher_id = t.id ' +
  'JOIN template tmpl ON tmpl.id = sc.template_id '

// ---- GET /api/admin/cards ----

async function listCards(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  const teacherParam = url.searchParams.get('teacher')
  const afterParam = url.searchParams.get('after')
  const beforeParam = url.searchParams.get('before')

  if (status !== 'pending' && status !== 'approved' && status !== 'hidden') {
    return error('bad_request')
  }

  // pending → oldest first (id ASC); approved/hidden → newest first (id DESC)
  const isPending = status === 'pending'
  const orderDir = isPending ? 'ASC' : 'DESC'
  const cursorClause = isPending
    ? (afterParam ? ' AND sc.id > ?' : '')
    : (beforeParam ? ' AND sc.id < ?' : '')

  const teacherClause = teacherParam ? ' AND sc.teacher_id = ?' : ''

  const sql =
    CARD_SELECT +
    `WHERE sc.status = ?${teacherClause}${cursorClause} ` +
    `ORDER BY sc.created_at ${orderDir}, sc.id ${orderDir} ` +
    'LIMIT 200'

  const args: (string | number)[] = [status]
  if (teacherParam) {
    const tid = parseId(teacherParam)
    if (tid === null) return error('bad_request')
    args.push(tid)
  }
  if (isPending && afterParam) {
    const afterId = parseId(afterParam)
    if (afterId === null) return error('bad_request')
    args.push(afterId)
  } else if (!isPending && beforeParam) {
    const beforeId = parseId(beforeParam)
    if (beforeId === null) return error('bad_request')
    args.push(beforeId)
  }

  const stmt = env.DB.prepare(sql).bind(...args)
  const { results } = await stmt.all<AdminCardRow>()
  return json(results.map(toAdminCard))
}

// ---- PUT /api/admin/cards/:id ----

async function reviewSingle(request: Request, env: Env, id: number, email: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)
  const status = body.status
  if (status !== 'approved' && status !== 'hidden') return error('bad_request')

  const now = new Date().toISOString()
  const result = await env.DB
    .prepare('UPDATE student_card SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?')
    .bind(status, now, email, id)
    .run()

  if (result.meta.changes === 0) return error('not_found')

  const row = await env.DB
    .prepare(CARD_SELECT + 'WHERE sc.id = ?')
    .bind(id)
    .first<AdminCardRow>()
  return json(row ? toAdminCard(row) : { success: true })
}

// ---- POST /api/admin/cards/review — bulk (json_each) ----

async function bulkReview(request: Request, env: Env, email: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)
  const rawIds = body.ids
  const status = body.status

  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_REVIEW_IDS) {
    return error('bad_request')
  }
  if (status !== 'approved' && status !== 'hidden') return error('bad_request')

  // Validate: all must be positive integers
  for (const id of rawIds) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return error('bad_request')
  }

  // No duplicates
  if (new Set(rawIds).size !== rawIds.length) return error('bad_request')

  const now = new Date().toISOString()
  // Bind 4 params total — stays well under the 100-param guard
  await env.DB
    .prepare(
      'UPDATE student_card SET status = ?, reviewed_at = ?, reviewed_by = ? ' +
      'WHERE id IN (SELECT value FROM json_each(?))',
    )
    .bind(status, now, email, JSON.stringify(rawIds))
    .run()

  return json({ success: true })
}

// ---- DELETE /api/admin/cards/:id ----

async function deleteCard(env: Env, id: number): Promise<Response> {
  const result = await env.DB
    .prepare('DELETE FROM student_card WHERE id = ?')
    .bind(id)
    .run()
  if (result.meta.changes === 0) return error('not_found')
  return json({ success: true })
}

/**
 * Routes admin card moderation requests.
 * Auth has already been checked; `email` is the authenticated identity.
 */
export async function handleModeration(
  request: Request,
  env: Env,
  email: string,
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const { method } = request
  const parts = pathname.split('/').filter(Boolean)

  try {
    // POST /api/admin/cards/review (must come before /:id check)
    if (parts.length === 4 && parts[2] === 'cards' && parts[3] === 'review') {
      if (method === 'POST') return await bulkReview(request, env, email)
      return error('method')
    }

    if (parts.length === 3 && parts[2] === 'cards') {
      if (method === 'GET') return await listCards(request, env)
      return error('method')
    }

    if (parts.length === 4 && parts[2] === 'cards') {
      const id = parseId(parts[3] ?? '')
      if (id === null) return error('bad_request')
      if (method === 'PUT') return await reviewSingle(request, env, id, email)
      if (method === 'DELETE') return await deleteCard(env, id)
      return error('method')
    }

    return error('not_found')
  } catch (e) {
    if (e instanceof HttpError) return error(e.code)
    throw e
  }
}
