import { error, json, readJson, HttpError } from './http.ts'
import { requireAdmin } from './auth.ts'
import { handleAdmins, parseId } from './admins.ts'
import { handleImages } from './images.ts'
import { handleWishes } from './wishes.ts'
import { newToken } from './token.ts'
import { isLayout, isSlot, DEFAULT_LAYOUT } from '../shared/layouts.ts'
import type { Env } from './types.ts'
import type { D1Stmt } from './types.ts'

type TeacherRow = {
  id: number
  token: string
  name: string
  subject: string
  created_at: string
  message: string
  status: string
}

type ImageSlot = { id: number; token: string }
type TeacherFull = TeacherRow & { layout: string; images: Record<string, ImageSlot> }

// ---- Helpers ----

/** SELECT for teacher + card + layout. */
const TEACHER_SQL =
  'SELECT t.id, t.token, t.name, t.subject, t.created_at, c.message, c.status, ' +
  `COALESCE(cs.layout, '${DEFAULT_LAYOUT}') AS layout ` +
  'FROM teacher t ' +
  'JOIN card c ON c.teacher_id = t.id ' +
  'LEFT JOIN card_style cs ON cs.teacher_id = t.id '

async function fetchImages(db: Env['DB'], teacherId: number): Promise<Record<string, ImageSlot>> {
  const { results } = await db
    .prepare(
      'SELECT ci.slot, i.id, i.token FROM card_image ci ' +
      'JOIN image i ON i.id = ci.image_id WHERE ci.teacher_id = ?',
    )
    .bind(teacherId)
    .all<{ slot: string; id: number; token: string }>()
  const images: Record<string, ImageSlot> = {}
  for (const r of results) images[r.slot] = { id: r.id, token: r.token }
  return images
}

async function fetchTeacherById(db: Env['DB'], id: number): Promise<TeacherFull | null> {
  const row = await db
    .prepare(`${TEACHER_SQL}WHERE t.id = ?`)
    .bind(id)
    .first<TeacherRow & { layout: string }>()
  if (!row) return null
  return { ...row, images: await fetchImages(db, row.id) }
}

async function fetchTeacherByToken(db: Env['DB'], token: string): Promise<TeacherFull | null> {
  const row = await db
    .prepare(`${TEACHER_SQL}WHERE t.token = ?`)
    .bind(token)
    .first<TeacherRow & { layout: string }>()
  if (!row) return null
  return { ...row, images: await fetchImages(db, row.id) }
}

// ---- Route handlers ----

async function listTeachers(env: Env): Promise<Response> {
  const { results } = await env.DB
    .prepare(`${TEACHER_SQL}ORDER BY t.id`)
    .all<TeacherRow & { layout: string }>()

  // Fetch all card_images in one query and group by teacher_id
  const { results: allImgs } = await env.DB
    .prepare(
      'SELECT ci.teacher_id, ci.slot, i.id, i.token FROM card_image ci ' +
      'JOIN image i ON i.id = ci.image_id',
    )
    .all<{ teacher_id: number; slot: string; id: number; token: string }>()

  const imgMap = new Map<number, Record<string, ImageSlot>>()
  for (const img of allImgs) {
    if (!imgMap.has(img.teacher_id)) imgMap.set(img.teacher_id, {})
    imgMap.get(img.teacher_id)![img.slot] = { id: img.id, token: img.token }
  }

  return json(results.map((t) => ({ ...t, images: imgMap.get(t.id) ?? {} })))
}

async function createTeacher(request: Request, env: Env, _email: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  const rawStatus = body.status
  const status = rawStatus === 'published' ? 'published' : 'draft'
  const rawLayout = body.layout
  const layout = typeof rawLayout === 'string' ? rawLayout : null

  if (name.length === 0 || name.length > 80) throw new HttpError('bad_request')
  if (subject.length > 80) throw new HttpError('bad_request')
  if (message.length > 600) throw new HttpError('bad_request')
  if (status === 'published' && message.length === 0) throw new HttpError('bad_request')
  if (layout !== null && !isLayout(layout)) throw new HttpError('bad_request')

  // Validate images
  const rawImages = body.images
  let imageSlots: Record<string, number> | null = null
  if (rawImages && typeof rawImages === 'object' && !Array.isArray(rawImages)) {
    imageSlots = {}
    for (const [slot, imgId] of Object.entries(rawImages as Record<string, unknown>)) {
      if (!isSlot(slot)) throw new HttpError('bad_request')
      if (typeof imgId !== 'number') throw new HttpError('bad_request')
      imageSlots[slot] = imgId as number
    }
    // Validate all image ids exist
    for (const imgId of Object.values(imageSlots)) {
      const imgRow = await env.DB.prepare('SELECT id FROM image WHERE id = ?').bind(imgId).first()
      if (!imgRow) throw new HttpError('bad_request')
    }
  }

  const now = new Date().toISOString()
  const effectiveLayout = layout ?? DEFAULT_LAYOUT

  for (let attempt = 0; attempt < 3; attempt++) {
    const tok = newToken()
    // Pre-check for UNIQUE collision
    const existing = await env.DB.prepare('SELECT id FROM teacher WHERE token = ?').bind(tok).first()
    if (existing) continue

    const stmts: D1Stmt[] = [
      env.DB.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind(tok, name, subject, now),
      env.DB.prepare('INSERT INTO card (teacher_id, message, status, updated_at) VALUES (last_insert_rowid(), ?, ?, ?)').bind(message, status, now),
    ]
    if (layout !== null) {
      stmts.push(env.DB.prepare('INSERT INTO card_style (teacher_id, layout) VALUES ((SELECT id FROM teacher WHERE token = ?), ?)').bind(tok, effectiveLayout))
    }
    if (imageSlots) {
      for (const [slot, imgId] of Object.entries(imageSlots)) {
        stmts.push(env.DB.prepare('INSERT INTO card_image (teacher_id, slot, image_id) VALUES ((SELECT id FROM teacher WHERE token = ?), ?, ?)').bind(tok, slot, imgId))
      }
    }

    await env.DB.batch(stmts)

    const row = await fetchTeacherByToken(env.DB, tok)
    return json(row)
  }

  console.error('admin: unavailable')
  return error('unavailable')
}

