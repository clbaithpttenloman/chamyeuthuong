import { error, json, readJson, HttpError } from './http.ts'
import { normalizeEmail } from './email.ts'
import type { Env } from './types.ts'

type AdminRow = {
  id: number
  email: string
  created_at: string
  created_by: string
}

/** Validates `:id` path segment: 1–9 digits, value ≥ 1. Shared with admin.ts. */
export function parseId(s: string): number | null {
  if (!/^\d{1,9}$/.test(s)) return null
  const id = parseInt(s, 10)
  return id >= 1 ? id : null
}

async function listAdmins(env: Pick<Env, 'DB'>): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT id, email, created_at, created_by FROM admin ORDER BY id',
  ).all<AdminRow>()
  return json(results)
}

async function addAdmin(
  request: Request,
  env: Pick<Env, 'DB'>,
  callerEmail: string,
): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request, 4096)

  const rawEmail = typeof body.email === 'string' ? body.email : null
  if (rawEmail === null) throw new HttpError('bad_request')

  const email = normalizeEmail(rawEmail)
  if (email === null) throw new HttpError('bad_request')

  const now = new Date().toISOString()

  // INSERT ... ON CONFLICT(email) DO NOTHING skips UNIQUE violations; changes === 0 means duplicate.
  const result = await env.DB
    .prepare('INSERT INTO admin (email, created_at, created_by) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING')
    .bind(email, now, callerEmail)
    .run()

  if (result.meta.changes === 0) throw new HttpError('conflict')

  console.error('admin: added')

  const row = await env.DB
    .prepare('SELECT id, email, created_at, created_by FROM admin WHERE email = ?')
    .bind(email)
    .first<AdminRow>()
  if (!row) throw new HttpError('conflict')
  return json(row)
}

async function removeAdmin(env: Pick<Env, 'DB'>, id: number): Promise<Response> {
  // Delete only when more than one admin exists (last-admin guard in SQL).
  const result = await env.DB
    .prepare('DELETE FROM admin WHERE id = ? AND (SELECT COUNT(*) FROM admin) > 1')
    .bind(id)
    .run()

  if (result.meta.changes === 1) {
    console.error('admin: removed')
    return json({ success: true })
  }

  // changes === 0: row didn't exist, or the guard blocked deletion (last admin).
  const existing = await env.DB
    .prepare('SELECT id FROM admin WHERE id = ?')
    .bind(id)
    .first()
  if (!existing) return error('not_found')
  return error('conflict')
}

/**
 * Handles all /api/admin/admins* requests.
 * Auth has already been verified by requireAdmin upstream; callerEmail is the verified identity.
 *
 * Routes:
 *   GET    /api/admin/admins          → list admins
 *   POST   /api/admin/admins          → add admin
 *   DELETE /api/admin/admins/:id      → remove admin (last-admin guard)
 */
export async function handleAdmins(
  request: Request,
  env: Pick<Env, 'DB'>,
  callerEmail: string,
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const { method } = request
  const parts = pathname.split('/').filter(Boolean)
  // ['api', 'admin', 'admins']        — list / add
  // ['api', 'admin', 'admins', ':id'] — remove

  try {
    if (parts.length === 3 && parts[2] === 'admins') {
      if (method === 'GET') return await listAdmins(env)
      if (method === 'POST') return await addAdmin(request, env, callerEmail)
      return error('method')
    }

    if (parts.length === 4 && parts[2] === 'admins') {
      const id = parseId(parts[3] ?? '')
      if (id === null) return error('bad_request')
      if (method === 'DELETE') return await removeAdmin(env, id)
      return error('method')
    }

    // Unrecognised path shape (e.g. /api/admin/admins/:id/subpath) — not found, not method error.
    return error('not_found')
  } catch (e) {
    if (e instanceof HttpError) return error(e.code)
    throw e // unexpected — let index.ts return 503
  }
}
