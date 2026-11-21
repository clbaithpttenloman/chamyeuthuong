/**
 * worker/tree.ts — public read APIs for the gift-tree campaign type.
 *
 * Routes:
 *   GET /api/campaigns/<slug>/tree       → { asOf, gifts, totals }  (ADR-7 memo + Cache-Control)
 *   GET /api/campaigns/<slug>/gifts      → { gifts }  paginated, 24/page, page 1–50
 *   GET /api/campaigns/<slug>/templates  → active templates for the campaign
 *   GET /api/gifts/<publicId>            → gift by public id (hidden = 404 for non-owner/non-admin)
 *
 * Tree memo (ADR-7):
 *   - WeakMap<D1, Store> — scoped to the D1 binding lifetime (per isolate in production)
 *   - Active campaign slug stored in a pinned slot (never evicted by FIFO overflow)
 *   - Other slugs in a 32-entry FIFO (5 s TTL)
 *   - Unknown slugs in a separate 404 set (30 s TTL, ≤ 32 entries)
 *   - TREE_READ_LIMIT charged on cache misses only; slug validated BEFORE any DB/limiter call
 *   - Response never reads Cookie; body byte-identical for anonymous vs signed-in
 */
import { fetchTemplateImages } from './publicSql.ts'
import { resolveLayout } from '../shared/layouts.ts'
import { error, json } from './http.ts'
import { ensureSchema } from './schema.ts'
import { isValidSlug, isEffectivelyOpen } from '../shared/campaign.ts'
import { readSession } from './session.ts'
import { isGoogleAuthoritative } from './google.ts'
import { isToken } from './token.ts'
import type { D1 } from './types.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> }

type TreeEnv = {
  DB: D1
  TREE_READ_LIMIT?: Limiter
  PUBLIC_READ_LIMIT?: Limiter
  ADMIN_FAIL_LIMIT?: Limiter
  GOOGLE_CLIENT_ID?: string
  NONCE_KEY?: string
  ADMIN_LEGACY_LOGIN?: string
}

type GiftItem = {
  rank: number
  place: 'tree' | 'ground'
  publicId: string
  heartCount: number
  nickname: string
  className: string
  boxStyle: number
  ornamentStyle: number
  layout: string
  backgroundTemplateId: number | null
  font: string
  ink: string
  message: string
  createdAt: string
}

type TreeData = {
  asOf: string
  open: boolean   // effective open: status=active AND now BETWEEN starts_at AND ends_at (item 9)
  gifts: GiftItem[]
  totals: { visible: number }
}

type TreeEntry = { data: TreeData; expiresAt: number }

type TreeStore = {
  hits: Map<string, TreeEntry>   // non-active slugs (FIFO, max 32)
  miss404: Map<string, number>   // 404 slugs (TTL = 30 s, max 32)
  pinned?: { slug: string; entry: TreeEntry }  // active campaign (never evicted)
}

// ── Per-isolate memo ──────────────────────────────────────────────────────────

const MEMO_TTL = 5_000
const MEMO_404_TTL = 30_000
const MEMO_MAX = 32
const MEMO_404_MAX = 32

const stores = new WeakMap<D1, TreeStore>()

function getStore(db: D1): TreeStore {
  let s = stores.get(db)
  if (!s) { s = { hits: new Map(), miss404: new Map() }; stores.set(db, s) }
  return s
}

/** Returns the cached data, null (404 hit), or 'miss'. */
function memoGet(db: D1, slug: string): TreeData | null | 'miss' {
  const store = getStore(db)
  const now = Date.now()

  // Check pinned slot first
  if (store.pinned && store.pinned.slug === slug) {
    if (store.pinned.entry.expiresAt > now) return store.pinned.entry.data
    store.pinned = undefined
  }

  // Check FIFO hits
  const hit = store.hits.get(slug)
  if (hit) {
    if (hit.expiresAt > now) return hit.data
    store.hits.delete(slug)
  }

  // Check 404 set
  const exp404 = store.miss404.get(slug)
  if (exp404 !== undefined) {
    if (exp404 > now) return null
    store.miss404.delete(slug)
  }

  return 'miss'
}

