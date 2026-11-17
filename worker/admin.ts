/**
 * worker/admin.ts — admin teacher CRUD and routing hub.
 *
 * Teacher model (plan § Decision: Admin API):
 *   teacher + teacher_title + teacher_profile created in one batch.
 *   Admin list uses LEFT JOINs so teachers without a profile still show.
 *
 * Bulk format: { lines: ["Thầy Name | Subject | Dept", ...] }
 *   First word is title (Thầy/Cô), rest of first pipe-segment is name.
 *
 * Routes to: handleTemplates, handleModeration, handleAdmins, handleImages, handleWishes.
 */
import { error, json, readJson, HttpError } from './http.ts'
import { requireAdmin } from './auth.ts'
import { handleAdmins, parseId } from './admins.ts'
import { handleImages } from './images.ts'
import { handleWishes } from './wishes.ts'
import { handleTemplates } from './templates.ts'
import { handleModeration } from './moderation.ts'
import { newToken } from './token.ts'
import { isTitle } from '../shared/honorific.ts'
import type { Env } from './types.ts'
import type { D1Stmt } from './types.ts'

// ---- Teacher row shape ----

type RawTeacherRow = {
  id: number
  token: string
  name: string
  subject: string
  created_at: string
  publicId: string | null
  department: string | null
  showOnHome: number | null
  title: 'Thầy' | 'Cô' | null
  pending_count: number
  approved_count: number
  hidden_count: number
}

const TEACHER_SELECT =
  'SELECT t.id, t.token, t.name, t.subject, t.created_at, ' +
  'tp.public_id AS publicId, COALESCE(tp.department, \'\') AS department, ' +
  'COALESCE(tp.show_on_home, 1) AS showOnHome, tt.title, ' +
  'COALESCE(SUM(CASE WHEN sc.status = \'pending\' THEN 1 ELSE 0 END), 0) AS pending_count, ' +
  'COALESCE(SUM(CASE WHEN sc.status = \'approved\' THEN 1 ELSE 0 END), 0) AS approved_count, ' +
  'COALESCE(SUM(CASE WHEN sc.status = \'hidden\' THEN 1 ELSE 0 END), 0) AS hidden_count ' +
  'FROM teacher t ' +
  'LEFT JOIN teacher_profile tp ON tp.teacher_id = t.id ' +
  'LEFT JOIN teacher_title tt ON tt.teacher_id = t.id ' +
  'LEFT JOIN student_card sc ON sc.teacher_id = t.id '

function toAdminTeacher(row: RawTeacherRow) {
  return {
    id: row.id,
    token: row.token,
    publicId: row.publicId ?? '',
    title: row.title ?? null,
    name: row.name,
    subject: row.subject,
    department: row.department ?? '',
    showOnHome: (row.showOnHome ?? 1) as 0 | 1,
    cardCounts: {
      pending: row.pending_count ?? 0,
      approved: row.approved_count ?? 0,
      hidden: row.hidden_count ?? 0,
    },
    created_at: row.created_at,
  }
}

async function fetchTeacherById(db: Env['DB'], id: number) {
  return db
    .prepare(TEACHER_SELECT + 'WHERE t.id = ? GROUP BY t.id, t.token, t.name, t.subject, t.created_at, tp.public_id, tp.department, tp.show_on_home, tt.title')
    .bind(id)
    .first<RawTeacherRow>()
}

// ---- List teachers ----

async function listTeachers(env: Env): Promise<Response> {
  const { results } = await env.DB
    .prepare(TEACHER_SELECT + 'GROUP BY t.id, t.token, t.name, t.subject, t.created_at, tp.public_id, tp.department, tp.show_on_home, tt.title ORDER BY t.id')
    .all<RawTeacherRow>()
  return json(results.map(toAdminTeacher))
}

// ---- Create teacher ----

