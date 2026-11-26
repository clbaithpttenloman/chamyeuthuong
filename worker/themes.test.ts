// @vitest-environment node
/**
 * Theme slot storage and API (Phase 3, ADR-6, FR-14..FR-18).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { handleThemes, handleThemeImage, THEME_CAMPAIGN_CAP } from './themes.ts'
import { testDb, type D1 } from './testDb.ts'
import { handleCampaigns } from './campaigns.ts'
import { METADATA_MESSAGE } from './themeInspect.ts'
import { seedGiftCampaign } from './testGift.ts'

const AUTH = { userId: 1, actor: 'user:test-admin' }
/** Public-serve limiter that always admits; the limit itself is tested separately. */
const OPEN = { IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) } }

function png(w: number, h: number, colourType = 6): Uint8Array<ArrayBuffer> {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const chunk = (t: string, d: number[]) => [...u32(d.length), ...[...t].map((c) => c.charCodeAt(0)), ...d, 0, 0, 0, 0]
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...u32(w), ...u32(h), 8, colourType, 0, 0, 0]),
    ...chunk('IDAT', [0x78, 0x9c, 0x63, 0x00]),
    ...chunk('IEND', []),
  ])
}

function upload(slot: string, campaignId: number, bytes: Uint8Array<ArrayBuffer>, mime = 'image/png'): Request {
  return new Request(`https://x/api/admin/campaigns/${campaignId}/theme/${slot}`, {
    method: 'POST',
    headers: { 'Content-Type': mime, 'Content-Length': String(bytes.length), 'X-Requested-With': 'fetch' },
    body: bytes,
  })
}

let db: D1
let sqlite: ReturnType<typeof testDb>['sqlite']
let campaignId: number

beforeEach(async () => {
  ;({ db, sqlite } = testDb())
  campaignId = await seedGiftCampaign(db, { slug: 'noel-theme', settings: { heart_min_account_age_hours: 0 } })
})

describe('upload', () => {
  it('a valid 256×256 transparent PNG for star → 201 with a token; stored with the real size', async () => {
    const bytes = png(256, 256)
    const r = await handleThemes(upload('star', campaignId, bytes), { DB: db }, AUTH)
    expect(r.status).toBe(201)
    const body = await r.json() as { token: string; slot: string }
    expect(body.slot).toBe('star')
    expect(body.token).toMatch(/^[0-9a-f]{32}$/)
    const row = sqlite.prepare('SELECT size, width, height FROM theme_image WHERE token = ?').get(body.token) as { size: number; width: number; height: number }
    expect(row).toEqual({ size: bytes.length, width: 256, height: 256 })
  })

  it('wrong size → 400 naming the rule and the actual size (AC-7 format)', async () => {
    const r = await handleThemes(upload('star', campaignId, png(300, 280)), { DB: db }, AUTH)
    expect(r.status).toBe(400)
    const body = await r.json() as { errors: string[] }
    expect(body.errors.join(' ')).toContain('Kích thước phải 256×256 (ảnh của bạn 300×280)')
  })

  it('unknown slot → 400', async () => {
    const r = await handleThemes(upload('nope', campaignId, png(256, 256)), { DB: db }, AUTH)
    expect(r.status).toBe(400)
  })

  it('campaign that does not exist → 404', async () => {
    const r = await handleThemes(upload('star', 999, png(256, 256)), { DB: db }, AUTH)
    expect(r.status).toBe(404)
  })

  it('body larger than the slot maximum is refused before inspection (hard cap)', async () => {
    const r = await handleThemes(upload('star', campaignId, new Uint8Array(400 * 1024)), { DB: db }, AUTH)
    expect(r.status).toBe(413)
  })

  it('replacing a slot deletes the old image in the same batch (no orphan rows)', async () => {
    const first = await (await handleThemes(upload('star', campaignId, png(256, 256)), { DB: db }, AUTH)).json() as { token: string }
    const second = await (await handleThemes(upload('star', campaignId, png(256, 256)), { DB: db }, AUTH)).json() as { token: string }
    const rows = sqlite.prepare("SELECT token FROM theme_image WHERE campaign_id = ? AND slot = 'star'").all(campaignId) as { token: string }[]
    expect(rows.map((x) => x.token)).toEqual([second.token])
    expect(first.token).not.toBe(second.token)
  })

  it('a PNG with a text chunk is refused with the metadata message', async () => {
    const withText = png(256, 256, 6)
    const data = [...new TextEncoder().encode('GPS'), 0, 1]
    const extra = [0, 0, 0, data.length, ...new TextEncoder().encode('tEXt'), ...data, 0, 0, 0, 0]
    const bytes = new Uint8Array([...withText.slice(0, withText.length - 12), ...extra, ...withText.slice(withText.length - 12)])
    const r = await handleThemes(upload('star', campaignId, bytes), { DB: db }, AUTH)
    expect(r.status).toBe(400)
    expect((await r.json() as { errors: string[] }).errors).toEqual([METADATA_MESSAGE])
  })

  it('the per-campaign total is enforced inside the insert (refuse when it would exceed the cap)', async () => {
    // Fill the other slots' total close to the cap by direct insert, then upload that does not fit.
    // Rows obey the per-row size CHECK (1 MB), so the filler is split across several rows.
    const insertFiller = sqlite.prepare(
      "INSERT INTO theme_image (campaign_id, slot, token, mime, size, width, height, data, created_at, created_by) VALUES (?, 'tree', ?, 'image/png', ?, 1, 1, 'AAAA', 'now', 'test')",
    )
    let remaining = THEME_CAMPAIGN_CAP - 10
    for (let i = 0; remaining > 0; i++) {
      const size = Math.min(remaining, 1048576)
      insertFiller.run(campaignId, i.toString(16).padStart(32, '0'), size)
      remaining -= size
    }
    const r = await handleThemes(upload('star', campaignId, png(256, 256)), { DB: db }, AUTH)
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_limit')
  })
})

