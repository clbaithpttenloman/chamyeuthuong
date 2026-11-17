/**
 * worker/templates.ts — admin template CRUD.
 *
 * Handles:
 *   GET    /api/admin/templates
 *   POST   /api/admin/templates
 *   PUT    /api/admin/templates/:id
 *   DELETE /api/admin/templates/:id
 *
 * Called from admin.ts after requireAdmin.
 */
import { error, json, readJson, HttpError } from './http.ts'
import { parseId } from './admins.ts'
import { isLayout, isSlot } from '../shared/layouts.ts'
import type { Env } from './types.ts'
import type { D1Stmt } from './types.ts'

/** Fetch slot→{id,token} map for a template. */
async function fetchImagesForTemplate(
  db: Env['DB'],
  templateId: number,
): Promise<Record<string, { id: number; token: string }>> {
  const { results } = await db
    .prepare(
      'SELECT ti.slot, i.id, i.token FROM template_image ti ' +
      'JOIN image i ON i.id = ti.image_id WHERE ti.template_id = ?',
    )
    .bind(templateId)
    .all<{ slot: string; id: number; token: string }>()
  const images: Record<string, { id: number; token: string }> = {}
  for (const r of results) images[r.slot] = { id: r.id, token: r.token }
  return images
}

function toAdminTemplate(
  row: { id: number; name: string; layout: string; active: number; created_at: string; created_by: string },
  images: Record<string, { id: number; token: string }>,
) {
  return { id: row.id, name: row.name, layout: row.layout, active: row.active, images, created_at: row.created_at, created_by: row.created_by }
}

// ---- GET /api/admin/templates ----

async function listTemplates(env: Env): Promise<Response> {
  const { results } = await env.DB
    .prepare('SELECT id, name, layout, active, created_at, created_by FROM template ORDER BY id')
    .all<{ id: number; name: string; layout: string; active: number; created_at: string; created_by: string }>()

  if (results.length === 0) return json([])

  // Fetch all images in one query
  const templateIds = results.map((t) => t.id)
  const { results: imgRows } = await env.DB
    .prepare(
      'SELECT ti.template_id, ti.slot, i.id, i.token FROM template_image ti ' +
      'JOIN image i ON i.id = ti.image_id ' +
      'WHERE ti.template_id IN (SELECT value FROM json_each(?))',
    )
    .bind(JSON.stringify(templateIds))
    .all<{ template_id: number; slot: string; id: number; token: string }>()

  const imgMap = new Map<number, Record<string, { id: number; token: string }>>()
  for (const r of imgRows) {
    if (!imgMap.has(r.template_id)) imgMap.set(r.template_id, {})
    imgMap.get(r.template_id)![r.slot] = { id: r.id, token: r.token }
  }

  return json(results.map((t) => toAdminTemplate(t, imgMap.get(t.id) ?? {})))
}

// ---- Shared validation for create/update ----

type TemplateInput = {
  name: string
  layout: string
  active: number
  imageUpdates: Record<string, number | null> | null
}

async function parseTemplateBody(
  request: Request,
  env: Env,
): Promise<TemplateInput> {
  const body = await readJson<Record<string, unknown>>(request, 4096)

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length === 0 || name.length > 60) throw new HttpError('bad_request')

  const layout = typeof body.layout === 'string' ? body.layout : ''
  if (!isLayout(layout)) throw new HttpError('bad_request')

  const active = body.active !== undefined ? (body.active === 1 ? 1 : body.active === 0 ? 0 : null) : 1
  if (active === null) throw new HttpError('bad_request')

  // Parse image slots: { [slot]: imageId | null }
  const rawImages = body.images
  let imageUpdates: Record<string, number | null> | null = null
  if (rawImages !== undefined && rawImages !== null && typeof rawImages === 'object' && !Array.isArray(rawImages)) {
    imageUpdates = {}
    for (const [slot, val] of Object.entries(rawImages as Record<string, unknown>)) {
      if (!isSlot(slot)) throw new HttpError('bad_request')
      if (val !== null && typeof val !== 'number') throw new HttpError('bad_request')
      imageUpdates[slot] = val === null ? null : (val as number)
    }
    // Validate non-null image ids exist
    for (const val of Object.values(imageUpdates)) {
      if (val !== null) {
        const imgRow = await env.DB.prepare('SELECT id FROM image WHERE id = ?').bind(val).first()
        if (!imgRow) throw new HttpError('bad_request')
      }
    }
  }

  return { name, layout, active, imageUpdates }
}