async function updateTeacher(request: Request, env: Env, id: number): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  const status = body.status
  const rawLayout = body.layout
  const layout = typeof rawLayout === 'string' ? rawLayout : undefined

  if (name.length === 0 || name.length > 80) throw new HttpError('bad_request')
  if (subject.length > 80) throw new HttpError('bad_request')
  if (message.length > 600) throw new HttpError('bad_request')
  if (status !== 'draft' && status !== 'published') throw new HttpError('bad_request')
  if (status === 'published' && message.length === 0) throw new HttpError('bad_request')
  if (layout !== undefined && !isLayout(layout)) throw new HttpError('bad_request')

  // Parse images update: { [slot]: number | null }
  const rawImages = body.images
  let imageUpdates: Record<string, number | null> | null = null
  if (rawImages !== undefined && rawImages !== null && typeof rawImages === 'object' && !Array.isArray(rawImages)) {
    imageUpdates = {}
    for (const [slot, val] of Object.entries(rawImages as Record<string, unknown>)) {
      if (!isSlot(slot)) throw new HttpError('bad_request')
      if (val !== null && typeof val !== 'number') throw new HttpError('bad_request')
      imageUpdates[slot] = val === null ? null : (val as number)
    }
    // Validate non-null image ids
    for (const val of Object.values(imageUpdates)) {
      if (val !== null) {
        const imgRow = await env.DB.prepare('SELECT id FROM image WHERE id = ?').bind(val).first()
        if (!imgRow) throw new HttpError('bad_request')
      }
    }
  }

  const now = new Date().toISOString()

  // Check teacher exists before building the batch; layout/image FK statements would throw
  // a FK violation (→ 503) if the id is unknown, so check first and return 404 cleanly.
  const teacherExists = await env.DB.prepare('SELECT id FROM teacher WHERE id = ?').bind(id).first()
  if (!teacherExists) return error('not_found')

  const stmts: D1Stmt[] = [
    env.DB.prepare('UPDATE teacher SET name = ?, subject = ? WHERE id = ?').bind(name, subject, id),
    env.DB.prepare('UPDATE card SET message = ?, status = ?, updated_at = ? WHERE teacher_id = ?').bind(message, status, now, id),
  ]
  if (layout !== undefined) {
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO card_style (teacher_id, layout) VALUES (?, ?)').bind(id, layout))
  }
  if (imageUpdates) {
    for (const [slot, val] of Object.entries(imageUpdates)) {
      if (val === null) {
        stmts.push(env.DB.prepare('DELETE FROM card_image WHERE teacher_id = ? AND slot = ?').bind(id, slot))
      } else {
        stmts.push(env.DB.prepare('INSERT OR REPLACE INTO card_image (teacher_id, slot, image_id) VALUES (?, ?, ?)').bind(id, slot, val))
      }
    }
  }

  try {
    await env.DB.batch(stmts)
  } catch (e) {
    // A teacher or image deleted between the checks above and this batch: client-side data is stale.
    if (e instanceof Error && e.message.includes('FOREIGN KEY constraint failed')) throw new HttpError('bad_request')
    throw e
  }

  const row = await fetchTeacherById(env.DB, id)
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