function memoSet(db: D1, slug: string, data: TreeData, isActive: boolean): void {
  const store = getStore(db)
  const entry: TreeEntry = { data, expiresAt: Date.now() + MEMO_TTL }
  if (isActive) {
    store.pinned = { slug, entry }
  } else {
    if (store.hits.size >= MEMO_MAX) {
      const oldest = store.hits.keys().next().value
      if (oldest !== undefined) store.hits.delete(oldest)
    }
    store.hits.set(slug, entry)
  }
}

function memoSet404(db: D1, slug: string): void {
  const store = getStore(db)
  if (store.miss404.size >= MEMO_404_MAX) {
    const oldest = store.miss404.keys().next().value
    if (oldest !== undefined) store.miss404.delete(oldest)
  }
  store.miss404.set(slug, Date.now() + MEMO_404_TTL)
}

// ── Gift row → public shape ───────────────────────────────────────────────────

type GiftRow = {
  public_id: string
  box_style: number
  ornament_style: number
  layout: string
  background_template_id: number | null
  font: string
  ink: string
  message: string
  nickname: string
  class_name: string
  heart_count: number
  created_at: string
}

function toPublicGift(row: GiftRow, rank: number, treeSlots: number): GiftItem {
  return {
    rank,
    place: rank <= treeSlots ? 'tree' : 'ground',
    publicId: row.public_id,
    heartCount: row.heart_count,
    nickname: row.nickname,
    className: row.class_name,
    boxStyle: row.box_style,
    ornamentStyle: row.ornament_style,
    layout: row.layout,
    backgroundTemplateId: row.background_template_id ?? null,
    font: row.font,
    ink: row.ink,
    message: row.message,
    createdAt: row.created_at,
  }
}

/** Same public fields as GiftItem minus rank and place (for gift-by-id and gift list). */
function toPublicGiftFlat(row: GiftRow) {
  return {
    publicId: row.public_id,
    heartCount: row.heart_count,
    nickname: row.nickname,
    className: row.class_name,
    boxStyle: row.box_style,
    ornamentStyle: row.ornament_style,
    layout: row.layout,
    backgroundTemplateId: row.background_template_id ?? null,
    font: row.font,
    ink: row.ink,
    message: row.message,
    createdAt: row.created_at,
  }
}

// ── SQL fragments ─────────────────────────────────────────────────────────────

const GIFT_PUBLIC_COLS =
  'public_id, box_style, ornament_style, layout, background_template_id,' +
  ' font, ink, message, nickname, class_name, heart_count, created_at'

// ── GET /api/campaigns/<slug>/tree ────────────────────────────────────────────

function treeResponse(data: TreeData): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=5',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

async function handleTreeEndpoint(slug: string, request: Request, env: TreeEnv): Promise<Response> {
  const db = env.DB

  // 1. Slug validated before memo/limiter/DB (regex + reserved words check is in isValidSlug)
  if (!isValidSlug(slug)) return error('not_found')

  // 2. Memo check (BEFORE rate limit and DB)
  const cached = memoGet(db, slug)
  if (cached === null) return error('not_found')   // in 404 set
  if (cached !== 'miss') return treeResponse(cached)  // cache hit

  // 3. Rate limit on cache miss only
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  if (env.TREE_READ_LIMIT) {
    const rl = await env.TREE_READ_LIMIT.limit({ key: ip })
    if (!rl.success) return error('rate_limited')
  }

  await ensureSchema(db)

  // 4. Fetch campaign
  const campaign = await db
    .prepare('SELECT id, kind, status, starts_at, ends_at, settings FROM campaign WHERE slug = ? LIMIT 1')
    .bind(slug)
    .first<{ id: number; kind: string; status: string; starts_at: string; ends_at: string; settings: string }>()

  if (!campaign || campaign.kind !== 'gift_tree' || campaign.status === 'draft') {
    memoSet404(db, slug)
    return error('not_found')
  }

  // Parse settings
  let settings: { tree_slots?: number; ground_slots?: number } = {}
  try { settings = JSON.parse(campaign.settings) } catch { /* use defaults */ }
  const treeSlots = typeof settings.tree_slots === 'number' ? settings.tree_slots : 15
  const groundSlots = typeof settings.ground_slots === 'number' ? settings.ground_slots : 10
  const limit = treeSlots + groundSlots

  // 5. Fetch gifts + total sequentially (batch only supports DML in testDb)
  const { results: giftRows } = await db
    .prepare(
      `SELECT ${GIFT_PUBLIC_COLS} FROM gift` +
      " WHERE campaign_id = ? AND status = 'visible'" +
      ' ORDER BY heart_count DESC, created_at ASC, id ASC LIMIT ?',
    )
    .bind(campaign.id, limit)
    .all<GiftRow>()

  const totalRow = await db
    .prepare(
      "SELECT COUNT(*) AS total FROM gift WHERE campaign_id = ? AND status = 'visible'",
    )
    .bind(campaign.id)
    .first<{ total: number }>()
  const totalVisible = totalRow?.total ?? 0

  const asOf = new Date().toISOString()
  const open = isEffectivelyOpen(
    { status: campaign.status as 'draft' | 'active' | 'closed', starts_at: campaign.starts_at, ends_at: campaign.ends_at },
    new Date(),
  )
  const gifts = giftRows.map((row, i) => toPublicGift(row, i + 1, treeSlots))

  const data: TreeData = { asOf, open, gifts, totals: { visible: totalVisible } }
  memoSet(db, slug, data, campaign.status === 'active')

  return treeResponse(data)
}

