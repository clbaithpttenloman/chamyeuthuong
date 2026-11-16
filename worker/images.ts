import { error, json, readBytes, HttpError } from './http.ts'
import { isToken, newToken } from './token.ts'
import { ensureSchema } from './schema.ts'
import { parseId } from './admins.ts'
import type { Env } from './types.ts'

// ---- Constants ----

const MAX_IMAGE_BYTES = 307200          // 300 KB
const MAX_IMAGE_COUNT = 200
const MAX_IMAGE_TOTAL = 41943040        // 40 MB (raw size; base64 storage is ~1.33× larger)
const MAX_DIM = 4096
const MAX_PIXELS = 8_000_000

// ---- Dimension / Exif parsers ----

function u32be(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0
}

type DimResult = { w: number; h: number } | 'exif' | null

/** Parse PNG: returns dimensions, 'exif' if eXIf chunk found, null if truncated/malformed. */
function parsePNG(b: Uint8Array): DimResult {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 24) return null
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return null
  // IHDR must be 13 bytes; type bytes 12-15 = "IHDR"
  const ihdrLen = u32be(b, 8)
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null
  if (b.length < 24) return null
  const w = u32be(b, 16)
  const h = u32be(b, 20)
  // Scan chunks after IHDR for eXIf
  let off = 8 + 4 + 4 + ihdrLen + 4
  while (off + 8 <= b.length) {
    const cLen = u32be(b, off)
    // Type: bytes off+4..off+7
    if (b[off + 4] === 0x65 && b[off + 5] === 0x58 && b[off + 6] === 0x49 && b[off + 7] === 0x66) {
      return 'exif'  // "eXIf"
    }
    off += 4 + 4 + cLen + 4
  }
  return { w, h }
}

/** Parse JPEG: returns dimensions, 'exif' if APP1 Exif found, null if no SOF found. */
function parseJPEG(b: Uint8Array): DimResult {
  if (b.length < 2 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let off = 2
  while (off + 1 < b.length) {
    if (b[off] !== 0xff) return null
    const marker = b[off + 1]
    off += 2
    // Standalone markers (no length)
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue
    if (off + 2 > b.length) return null
    const segLen = (b[off] << 8) | b[off + 1]
    if (segLen < 2) return null
    // APP1 — check for Exif
    if (marker === 0xe1 && off + 8 <= b.length) {
      if (
        b[off + 2] === 0x45 && b[off + 3] === 0x78 && b[off + 4] === 0x69 &&
        b[off + 5] === 0x66 && b[off + 6] === 0x00 && b[off + 7] === 0x00
      ) return 'exif'
    }
    // SOF markers: C0-CF excluding C4 (DHT), C8, CC (DAC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (off + 7 > b.length) return null
      const h = (b[off + 3] << 8) | b[off + 4]
      const w = (b[off + 5] << 8) | b[off + 6]
      return { w, h }
    }
    off += segLen
  }
  return null
}

/** Parse WebP: returns dimensions, 'exif' if EXIF chunk/flag found, null if malformed. */
function parseWebP(b: Uint8Array): DimResult {
  if (b.length < 12) return null
  if (b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) return null
  if (b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null
  if (b.length < 16) return null
  const fourCC = String.fromCharCode(b[12], b[13], b[14], b[15])

  if (fourCC === 'VP8X') {
    if (b.length < 30) return null
    // Bit 3 of flags (byte 20) = EXIF present
    if ((b[20] & 0x08) !== 0) return 'exif'
    // Also scan chunks for EXIF type
    if (hasWebPExifChunk(b)) return 'exif'
    const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16))
    const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16))
    return { w, h }
  }

  if (fourCC === 'VP8 ') {
    if (b.length < 30) return null
    if ((b[20] & 1) !== 0) return null  // not a keyframe
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    const w = (b[26] | (b[27] << 8)) & 0x3fff
    const h = (b[28] | (b[29] << 8)) & 0x3fff
    return { w, h }
  }

  if (fourCC === 'VP8L') {
    if (b.length < 25) return null
    if (b[20] !== 0x2f) return null  // VP8L signature
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
    const w = 1 + (bits & 0x3fff)
    const h = 1 + ((bits >> 14) & 0x3fff)
    return { w, h }
  }

  return null
}