describe('animated slots', () => {
  function uploadWith(slot: string, query: string, bytes: Uint8Array<ArrayBuffer>, mime: string): Request {
    return new Request(`https://x/api/admin/campaigns/${campaignId}/theme/${slot}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': mime, 'Content-Length': String(bytes.length), 'X-Requested-With': 'fetch' },
      body: bytes,
    })
  }

  it('a sprite sheet without fps → 400 asking for the speed', async () => {
    const r = await handleThemes(uploadWith('box_1_open', '', png(1024, 1536), 'image/png'), { DB: db }, AUTH)
    expect(r.status).toBe(400)
    expect((await r.json() as { errors: string[] }).errors.join(' ')).toContain('Khai báo tốc độ từ 12 đến 30')
  })

  it('a 2×3 sprite sheet with ?fps=24 → 201 with 6 frames and fps 24, shown in the campaign map', async () => {
    const r = await handleThemes(uploadWith('box_1_open', '?fps=24', png(1024, 1536), 'image/png'), { DB: db }, AUTH)
    expect(r.status).toBe(201)
    expect(await r.json()).toMatchObject({ slot: 'box_1_open', frames: 6, fps: 24 })
    const map = await (await handleThemes(new Request(`https://x/api/admin/campaigns/${campaignId}/theme`), { DB: db }, AUTH)).json() as { theme: Record<string, { frames: number; fps: number; cols: number; rows: number }> }
    expect(map.theme.box_1_open).toMatchObject({ frames: 6, fps: 24, cols: 2, rows: 3 })
  })

  it('a two-frame 256×256 GIF for the star slot → 201, stored with frames 2 and no fps', async () => {
    // Each frame: graphic control with the transparency bit (star must be transparent), then the image.
    const frame = [0x21, 0xf9, 4, 1, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 0x00, 0x01, 0x00, 0x01, 0x00, 2, 2, 0x4c, 0x01, 0]
    const gif = new Uint8Array([
      ...new TextEncoder().encode('GIF89a'), 0x00, 0x01, 0x00, 0x01, 0x00, 0, 0,
      0x21, 0xff, 11, ...new TextEncoder().encode('NETSCAPE2.0'), 3, 1, 0, 0, 0,
      ...frame, ...frame,
      0x3b,
    ])
    const r = await handleThemes(uploadWith('star', '', gif, 'image/gif'), { DB: db }, AUTH)
    expect(r.status).toBe(201)
    expect(await r.json()).toMatchObject({ slot: 'star', mime: 'image/gif', frames: 2, fps: null })
  })

  it('?fps is ignored for non-sprite slots', async () => {
    const r = await handleThemes(uploadWith('star', '?fps=24', png(256, 256), 'image/png'), { DB: db }, AUTH)
    expect(r.status).toBe(201)
    expect(await r.json()).toMatchObject({ frames: 1, fps: null })
  })
})

describe('reset to default', () => {
  it('DELETE removes the slot image; the slot is then default again', async () => {
    await handleThemes(upload('star', campaignId, png(256, 256)), { DB: db }, AUTH)
    const r = await handleThemes(new Request(`https://x/api/admin/campaigns/${campaignId}/theme/star`, { method: 'DELETE', headers: { 'X-Requested-With': 'fetch' } }), { DB: db }, AUTH)
    expect(r.status).toBe(204)
    const count = sqlite.prepare("SELECT COUNT(*) AS c FROM theme_image WHERE slot = 'star'").get() as { c: number }
    expect(count.c).toBe(0)
  })
})