async function createBulk(request: Request, env: Env): Promise<Response> {
  // Enforce 64 KB body cap; readJson throws too_long (413) when exceeded
  const body = await readJson<Record<string, unknown>>(request, 65536)

  const rawItems = body.items
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 100) {
    throw new HttpError('bad_request')
  }

  // Validate each item
  const items = rawItems.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError('bad_request')
    const obj = item as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name.trim() : ''
    const subject = typeof obj.subject === 'string' ? obj.subject.trim() : ''
    const message = typeof obj.message === 'string' ? obj.message.trim() : ''
    if (name.length === 0 || name.length > 80) throw new HttpError('bad_request')
    if (subject.length > 80) throw new HttpError('bad_request')
    if (message.length > 600) throw new HttpError('bad_request')
    return { name, subject, message }
  })

  // Parse shared layout
  const rawLayout = body.layout
  const layout = typeof rawLayout === 'string' ? rawLayout : null
  if (layout !== null && !isLayout(layout)) throw new HttpError('bad_request')
  const effectiveLayout = layout ?? DEFAULT_LAYOUT

  // Parse shared images
  const rawImages = body.images
  let imageSlots: Record<string, number> | null = null
  if (rawImages && typeof rawImages === 'object' && !Array.isArray(rawImages)) {
    imageSlots = {}
    for (const [slot, imgId] of Object.entries(rawImages as Record<string, unknown>)) {
      if (!isSlot(slot)) throw new HttpError('bad_request')
      if (typeof imgId !== 'number') throw new HttpError('bad_request')
      imageSlots[slot] = imgId as number
    }
    // Validate all image ids exist
    for (const imgId of Object.values(imageSlots)) {
      const imgRow = await env.DB.prepare('SELECT id FROM image WHERE id = ?').bind(imgId).first()
      if (!imgRow) throw new HttpError('bad_request')
    }
  }

  // Parse shared status
  const rawStatus = body.status
  const status = rawStatus === 'published' ? 'published' : 'draft'
  if (status === 'published') {
    for (const item of items) {
      if (item.message.length === 0) throw new HttpError('bad_request')
    }
  }

  const now = new Date().toISOString()

  // Try the batch, retry once on UNIQUE collision for teacher.token
  let tokens: string[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    tokens = items.map(() => newToken())

    const stmts: D1Stmt[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const tok = tokens[i]
      stmts.push(env.DB.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind(tok, item.name, item.subject, now))
      stmts.push(env.DB.prepare('INSERT INTO card (teacher_id, message, status, updated_at) VALUES ((SELECT id FROM teacher WHERE token = ?), ?, ?, ?)').bind(tok, item.message, status, now))
      if (layout !== null) {
        stmts.push(env.DB.prepare('INSERT INTO card_style (teacher_id, layout) VALUES ((SELECT id FROM teacher WHERE token = ?), ?)').bind(tok, effectiveLayout))
      }
      if (imageSlots) {
        for (const [slot, imgId] of Object.entries(imageSlots)) {
          stmts.push(env.DB.prepare('INSERT INTO card_image (teacher_id, slot, image_id) VALUES ((SELECT id FROM teacher WHERE token = ?), ?, ?)').bind(tok, slot, imgId))
        }
      }
    }

    try {
      await env.DB.batch(stmts)
      break  // success
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('UNIQUE constraint failed: teacher.token')) {
        if (attempt === 0) continue  // retry with new tokens
        return error('unavailable')  // second collision
      }
      throw e  // unexpected error
    }
  }

  // Fetch created teachers using the tokens
  const ph = tokens.map(() => '?').join(', ')
  const { results: teacherRows } = await env.DB
    .prepare(`${TEACHER_SQL}WHERE t.token IN (${ph}) ORDER BY t.id`)
    .bind(...tokens)
    .all<TeacherRow & { layout: string }>()

  // Fetch images for all created teachers
  const teacherIds = teacherRows.map((r) => r.id)
  let created: TeacherFull[]
  if (teacherIds.length > 0) {
    const idPh = teacherIds.map(() => '?').join(', ')
    const { results: imgRows } = await env.DB
      .prepare(
        `SELECT ci.teacher_id, ci.slot, i.id, i.token FROM card_image ci ` +
        `JOIN image i ON i.id = ci.image_id WHERE ci.teacher_id IN (${idPh})`,
      )
      .bind(...teacherIds)
      .all<{ teacher_id: number; slot: string; id: number; token: string }>()

    const imgMap = new Map<number, Record<string, ImageSlot>>()
    for (const img of imgRows) {
      if (!imgMap.has(img.teacher_id)) imgMap.set(img.teacher_id, {})
      imgMap.get(img.teacher_id)![img.slot] = { id: img.id, token: img.token }
    }
    created = teacherRows.map((t) => ({ ...t, images: imgMap.get(t.id) ?? {} }))
  } else {
    created = []
  }

  return json({ created })
}

/**
 * Routes all /api/admin/* requests after checking auth.
 * Never reads token, id, or created_at from request bodies (plan § Constraints).
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

    if (parts.length === 3 && parts[2] === 'teachers') {
      if (method === 'GET') return await listTeachers(env)
      if (method === 'POST') return await createTeacher(request, env, email)
      return error('method')
    }

    // /api/admin/teachers/bulk  (must come before /:id check)
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