async function createTeacher(request: Request, env: Env, _email: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const department = typeof body.department === 'string' ? body.department.trim() : ''
  const showOnHome = body.showOnHome === 0 ? 0 : 1
  const rawTitle = body.title

  if (!name || name.length > 80) throw new HttpError('bad_request')
  if (subject.length > 80) throw new HttpError('bad_request')
  if (typeof rawTitle !== 'string' || !isTitle(rawTitle)) throw new HttpError('bad_request')

  const now = new Date().toISOString()

  // Generate token with retry on UNIQUE collision (up to 3 attempts)
  let token: string | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const tok = newToken()
    const existing = await env.DB.prepare('SELECT id FROM teacher WHERE token = ?').bind(tok).first()
    if (!existing) { token = tok; break }
  }
  if (!token) {
    console.error('admin: unavailable')
    return error('unavailable')
  }

  // Generate publicId (no retry needed: astronomically unlikely collision)
  const publicId = newToken()

  const stmts: D1Stmt[] = [
    env.DB.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind(token, name, subject, now),
    env.DB.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES ((SELECT id FROM teacher WHERE token = ?), ?)').bind(token, rawTitle),
    env.DB.prepare('INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES ((SELECT id FROM teacher WHERE token = ?), ?, ?, ?)').bind(token, publicId, department, showOnHome),
  ]

  await env.DB.batch(stmts)

  const row = await fetchTeacherById(env.DB, (await env.DB.prepare('SELECT id FROM teacher WHERE token = ?').bind(token).first<{ id: number }>())!.id)
  return json(toAdminTeacher(row!))
}

// ---- Update teacher ----

async function updateTeacher(request: Request, env: Env, id: number): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const department = typeof body.department === 'string' ? body.department.trim() : ''
  const showOnHome = body.showOnHome === 0 ? 0 : 1
  const rawTitle = body.title

  if (!name || name.length > 80) throw new HttpError('bad_request')
  if (subject.length > 80) throw new HttpError('bad_request')
  if (rawTitle !== undefined && (typeof rawTitle !== 'string' || !isTitle(rawTitle))) {
    throw new HttpError('bad_request')
  }

  const existing = await env.DB.prepare('SELECT id FROM teacher WHERE id = ?').bind(id).first()
  if (!existing) return error('not_found')

  // Get existing publicId (stable across updates)
  const profileRow = await env.DB
    .prepare('SELECT public_id FROM teacher_profile WHERE teacher_id = ?')
    .bind(id)
    .first<{ public_id: string }>()
  const publicId = profileRow?.public_id ?? newToken()

  const stmts: D1Stmt[] = [
    env.DB.prepare('UPDATE teacher SET name = ?, subject = ? WHERE id = ?').bind(name, subject, id),
    env.DB.prepare(
      'INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(teacher_id) DO UPDATE SET department = excluded.department, show_on_home = excluded.show_on_home',
    ).bind(id, publicId, department, showOnHome),
  ]

  if (rawTitle !== undefined) {
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(id, rawTitle))
  }

  try {
    await env.DB.batch(stmts)
  } catch (e) {
    if (e instanceof Error && e.message.includes('FOREIGN KEY constraint failed')) throw new HttpError('bad_request')
    throw e
  }

  const row = await fetchTeacherById(env.DB, id)
  if (!row) return error('not_found')
  return json(toAdminTeacher(row))
}

// ---- Rotate QR token (publicId stays stable) ----

async function rotateToken(env: Env, id: number): Promise<Response> {
  const existing = await env.DB.prepare('SELECT id FROM teacher WHERE id = ?').bind(id).first()
  if (!existing) return error('not_found')

  const profileRow = await env.DB
    .prepare('SELECT public_id FROM teacher_profile WHERE teacher_id = ?')
    .bind(id)
    .first<{ public_id: string }>()

  for (let attempt = 0; attempt < 3; attempt++) {
    const tok = newToken()
    const collision = await env.DB.prepare('SELECT id FROM teacher WHERE token = ?').bind(tok).first()
    if (collision) continue
    await env.DB.prepare('UPDATE teacher SET token = ? WHERE id = ?').bind(tok, id).run()
    return json({ token: tok, publicId: profileRow?.public_id ?? null })
  }

  console.error('admin: unavailable')
  return error('unavailable')
}

// ---- Delete teacher ----

async function deleteTeacher(env: Env, id: number): Promise<Response> {
  const result = await env.DB.prepare('DELETE FROM teacher WHERE id = ?').bind(id).run()
  if (result.meta.changes === 0) return error('not_found')
  return json({ success: true })
}

