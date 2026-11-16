import { error, json, readJson, HttpError } from './http.ts'
import { parseId } from './admins.ts'
import type { Env } from './types.ts'

type WishRow = {
  id: number
  title: string
  body: string
  created_at: string
  created_by: string
}

async function listWishes(env: Pick<Env, 'DB'>): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT id, title, body, created_at, created_by FROM wish ORDER BY id',
  ).all<WishRow>()
  return json(results)
}

async function createWish(
  request: Request,
  env: Pick<Env, 'DB'>,
  email: string,
): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)
  const title = typeof body.title === 'string' ? body.title : ''
  const wishBody = typeof body.body === 'string' ? body.body : ''

  if (title.length === 0 || title.length > 80) throw new HttpError('bad_request')
  if (wishBody.length === 0 || wishBody.length > 600) throw new HttpError('bad_request')

  // Cap at 200 wishes
  const count = await env.DB.prepare('SELECT COUNT(*) as c FROM wish').first<{ c: number }>()
  if ((count?.c ?? 0) >= 200) throw new HttpError('conflict')

  const now = new Date().toISOString()
  await env.DB
    .prepare('INSERT INTO wish (title, body, created_at, created_by) VALUES (?, ?, ?, ?)')
    .bind(title, wishBody, now, email)
    .run()

  const row = await env.DB
    .prepare('SELECT id, title, body, created_at, created_by FROM wish WHERE rowid = last_insert_rowid()')
    .first<WishRow>()
  return json(row)
}

async function updateWish(
  request: Request,
  env: Pick<Env, 'DB'>,
  id: number,
): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)
  const title = typeof body.title === 'string' ? body.title : ''
  const wishBody = typeof body.body === 'string' ? body.body : ''

  if (title.length === 0 || title.length > 80) throw new HttpError('bad_request')
  if (wishBody.length === 0 || wishBody.length > 600) throw new HttpError('bad_request')

  const result = await env.DB
    .prepare('UPDATE wish SET title = ?, body = ? WHERE id = ?')
    .bind(title, wishBody, id)
    .run()

  if (result.meta.changes === 0) return error('not_found')

  const row = await env.DB
    .prepare('SELECT id, title, body, created_at, created_by FROM wish WHERE id = ?')
    .bind(id)
    .first<WishRow>()
  return json(row)
}

async function deleteWish(env: Pick<Env, 'DB'>, id: number): Promise<Response> {
  const result = await env.DB.prepare('DELETE FROM wish WHERE id = ?').bind(id).run()
  if (result.meta.changes === 0) return error('not_found')
  return json({ success: true })
}

/**
 * Handles all /api/admin/wishes* requests.
 * Auth has already been checked by requireAdmin upstream; email is the authenticated identity.
 */
export async function handleWishes(
  request: Request,
  env: Pick<Env, 'DB'>,
  email: string,
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const { method } = request
  const parts = pathname.split('/').filter(Boolean)
  // ['api', 'admin', 'wishes']        — list / create
  // ['api', 'admin', 'wishes', ':id'] — update / delete

  try {
    if (parts.length === 3 && parts[2] === 'wishes') {
      if (method === 'GET') return await listWishes(env)
      if (method === 'POST') return await createWish(request, env, email)
      return error('method')
    }

    if (parts.length === 4 && parts[2] === 'wishes') {
      const id = parseId(parts[3] ?? '')
      if (id === null) return error('bad_request')
      if (method === 'PUT') return await updateWish(request, env, id)
      if (method === 'DELETE') return await deleteWish(env, id)
      return error('method')
    }

    return error('not_found')
  } catch (e) {
    if (e instanceof HttpError) return error(e.code)
    throw e
  }
}
