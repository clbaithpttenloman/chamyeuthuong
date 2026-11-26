/**
 * Theme slot storage and API (Phase 3, ADR-6, FR-14..FR-18). Admins upload one static image per
 * gift-tree slot; the image is stored in D1 as base64 and served from /api/theme-image/<token>.
 */
import { json, error, readBytes, HttpError } from './http.ts'
import { ensureSchema } from './schema.ts'
import { parseId } from './admins.ts'
import { encodeBase64, decodeBase64, getCache, type CacheStore } from './images.ts'
import { getSlotSpec, validateThemeImage, themeAssetFor, type ThemeFormat } from '../shared/themeSlots.ts'
import { inspectTheme, METADATA_MESSAGE } from './themeInspect.ts'
import type { D1, Env as WorkerEnv } from './types.ts'

/** Total stored bytes per campaign across all slots. Matches the 15 MB D1 row budget per campaign. */
export const THEME_CAMPAIGN_CAP = 15728640

type Env = { DB: D1 }
type Auth = { userId: number; actor: string }

const ROUTE = /^\/api\/admin\/campaigns\/(\d{1,9})\/theme(?:\/([a-z0-9_]+))?$/
const SERVE = /^\/api\/theme-image\/([0-9a-f]{32})$/

function newImageToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function campaignExists(db: D1, id: number): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM campaign WHERE id = ?').bind(id).first<{ id: number }>()
  return row !== null
}

/**
 * Admin routes for one campaign's theme (caller must have passed requireAdmin):
 *   GET    /api/admin/campaigns/<id>/theme          → { theme: { slot: url } } (drafts included)
 *   POST   /api/admin/campaigns/<id>/theme/<slot>   → upload; DELETE restores the default
 */
export async function handleThemes(request: Request, env: Env, auth: Auth): Promise<Response> {
  const url = new URL(request.url)
  const m = ROUTE.exec(url.pathname)
  if (!m) return error('not_found')
  const campaignId = parseId(m[1])
  const slot = m[2]
  if (campaignId === null) return error('not_found')

  await ensureSchema(env.DB)
  if (!(await campaignExists(env.DB, campaignId))) return error('not_found')

  if (slot === undefined) {
    if (request.method !== 'GET') return error('method')
    const { results } = await env.DB
      .prepare('SELECT slot, token, frames, fps, width, height FROM theme_image WHERE campaign_id = ?')
      .bind(campaignId)
      .all<{ slot: string; token: string; frames: number; fps: number | null; width: number; height: number }>()
    return json({ theme: Object.fromEntries(results.map((r) => [r.slot, themeAssetFor(r.token, r.frames, r.fps, r.width, r.height, getSlotSpec(r.slot)?.animation === 'sprite')])) })
  }

  const spec = getSlotSpec(slot)
  if (!spec) return json({ error: 'bad_request', errors: ['Ô ảnh không hợp lệ.'] }, 400)

  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM theme_image WHERE campaign_id = ? AND slot = ?').bind(campaignId, slot).run()
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  }
  if (request.method !== 'POST') return error('method')

  // Refuse oversized bodies before reading them. readBytes enforces the same limit for chunked bodies.
  let bytes: Uint8Array
  try {
    bytes = await readBytes(request, spec.maxBytes)
  } catch (e) {
    if (e instanceof HttpError) return error('too_long')
    throw e
  }
  if (bytes.length === 0) return json({ error: 'bad_request', errors: ['Chưa có ảnh.'] }, 400)

  const mime = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase()
  const inspected = inspectTheme(mime, bytes)
  if (!inspected.ok) return json({ error: 'bad_request', errors: [inspected.error] }, 400)
  const info = inspected.info
  if (info.exif) return json({ error: 'bad_request', errors: [METADATA_MESSAGE] }, 400)

  // Sprite slots declare their playback speed on the query string (?fps=12..30). Other slots ignore it.
  const fpsParam = url.searchParams.get('fps')
  const fps = fpsParam === null ? null : Number(fpsParam)
  const check = validateThemeImage(spec, { mime: info.mime, size: bytes.length, width: info.width, height: info.height, hasAlpha: info.hasAlpha, animated: info.animated, frames: info.frames }, fps)
  if (!check.ok) return json({ error: 'bad_request', errors: check.errors }, 400)
  const frames = check.frames
  const storedFps = check.fps

  const token = newImageToken()
  const now = new Date().toISOString()
  // One batch (transactional): insert only when the campaign total stays within the cap, then remove
  // the previous image of this slot. The old row is only deleted when the new row exists.
  const insert = env.DB
    .prepare(
      `INSERT INTO theme_image (campaign_id, slot, token, mime, size, width, height, frames, fps, data, created_at, created_by)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COALESCE(SUM(size), 0) FROM theme_image WHERE campaign_id = ? AND slot != ?) + ? <= ?`,
    )
    .bind(campaignId, slot, token, info.mime, bytes.length, info.width, info.height, frames, storedFps, encodeBase64(bytes), now, auth.actor,
      campaignId, slot, bytes.length, THEME_CAMPAIGN_CAP)
  const cleanup = env.DB
    .prepare(
      `DELETE FROM theme_image WHERE campaign_id = ? AND slot = ? AND token != ?
       AND EXISTS (SELECT 1 FROM theme_image WHERE token = ?)`,
    )
    .bind(campaignId, slot, token, token)
  const [inserted] = await env.DB.batch([insert, cleanup])
  if (inserted.meta.changes !== 1) return json({ error: 'campaign_limit' }, 409)

  return json({ token, ...themeAssetFor(token, frames, storedFps, info.width, info.height, spec.animation === 'sprite'), slot, mime: info.mime, width: info.width, height: info.height, size: bytes.length }, 201)
}

/**
 * GET /api/theme-image/<token>. Public: the token is random and is shown on the game page.
 * Order: method → IMAGE_IP_LIMIT → token shape → Cache API → D1. Only 200s are cached.
 */
export async function handleThemeImage(
  request: Request,
  env: Pick<WorkerEnv, 'DB' | 'IMAGE_IP_LIMIT'> & { _caches?: CacheStore },
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  if (request.method !== 'GET') return error('method')
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const { success } = await env.IMAGE_IP_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  const m = SERVE.exec(new URL(request.url).pathname)
  if (!m) return error('not_found')

  const cacheKey = new URL(`/api/theme-image/${m[1]}`, request.url).toString()
  const cache = getCache(env)
  if (cache) {
    const cached = await cache.match(cacheKey)
    if (cached) return cached
  }

  await ensureSchema(env.DB)
  const row = await env.DB
    .prepare('SELECT mime, data FROM theme_image WHERE token = ?')
    .bind(m[1])
    .first<{ mime: ThemeFormat; data: string }>()
  if (!row) return error('not_found')

  const bytes = decodeBase64(row.data)
  const resp = new Response(bytes.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': row.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Robots-Tag': 'noindex',
    },
  })
  if (cache) {
    if (ctx) ctx.waitUntil(cache.put(cacheKey, resp.clone()))
    else cache.put(cacheKey, resp.clone()).catch(() => {})
  }
  return resp
}
