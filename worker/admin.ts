/**
 * worker/admin.ts — admin teacher CRUD and routing hub.
 *
 * Teacher model (plan § Decision: Admin API):
 *   teacher + teacher_title + teacher_profile created in one batch.
 *   Admin list uses LEFT JOINs so teachers without a profile still show.
 *
 * Bulk format: { items: [{ title, name, subject?, department? }] } (1–100 items; role ignored → Giáo viên).
 *
 * Routes to: handleTemplates, handleModeration, handleAdmins, handleImages, handleWishes,
 *            handleAbout / handleAdminAbout.
 */
import { error, json, readJson, HttpError } from './http.ts'
import { requireAdmin } from './auth.ts'
import { handleAdmins, parseId } from './admins.ts'
import { handleImages } from './images.ts'
import { handleWishes } from './wishes.ts'
import { handleTemplates } from './templates.ts'
import { handleModeration } from './moderation.ts'
import { handleAdminAbout } from './about.ts'
import { newToken } from './token.ts'
import { isTitle } from '../shared/honorific.ts'
import { DEFAULT_ROLE, isRole, type Role } from '../shared/api.ts'
import type { Env } from './types.ts'
import type { D1Stmt } from './types.ts'

// ---- Input validation helpers ----

/** Strictly parses 0 or 1; returns null for any other value. */
function parseBit(val: unknown): 0 | 1 | null {
  if (val === 0) return 0
  if (val === 1) return 1
  return null
}

type RawTeacherRow = {
  id: number
  token: string
  name: string
  subject: string
  created_at: string
  department: string | null
  role: Role | null
  showOnHome: number | null
  title: 'Thầy' | 'Cô' | null
  pending_count: number
  approved_count: number
  hidden_count: number
}

const TEACHER_SELECT =
  'SELECT t.id, t.token, t.name, t.subject, t.created_at, ' +
  'COALESCE(tp.department, \'\') AS department, ' +
  'COALESCE(tp.role, \'Giáo viên\') AS role, ' +
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
    title: row.title ?? null,
    name: row.name,
    subject: row.subject,
    department: row.department ?? '',
    role: row.role ?? DEFAULT_ROLE,
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
    .prepare(TEACHER_SELECT + 'WHERE t.id = ? GROUP BY t.id, t.token, t.name, t.subject, t.created_at, tp.department, tp.role, tp.show_on_home, tt.title')
    .bind(id)
    .first<RawTeacherRow>()
}

// ---- List teachers ----

async function listTeachers(env: Env): Promise<Response> {
  const { results } = await env.DB
    .prepare(TEACHER_SELECT + 'GROUP BY t.id, t.token, t.name, t.subject, t.created_at, tp.department, tp.role, tp.show_on_home, tt.title ORDER BY t.id')
    .all<RawTeacherRow>()
  return json(results.map(toAdminTeacher))
}

// ---- Create teacher ----

async function createTeacher(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const department = typeof body.department === 'string' ? body.department.trim() : ''
  const rawTitle = body.title

  if (!name || name.length > 80) throw new HttpError('bad_request')
  if (subject.length > 80) throw new HttpError('bad_request')
  if (department.length > 80) throw new HttpError('bad_request')
  if (typeof rawTitle !== 'string' || !isTitle(rawTitle)) throw new HttpError('bad_request')

  // Role: a present key must be an exact allowed label (null/other types → 400); missing → default
  if ('role' in body && !isRole(body.role)) throw new HttpError('bad_request')
  const role: Role = 'role' in body ? (body.role as Role) : DEFAULT_ROLE

  // Strict 0|1 for showOnHome; default to 1 when omitted
  const rawShowOnHome = 'showOnHome' in body ? parseBit(body.showOnHome) : (1 as 0 | 1)
  if (rawShowOnHome === null) throw new HttpError('bad_request')
  const showOnHome: 0 | 1 = rawShowOnHome

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

  const stmts: D1Stmt[] = [
    env.DB.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind(token, name, subject, now),
    env.DB.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES ((SELECT id FROM teacher WHERE token = ?), ?)').bind(token, rawTitle),
    env.DB.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home, role) VALUES ((SELECT id FROM teacher WHERE token = ?), ?, ?, ?)').bind(token, department, showOnHome, role),
  ]

  await env.DB.batch(stmts)

  const row = await fetchTeacherById(env.DB, (await env.DB.prepare('SELECT id FROM teacher WHERE token = ?').bind(token).first<{ id: number }>())!.id)
  return json(toAdminTeacher(row!))
}

// ---- Update teacher ----

