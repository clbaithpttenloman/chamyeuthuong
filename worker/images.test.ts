// @vitest-environment node
/**
 * Tests for worker/images.ts
 * Failing until Group 2 creates worker/images.ts.
 *
 * Contracts expected:
 *   handleImages(request, env, email): Promise<Response>
 *     — routes GET/POST/DELETE for /api/admin/images and /api/admin/images/:id
 *   handlePublicImage(request, env): Promise<Response>
 *     — handles GET /api/image/:token
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./token.ts', () => ({
  newToken: vi.fn(() => 'generatedtoken1234'),
  isToken: (t: string) => /^[a-z0-9]{16}$/.test(t),
}))

// These imports fail until images.ts is created → all tests in this file fail
import { handleImages, handlePublicImage } from './images.ts'
import { testDb, type D1 } from './testDb.ts'
import { TEST_EMAIL } from './testAuth.ts'
import { newToken } from './token.ts'

// ---- Minimal real image byte-array fixtures ----

/** PNG: magic signature + IHDR with controllable width × height. */
function makePNG(w = 1, h = 1): Uint8Array {
  const b = new Uint8Array(45)
  // Signature
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  // IHDR length (13)
  b.set([0x00, 0x00, 0x00, 0x0d], 8)
  // IHDR type
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  // Width (big-endian uint32)
  b[16] = (w >>> 24) & 0xff; b[17] = (w >>> 16) & 0xff; b[18] = (w >>> 8) & 0xff; b[19] = w & 0xff
  // Height (big-endian uint32)
  b[20] = (h >>> 24) & 0xff; b[21] = (h >>> 16) & 0xff; b[22] = (h >>> 8) & 0xff; b[23] = h & 0xff
  // Bit depth 8, colour type 2 (RGB), compression 0, filter 0, interlace 0
  b.set([0x08, 0x02, 0x00, 0x00, 0x00], 24)
  // IHDR CRC placeholder (not validated in parser)
  b.set([0x00, 0x00, 0x00, 0x00], 29)
  // IEND chunk: length 0, type, CRC
  b.set([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], 33)
  return b
}

/** JPEG: SOI + SOF0 marker with controllable width × height + EOI. */
function makeJPEG(w = 1, h = 1): Uint8Array {
  const b = new Uint8Array(17)
  b[0] = 0xff; b[1] = 0xd8                           // SOI
  b[2] = 0xff; b[3] = 0xc0                           // SOF0
  b[4] = 0x00; b[5] = 0x0b                           // length = 11
  b[6] = 0x08                                         // precision
  b[7] = (h >>> 8) & 0xff; b[8] = h & 0xff           // height
  b[9] = (w >>> 8) & 0xff; b[10] = w & 0xff          // width
  b[11] = 0x01                                        // ncomponents
  b[12] = 0x01; b[13] = 0x11; b[14] = 0x00           // component data
  b[15] = 0xff; b[16] = 0xd9                          // EOI
  return b
}

/** WebP (VP8X): RIFF header + VP8X chunk with controllable canvas size. */
function makeWebP(w = 1, h = 1): Uint8Array {
  const b = new Uint8Array(30)
  b.set([0x52, 0x49, 0x46, 0x46], 0)   // "RIFF"
  b.set([0x16, 0x00, 0x00, 0x00], 4)   // file size − 8 = 22
  b.set([0x57, 0x45, 0x42, 0x50], 8)   // "WEBP"
  b.set([0x56, 0x50, 0x38, 0x58], 12)  // "VP8X"
  b.set([0x0a, 0x00, 0x00, 0x00], 16)  // VP8X chunk size = 10
  b.set([0x00, 0x00, 0x00, 0x00], 20)  // flags
  const wm1 = w - 1; b[24] = wm1 & 0xff; b[25] = (wm1 >> 8) & 0xff; b[26] = (wm1 >> 16) & 0xff
  const hm1 = h - 1; b[27] = hm1 & 0xff; b[28] = (hm1 >> 8) & 0xff; b[29] = (hm1 >> 16) & 0xff
  return b
}

