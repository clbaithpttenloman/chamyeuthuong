/**
 * worker/public.ts — unauthenticated public read endpoints.
 *
 * Handles:
 *   GET /api/wall
 *   GET /api/teachers/:publicId
 *   GET /api/templates
 *   GET /api/wishes
 *
 * Order: rate limit → isToken check → ensureSchema → DB.
 * Never logs student text. Options → 405 (no CORS headers).
 */
import { error, json } from './http.ts'
import { isToken } from './token.ts'
import { ensureSchema } from './schema.ts'
import { cardWhere, teacherWhere, fetchTemplateImages, toPublicCard, type CardRow } from './publicSql.ts'
import type { Env } from './types.ts'

// ---- GET /api/wall ----

async function handleWall(db: Env['DB']): Promise<Response> {
  // Teachers (show_on_home=1) with approved card count
  const { results: teachers } = await db
    .prepare(
      'SELECT tp.public_id AS publicId, tt.title, t.name, t.subject, tp.department, ' +
      'COUNT(sc.id) AS cardCount ' +
      'FROM teacher t ' +
      `JOIN teacher_profile tp ON tp.teacher_id = t.id AND ${teacherWhere('tp')} ` +
      'LEFT JOIN teacher_title tt ON tt.teacher_id = t.id ' +
      `LEFT JOIN student_card sc ON sc.teacher_id = t.id AND ${cardWhere('sc')} ` +
      'GROUP BY t.id, tp.public_id, tt.title, t.name, t.subject, tp.department ' +
      'ORDER BY t.id',
    )
    .all<{ publicId: string; title: string | null; name: string; subject: string; department: string; cardCount: number }>()

  // Latest: one per teacher (newest approved card), capped at 6, show_on_home=1 only
  const { results: latestRows } = await db
    .prepare(
      'SELECT sc.public_id, sc.message, sc.from_name, sc.from_class, sc.anonymous, sc.created_at, ' +
      'sc.template_id, tmpl.layout, ' +
      'tp.public_id AS teacher_public_id, tt.title AS teacher_title, t.name AS teacher_name ' +
      'FROM student_card sc ' +
      'JOIN teacher t ON t.id = sc.teacher_id ' +
      `JOIN teacher_profile tp ON tp.teacher_id = t.id AND ${teacherWhere('tp')} ` +
      'LEFT JOIN teacher_title tt ON tt.teacher_id = t.id ' +
      'JOIN template tmpl ON tmpl.id = sc.template_id ' +
      `WHERE ${cardWhere('sc')} ` +
      'AND sc.id = (' +
      '  SELECT sc2.id FROM student_card sc2 ' +
      `  WHERE sc2.teacher_id = sc.teacher_id AND ${cardWhere('sc2')} ` +
      '  ORDER BY sc2.created_at DESC, sc2.id DESC LIMIT 1' +
      ') ' +
      'ORDER BY sc.created_at DESC, sc.id DESC ' +
      'LIMIT 6',
    )
    .all<CardRow & { teacher_public_id: string; teacher_title: string | null; teacher_name: string }>()

  // Template images for latest cards
  const templateIds = [...new Set(latestRows.map((r) => r.template_id))]
  const imgMap = await fetchTemplateImages(db, templateIds)

  const latest = latestRows.map((row) => ({
    ...toPublicCard(row, imgMap.get(row.template_id) ?? {}),
    teacher: { publicId: row.teacher_public_id, title: row.teacher_title, name: row.teacher_name },
  }))

  // Totals
  const totalsRow = await db
    .prepare(
      'SELECT ' +
      `(SELECT COUNT(*) FROM teacher t JOIN teacher_profile tp ON tp.teacher_id = t.id AND ${teacherWhere('tp')}) AS teachers, ` +
      `(SELECT COUNT(*) FROM student_card sc JOIN teacher t ON t.id = sc.teacher_id JOIN teacher_profile tp ON tp.teacher_id = t.id AND ${teacherWhere('tp')} WHERE ${cardWhere('sc')}) AS cards`,
    )
    .first<{ teachers: number; cards: number }>()

  return json({
    teachers,
    latest,
    totals: { teachers: totalsRow?.teachers ?? 0, cards: totalsRow?.cards ?? 0 },
  })
}

// ---- GET /api/teachers/:publicId ----

async function handleTeacherPage(db: Env['DB'], publicId: string): Promise<Response> {
  // Single query: teacher profile + teacher_id in one statement
  const teacherRow = await db
    .prepare(
      'SELECT tp.teacher_id, tp.public_id AS publicId, tt.title, t.name, t.subject, tp.department ' +
      'FROM teacher t ' +
      'JOIN teacher_profile tp ON tp.teacher_id = t.id ' +
      'LEFT JOIN teacher_title tt ON tt.teacher_id = t.id ' +
      'WHERE tp.public_id = ?',
    )
    .bind(publicId)
    .first<{ teacher_id: number; publicId: string; title: string | null; name: string; subject: string; department: string }>()

  if (!teacherRow) return error('not_found')

  // Approved cards, newest first, capped at 200
  const { results: cardRows } = await db
    .prepare(
      'SELECT sc.public_id, sc.message, sc.from_name, sc.from_class, sc.anonymous, sc.created_at, ' +
      'sc.template_id, tmpl.layout ' +
      'FROM student_card sc ' +
      'JOIN template tmpl ON tmpl.id = sc.template_id ' +
      `WHERE sc.teacher_id = ? AND ${cardWhere('sc')} ` +
      'ORDER BY sc.created_at DESC, sc.id DESC ' +
      'LIMIT 200',
    )
    .bind(teacherRow.teacher_id)
    .all<CardRow>()

  // Total (without the 200 cap)
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM student_card sc WHERE sc.teacher_id = ? AND ${cardWhere('sc')}`)
    .bind(teacherRow.teacher_id)
    .first<{ total: number }>()

  const templateIds = [...new Set(cardRows.map((r) => r.template_id))]
  const imgMap = await fetchTemplateImages(db, templateIds)

  const cards = cardRows.map((row) => toPublicCard(row, imgMap.get(row.template_id) ?? {}))

  return json({
    teacher: {
      publicId: teacherRow.publicId,
      title: teacherRow.title,
      name: teacherRow.name,
      subject: teacherRow.subject,
      department: teacherRow.department,
    },
    cards,
    total: totalRow?.total ?? 0,
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

  // 2. Route — isToken check before ensureSchema/DB where applicable
  if (pathname === '/api/wall') {
    if (method !== 'GET') return error('method')
    await ensureSchema(env.DB)
    return handleWall(env.DB)
  }

  if (pathname.startsWith('/api/teachers/')) {
    if (method !== 'GET') return error('method')
    const publicId = pathname.slice('/api/teachers/'.length)
    if (!isToken(publicId)) return error('not_found')
    await ensureSchema(env.DB)
    return handleTeacherPage(env.DB, publicId)
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
