/**
 * worker/public.ts — unauthenticated public read endpoints.
 *
 * Handles:
 *   GET /api/wall
 *   GET /api/templates
 *   GET /api/wishes
 *
 * Order: rate limit → ensureSchema → DB.
 * Never logs student text. Options → 405 (no CORS headers).
 * GET /api/teachers/* is removed; the route no longer exists.
 */
import { error, json } from './http.ts'
import { ensureSchema } from './schema.ts'
import { cardWhere, teacherWhere, fetchTemplateImages } from './publicSql.ts'
import type { Env } from './types.ts'

// ---- GET /api/wall ----

async function handleWall(db: Env['DB']): Promise<Response> {
  // Teachers (show_on_home=1) with approved card count; expose numeric id (not token or publicId).
  const { results: teachers } = await db
    .prepare(
      'SELECT t.id, tt.title, t.name, t.subject, tp.department, ' +
      'COUNT(sc.id) AS cardCount ' +
      'FROM teacher t ' +
      `JOIN teacher_profile tp ON tp.teacher_id = t.id AND ${teacherWhere('tp')} ` +
      'LEFT JOIN teacher_title tt ON tt.teacher_id = t.id ' +
      `LEFT JOIN student_card sc ON sc.teacher_id = t.id AND ${cardWhere('sc')} ` +
      'GROUP BY t.id, tt.title, t.name, t.subject, tp.department ' +
      'ORDER BY t.id',
    )
    .all<{ id: number; title: string | null; name: string; subject: string; department: string; cardCount: number }>()

  // Totals (show_on_home=1 teachers and their approved cards only)
  const totalsRow = await db
    .prepare(
      'SELECT ' +
      `(SELECT COUNT(*) FROM teacher t JOIN teacher_profile tp ON tp.teacher_id = t.id AND ${teacherWhere('tp')}) AS teachers, ` +
      `(SELECT COUNT(*) FROM student_card sc JOIN teacher t ON t.id = sc.teacher_id JOIN teacher_profile tp ON tp.teacher_id = t.id AND ${teacherWhere('tp')} WHERE ${cardWhere('sc')}) AS cards`,
    )
    .first<{ teachers: number; cards: number }>()

  return json({
    teachers,
    totals: { teachers: totalsRow?.teachers ?? 0, cards: totalsRow?.cards ?? 0 },
  })
}

// ---- GET /api/templates ----

async function handleTemplateList(db: Env['DB']): Promise<Response> {
  const { results: templates } = await db
    .prepare('SELECT id, name, layout FROM template WHERE active = 1 ORDER BY id')
    .all<{ id: number; name: string; layout: string }>()

  if (templates.length === 0) return json([])

  const templateIds = templates.map((t) => t.id)
  const imgMap = await fetchTemplateImages(db, templateIds)
  return json(
    templates.map((t) => ({
      id: t.id,
      name: t.name,
      layout: t.layout,
      images: imgMap.get(t.id) ?? {},
    })),
  )
}

// ---- GET /api/wishes ----

async function handleWishes(db: Env['DB']): Promise<Response> {
  const { results } = await db
    .prepare('SELECT id, title, body FROM wish ORDER BY id')
    .all<{ id: number; title: string; body: string }>()
  return json(results)
}

/**
 * Routes unauthenticated public GET requests.
 * Rate limit is checked first, before any DB access.
 * GET /api/teachers/* is intentionally removed and returns 404.
 */
export async function handlePublic(request: Request, env: Env): Promise<Response> {
  const { method, url } = request
  const { pathname } = new URL(url)
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  // OPTIONS → 405 on all public routes (no CORS headers)
  if (method === 'OPTIONS') return error('method')

  // 1. Rate limit — always first, before any DB work
  const { success } = await env.PUBLIC_IP_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  // 2. Route
  if (pathname === '/api/wall') {
    if (method !== 'GET') return error('method')
    await ensureSchema(env.DB)
    return handleWall(env.DB)
  }

  if (pathname === '/api/templates') {
    if (method !== 'GET') return error('method')
    await ensureSchema(env.DB)
    return handleTemplateList(env.DB)
  }

  if (pathname === '/api/wishes') {
    if (method !== 'GET') return error('method')
    await ensureSchema(env.DB)
    return handleWishes(env.DB)
  }

  return error('not_found')
}
