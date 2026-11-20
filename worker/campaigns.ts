/**
 * worker/campaigns.ts — campaign public read APIs and admin lifecycle helpers.
 *
 * Public endpoints (no auth required):
 *   GET /api/campaigns/active  → the current active campaign, or 404
 *   GET /api/campaigns/<slug>  → a campaign by slug, or 404 / 404 for invalid slug
 *
 * Both responses carry Cache-Control: public, max-age=5 and are memoised per D1 binding
 * keyed by pathname (query string ignored), TTL 5 s, ≤ 32 hit entries.
 * A separate bounded set tracks 404 paths (5 s TTL, ≤ 64 entries) so unknown slugs do
 * not cost a D1 query on each request.
 * Using WeakMap<D1, …> scopes the memo to the D1 binding lifetime, which is per-isolate
 * in production and per-test in unit tests.
 *
 * Admin helpers (exported; callers enforce auth before calling):
 *   activateCampaign(db, id)                               — close the previous active, activate id
 *   handleAdminCampaigns(request, env, email) — CRUD for /api/admin/campaigns*
 */
import { error, json, readJson, HttpError } from './http.ts'
import { ensureSchema } from './schema.ts'
import { isValidSlug, isEffectivelyOpen } from '../shared/campaign.ts'
import type { D1, Env } from './types.ts'

// ---- Response shape ----

/** DB row returned by campaign queries. */
type CampaignRow = {
  id: number
  slug: string
  kind: string
  name: string
  tagline: string
  content: string
  theme_colors: string
  settings: string
  starts_at: string
  ends_at: string
  status: 'draft' | 'active' | 'closed'
}

/** Public campaign API shape (camelCase). */
type CampaignData = {
  slug: string
  kind: string
  name: string
  tagline: string
  content: unknown
  themeColors: unknown
  settings: unknown
  startsAt: string
  endsAt: string
  status: string
  open: boolean
}

function toCampaignData(row: CampaignRow, now: Date): CampaignData {
  return {
    slug: row.slug,
    kind: row.kind,
    name: row.name,
    tagline: row.tagline,
    content: parseJson(row.content),
    themeColors: parseJson(row.theme_colors),
    settings: parseJson(row.settings),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    open: isEffectivelyOpen(row, now),
  }
}

function parseJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return {} }
}

/** Builds a campaign response with Cache-Control: public, max-age=5, no Vary, no Set-Cookie. */
function campaignResponse(data: CampaignData): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=5',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

// ---- Per-isolate memo (WeakMap keyed by D1 binding) ----

type MemoEntry = { data: CampaignData; expiresAt: number }
type MemoStore = { hits: Map<string, MemoEntry>; miss404: Map<string, number> }

const MEMO_TTL_MS = 5_000
const MEMO_MAX = 32
const MEMO_404_MAX = 64

// WeakMap ensures entries are garbage-collected with the D1 binding (per isolate in production).
const stores = new WeakMap<D1, MemoStore>()

function getStore(db: D1): MemoStore {
  let s = stores.get(db)
  if (!s) { s = { hits: new Map(), miss404: new Map() }; stores.set(db, s) }
  return s
}

function memoGet(db: D1, key: string): CampaignData | null | 'miss' {
  const { hits, miss404 } = getStore(db)
  const now = Date.now()
  const hit = hits.get(key)
  if (hit) {
    if (hit.expiresAt > now) return hit.data
    hits.delete(key)
  }
  const exp = miss404.get(key)
  if (exp !== undefined) {
    if (exp > now) return null   // cached 404
    miss404.delete(key)
  }
  return 'miss'
}

function memoSet(db: D1, key: string, data: CampaignData): void {
  const { hits } = getStore(db)
  if (hits.size >= MEMO_MAX) {
    const oldest = hits.keys().next().value
    if (oldest !== undefined) hits.delete(oldest)
  }
  hits.set(key, { data, expiresAt: Date.now() + MEMO_TTL_MS })
}

function memoSet404(db: D1, key: string): void {
  const { miss404 } = getStore(db)
  if (miss404.size >= MEMO_404_MAX) {
    const oldest = miss404.keys().next().value
    if (oldest !== undefined) miss404.delete(oldest)
  }
  miss404.set(key, Date.now() + MEMO_TTL_MS)
}

// ---- Public read handler ----

const SELECT_CAMPAIGN =
  'SELECT id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status FROM campaign'

/**
 * Handles GET /api/campaigns/active and GET /api/campaigns/<slug>.
 * Returns 404 for invalid slugs (bad charset or reserved) or not-found campaigns.
 * Responses are memoised per D1 binding; Cache-Control: public, max-age=5, no Vary, no Set-Cookie.
 */
