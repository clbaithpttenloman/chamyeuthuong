/**
 * worker/campaigns.ts — campaign public read APIs and admin lifecycle helpers.
 *
 * Public endpoints (no auth required):
 *   GET /api/campaigns/active  → the current active campaign, or most recent closed (FR-3)
 *   GET /api/campaigns/<slug>  → a campaign by slug (active/closed only; draft → 404)
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
import { isValidSlug, isEffectivelyOpen, CAMPAIGN_KINDS, validateSettings } from '../shared/campaign.ts'
import type { CampaignKind } from '../shared/campaign.ts'
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
type MemoStore = { hits: Map<string, MemoEntry>; miss404: Map<string, number>; active?: MemoEntry }

const MEMO_TTL_MS = 5_000
const MEMO_404_TTL_MS = 30_000  // Security item 2: 30 s TTL for 404s (design-specified)
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
  const store = getStore(db)
  const now = Date.now()

  if (key === 'active') {
    // Check pinned active slot (never evicted by other slug entries)
    if (store.active) {
      if (store.active.expiresAt > now) return store.active.data
      store.active = undefined
    }
    // Check 404 for active
    const exp = store.miss404.get('active')
    if (exp !== undefined) {
      if (exp > now) return null
      store.miss404.delete('active')
    }
    return 'miss'
  }

  // Slug path: check FIFO hits map
  const hit = store.hits.get(key)
  if (hit) {
    if (hit.expiresAt > now) return hit.data
    store.hits.delete(key)
  }
  const exp = store.miss404.get(key)
  if (exp !== undefined) {
    if (exp > now) return null
    store.miss404.delete(key)
  }
  return 'miss'
}

function memoSet(db: D1, key: string, data: CampaignData): void {
  const store = getStore(db)
  if (key === 'active') {
    // Store in the pinned active slot — never evicted by other slug entries.
    store.active = { data, expiresAt: Date.now() + MEMO_TTL_MS }
    return
  }
  // Non-active slugs go in the 32-entry FIFO
  if (store.hits.size >= MEMO_MAX) {
    const oldest = store.hits.keys().next().value
    if (oldest !== undefined) store.hits.delete(oldest)
  }
  store.hits.set(key, { data, expiresAt: Date.now() + MEMO_TTL_MS })
}

function memoSet404(db: D1, key: string): void {
  const { miss404 } = getStore(db)
  if (miss404.size >= MEMO_404_MAX) {
    const oldest = miss404.keys().next().value
    if (oldest !== undefined) miss404.delete(oldest)
  }
  miss404.set(key, Date.now() + MEMO_404_TTL_MS)  // 30 s TTL (security item 2)
}

// ---- Public read handler ----

const SELECT_CAMPAIGN =
  'SELECT id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status FROM campaign'

/**
 * Handles GET /api/campaigns/active and GET /api/campaigns/<slug>.
 *
 * /active: returns the active campaign; if none is active, falls back to the most recent
 *   closed campaign (FR-3, open: false). Returns 404 only when no campaigns exist at all.
 * /<slug>: 404 for draft campaigns (decisions.md item 4) and for unknown or invalid slugs.
 * Responses are memoised per D1 binding; Cache-Control: public, max-age=5, no Vary, no Set-Cookie.
 */