// ---- Bulk create (line format: "Title Name | Subject | Dept") ----

type ParsedLine = { title: string; name: string; subject: string; department: string }

function parseBulkLine(line: string): ParsedLine | null {
  const parts = line.split('|').map((s) => s.trim())
  const firstPart = parts[0] ?? ''
  const spaceIdx = firstPart.indexOf(' ')
  if (spaceIdx === -1) return null
  const title = firstPart.slice(0, spaceIdx)
  const name = firstPart.slice(spaceIdx + 1).trim()
  if (!isTitle(title) || !name) return null
  return {
    title,
    name,
    subject: (parts[1] ?? '').trim(),
    department: (parts[2] ?? '').trim(),
  }
}

async function createBulk(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 65536)

  const rawLines = body.lines
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > 100) {
    throw new HttpError('bad_request')
  }

  const items: ParsedLine[] = rawLines.map((line: unknown) => {
    if (typeof line !== 'string') throw new HttpError('bad_request')
    const parsed = parseBulkLine(line)
    if (!parsed) throw new HttpError('bad_request')
    return parsed
  })

  const now = new Date().toISOString()

  // Generate token + publicId for each teacher (token with up to 3 retries each)
  const tokenPairs: Array<{ token: string; publicId: string }> = []
  for (const _item of items) {
    let token: string | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const tok = newToken()
      const existing = await env.DB.prepare('SELECT id FROM teacher WHERE token = ?').bind(tok).first()
      if (!existing) { token = tok; break }
    }
    if (!token) {
      console.error('admin: unavailable')
      return error('unavailable')
    }
    const publicId = newToken()
    tokenPairs.push({ token, publicId })
  }

  // Build batch stmts
  const stmts: D1Stmt[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const { token, publicId } = tokenPairs[i]
    stmts.push(env.DB.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind(token, item.name, item.subject, now))
    stmts.push(env.DB.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES ((SELECT id FROM teacher WHERE token = ?), ?)').bind(token, item.title))
    stmts.push(env.DB.prepare('INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES ((SELECT id FROM teacher WHERE token = ?), ?, ?, ?)').bind(token, publicId, item.department, 1))
  }

  try {
    await env.DB.batch(stmts)
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('UNIQUE constraint failed: teacher.token')) return error('unavailable')
    throw e
  }

  // Fetch created teachers
  const tokens = tokenPairs.map((p) => p.token)
  const { results } = await env.DB
    .prepare(TEACHER_SELECT + 'WHERE t.token IN (SELECT value FROM json_each(?)) GROUP BY t.id, t.token, t.name, t.subject, t.created_at, tp.public_id, tp.department, tp.show_on_home, tt.title ORDER BY t.id')
    .bind(JSON.stringify(tokens))
    .all<RawTeacherRow>()

  return json({ created: results.map(toAdminTeacher) })
}

/**
 * Routes all /api/admin/* requests after checking auth.
 */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAdmin(request, env)
  if (authResult instanceof Response) return authResult
  const { email } = authResult

  const { pathname } = new URL(request.url)
  const { method } = request
  const parts = pathname.split('/').filter(Boolean)

  try {
    if (parts.length >= 3 && parts[2] === 'admins') {
      return await handleAdmins(request, env, email)
    }

    if (parts.length >= 3 && parts[2] === 'images') {
      return await handleImages(request, env, email)
    }

    if (parts.length >= 3 && parts[2] === 'wishes') {
      return await handleWishes(request, env, email)
    }

    if (parts.length >= 3 && parts[2] === 'templates') {
      return await handleTemplates(request, env, email)
    }

    if (parts.length >= 3 && parts[2] === 'cards') {
      return await handleModeration(request, env, email)
    }

    // ---- Teachers ----

    if (parts.length === 3 && parts[2] === 'teachers') {
      if (method === 'GET') return await listTeachers(env)
      if (method === 'POST') return await createTeacher(request, env, email)
      return error('method')
    }

    // /api/admin/teachers/bulk (before /:id check)
    if (parts.length === 4 && parts[2] === 'teachers' && parts[3] === 'bulk') {
      if (method === 'POST') return await createBulk(request, env)
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
    throw e
  }
}