/** GIF87a magic bytes. */
function makeGIF(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
}

/** SVG bytes (starts with '<svg'). */
function makeSVG(): Uint8Array {
  return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
}

/** PNG bytes with an eXIf chunk inserted after IHDR. */
function makePNGWithExif(w = 1, h = 1): Uint8Array {
  const ihdr = makePNG(w, h)
  // Insert a minimal eXIf chunk at byte 33 (after IHDR's CRC at bytes 29-32)
  const exifType = [0x65, 0x58, 0x49, 0x66] // "eXIf"
  const exifData = [0x00, 0x00, 0x00, 0x00]
  // chunk: length(4) + type(4) + data(4) + CRC(4) = 16 bytes
  const exifChunk = new Uint8Array([0x00, 0x00, 0x00, 0x04, ...exifType, ...exifData, 0x00, 0x00, 0x00, 0x00])
  const out = new Uint8Array(ihdr.length + exifChunk.length)
  out.set(ihdr.slice(0, 33), 0)
  out.set(exifChunk, 33)
  out.set(ihdr.slice(33), 33 + exifChunk.length)
  return out
}

/** JPEG bytes with an APP1 Exif segment after SOI. */
function makeJPEGWithExif(w = 1, h = 1): Uint8Array {
  const soiAndSof = makeJPEG(w, h)
  // APP1 Exif segment: FF E1 + length (10) + "Exif\0\0" (6 bytes) + 2 bytes padding
  const app1 = new Uint8Array([
    0xff, 0xe1,       // APP1 marker
    0x00, 0x0a,       // length = 10 (includes these 2 bytes)
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x00, 0x00,       // padding
  ])
  const out = new Uint8Array(2 + app1.length + soiAndSof.length - 2)
  out.set(soiAndSof.slice(0, 2), 0)   // FF D8 (SOI)
  out.set(app1, 2)                     // APP1 Exif
  out.set(soiAndSof.slice(2), 2 + app1.length)  // rest of JPEG
  return out
}

/** WebP bytes with an EXIF chunk. */
function makeWebPWithExif(w = 1, h = 1): Uint8Array {
  const base = makeWebP(w, h)
  // EXIF chunk: "EXIF" + length (4) + placeholder data (4)
  const exifChunk = new Uint8Array([
    0x45, 0x58, 0x49, 0x46,  // "EXIF"
    0x04, 0x00, 0x00, 0x00,  // size = 4
    0x00, 0x00, 0x00, 0x00,  // data
  ])
  // Set EXIF flag in VP8X (byte 20, flags)
  const out = new Uint8Array(base.length + exifChunk.length)
  out.set(base, 0)
  out[20] = 0x08  // EXIF flag in VP8X flags
  out.set(exifChunk, base.length)
  // Update RIFF file size
  const newSize = out.length - 8
  out[4] = newSize & 0xff; out[5] = (newSize >> 8) & 0xff
  out[6] = (newSize >> 16) & 0xff; out[7] = (newSize >> 24) & 0xff
  return out
}

/** Pad a byte array to `size` bytes (or return a fresh array of that size). */
function pad(b: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size)
  out.set(b.slice(0, Math.min(b.length, size)), 0)
  return out
}

// ---- Env builders ----

function makeEnv(db: D1, opts: { imageIpLimit?: boolean; adminFailLimit?: boolean } = {}) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: opts.adminFailLimit ?? true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: opts.imageIpLimit ?? true }) },
    BOOTSTRAP_EMAIL: undefined as string | undefined,
    ALLOW_FIRST_CLAIM: undefined as string | undefined,
  }
}

// ---- Admin image request builder ----

function imageReq(
  method: string,
  path: string,
  body?: Uint8Array | null,
  contentType?: string,
): Request {
  const headers: Record<string, string> = {
    'X-Admin-Email': TEST_EMAIL,
    'CF-Connecting-IP': '1.2.3.4',
  }
  if (method !== 'GET') headers['X-Requested-With'] = 'fetch'
  if (contentType) headers['Content-Type'] = contentType
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: (body ?? undefined) as BodyInit | undefined,
  })
}