function hasWebPExifChunk(b: Uint8Array): boolean {
  let off = 12  // past RIFF/size/WEBP
  while (off + 8 <= b.length) {
    if (b[off] === 0x45 && b[off + 1] === 0x58 && b[off + 2] === 0x49 && b[off + 3] === 0x46) return true  // "EXIF"
    const size = b[off + 4] | (b[off + 5] << 8) | (b[off + 6] << 16) | (b[off + 7] << 24)
    off += 8 + size + (size & 1)  // chunks are padded to even size
  }
  return false
}

/** Validate image dimensions; returns error string on rejection, null on pass. */
function checkDimensions(mime: string, bytes: Uint8Array): DimResult {
  if (mime === 'image/png') return parsePNG(bytes)
  if (mime === 'image/jpeg') return parseJPEG(bytes)
  if (mime === 'image/webp') return parseWebP(bytes)
  return null
}

/** Check magic bytes against declared MIME type. */
function magicOk(mime: string, b: Uint8Array): boolean {
  if (b.length < 4) return false
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8
  if (mime === 'image/png') {
    return (
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
    )
  }
  if (mime === 'image/webp') {
    return (
      b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
    )
  }
  return false
}

// ---- Base64 helpers ----

// SHORTCUT: base64 in D1 TEXT — move to R2 binding when image library exceeds ~100 images
//   or when first-deploy CPU measurement shows decoding is too slow (see docs/runbooks/admin.md).
//   Upgrade path: add an R2 binding, store raw bytes there, store only the R2 key in D1.
function decodeBase64(b64: string): Uint8Array {
  if (typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64 === 'function') {
    return (Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(b64)
  }
  // Chunked atob loop for runtimes without Uint8Array.fromBase64
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

// ---- Cache API types ----

type CacheStore = {
  default: {
    match(req: Request | string): Promise<Response | undefined>
    put(req: Request | string, resp: Response): Promise<void>
  }
}

function getCache(env: { _caches?: CacheStore }): CacheStore['default'] | undefined {
  if (env._caches) return env._caches.default
  if (typeof caches !== 'undefined') return (caches as unknown as CacheStore).default
  return undefined
}

// ---- Admin image list ----

async function listImages(env: Pick<Env, 'DB'>): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT i.id, i.token, i.name, i.mime, i.size, i.created_at, i.created_by, ' +
    '(SELECT COUNT(*) FROM card_image ci WHERE ci.image_id = i.id) AS used_by ' +
    'FROM image i ORDER BY i.id',
  ).all<Record<string, unknown>>()
  return json(results)
}

// ---- Admin image upload ----

async function uploadImage(
  request: Request,
  env: Pick<Env, 'DB'>,
  email: string,
): Promise<Response> {
  // Parse and validate Content-Type (exact match, strip params, case-insensitive)
  const rawCt = request.headers.get('Content-Type') ?? ''
  const mime = rawCt.split(';')[0].trim().toLowerCase()
  if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') {
    throw new HttpError('bad_request')
  }

  // Validate name
  const rawName = new URL(request.url).searchParams.get('name') ?? ''
  const name = rawName.trim()
  if (name.length === 0 || name.length > 80) throw new HttpError('bad_request')
  // Reject control characters
  if (/[\x00-\x1f\x7f]/.test(name)) throw new HttpError('bad_request')

  // Read bytes (early-rejects on Content-Length > limit, also counts bytes read)
  const bytes = await readBytes(request, MAX_IMAGE_BYTES)
  if (bytes.length === 0) throw new HttpError('bad_request')

  // Magic bytes check
  if (!magicOk(mime, bytes)) throw new HttpError('bad_request')

  // Dimension check and Exif rejection
  const dimResult = checkDimensions(mime, bytes)
  if (dimResult === null) throw new HttpError('bad_request')  // truncated / unparseable
  if (dimResult === 'exif') throw new HttpError('bad_request')  // Exif found
  const { w, h } = dimResult
  if (w > MAX_DIM || h > MAX_DIM || w * h > MAX_PIXELS) throw new HttpError('bad_request')

  // base64-encode for D1 TEXT storage
  // SHORTCUT: base64 in D1 TEXT — R2 upgrade path noted in decodeBase64 above
  let b64: string
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(bytes).toString('base64')
  } else {
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    b64 = btoa(bin)
  }

  const tok = newToken()
  const now = new Date().toISOString()
  const size = bytes.length

  // Atomic INSERT with count and total-bytes cap
  const result = await env.DB
    .prepare(
      'INSERT INTO image (token, name, mime, size, data, created_at, created_by) ' +
      'SELECT ?, ?, ?, ?, ?, ?, ? ' +
      'WHERE (SELECT COUNT(*) FROM image) < ? ' +
      '  AND (SELECT COALESCE(SUM(size), 0) FROM image) + ? <= ?',
    )
    .bind(tok, name, mime, size, b64, now, email, MAX_IMAGE_COUNT, size, MAX_IMAGE_TOTAL)
    .run()

  if (result.meta.changes === 0) throw new HttpError('conflict')

  // Fetch and return the new row (without data)
  const row = await env.DB
    .prepare('SELECT id, token, name, mime, size, created_at, created_by FROM image WHERE token = ?')
    .bind(tok)
    .first<Record<string, unknown>>()
  return json(row)
}