export async function handleCampaigns(
  request: Request,
  env: { DB: D1 },
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const db = env.DB

  // Memo key is the pathname; query string is ignored.
  const hit = memoGet(db, pathname)
  if (hit === null) return error('not_found')
  if (hit !== 'miss') return campaignResponse(hit)

  await ensureSchema(db)

  const now = new Date()

  if (pathname === '/api/campaigns/active') {
    const row = await db
      .prepare(`${SELECT_CAMPAIGN} WHERE status = 'active' LIMIT 1`)
      .first<CampaignRow>()
    if (!row) {
      memoSet404(db, pathname)
      return error('not_found')
    }
    const data = toCampaignData(row, now)
    memoSet(db, pathname, data)
    return campaignResponse(data)
  }

  // /api/campaigns/<slug>
  // pathname is /api/campaigns/<slug>  → split gives ['', 'api', 'campaigns', '<slug>']
  const slug = pathname.split('/')[3] ?? ''

  // Validate slug before hitting D1; invalid slugs are not cached (they never become valid).
  if (!isValidSlug(slug)) {
    return error('not_found')
  }

  const row = await db
    .prepare(`${SELECT_CAMPAIGN} WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first<CampaignRow>()

  if (!row) {
    memoSet404(db, pathname)
    return error('not_found')
  }
  const data = toCampaignData(row, now)
  memoSet(db, pathname, data)
  return campaignResponse(data)
}

// ---- activateCampaign ----

/**
 * Closes any currently active campaign and activates the given one in a single D1 batch.
 * This maintains the partial-unique-index invariant: at most one active campaign at a time.
 */
export async function activateCampaign(db: D1, id: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE campaign SET status = 'closed' WHERE status = 'active' AND id != ?").bind(id),
    db.prepare("UPDATE campaign SET status = 'active' WHERE id = ?").bind(id),
  ])
}

// ---- Admin CRUD ----

/** Returns true if any legacy table rows reference this campaign_id. */
async function campaignHasRows(db: D1, id: number): Promise<boolean> {
  for (const table of ['template', 'wish', 'student_card'] as const) {
    const row = await db
      .prepare(`SELECT 1 FROM ${table} WHERE campaign_id = ? LIMIT 1`)
      .bind(id)
      .first<{ 1: number }>()
    if (row) return true
  }
  return false
}

/**
 * Admin CRUD handler for /api/admin/campaigns and /api/admin/campaigns/<id>/*.
 * Callers MUST verify admin auth before invoking — this function assumes auth is done.
 * // TODO(phase1-task2): require Google session — the next task swaps requireAdmin so it also
 * // accepts Google-issued sessions; this function's signature remains the same.
 */
export async function handleAdminCampaigns(
  request: Request,
  env: Pick<Env, 'DB'>,
  email: string,
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const db = env.DB
  await ensureSchema(db)

  // /api/admin/campaigns → list / create
  if (pathname === '/api/admin/campaigns') {
    if (request.method === 'GET') {
      const { results } = await db
        .prepare(
          'SELECT id, slug, kind, name, tagline, starts_at, ends_at, status, created_at, created_by FROM campaign ORDER BY id DESC',
        )
        .all<Record<string, unknown>>()
      return json({ campaigns: results })
    }

    if (request.method === 'POST') {
      let body: Record<string, unknown>
      try { body = (await readJson<Record<string, unknown>>(request, 4096)) as Record<string, unknown> }
      catch (e) { return error(e instanceof HttpError ? e.code : 'bad_request') }

      const { slug, kind, name, tagline, content, themeColors, settings, startsAt, endsAt, status } = body
      if (
        typeof slug !== 'string' || !isValidSlug(slug) ||
        typeof kind !== 'string' ||
        typeof name !== 'string' ||
        typeof startsAt !== 'string' ||
        typeof endsAt !== 'string'
      ) return error('bad_request')

      const now = new Date().toISOString()
      try {
        await db
          .prepare(
            'INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            slug,
            kind,
            name ?? '',
            tagline ?? '',
            typeof content === 'string' ? content : JSON.stringify(content ?? {}),
            typeof themeColors === 'string' ? themeColors : JSON.stringify(themeColors ?? {}),
            typeof settings === 'string' ? settings : JSON.stringify(settings ?? {}),
            startsAt,
            endsAt,
            status ?? 'draft',
            now,
            email,
          )
          .run()
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        if (msg.includes('CHECK') || msg.includes('UNIQUE')) return error('bad_request')
        throw e
      }
      const created = await db.prepare('SELECT id FROM campaign WHERE slug = ?').bind(slug).first<{ id: number }>()
      return json({ id: created?.id }, 201)
    }
    return error('method')
  }

  // /api/admin/campaigns/<id>[/sub]
  const idMatch = pathname.match(/^\/api\/admin\/campaigns\/(\d+)(\/.*)?$/)
  if (!idMatch) return error('not_found')
  const id = Number(idMatch[1])
  const sub = idMatch[2] ?? ''

  if (sub === '/activate') {
    if (request.method !== 'POST') return error('method')
    await activateCampaign(db, id)
    return json({ ok: true })
  }

  if (sub === '' || sub === '/') {
    if (request.method === 'GET') {
      const row = await db
        .prepare('SELECT * FROM campaign WHERE id = ?')
        .bind(id)
        .first<Record<string, unknown>>()
      if (!row) return error('not_found')
      return json(row)
    }

    if (request.method === 'PATCH') {
      let body: Record<string, unknown>
      try { body = (await readJson<Record<string, unknown>>(request, 4096)) as Record<string, unknown> }
      catch (e) { return error(e instanceof HttpError ? e.code : 'bad_request') }

      const fields: string[] = []
      const values: unknown[] = []
      const allowed = ['name', 'tagline', 'content', 'theme_colors', 'settings', 'starts_at', 'ends_at', 'status'] as const
      for (const f of allowed) {
        if (f in body) {
          fields.push(`${f} = ?`)
          values.push(typeof body[f] === 'object' && body[f] !== null ? JSON.stringify(body[f]) : body[f])
        }
      }
      if (fields.length === 0) return error('bad_request')
      values.push(id)
      try {
        await db.prepare(`UPDATE campaign SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run()
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        if (msg.includes('CHECK') || msg.includes('UNIQUE')) return error('bad_request')
        throw e
      }
      return json({ ok: true })
    }

    if (request.method === 'DELETE') {
      // Refuse deletion if any legacy-table rows reference this campaign (FR-7).
      if (await campaignHasRows(db, id)) {
        return json({ error: 'campaign_has_rows' }, 409)
      }
      await db.prepare('DELETE FROM campaign WHERE id = ?').bind(id).run()
      return json({ ok: true })
    }
    return error('method')
  }

  return error('not_found')
}