let db: D1
let tokenSeq = 0

beforeEach(async () => {
  ;({ db } = testDb())
  tokenSeq = 0
  vi.mocked(newToken).mockImplementation(() => {
    const t = `img${String(tokenSeq++).padStart(13, '0')}`
    return t
  })
  // Seed admin for auth
  const now = new Date().toISOString()
  await db
    .prepare('INSERT INTO admin (email, created_at, created_by) VALUES (?, ?, ?)')
    .bind(TEST_EMAIL, now, 'test-seed')
    .run()
})

// ===================================================================
// Admin image upload — happy paths
// ===================================================================

describe('POST /api/admin/images — happy paths', () => {
  it('uploads a minimal JPEG and returns metadata row (no data field)', async () => {
    const bytes = makeJPEG(10, 10)
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=test.jpg', bytes, 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    expect(body.name).toBe('test.jpg')
    expect(body.mime).toBe('image/jpeg')
    expect(body.size).toBe(bytes.byteLength)
    expect(typeof body.token).toBe('string')
    expect(body.token).toMatch(/^[a-z0-9]{16}$/)
    expect(body).not.toHaveProperty('data')
  })

  it('uploads a minimal PNG and returns 200', async () => {
    const bytes = makePNG(10, 10)
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=test.png', bytes, 'image/png'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { mime: string }).mime).toBe('image/png')
  })

  it('uploads a minimal WebP and returns 200', async () => {
    const bytes = makeWebP(10, 10)
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=test.webp', bytes, 'image/webp'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { mime: string }).mime).toBe('image/webp')
  })

  it('stores created_by as the caller email', async () => {
    const bytes = makeJPEG()
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=x.jpg', bytes, 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { created_by: string }
    expect(body.created_by).toBe(TEST_EMAIL)
  })
})

// ===================================================================
// Admin image upload — validation errors
// ===================================================================