// ---- POST /api/admin/templates ----

async function createTemplate(request: Request, env: Env, email: string): Promise<Response> {
  const { name, layout, active, imageUpdates } = await parseTemplateBody(request, env)
  const now = new Date().toISOString()

  // All inserts in ONE batch so a FK error on any image slot leaves no orphan template row.
  const stmts: D1Stmt[] = [
    env.DB.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .bind(name, layout, active, now, email),
  ]

  if (imageUpdates) {
    for (const [slot, val] of Object.entries(imageUpdates)) {
      if (val !== null) {
        // (SELECT last_insert_rowid()) references the template row just inserted in this batch.
        stmts.push(
          env.DB.prepare('INSERT INTO template_image (template_id, slot, image_id) VALUES ((SELECT last_insert_rowid()), ?, ?)')
            .bind(slot, val),
        )
      }
    }
  }

  let templateId: number
  try {
    const results = await env.DB.batch(stmts)
    templateId = results[0].meta.last_row_id
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('FOREIGN KEY constraint failed')) throw new HttpError('bad_request')
    throw e
  }

  const row = await env.DB
    .prepare('SELECT id, name, layout, active, created_at, created_by FROM template WHERE id = ?')
    .bind(templateId)
    .first<{ id: number; name: string; layout: string; active: number; created_at: string; created_by: string }>()
  if (!row) throw new HttpError('unavailable')

  const images = await fetchImagesForTemplate(env.DB, templateId)
  return json(toAdminTemplate(row, images))
}

// ---- PUT /api/admin/templates/:id ----

async function updateTemplate(request: Request, env: Env, id: number): Promise<Response> {
  const existing = await env.DB.prepare('SELECT id FROM template WHERE id = ?').bind(id).first()
  if (!existing) return error('not_found')

  const { name, layout, active, imageUpdates } = await parseTemplateBody(request, env)

  const stmts: D1Stmt[] = [
    env.DB.prepare('UPDATE template SET name = ?, layout = ?, active = ? WHERE id = ?').bind(name, layout, active, id),
  ]

  if (imageUpdates) {
    for (const [slot, val] of Object.entries(imageUpdates)) {
      if (val === null) {
        stmts.push(env.DB.prepare('DELETE FROM template_image WHERE template_id = ? AND slot = ?').bind(id, slot))
      } else {
        stmts.push(env.DB.prepare('INSERT OR REPLACE INTO template_image (template_id, slot, image_id) VALUES (?, ?, ?)').bind(id, slot, val))
      }
    }
  }

  try {
    await env.DB.batch(stmts)
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('FOREIGN KEY constraint failed')) throw new HttpError('bad_request')
    throw e
  }

  const row = await env.DB
    .prepare('SELECT id, name, layout, active, created_at, created_by FROM template WHERE id = ?')
    .bind(id)
    .first<{ id: number; name: string; layout: string; active: number; created_at: string; created_by: string }>()
  if (!row) return error('not_found')

  const images = await fetchImagesForTemplate(env.DB, id)
  return json(toAdminTemplate(row, images))
}

// ---- DELETE /api/admin/templates/:id ----

async function deleteTemplate(env: Env, id: number): Promise<Response> {
  const existing = await env.DB.prepare('SELECT id FROM template WHERE id = ?').bind(id).first()
  if (!existing) return error('not_found')

  try {
    const result = await env.DB.prepare('DELETE FROM template WHERE id = ?').bind(id).run()
    if (result.meta.changes === 0) return error('not_found')
    return json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('FOREIGN KEY constraint failed')) return error('conflict')
    throw e
  }
}

/**
 * Routes admin template CRUD.
 * Auth has already been checked; `email` is the authenticated identity.
 */
export async function handleTemplates(
  request: Request,
  env: Env,
  email: string,
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const { method } = request
  const parts = pathname.split('/').filter(Boolean)

  try {
    if (parts.length === 3 && parts[2] === 'templates') {
      if (method === 'GET') return await listTemplates(env)
      if (method === 'POST') return await createTemplate(request, env, email)
      return error('method')
    }

    if (parts.length === 4 && parts[2] === 'templates') {
      const id = parseId(parts[3] ?? '')
      if (id === null) return error('bad_request')
      if (method === 'PUT') return await updateTemplate(request, env, id)
      if (method === 'DELETE') return await deleteTemplate(env, id)
      return error('method')
    }

    return error('not_found')
  } catch (e) {
    if (e instanceof HttpError) return error(e.code)
    throw e
  }
}