// ---- Admin image delete ----

async function deleteImage(env: Pick<Env, 'DB'>, id: number): Promise<Response> {
  // Check exists first
  const existing = await env.DB.prepare('SELECT id FROM image WHERE id = ?').bind(id).first()
  if (!existing) return error('not_found')

  // Try delete; FK RESTRICT on card_image.image_id will throw if in use
  try {
    const result = await env.DB.prepare('DELETE FROM image WHERE id = ?').bind(id).run()
    if (result.meta.changes === 0) return error('not_found')
    return json({ success: true })
  } catch (e) {
    // FK constraint violated → image is in use
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('FOREIGN KEY constraint failed') || msg.includes('RESTRICT')) {
      return error('conflict')
    }
    throw e
  }
}

/**
 * Routes GET/POST/DELETE for /api/admin/images and /api/admin/images/:id.
 * Auth is handled upstream by requireAdmin; email is the authenticated identity.
 */
export async function handleImages(
  request: Request,
  env: Pick<Env, 'DB'>,
  email: string,
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const { method } = request
  const parts = pathname.split('/').filter(Boolean)
  // ['api', 'admin', 'images']        — list / upload
  // ['api', 'admin', 'images', ':id'] — delete

  try {
    if (parts.length === 3 && parts[2] === 'images') {
      if (method === 'GET') return await listImages(env)
      if (method === 'POST') return await uploadImage(request, env, email)
      return error('method')
    }

    if (parts.length === 4 && parts[2] === 'images') {
      const id = parseId(parts[3] ?? '')
      if (id === null) return error('bad_request')
      if (method === 'DELETE') return await deleteImage(env, id)
      return error('method')
    }

    return error('not_found')
  } catch (e) {
    if (e instanceof HttpError) return error(e.code)
    throw e
  }
}

/**
 * GET /api/image/:token — public image endpoint.
 * Order: IMAGE_IP_LIMIT → token check → Cache API → ensureSchema → DB → response.
 * Never echoes the image name in response headers. Only 200s are cached.
 */
export async function handlePublicImage(
  request: Request,
  env: Pick<Env, 'DB' | 'IMAGE_IP_LIMIT'> & { _caches?: CacheStore },
): Promise<Response> {
  if (request.method !== 'GET') return error('method')

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  // 1. Rate limit — always first
  const { success } = await env.IMAGE_IP_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  // 2. Token validation — no DB for malformed tokens
  // Exactly /api/image/<token>: extra segments would otherwise alias the same image under many URLs.
  const segments = new URL(request.url).pathname.split('/')
  const token = segments.length === 4 ? segments[3] ?? '' : ''
  if (!isToken(token)) return error('not_found')

  // 3. Cache API check (before ensureSchema; cache hit skips DB entirely)
  const cacheKey = new URL(`/api/image/${token}`, request.url).toString()
  const cache = getCache(env)
  if (cache) {
    const cached = await cache.match(cacheKey)
    if (cached) return cached
  }

  // 4. ensureSchema then DB query
  await ensureSchema(env.DB)

  const row = await env.DB
    .prepare('SELECT mime, data FROM image WHERE token = ?')
    .bind(token)
    .first<{ mime: string; data: string }>()

  if (!row) return error('not_found')

  // 5. Decode base64 and build response
  const imageBytes = decodeBase64(row.data)

  const resp = new Response(imageBytes.buffer as ArrayBuffer, {
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

  // 6. Cache the 200 response (only 200s; 404s are never cached)
  if (cache) {
    cache.put(cacheKey, resp.clone()).catch(() => {})
  }

  return resp
}
