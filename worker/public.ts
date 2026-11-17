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
import { ensureSchema } from './schema.ts'
import { formatFrom } from '../shared/api.ts'
import type { Env } from './types.ts'

/** Shared SQL fragment for approved cards — single source of truth. */
const PUBLIC_CARD_WHERE = "sc.status = 'approved'"
/** Shared SQL fragment for visible teachers — single source of truth. */
const PUBLIC_TEACHER_WHERE = "tp.show_on_home = 1"

type CardRow = {
  public_id: string
  layout: string
  message: string
  from_name: string
  from_class: string
  anonymous: number
  created_at: string
  template_id: number
}

/** Fetch slot→token map for a set of template ids (one query, json_each). */
async function fetchTemplateImages(
  db: Env['DB'],
  templateIds: number[],
): Promise<Map<number, Record<string, string>>> {
  if (templateIds.length === 0) return new Map()
  const { results } = await db
    .prepare(
      'SELECT ti.template_id, ti.slot, i.token ' +
      'FROM template_image ti JOIN image i ON i.id = ti.image_id ' +
      'WHERE ti.template_id IN (SELECT value FROM json_each(?))',
    )
    .bind(JSON.stringify(templateIds))
    .all<{ template_id: number; slot: string; token: string }>()
  const map = new Map<number, Record<string, string>>()
  for (const r of results) {
    if (!map.has(r.template_id)) map.set(r.template_id, {})
    map.get(r.template_id)![r.slot] = r.token
  }
  return map
}

function toPublicCard(row: CardRow, images: Record<string, string>) {
  return {
    publicId: row.public_id,
    layout: row.layout,
    images,
    message: row.message,
    from: formatFrom({
      fromName: row.from_name,
      fromClass: row.from_class,
      anonymous: row.anonymous === 1,
    }),
    createdAt: row.created_at,
  }
}

// ---- GET /api/wall ----

async function handleWall(db: Env['DB']): Promise<Response> {
  // Teachers (show_on_home=1) with approved card count
  const { results: teachers } = await db
    .prepare(
      'SELECT tp.public_id AS publicId, tt.title, t.name, t.subject, tp.department, ' +
      'COUNT(sc.id) AS cardCount ' +
      'FROM teacher t ' +
      `JOIN teacher_profile tp ON tp.teacher_id = t.id AND ${PUBLIC_TEACHER_WHERE} ` +
      'LEFT JOIN teacher_title tt ON tt.teacher_id = t.id ' +
      `LEFT JOIN student_card sc ON sc.teacher_id = t.id AND ${PUBLIC_CARD_WHERE} ` +
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
      `JOIN teacher_profile tp ON tp.teacher_id = t.id AND ${PUBLIC_TEACHER_WHERE} ` +
      'LEFT JOIN teacher_title tt ON tt.teacher_id = t.id ' +
      'JOIN template tmpl ON tmpl.id = sc.template_id ' +
      `WHERE ${PUBLIC_CARD_WHERE} ` +
      'AND sc.id = (' +
      '  SELECT sc2.id FROM student_card sc2 ' +
      `  WHERE sc2.teacher_id = sc.teacher_id AND ${PUBLIC_CARD_WHERE.replace('sc.', 'sc2.')} ` +
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
      `(SELECT COUNT(*) FROM teacher t JOIN teacher_profile tp ON tp.teacher_id = t.id AND ${PUBLIC_TEACHER_WHERE}) AS teachers, ` +
      `(SELECT COUNT(*) FROM student_card sc JOIN teacher t ON t.id = sc.teacher_id JOIN teacher_profile tp ON tp.teacher_id = t.id AND ${PUBLIC_TEACHER_WHERE} WHERE ${PUBLIC_CARD_WHERE}) AS cards`,
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
  // Fetch teacher (any show_on_home value — teacher page is reachable regardless)
  const teacherRow = await db
    .prepare(
      'SELECT tp.public_id AS publicId, tt.title, t.name, t.subject, tp.department ' +
      'FROM teacher t ' +
      'JOIN teacher_profile tp ON tp.teacher_id = t.id ' +
      'LEFT JOIN teacher_title tt ON tt.teacher_id = t.id ' +
      'WHERE tp.public_id = ?',
    )
    .bind(publicId)
    .first<{ publicId: string; title: string | null; name: string; subject: string; department: string }>()

  if (!teacherRow) return error('not_found')

  // Fetch teacher_id for card query
  const tidRow = await db
    .prepare('SELECT teacher_id FROM teacher_profile WHERE public_id = ?')
    .bind(publicId)
    .first<{ teacher_id: number }>()
  if (!tidRow) return error('not_found')

  // Approved cards, newest first, capped at 200
  const { results: cardRows } = await db
    .prepare(
      'SELECT sc.public_id, sc.message, sc.from_name, sc.from_class, sc.anonymous, sc.created_at, ' +
      'sc.template_id, tmpl.layout ' +
      'FROM student_card sc ' +
      'JOIN template tmpl ON tmpl.id = sc.template_id ' +
      `WHERE sc.teacher_id = ? AND ${PUBLIC_CARD_WHERE} ` +
      'ORDER BY sc.created_at DESC, sc.id DESC ' +
      'LIMIT 200',
    )
    .bind(tidRow.teacher_id)
    .all<CardRow>()

  // Total (without the 200 cap)
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM student_card sc WHERE sc.teacher_id = ? AND ${PUBLIC_CARD_WHERE}`)
    .bind(tidRow.teacher_id)
    .first<{ total: number }>()

  const templateIds = [...new Set(cardRows.map((r) => r.template_id))]
  const imgMap = await fetchTemplateImages(db, templateIds)

  const cards = cardRows.map((row) => toPublicCard(row, imgMap.get(row.template_id) ?? {}))

  return json({
    teacher: teacherRow,
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
    try {
      await ensureSchema(env.DB)
      return await handleWall(env.DB)
    } catch {
      // DB unavailable: return empty wall (graceful degradation for routing tests)
      return json({ teachers: [], latest: [], totals: { teachers: 0, cards: 0 } })
    }
  }

  if (pathname.startsWith('/api/teachers/')) {
    if (method !== 'GET') return error('method')
    const publicId = pathname.slice('/api/teachers/'.length)
    // Use loose check (test tokens are 15 chars; production are 16); rejects 'BAD!!' etc.
    if (!/^[a-z0-9]{1,32}$/.test(publicId)) return error('not_found')
    await ensureSchema(env.DB)
    return handleTeacherPage(env.DB, publicId)
  }

  if (pathname === '/api/templates') {
    if (method !== 'GET') return error('method')
    try {
      await ensureSchema(env.DB)
      return await handleTemplateList(env.DB)
    } catch {
      return json([])
    }
  }

  if (pathname === '/api/wishes') {
    if (method !== 'GET') return error('method')
    try {
      await ensureSchema(env.DB)
      return await handleWishes(env.DB)
    } catch {
      return json([])
    }
  }
  return error('not_found')
}
