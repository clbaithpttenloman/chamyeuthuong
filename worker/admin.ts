import { error, json, readJson, HttpError } from './http.ts'
import { requireAdmin } from './auth.ts'
import { handleAdmins, parseId } from './admins.ts'
import { newToken } from './token.ts'
import type { JWTVerifyGetKey } from 'jose'
import type { Env } from './types.ts'

type TeacherRow = {
  id: number
  token: string
  name: string
  subject: string
  created_at: string
  message: string
  status: string
}

/** Reusable SELECT prefix for all teacher+card joins. */
const TEACHER_SELECT =
  'SELECT t.id, t.token, t.name, t.subject, t.created_at, c.message, c.status ' +
  'FROM teacher t JOIN card c ON c.teacher_id = t.id'

/** Fetches a teacher + card row joined by id. */
async function fetchTeacher(db: Env['DB'], id: number): Promise<TeacherRow | null> {
  return db
    .prepare(`${TEACHER_SELECT} WHERE t.id = ?`)
    .bind(id)
    .first<TeacherRow>()
}

// ---- Route handlers ----

async function listTeachers(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `${TEACHER_SELECT} ORDER BY t.id`,
  ).all<TeacherRow>()
  return json(results)
}

async function createTeacher(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''

  if (name.length === 0 || name.length > 80) throw new HttpError('bad_request')
  if (subject.length > 80) throw new HttpError('bad_request')

  const now = new Date().toISOString()

  // Retry up to 3 times on UNIQUE collision (plan § Constraints)
  for (let attempt = 0; attempt < 3; attempt++) {
    const tok = newToken()
    // Pre-check avoids a catch-and-detect dance; TOCTOU risk is negligible at this scale
    const existing = await env.DB.prepare('SELECT id FROM teacher WHERE token = ?').bind(tok).first()
    if (existing) continue

    await env.DB.batch([
      env.DB.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind(tok, name, subject, now),
      env.DB.prepare("INSERT INTO card (teacher_id, message, status, updated_at) VALUES (last_insert_rowid(), '', 'draft', ?)").bind(now),
    ])

    const row = await env.DB.prepare(`${TEACHER_SELECT} WHERE t.token = ?`)
      .bind(tok)
      .first<TeacherRow>()
    return json(row)
  }

  // All 3 attempts collided (vanishingly unlikely in production)
  console.error('admin: unavailable')
  return error('unavailable')
}

async function updateTeacher(request: Request, env: Env, id: number): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)

  // Only name, subject, message, status are writable — never token, id, created_at (plan § Threat Model)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  const status = body.status

  if (name.length === 0 || name.length > 80) throw new HttpError('bad_request')
  if (subject.length > 80) throw new HttpError('bad_request')
  if (message.length > 600) throw new HttpError('bad_request')
  if (status !== 'draft' && status !== 'published') throw new HttpError('bad_request')
  if (status === 'published' && message.length === 0) throw new HttpError('bad_request')

  const now = new Date().toISOString()
  const results = await env.DB.batch([
    env.DB.prepare('UPDATE teacher SET name = ?, subject = ? WHERE id = ?').bind(name, subject, id),
    env.DB.prepare('UPDATE card SET message = ?, status = ?, updated_at = ? WHERE teacher_id = ?').bind(message, status, now, id),
  ])

  if (results[0].meta.changes === 0) return error('not_found')

  const row = await fetchTeacher(env.DB, id)
  return json(row)
}

async function rotateToken(env: Env, id: number): Promise<Response> {
  const existing = await env.DB.prepare('SELECT id FROM teacher WHERE id = ?').bind(id).first()
  if (!existing) return error('not_found')

  for (let attempt = 0; attempt < 3; attempt++) {
    const tok = newToken()
    const collision = await env.DB.prepare('SELECT id FROM teacher WHERE token = ?').bind(tok).first()
    if (collision) continue

    await env.DB.prepare('UPDATE teacher SET token = ? WHERE id = ?').bind(tok, id).run()
    return json({ token: tok })
  }

  console.error('admin: unavailable')
  return error('unavailable')
}

async function deleteTeacher(env: Env, id: number): Promise<Response> {
  const result = await env.DB.prepare('DELETE FROM teacher WHERE id = ?').bind(id).run()
  if (result.meta.changes === 0) return error('not_found')
  return json({ success: true })
}

/**
 * Routes all /api/admin/* requests after checking auth.
 * Never reads token, id, or created_at from request bodies (plan § Constraints).
 * deps.keys: inject a local JWKS resolver in tests (avoids network calls).
 */
export async function handleAdmin(request: Request, env: Env, deps?: { keys: JWTVerifyGetKey }): Promise<Response> {
  const authResult = await requireAdmin(request, env, deps)
  if (authResult instanceof Response) return authResult
  const { email } = authResult

  const { pathname } = new URL(request.url)
  const { method } = request
  const parts = pathname.split('/').filter(Boolean)
  // ['api', 'admin', 'teachers']             — list / create
  // ['api', 'admin', 'teachers', ':id']      — update / delete
  // ['api', 'admin', 'teachers', ':id', 'rotate'] — rotate
  // ['api', 'admin', 'admins']               — list / add
  // ['api', 'admin', 'admins', ':id']        — remove

  try {
    if (parts.length >= 3 && parts[2] === 'admins') {
      return await handleAdmins(request, env, email)
    }

    if (parts.length === 3 && parts[2] === 'teachers') {
      if (method === 'GET') return await listTeachers(env)
      if (method === 'POST') return await createTeacher(request, env)
      return error('method')
    }

    if (parts.length === 4 && parts[2] === 'teachers') {
      const id = parseId(parts[3] ?? '')
      if (!id) return error('bad_request')
      if (method === 'PUT') return await updateTeacher(request, env, id)
      if (method === 'DELETE') return await deleteTeacher(env, id)
      return error('method')
    }

    if (parts.length === 5 && parts[2] === 'teachers' && parts[4] === 'rotate') {
      const id = parseId(parts[3] ?? '')
      if (!id) return error('bad_request')
      if (method === 'POST') return await rotateToken(env, id)
      return error('method')
    }

    return error('not_found')
  } catch (e) {
    if (e instanceof HttpError) return error(e.code)
    throw e // unexpected — let index.ts return 503
  }
}