// ── GET /api/campaigns/<slug>/gifts ───────────────────────────────────────────

async function handleGiftList(slug: string, request: Request, env: TreeEnv): Promise<Response> {
  const url = new URL(request.url)
  const db = env.DB

  if (!isValidSlug(slug)) return error('not_found')

  // Rate limit
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  if (env.PUBLIC_READ_LIMIT) {
    const rl = await env.PUBLIC_READ_LIMIT.limit({ key: ip })
    if (!rl.success) return error('rate_limited')
  }

  // Page validation: must be a pure digit string (item 11), then 1–50 range.
  const rawPage = url.searchParams.get('page')
  const page = rawPage !== null ? (/^\d+$/.test(rawPage) ? Number(rawPage) : NaN) : 1
  if (!Number.isInteger(page) || page < 1 || page > 50) {
    return new Response(JSON.stringify({ error: 'bad_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  const sort = url.searchParams.get('sort') ?? 'hearts'
  const offset = (page - 1) * 24

  await ensureSchema(db)

  // Fetch campaign (must be gift_tree, any non-draft status)
  const campaign = await db
    .prepare('SELECT id, kind, status FROM campaign WHERE slug = ? LIMIT 1')
    .bind(slug)
    .first<{ id: number; kind: string; status: string }>()

  if (!campaign || campaign.kind !== 'gift_tree' || campaign.status === 'draft') {
    return error('not_found')
  }

  const orderBy = sort === 'new'
    ? 'created_at DESC, id DESC'
    : 'heart_count DESC, created_at ASC, id ASC'

  const { results } = await db
    .prepare(
      `SELECT ${GIFT_PUBLIC_COLS} FROM gift` +
      " WHERE campaign_id = ? AND status = 'visible'" +
      ` ORDER BY ${orderBy} LIMIT 24 OFFSET ?`,
    )
    .bind(campaign.id, offset)
    .all<GiftRow>()

  return new Response(JSON.stringify({ gifts: results.map(toPublicGiftFlat) }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=5',
    },
  })
}

// ── GET /api/campaigns/<slug>/templates ───────────────────────────────────────

async function handleCampaignTemplates(slug: string, request: Request, env: TreeEnv): Promise<Response> {
  const db = env.DB

  if (!isValidSlug(slug)) return error('not_found')

  // Public list: every request is a D1 read, so it is metered like other public lists.
  if (env.PUBLIC_READ_LIMIT) {
    const rl = await env.PUBLIC_READ_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' })
    if (!rl.success) return error('rate_limited')
  }

  await ensureSchema(db)

  // Fetch campaign (any kind, any non-draft status)
  const campaign = await db
    .prepare('SELECT id, kind, status FROM campaign WHERE slug = ? LIMIT 1')
    .bind(slug)
    .first<{ id: number; kind: string; status: string }>()

  if (!campaign || campaign.status === 'draft') return error('not_found')

  const { results } = await db
    .prepare('SELECT id, name, layout FROM template WHERE campaign_id = ? AND active = 1 ORDER BY id')
    .bind(campaign.id)
    .all<{ id: number; name: string; layout: string }>()

  // Same shape as the 20/11 /api/templates: { id, name, layout, images: { slot: token } }.
  const imgMap = await fetchTemplateImages(db, results.map((t) => t.id))
  const list = results.map((t) => ({ id: t.id, name: t.name, layout: resolveLayout(t.layout).id, images: imgMap.get(t.id) ?? {} }))
  return new Response(JSON.stringify(list), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=5',
    },
  })
}

// ── GET /api/gifts/<publicId> ─────────────────────────────────────────────────

async function handleGiftById(publicId: string, request: Request, env: TreeEnv): Promise<Response> {
  const db = env.DB

  // Validate publicId format before hitting the DB (item 11: isToken check).
  // A well-formed public id is exactly 16 lowercase alphanumeric characters.
  if (!isToken(publicId)) return error('not_found')

  // Rate limit
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  if (env.PUBLIC_READ_LIMIT) {
    const rl = await env.PUBLIC_READ_LIMIT.limit({ key: ip })
    if (!rl.success) return error('rate_limited')
  }

  await ensureSchema(db)

  const gift = await db
    .prepare(
      `SELECT ${GIFT_PUBLIC_COLS}, id, user_id, status FROM gift WHERE public_id = ? LIMIT 1`,
    )
    .bind(publicId)
    .first<GiftRow & { id: number; user_id: number; status: string }>()

  if (!gift) return error('not_found')

  if (gift.status === 'visible') {
    return json(toPublicGiftFlat(gift))
  }

  // Deleted → 404 for everyone
  if (gift.status === 'deleted') return error('not_found')

  // Hidden (hidden_auto or hidden_admin): check if requester is owner or admin
  const session = await readSession(request, db)
  if (!session) return error('not_found')

  // Owner check
  if (session.userId === gift.user_id) return json(toPublicGiftFlat(gift))

  // Admin check
  const userRow = await db
    .prepare('SELECT email, hd, google_sub FROM app_user WHERE id = ? LIMIT 1')
    .bind(session.userId)
    .first<{ email: string; hd: string | null; google_sub: string | null }>()

  if (!userRow) return error('not_found')

  const adminRow = await db
    .prepare('SELECT google_sub FROM admin WHERE lower(email) = ? LIMIT 1')
    .bind(userRow.email.toLowerCase())
    .first<{ google_sub: string | null }>()

  if (!adminRow || !isGoogleAuthoritative(userRow.email, userRow.hd ?? undefined)) {
    return error('not_found')
  }

  const isAdmin = adminRow.google_sub === null || adminRow.google_sub === userRow.google_sub
  if (!isAdmin) return error('not_found')

  return json(toPublicGiftFlat(gift))
}

// ── Main router ───────────────────────────────────────────────────────────────

/**
 * Routes GET requests for the gift-tree read APIs.
 *   GET /api/campaigns/<slug>/tree       → handleTreeEndpoint
 *   GET /api/campaigns/<slug>/gifts      → handleGiftList
 *   GET /api/campaigns/<slug>/templates  → handleCampaignTemplates
 *   GET /api/gifts/<publicId>            → handleGiftById
 */
export async function handleTree(request: Request, env: TreeEnv): Promise<Response> {
  if (request.method !== 'GET') return error('method')

  const { pathname } = new URL(request.url)

  const treeMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/tree$/)
  if (treeMatch) return handleTreeEndpoint(treeMatch[1]!, request, env)

  const giftsMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/gifts$/)
  if (giftsMatch) return handleGiftList(giftsMatch[1]!, request, env)

  const templatesMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/templates$/)
  if (templatesMatch) return handleCampaignTemplates(templatesMatch[1]!, request, env)

  const giftByIdMatch = pathname.match(/^\/api\/gifts\/([a-zA-Z0-9_-]+)$/)
  if (giftByIdMatch) return handleGiftById(giftByIdMatch[1]!, request, env)

  return error('not_found')
}