describe('POST /api/admin/images — type/magic validation', () => {
  it('wrong declared Content-Type with correct magic bytes → 400', async () => {
    // PNG bytes but declared as image/jpeg
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=x.jpg', makePNG(), 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('JPEG magic bytes but declared as image/png → 400', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=x.png', makeJPEG(), 'image/png'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('SVG body → 400 (not a raster type)', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=x.svg', makeSVG(), 'image/svg+xml'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('GIF body → 400 (not a raster type)', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=x.gif', makeGIF(), 'image/gif'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('empty body → 400', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=x.png', new Uint8Array(0), 'image/png'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('missing Content-Type → 400', async () => {
    const r = await handleImages(
      new Request('https://x/api/admin/images?name=x.jpg', {
        method: 'POST',
        headers: {
          'X-Admin-Email': TEST_EMAIL,
          'CF-Connecting-IP': '1.2.3.4',
          'X-Requested-With': 'fetch',
        },
        body: makeJPEG() as unknown as BodyInit,
      }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })
})

describe('POST /api/admin/images — size limit (counted on bytes read)', () => {
  it('body > 307200 bytes → 400 bad_request', async () => {
    // Build an oversized payload: PNG magic + padding to 307201 bytes
    const oversized = pad(makePNG(), 307201)
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=big.png', oversized, 'image/png'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('body > 307200 without Content-Length header → 400 (counted on bytes read)', async () => {
    const oversized = pad(makePNG(), 307201)
    const stream = new ReadableStream({
      start(c) { c.enqueue(oversized); c.close() },
    })
    const r = await handleImages(
      new Request('https://x/api/admin/images?name=big.png', {
        method: 'POST',
        headers: {
          'X-Admin-Email': TEST_EMAIL,
          'CF-Connecting-IP': '1.2.3.4',
          'X-Requested-With': 'fetch',
          'Content-Type': 'image/png',
        },
        body: stream,
        duplex: 'half',
      } as RequestInit),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })
})

describe('POST /api/admin/images — name validation', () => {
  it('name > 80 chars → 400', async () => {
    const longName = 'a'.repeat(81) + '.jpg'
    const r = await handleImages(
      imageReq('POST', `/api/admin/images?name=${longName}`, makeJPEG(), 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('empty name → 400', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=', makeJPEG(), 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('name with control character (\\x01) → 400', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=bad%01name.jpg', makeJPEG(), 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('name is trimmed before storage', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=+hello.jpg', makeJPEG(), 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    // name should be trimmed (URL-decoded space at start stripped)
    const body = await r.json() as { name: string }
    expect(body.name).not.toMatch(/^\s/)
  })
})

// ===================================================================
// Admin image upload — quota caps (atomic)
// ===================================================================

describe('POST /api/admin/images — 200-image cap (failing until Group 2)', () => {
  it('201st image upload → 409 conflict', async () => {
    // Seed 200 image rows directly
    for (let i = 0; i < 200; i++) {
      const tok = `img${String(i).padStart(13, '0')}`
      await db
        .prepare(
          "INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)",
        )
        .bind(tok, `img${i}.jpg`, 'image/jpeg', 100, 'data', new Date().toISOString(), TEST_EMAIL)
        .run()
    }
    vi.mocked(newToken).mockReturnValue('img0000000000200')
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=extra.jpg', makeJPEG(), 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('conflict')
  })

  it('total-bytes cap (> 40 MB) → 409 conflict', async () => {
    // Seed rows (each within the per-row size CHECK) whose sizes sum exactly to the 40 MB total limit,
    // so any further upload must be refused. 139 x 300000 + 243040 = 41943040.
    const sizes = [...Array(139).fill(300000), 243040]
    for (let i = 0; i < sizes.length; i++) {
      await db
        .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
        .bind(`big${String(i).padStart(13, '0')}`, `big${i}.jpg`, 'image/jpeg', sizes[i], 'data', new Date().toISOString(), TEST_EMAIL)
        .run()
    }
    vi.mocked(newToken).mockReturnValue('img0000000000001')
    // Upload a 10-byte image (total would exceed 40 MB)
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=small.jpg', makeJPEG(), 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('conflict')
  })

  it('concurrent uploads at 199 images → exactly one succeeds, one gets 409', async () => {
    // Seed 199 images
    for (let i = 0; i < 199; i++) {
      const tok = `img${String(i).padStart(13, '0')}`
      await db
        .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
        .bind(tok, `img${i}.jpg`, 'image/jpeg', 100, 'data', new Date().toISOString(), TEST_EMAIL)
        .run()
    }
    vi.mocked(newToken)
      .mockReturnValueOnce('img0000000000199')
      .mockReturnValueOnce('img0000000000200')

    const env = makeEnv(db)
    const [r1, r2] = await Promise.all([
      handleImages(imageReq('POST', '/api/admin/images?name=a.jpg', makeJPEG(), 'image/jpeg'), env, TEST_EMAIL),
      handleImages(imageReq('POST', '/api/admin/images?name=b.jpg', makeJPEG(), 'image/jpeg'), env, TEST_EMAIL),
    ])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 409])
  })
})

// ===================================================================
// Admin image upload — pixel dimension caps (Amendments W1)
// ===================================================================

describe('POST /api/admin/images — pixel dimension caps', () => {
  it('PNG with width = 4097 → 400 bad_request', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=w.png', pad(makePNG(4097, 1), 1000), 'image/png'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('PNG with height = 4097 → 400 bad_request', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=h.png', pad(makePNG(1, 4097), 1000), 'image/png'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('PNG with w×h > 8_000_000 → 400 bad_request', async () => {
    // 2000×4001 = 8_002_000 > 8_000_000
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=mp.png', pad(makePNG(2000, 4001), 2000), 'image/png'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('JPEG with width = 4097 → 400 bad_request', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=w.jpg', pad(makeJPEG(4097, 1), 200), 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('JPEG with height = 4097 → 400 bad_request', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=h.jpg', pad(makeJPEG(1, 4097), 200), 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('WebP with width = 4097 → 400 bad_request', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=w.webp', pad(makeWebP(4097, 1), 200), 'image/webp'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('WebP with height = 4097 → 400 bad_request', async () => {
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=h.webp', pad(makeWebP(1, 4097), 200), 'image/webp'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('truncated PNG header (< 24 bytes) → 400 bad_request', async () => {
    const truncated = makePNG().slice(0, 20)  // cuts off before height bytes end
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=trunc.png', truncated, 'image/png'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('truncated JPEG — no SOF marker found → 400 bad_request', async () => {
    const truncated = new Uint8Array([0xff, 0xd8])  // only SOI
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=trunc.jpg', truncated, 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })
})

// ===================================================================
// Admin image upload — Exif rejection (Amendments cycle 2)
// ===================================================================

describe('POST /api/admin/images — Exif rejection', () => {
  it('JPEG with APP1 Exif segment → 400 bad_request (privacy)', async () => {
    const bytes = pad(makeJPEGWithExif(10, 10), 200)
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=exif.jpg', bytes, 'image/jpeg'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('PNG with eXIf chunk → 400 bad_request', async () => {
    const bytes = makePNGWithExif(10, 10)
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=exif.png', bytes, 'image/png'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('WebP with EXIF chunk → 400 bad_request', async () => {
    const bytes = makeWebPWithExif(10, 10)
    const r = await handleImages(
      imageReq('POST', '/api/admin/images?name=exif.webp', bytes, 'image/webp'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })
})

// ===================================================================
// Admin image list (GET /api/admin/images)
// ===================================================================

describe('GET /api/admin/images — list', () => {
  it('returns empty array when no images exist', async () => {
    const r = await handleImages(imageReq('GET', '/api/admin/images'), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('list excludes the data field', async () => {
    // Seed an image row
    await db
      .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
      .bind('imgabc1234567890', 'x.jpg', 'image/jpeg', 100, 'base64data', new Date().toISOString(), TEST_EMAIL)
      .run()
    const r = await handleImages(imageReq('GET', '/api/admin/images'), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(200)
    const list = await r.json() as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('data')
    expect(list[0]).toHaveProperty('token')
    expect(list[0]).toHaveProperty('name')
    expect(list[0]).toHaveProperty('mime')
    expect(list[0]).toHaveProperty('size')
  })

  it('list includes used_by count (0 when no card uses it)', async () => {
    await db
      .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
      .bind('imgabc1234567890', 'x.jpg', 'image/jpeg', 100, 'data', new Date().toISOString(), TEST_EMAIL)
      .run()
    const r = await handleImages(imageReq('GET', '/api/admin/images'), makeEnv(db), TEST_EMAIL)
    const list = await r.json() as Array<{ used_by: number }>
    expect(typeof list[0].used_by).toBe('number')
    expect(list[0].used_by).toBe(0)
  })
})

// ===================================================================
// Admin image delete (DELETE /api/admin/images/:id)
// ===================================================================

describe('DELETE /api/admin/images/:id', () => {
  it('deleting an unused image → 200', async () => {
    await db
      .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
      .bind('imgabc1234567890', 'x.jpg', 'image/jpeg', 100, 'data', new Date().toISOString(), TEST_EMAIL)
      .run()
    const row = await db.prepare('SELECT id FROM image WHERE token=?').bind('imgabc1234567890').first<{ id: number }>()
    const r = await handleImages(
      imageReq('DELETE', `/api/admin/images/${row!.id}`),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    // Row gone from DB
    expect(await db.prepare('SELECT id FROM image WHERE token=?').bind('imgabc1234567890').first()).toBeNull()
  })

  it('deleting an in-use image → 409 conflict', async () => {
    // Create teacher + card_image using the image
    const now = new Date().toISOString()
    await db.prepare("INSERT INTO teacher (token,name,subject,created_at) VALUES (?,?,?,?)")
      .bind('tok1234567890ab', 'T', '', now).run()
    const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind('tok1234567890ab').first<{ id: number }>())!.id
    await db.prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
      .bind('imgabc1234567890', 'x.jpg', 'image/jpeg', 100, 'data', now, TEST_EMAIL).run()
    const iid = (await db.prepare('SELECT id FROM image WHERE token=?').bind('imgabc1234567890').first<{ id: number }>())!.id
    await db.prepare("INSERT INTO card_image (teacher_id,slot,image_id) VALUES (?,?,?)").bind(tid, 'background', iid).run()

    const r = await handleImages(
      imageReq('DELETE', `/api/admin/images/${iid}`),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('conflict')
  })

  it('unknown image id → 404', async () => {
    const r = await handleImages(
      imageReq('DELETE', '/api/admin/images/999'),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(404)
  })
})

// ===================================================================
// Public image endpoint (GET /api/image/:token)
// ===================================================================

describe('GET /api/image/:token — public image', () => {
  it('unknown valid token → 404 JSON', async () => {
    const r = await handlePublicImage(
      new Request('https://x/api/image/unknowntoken1234', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })

  it('malformed token → 404 with zero DB statements', async () => {
    const { db: freshDb, state } = testDb()
    const r = await handlePublicImage(
      new Request('https://x/api/image/BAD!!', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(freshDb),
    )
    expect(r.status).toBe(404)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('valid token with matching image → byte-exact round trip', async () => {
    const original = makeJPEG(10, 10)
    const b64 = Buffer.from(original).toString('base64')
    const now = new Date().toISOString()
    await db
      .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
      .bind('imgabc1234567890', 'x.jpg', 'image/jpeg', original.byteLength, b64, now, TEST_EMAIL)
      .run()
    const r = await handlePublicImage(
      new Request('https://x/api/image/imgabc1234567890', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const buf = await r.arrayBuffer()
    expect(new Uint8Array(buf)).toEqual(original)
  })

  it('response headers: Content-Type, Cache-Control immutable, nosniff, CSP sandbox, CORP, noindex', async () => {
    const original = makeJPEG()
    const b64 = Buffer.from(original).toString('base64')
    const now = new Date().toISOString()
    await db
      .prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
      .bind('imgabc1234567890', 'x.jpg', 'image/jpeg', original.byteLength, b64, now, TEST_EMAIL)
      .run()
    const r = await handlePublicImage(
      new Request('https://x/api/image/imgabc1234567890', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    expect(r.headers.get('Content-Type')).toBe('image/jpeg')
    expect(r.headers.get('Cache-Control')).toContain('immutable')
    expect(r.headers.get('Cache-Control')).toContain('max-age=31536000')
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect(r.headers.get('Content-Security-Policy')).toContain('sandbox')
    expect(r.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex')
  })

  it('IMAGE_IP_LIMIT exhausted → 429 before any DB statement', async () => {
    const { db: freshDb, state } = testDb()
    const r = await handlePublicImage(
      new Request('https://x/api/image/imgabc1234567890', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(freshDb, { imageIpLimit: false }),
    )
    expect(r.status).toBe(429)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('Cache API hit skips the DB', async () => {
    const original = makeJPEG()
    const cachedResponse = new Response(original as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
    const { db: freshDb, state } = testDb()
    // Inject a mock Cache API
    const mockCaches = {
      default: {
        match: async (_req: unknown) => cachedResponse.clone(),
        put: async () => undefined,
      },
    }
    const r = await handlePublicImage(
      new Request('https://x/api/image/imgabc1234567890', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      { ...makeEnv(freshDb), _caches: mockCaches },
    )
    expect(r.status).toBe(200)
    // DB must not have been touched — cache served the response
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('404 response is never cached', async () => {
    let putCalled = false
    const mockCaches = {
      default: {
        match: async () => undefined,
        put: async () => { putCalled = true },
      },
    }
    const r = await handlePublicImage(
      new Request('https://x/api/image/unknowntoken1234', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      { ...makeEnv(db), _caches: mockCaches },
    )
    expect(r.status).toBe(404)
    expect(putCalled).toBe(false)
  })
})