describe('serve limits and caching', () => {
  it('rate-limited client → 429 before any lookup', async () => {
    const r = await handleThemeImage(
      new Request('https://x/api/theme-image/0123456789abcdef0123456789abcdef', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      { DB: db, IMAGE_IP_LIMIT: { limit: async () => ({ success: false }) } },
    )
    expect(r.status).toBe(429)
  })

  it('non-GET → 405', async () => {
    const r = await handleThemeImage(new Request('https://x/api/theme-image/0123456789abcdef0123456789abcdef', { method: 'POST' }), { DB: db, ...OPEN })
    expect(r.status).toBe(405)
  })

  it('a cached 200 is returned without a D1 read (cache hit short-circuits)', async () => {
    const cache = new Map<string, Response>()
    const store = { default: {
      match: async (req: Request | string) => cache.get(typeof req === 'string' ? req : req.url)?.clone(),
      put: async (req: Request | string, resp: Response) => { cache.set(typeof req === 'string' ? req : req.url, resp) },
    } }
    const token = '0123456789abcdef0123456789abcdef'
    cache.set(`https://x/api/theme-image/${token}`, new Response('from-cache', { status: 200 }))
    const r = await handleThemeImage(new Request(`https://x/api/theme-image/${token}`), { DB: db, ...OPEN, _caches: store })
    expect(await r.text()).toBe('from-cache')
  })

  it('a 200 is written to the cache; 404 is not', async () => {
    const puts: string[] = []
    const store = { default: {
      match: async () => undefined,
      put: async (req: Request | string) => { puts.push(typeof req === 'string' ? req : req.url) },
    } }
    const body = await (await handleThemes(upload('star', campaignId, png(256, 256)), { DB: db }, AUTH)).json() as { token: string }
    await handleThemeImage(new Request(`https://x/api/theme-image/${body.token}`), { DB: db, ...OPEN, _caches: store })
    await handleThemeImage(new Request('https://x/api/theme-image/0123456789abcdef0123456789abcdef'), { DB: db, ...OPEN, _caches: store })
    expect(puts).toEqual([`https://x/api/theme-image/${body.token}`])
  })
})

describe('serve', () => {
  it('GET /api/theme-image/<token> returns the stored bytes, MIME and immutable caching', async () => {
    const bytes = png(256, 256)
    const body = await (await handleThemes(upload('star', campaignId, bytes), { DB: db }, AUTH)).json() as { token: string }
    const r = await handleThemeImage(new Request(`https://x/api/theme-image/${body.token}`), { DB: db, ...OPEN })
    expect(r.status).toBe(200)
    expect(r.headers.get('Content-Type')).toBe('image/png')
    expect(r.headers.get('Cache-Control')).toContain('immutable')
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox")
    expect(r.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes)
  })

  it('unknown token → 404', async () => {
    const r = await handleThemeImage(new Request('https://x/api/theme-image/0123456789abcdef0123456789abcdef'), { DB: db, ...OPEN })
    expect(r.status).toBe(404)
  })

  it('malformed token → 404 (no lookup)', async () => {
    const r = await handleThemeImage(new Request('https://x/api/theme-image/../../etc'), { DB: db, ...OPEN })
    expect(r.status).toBe(404)
  })
})

describe('admin theme list', () => {
  it('GET /api/admin/campaigns/<id>/theme lists uploaded slots, including for a draft campaign', async () => {
    const body = await (await handleThemes(upload('tree', campaignId, png(1200, 1600)), { DB: db }, AUTH)).json() as { token: string }
    const r = await handleThemes(new Request(`https://x/api/admin/campaigns/${campaignId}/theme`), { DB: db }, AUTH)
    expect(r.status).toBe(200)
    expect((await r.json() as { theme: Record<string, unknown> }).theme).toEqual({ tree: { url: `/api/theme-image/${body.token}`, frames: 1, fps: null, cols: 1, rows: 1 } })
  })
})

describe('campaign read carries the theme map', () => {
  it('GET /api/campaigns/<slug> lists each uploaded slot as /api/theme-image/<token>', async () => {
    const body = await (await handleThemes(upload('star', campaignId, png(256, 256)), { DB: db }, AUTH)).json() as { token: string }
    const r = await handleCampaigns(new Request('https://x/api/campaigns/noel-theme'), { DB: db })
    expect(r.status).toBe(200)
    const campaign = await r.json() as { theme: Record<string, unknown> }
    expect(campaign.theme).toEqual({ star: { url: `/api/theme-image/${body.token}`, frames: 1, fps: null, cols: 1, rows: 1 } })
  })
})