export async function handleCampaigns(
  request: Request,
  env: { DB: D1; PUBLIC_READ_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> } },
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const db = env.DB

  // Accept #9: only GET is allowed for public campaign reads
  if (request.method !== 'GET') return error('method')

  // Security item 2: validate canonical path and extract memo key BEFORE memo, limiter, or DB.
  // Non-canonical paths (trailing slash, //, extra segments, invalid slug) → 404 immediately.
  let memoKey: string
  let slug = ''
  if (pathname === '/api/campaigns/active') {
    memoKey = 'active'
  } else {
    const slugPart = pathname.startsWith('/api/campaigns/')
      ? pathname.slice('/api/campaigns/'.length)
      : ''
    if (!slugPart || slugPart.includes('/') || !isValidSlug(slugPart)) {
      return error('not_found')
    }
    // Prefixed so a campaign whose slug is literally "active" cannot share the pinned slot.
    slug = slugPart
    memoKey = `s:${slugPart}`
  }

  // Memo key = 'active' or the validated slug (query string is ignored by URL parsing).
  const hit = memoGet(db, memoKey)
  if (hit === null) return error('not_found')
  if (hit !== 'miss') return campaignResponse(hit)

  // Accept #7: rate limit cache misses per IP (PUBLIC_READ_LIMIT, 3000/60s)
  if (env.PUBLIC_READ_LIMIT) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const rl = await env.PUBLIC_READ_LIMIT.limit({ key: ip })
    if (!rl.success) return error('rate_limited')
  }

  await ensureSchema(db)

  const now = new Date()

  if (memoKey === 'active') {
    // Try active first
    let row = await db
      .prepare(`${SELECT_CAMPAIGN} WHERE status = 'active' LIMIT 1`)
      .first<CampaignRow>()

    // FR-3: no active → fall back to the most recent closed campaign (read-only, open: false)
    if (!row) {
      row = await db
        .prepare(`${SELECT_CAMPAIGN} WHERE status = 'closed' ORDER BY id DESC LIMIT 1`)
        .first<CampaignRow>()
    }

    if (!row) {
      memoSet404(db, 'active')
      return error('not_found')
    }
    const data = toCampaignData(row, now)
    memoSet(db, 'active', data)
    return campaignResponse(data)
  }

  // /api/campaigns/<slug> — memoKey is `s:` + the validated slug
  const row = await db
    .prepare(`${SELECT_CAMPAIGN} WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first<CampaignRow>()

  if (!row) {
    memoSet404(db, memoKey)
    return error('not_found')
  }

  // Draft campaigns are not publicly readable (decisions.md 2026-11-16 item 4).
  if (row.status === 'draft') {
    memoSet404(db, memoKey)
    return error('not_found')
  }

  const data = toCampaignData(row, now)
  memoSet(db, memoKey, data)
  return campaignResponse(data)
}

// ---- activateCampaign ----

/**
 * Closes any currently active campaign and activates the given one in a single D1 batch.
 * This maintains the partial-unique-index invariant: at most one active campaign at a time.
 * Returns 'not_found' if the campaign does not exist (Accept #2 — leaves current active untouched).
 */
export async function activateCampaign(db: D1, id: number): Promise<'ok' | 'not_found'> {
  // Check the target campaign exists before touching the active campaign (Accept #2).
  const existing = await db.prepare('SELECT id FROM campaign WHERE id = ?').bind(id).first<{ id: number }>()
  if (!existing) return 'not_found'
  await db.batch([
    db.prepare("UPDATE campaign SET status = 'closed' WHERE status = 'active' AND id != ?").bind(id),
    db.prepare("UPDATE campaign SET status = 'active' WHERE id = ?").bind(id),
  ])
  return 'ok'
}

// ---- Admin CRUD helpers ----

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

/** Parse a JSON string and check it is a non-null, non-array object.
 *  Returns the object on success, or null on failure. */
function parseJsonObj(s: unknown): Record<string, unknown> | null {
  if (s === undefined || s === null) return {}  // absent → treat as empty object (defaults)
  const str = typeof s === 'string' ? s : JSON.stringify(s)
  try {
    const v = JSON.parse(str)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
    return v as Record<string, unknown>
  } catch { return null }
}

/** ISO 8601 UTC regex: YYYY-MM-DDTHH:MM:SS[.ms]Z — rejects date-only and timezone offsets. */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** Returns true when s is a valid ISO 8601 UTC datetime string (YYYY-MM-DDTHH:MM:SS[.ms]Z). */
function isValidIso(s: unknown): s is string {
  if (typeof s !== 'string') return false
  if (!ISO_UTC_RE.test(s)) return false
  const d = new Date(s)
  return !isNaN(d.getTime())
}

/**
 * Validate POST/PATCH body fields shared between create and update.
 * Returns 'ok' or an error Response.
 *
 * @param kind           - the campaign kind (from body for POST; from DB for PATCH)
 * @param body           - the parsed request body
 * @param isPatch        - true for PATCH (skips required-field checks for starts_at/ends_at)
 * @param existingRow    - for PATCH: the stored starts_at/ends_at to compare a single changed date against
 */
function validateCampaignBody(
  kind: CampaignKind,
  body: Record<string, unknown>,
  isPatch: boolean,
  existingRow?: { starts_at: string; ends_at: string },
): Response | 'ok' {
  // Accept #4: name must be a string, trimmed, ≤120 codepoints
  if ('name' in body) {
    if (typeof body.name !== 'string') return error('bad_request')
    const trimmed = body.name.trim()
    // Empty after trim is refused on POST and PATCH: a campaign always has a name.
    if (trimmed === '' || [...trimmed].length > 120) return error('bad_request')
    body.name = trimmed
  } else if (!isPatch) {
    // POST: name is required (checked again in POST handler but guard here too)
    return error('bad_request')
  }

  // Accept #4: tagline must be a string, trimmed, ≤200 codepoints (optional)
  if ('tagline' in body) {
    if (typeof body.tagline !== 'string') return error('bad_request')
    const trimmed = body.tagline.trim()
    if ([...trimmed].length > 200) return error('bad_request')
    body.tagline = trimmed
  }

  // content must be a JSON object when present
  if ('content' in body) {
    const c = parseJsonObj(body.content)
    if (c === null) return error('bad_request')
    // Replace raw value with the parsed form so caller gets sanitised string
    body.content = JSON.stringify(c)
  }

  // theme_colors must be a JSON object when present
  if ('theme_colors' in body) {
    const tc = parseJsonObj(body.theme_colors)
    if (tc === null) return error('bad_request')
    body.theme_colors = JSON.stringify(tc)
  }

  // settings must pass validateSettings when present
  if ('settings' in body) {
    const parsed = parseJsonObj(body.settings)
    if (parsed === null) return error('bad_request')
    const result = validateSettings(kind, parsed)
    if (!result.ok) return error('bad_request')
    body.settings = JSON.stringify(result.value)
  }

  // Date validation
  const hasStart = 'starts_at' in body
  const hasEnd = 'ends_at' in body
  if (hasStart) {
    if (!isValidIso(body.starts_at)) return error('bad_request')
    // Normalise: canonical toISOString() without milliseconds (security item 6)
    body.starts_at = new Date(body.starts_at as string).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  if (hasEnd) {
    if (!isValidIso(body.ends_at)) return error('bad_request')
    body.ends_at = new Date(body.ends_at as string).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  if (!isPatch) {
    // For POST: both dates are required and end must be after start
    if (!hasStart || !hasEnd) return error('bad_request')
  }
  if (hasStart && hasEnd) {
    // When both are provided: end must be strictly after start
    const start = new Date(body.starts_at as string).getTime()
    const end = new Date(body.ends_at as string).getTime()
    if (end <= start) return error('bad_request')
  } else if (isPatch && existingRow) {
    // Accept #4: PATCH with only one date — compare against the stored other date
    if (hasStart && !hasEnd) {
      const start = new Date(body.starts_at as string).getTime()
      const storedEnd = new Date(existingRow.ends_at).getTime()
      if (storedEnd <= start) return error('bad_request')
    }
    if (hasEnd && !hasStart) {
      const storedStart = new Date(existingRow.starts_at).getTime()
      const end = new Date(body.ends_at as string).getTime()
      if (end <= storedStart) return error('bad_request')
    }
  }

  return 'ok'
}

const BODY_LIMIT = 16_384  // 16 KB

/**
 * Admin CRUD handler for /api/admin/campaigns and /api/admin/campaigns/<id>/*.
 * Callers MUST verify admin auth before invoking — this function assumes auth is done.
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
      try { body = (await readJson<Record<string, unknown>>(request, BODY_LIMIT)) as Record<string, unknown> }
      catch (e) { return error(e instanceof HttpError ? e.code : 'bad_request') }

      // snake_case keys (matching D1 columns and the editor's AdminCampaignInput)
      const { slug, kind, starts_at, ends_at } = body

      // Accept #3: status is not allowed on POST — new campaigns are always draft
      if ('status' in body) return error('bad_request')

      if (
        typeof slug !== 'string' || !isValidSlug(slug) ||
        typeof starts_at !== 'string' ||
        typeof ends_at !== 'string'
      ) return error('bad_request')

      // Validate kind against allowed values
      if (!CAMPAIGN_KINDS.includes(kind as CampaignKind)) return error('bad_request')
      const campaignKind = kind as CampaignKind

      // name is required for POST — also validated inside validateCampaignBody
      if (typeof body.name !== 'string') return error('bad_request')

      const bodyValidation = validateCampaignBody(campaignKind, body, false)
      if (bodyValidation !== 'ok') return bodyValidation

      const now = new Date().toISOString()
      try {
        await db
          .prepare(
            'INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            slug,
            campaignKind,
            typeof body.name === 'string' ? body.name : '',
            typeof body.tagline === 'string' ? body.tagline : '',
            typeof body.content === 'string' ? body.content : '{}',
            typeof body.theme_colors === 'string' ? body.theme_colors : '{}',
            typeof body.settings === 'string' ? body.settings : '{}',
            starts_at,
            ends_at,
            'draft',  // Accept #3: always draft on creation
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
    const result = await activateCampaign(db, id)
    if (result === 'not_found') return error('not_found')
    return json({ ok: true })
  }

  if (sub === '/close') {
    if (request.method !== 'POST') return error('method')
    const result = await db.prepare("UPDATE campaign SET status = 'closed' WHERE id = ?").bind(id).run()
    if (!result.meta?.changes) return error('not_found')
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
      try { body = (await readJson<Record<string, unknown>>(request, BODY_LIMIT)) as Record<string, unknown> }
      catch (e) { return error(e instanceof HttpError ? e.code : 'bad_request') }

      // status and kind are immutable via PATCH (use /activate or /close)
      if ('status' in body) return error('bad_request')
      if ('kind' in body) return error('bad_request')

      // Accept #2: check campaign exists; also fetch existing dates for single-date validation
      const existing = await db
        .prepare('SELECT kind, starts_at, ends_at FROM campaign WHERE id = ?')
        .bind(id)
        .first<{ kind: string; starts_at: string; ends_at: string }>()
      if (!existing) return error('not_found')

      let campaignKind: CampaignKind = 'teacher_cards'
      if (CAMPAIGN_KINDS.includes(existing.kind as CampaignKind)) {
        campaignKind = existing.kind as CampaignKind
      }

      // Accept #4: pass existing row so single-date validation compares against stored dates
      const bodyValidation = validateCampaignBody(campaignKind, body, true, existing)
      if (bodyValidation !== 'ok') return bodyValidation

      const fields: string[] = []
      const values: unknown[] = []
      const allowed = ['name', 'tagline', 'content', 'theme_colors', 'settings', 'starts_at', 'ends_at'] as const
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
      // Security item 7: refuse deletion of campaign 1 (foundation campaign, always protected).
      if (id === 1) return json({ error: 'campaign_protected' }, 409)

      // Accept #2: check campaign exists first (return 404 for unknown ids)
      const existing = await db.prepare('SELECT id, status FROM campaign WHERE id = ?').bind(id).first<{ id: number; status: string }>()
      if (!existing) return error('not_found')

      // Security item 7: refuse deletion of the active campaign.
      if (existing.status === 'active') return json({ error: 'campaign_protected' }, 409)

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