async function updateTeacher(request: Request, env: Env, id: number): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const rawTitle = body.title

  if (!name || name.length > 80) throw new HttpError('bad_request')

  if (rawTitle !== undefined && (typeof rawTitle !== 'string' || !isTitle(rawTitle))) {
    throw new HttpError('bad_request')
  }

  // Strict 0|1 for showOnHome when provided
  if ('showOnHome' in body && parseBit(body.showOnHome) === null) throw new HttpError('bad_request')

  // Role when provided: exact allowed label only. Omitted → existing value kept (not in SET list).
  if ('role' in body && !isRole(body.role)) throw new HttpError('bad_request')

  const existing = await env.DB.prepare('SELECT id FROM teacher WHERE id = ?').bind(id).first()
  if (!existing) return error('not_found')

  // Fetch existing teacher + profile values to preserve when fields are omitted in body
  const teacherRow = await env.DB
    .prepare('SELECT subject FROM teacher WHERE id = ?')
    .bind(id)
    .first<{ subject: string }>()

  const profileRow = await env.DB
    .prepare('SELECT department, show_on_home FROM teacher_profile WHERE teacher_id = ?')
    .bind(id)
    .first<{ department: string | null; show_on_home: number | null }>()

  // Keep existing values when fields are omitted
  const finalSubject = 'subject' in body
    ? (typeof body.subject === 'string' ? body.subject.trim() : '')
    : (teacherRow?.subject ?? '')
  if (finalSubject.length > 80) throw new HttpError('bad_request')

  const finalDepartment = 'department' in body
    ? (typeof body.department === 'string' ? body.department.trim() : '')
    : (profileRow?.department ?? '')
  if (finalDepartment.length > 80) throw new HttpError('bad_request')

  const finalShowOnHome: 0 | 1 = 'showOnHome' in body
    ? parseBit(body.showOnHome)!
    : ((profileRow?.show_on_home as 0 | 1 | null) ?? 1) as 0 | 1

  // With no profile row yet, the INSERT path uses the column default ('Giáo viên') when role is omitted.
  const profileStmt = 'role' in body
    ? env.DB.prepare(
        'INSERT INTO teacher_profile (teacher_id, department, show_on_home, role) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(teacher_id) DO UPDATE SET department = excluded.department, show_on_home = excluded.show_on_home, role = excluded.role',
      ).bind(id, finalDepartment, finalShowOnHome, body.role as Role)
    : env.DB.prepare(
        'INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?) ' +
        'ON CONFLICT(teacher_id) DO UPDATE SET department = excluded.department, show_on_home = excluded.show_on_home',
      ).bind(id, finalDepartment, finalShowOnHome)

  const stmts: D1Stmt[] = [
    env.DB.prepare('UPDATE teacher SET name = ?, subject = ? WHERE id = ?').bind(name, finalSubject, id),
    profileStmt,
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

// ---- Rotate QR token ----

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

// ---- Delete teacher ----

async function deleteTeacher(env: Env, id: number): Promise<Response> {
  const result = await env.DB.prepare('DELETE FROM teacher WHERE id = ?').bind(id).run()
  if (result.meta.changes === 0) return error('not_found')
  return json({ success: true })
}

// ---- Bulk create ({ items: [{ title, name, subject?, department? }] }) ----
// Every item gets the default role (Giáo viên); a per-item `role` key is ignored like any unknown key.

async function createBulk(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 65536)

  const rawItems = body.items
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 100) {
    throw new HttpError('bad_request')
  }

  type ParsedItem = { title: string; name: string; subject: string; department: string }
  const items: ParsedItem[] = rawItems.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError('bad_request')
    const obj = item as Record<string, unknown>

    const rawTitle = obj.title
    if (typeof rawTitle !== 'string' || !isTitle(rawTitle)) throw new HttpError('bad_request')

    const name = typeof obj.name === 'string' ? obj.name.trim() : ''
    if (!name || name.length > 80) throw new HttpError('bad_request')

    const subject = typeof obj.subject === 'string' ? obj.subject.trim() : ''
    if (subject.length > 80) throw new HttpError('bad_request')

    const department = typeof obj.department === 'string' ? obj.department.trim() : ''
    if (department.length > 80) throw new HttpError('bad_request')

    return { title: rawTitle, name, subject, department }
  })

  const now = new Date().toISOString()

  // Generate token for each teacher (up to 3 retries each)
  const tokens: string[] = []
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
    tokens.push(token)
  }

  // Build batch stmts
  const stmts: D1Stmt[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const token = tokens[i]
    stmts.push(env.DB.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind(token, item.name, item.subject, now))
    stmts.push(env.DB.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES ((SELECT id FROM teacher WHERE token = ?), ?)').bind(token, item.title))
    stmts.push(env.DB.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES ((SELECT id FROM teacher WHERE token = ?), ?, ?)').bind(token, item.department, 1))
  }

  try {
    await env.DB.batch(stmts)
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('UNIQUE constraint failed: teacher.token')) return error('unavailable')
    throw e
  }

  // Fetch created teachers
  const { results } = await env.DB
    .prepare(TEACHER_SELECT + 'WHERE t.token IN (SELECT value FROM json_each(?)) GROUP BY t.id, t.token, t.name, t.subject, t.created_at, tp.department, tp.role, tp.show_on_home, tt.title ORDER BY t.id')
    .bind(JSON.stringify(tokens))
    .all<RawTeacherRow>()

  return json({ created: results.map(toAdminTeacher) })
}

/**
 * Routes all /api/admin/* requests after checking auth.
 * 20/11 routes (teachers, templates, images, wishes, moderation, about, GET admins)
 * accept the legacy X-Admin-Email path while ADMIN_LEGACY_LOGIN = '1'.
 * POST/DELETE /api/admin/admins requires a Google session (never legacy).
 */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url)
  const { method } = request
  const parts = pathname.split('/').filter(Boolean)

  // Campaign endpoints and POST/DELETE admin-list changes always require a Google session.
  // All 20/11 routes (teachers, templates, images, wishes, moderation, about, GET admins)
  // accept the legacy X-Admin-Email path while ADMIN_LEGACY_LOGIN = '1'.
  const requiresGoogle =
    parts.length >= 3 && (
      parts[2] === 'campaigns' ||
      (parts[2] === 'admins' && (method === 'POST' || method === 'DELETE'))
    )

  const authResult = await requireAdmin(request, env, { legacy: !requiresGoogle })
  if (authResult instanceof Response) return authResult
  const { email } = authResult

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

    // ---- About content (admin editor) ----
    if (parts.length >= 3 && parts[2] === 'about') {
      return await handleAdminAbout(request, env, email)
    }

    // ---- Teachers ----

    if (parts.length === 3 && parts[2] === 'teachers') {
      if (method === 'GET') return await listTeachers(env)
      if (method === 'POST') return await createTeacher(request, env)
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
