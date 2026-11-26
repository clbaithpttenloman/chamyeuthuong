// @vitest-environment node
/**
 * Theme upload inspection (Phase 3): real format, size, transparency and animation.
 * Fixtures are built byte by byte so each rule is tested on a known input.
 */
import { describe, it, expect } from 'vitest'
import { inspectTheme, METADATA_MESSAGE } from './themeInspect.ts'

function u32be(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
}
function u32le(n: number): number[] {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
}
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0))
}
function pngChunk(type: string, data: number[]): number[] {
  return [...u32be(data.length), ...ascii(type), ...data, 0, 0, 0, 0] // CRC not checked by the parser
}
function png(w: number, h: number, colourType: number, extra: number[][] = []): Uint8Array {
  const ihdr = [...u32be(w), ...u32be(h), 8, colourType, 0, 0, 0]
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', ihdr),
    ...extra.flat(),
    ...pngChunk('IDAT', [0x78, 0x9c, 0x63, 0x00]),
    ...pngChunk('IEND', []),
  ]
  return new Uint8Array(bytes)
}
/** VP8X extended WebP: flags byte at offset 20, canvas size minus one in 24-29. */
function webpVp8x(w: number, h: number, flags: number, extraChunks: number[] = []): Uint8Array {
  const canvas = [...u32le(w - 1).slice(0, 3), ...u32le(h - 1).slice(0, 3)]
  const body = [flags, 0, 0, 0, ...canvas]
  const chunks = [...ascii('VP8X'), ...u32le(10), ...body, ...extraChunks]
  return new Uint8Array([...ascii('RIFF'), ...u32le(4 + chunks.length), ...ascii('WEBP'), ...chunks])
}
/** Lossless VP8L (simple) WebP: alpha_is_used is bit 28 of the 32-bit header word. */
function webpVp8l(w: number, h: number, alpha: boolean): Uint8Array {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28)
  const payload = [0x2f, ...u32le(bits), 0, 0]
  const chunk = [...ascii('VP8L'), ...u32le(payload.length), ...payload]
  return new Uint8Array([...ascii('RIFF'), ...u32le(4 + chunk.length), ...ascii('WEBP'), ...chunk])
}
/** One ANMF frame chunk: offset (x/2, y/2) and the frame size. Duration and flags are zero. */
function anmf(x: number, y: number, w: number, h: number): number[] {
  const u24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255]
  const payload = [...u24(x / 2), ...u24(y / 2), ...u24(w - 1), ...u24(h - 1), 0, 0, 0, 0]
  return [...ascii('ANMF'), ...u32le(payload.length), ...payload]
}

/** GIF builder: one image descriptor per frame, optional transparency, comment, or extra application block. */
function gif(w: number, h: number, frames: Array<{ x?: number; y?: number; w: number; h: number }>, opts: { transparent?: boolean; comment?: boolean; app?: string } = {}): Uint8Array {
  const u16 = (n: number) => [n & 255, (n >> 8) & 255]
  const out: number[] = [...ascii('GIF89a'), ...u16(w), ...u16(h), 0x00, 0, 0]
  if (opts.app) out.push(0x21, 0xff, 11, ...ascii(opts.app.padEnd(11, ' ').slice(0, 11)), 3, 1, 0, 0, 0)
  if (opts.comment) out.push(0x21, 0xfe, 2, ...ascii('hi'), 0)
  for (const f of frames) {
    out.push(0x21, 0xf9, 4, opts.transparent ? 1 : 0, 0, 0, 0, 0)
    out.push(0x2c, ...u16(f.x ?? 0), ...u16(f.y ?? 0), ...u16(f.w), ...u16(f.h), 0x00)
    out.push(2, 2, 0x4c, 0x01, 0)
  }
  out.push(0x3b)
  return new Uint8Array(out)
}

/** Baseline JPEG header with a SOF0 segment (height then width). */
function jpeg(w: number, h: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255,
    0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xd9,
  ])
}

describe('PNG', () => {
  it('colour type 6 (RGBA) → alpha, not animated', () => {
    const r = inspectTheme('image/png', png(256, 256, 6))
    expect(r).toEqual({ ok: true, info: { mime: 'image/png', width: 256, height: 256, hasAlpha: true, animated: false, exif: false, frames: 1 } })
  })

  it('colour type 2 (RGB) without tRNS → no alpha', () => {
    const r = inspectTheme('image/png', png(1080, 1920, 2))
    expect(r.ok && r.info.hasAlpha).toBe(false)
  })

  it('colour type 2 with a tRNS chunk → alpha', () => {
    const r = inspectTheme('image/png', png(256, 256, 2, [pngChunk('tRNS', [0, 0, 0, 0, 0, 0])]))
    expect(r.ok && r.info.hasAlpha).toBe(true)
  })

  it('an acTL chunk (APNG) → animated', () => {
    const r = inspectTheme('image/png', png(256, 256, 6, [pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0])]))
    expect(r.ok && r.info.animated).toBe(true)
  })

  it('an eXIf chunk → metadata flagged (the caller refuses it)', () => {
    const r = inspectTheme('image/png', png(256, 256, 6, [pngChunk('eXIf', [1, 2, 3, 4])]))
    expect(r.ok && r.info.exif).toBe(true)
  })

  it('bytes that are not a PNG → error', () => {
    expect(inspectTheme('image/png', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).ok).toBe(false)
  })
})

describe('WebP', () => {
  it('VP8X with the alpha flag (0x10) → alpha; animation flag (0x02) clear → static', () => {
    const r = inspectTheme('image/webp', webpVp8x(256, 256, 0x10))
    expect(r).toEqual({ ok: true, info: { mime: 'image/webp', width: 256, height: 256, hasAlpha: true, animated: false, exif: false, frames: 1 } })
  })

  it('VP8X animation flag (0x02) with frames → animated, frame count from ANMF chunks', () => {
    const r = inspectTheme('image/webp', webpVp8x(256, 256, 0x12, [...anmf(0, 0, 256, 256), ...anmf(0, 0, 128, 128)]))
    expect(r.ok && r.info.animated && r.info.frames).toBe(2)
  })

  it('animated WebP with no frames → refused', () => {
    const r = inspectTheme('image/webp', webpVp8x(256, 256, 0x12))
    expect(r.ok).toBe(false)
  })

  it('a frame that runs past the canvas → refused with the actual extent', () => {
    const r = inspectTheme('image/webp', webpVp8x(256, 256, 0x12, anmf(0, 0, 300, 256)))
    expect(r).toEqual({ ok: false, error: 'Khung hình WebP nằm ngoài khung ảnh (300×256 trên 256×256)' })
  })

  it('VP8X without alpha flag → no alpha', () => {
    const r = inspectTheme('image/webp', webpVp8x(1200, 1600, 0x00))
    expect(r.ok && r.info.hasAlpha).toBe(false)
  })

  it('lossless VP8L with alpha_is_used → alpha, and dimensions decoded', () => {
    const r = inspectTheme('image/webp', webpVp8l(512, 512, true))
    expect(r.ok && r.info.hasAlpha && r.info.width === 512 && r.info.height === 512).toBe(true)
  })
})

describe('JPEG', () => {
  it('SOF0 dimensions, never transparent', () => {
    const r = inspectTheme('image/jpeg', jpeg(1080, 1920))
    expect(r).toEqual({ ok: true, info: { mime: 'image/jpeg', width: 1080, height: 1920, hasAlpha: false, animated: false, exif: false, frames: 1 } })
  })

  it('APP1 Exif segment → refused with the EXIF message, not a size error', () => {
    const exifJpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      ...jpeg(1080, 1920).slice(2),
    ])
    expect(inspectTheme('image/jpeg', exifJpeg)).toEqual({ ok: false, error: METADATA_MESSAGE })
  })

  it('truncated JPEG → error', () => {
    expect(inspectTheme('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff])).ok).toBe(false)
  })
})

describe('WebP metadata', () => {
  it('ICC colour profile alone is not metadata (same policy as PNG and JPEG)', () => {
    const r = inspectTheme('image/webp', webpVp8x(256, 256, 0, [...ascii('ICCP'), ...u32le(4), 0, 0, 0, 0]))
    expect(r.ok && r.info.exif).toBe(false)
  })

  it('EXIF chunk → refused with the EXIF message', () => {
    const exifWebp = webpVp8x(256, 256, 0, [...ascii('EXIF'), ...u32le(4), 0, 0, 0, 0])
    expect(inspectTheme('image/webp', exifWebp)).toEqual({ ok: false, error: METADATA_MESSAGE })
  })
})

describe('PNG structure', () => {
  it('a first chunk that is not IHDR → refused as a broken file', () => {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const bytes = new Uint8Array([...sig, ...pngChunk('tEXt', [...ascii('a'), 0, ...ascii('b')]), ...pngChunk('IEND', [])])
    expect(inspectTheme('image/png', bytes).ok).toBe(false)
  })
})

describe('metadata beyond EXIF (text chunks, XMP, comments) is refused', () => {
  it('PNG tEXt chunk (for example Author or GPS text) → metadata flag', () => {
    const r = inspectTheme('image/png', png(256, 256, 6, [pngChunk('tEXt', [...ascii('Author'), 0, ...ascii('x')])]))
    expect(r.ok && r.info.exif).toBe(true)
  })

  it('PNG iTXt chunk (XMP carrier) → metadata flag', () => {
    const r = inspectTheme('image/png', png(256, 256, 6, [pngChunk('iTXt', ascii('XML:com.adobe.xmp'))]))
    expect(r.ok && r.info.exif).toBe(true)
  })

  it('JPEG APP1 XMP packet (not Exif) → metadata flag with the real size', () => {
    const payload = [...ascii('http://ns.adobe.com/xap/1.0/'), 0]
    const xmpSegment = [0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload]
    const r = inspectTheme('image/jpeg', new Uint8Array([0xff, 0xd8, ...xmpSegment, ...jpeg(1080, 1920).slice(2)]))
    expect(r.ok && r.info.exif && r.info.width === 1080).toBe(true)
  })

  it('JPEG COM comment segment → metadata flag', () => {
    const comment = [0xff, 0xfe, 0x00, 0x04, 0x68, 0x69] // COM, length 4 = 2 bytes of text
    const r = inspectTheme('image/jpeg', new Uint8Array([0xff, 0xd8, ...comment, ...jpeg(256, 256).slice(2)]))
    expect(r.ok && r.info.exif).toBe(true)
  })

  it('PNG zTXt chunk → metadata flag', () => {
    const r = inspectTheme('image/png', png(256, 256, 6, [pngChunk('zTXt', [...ascii('Comment'), 0, 0, 0x78, 0x9c])]))
    expect(r.ok && r.info.exif).toBe(true)
  })

  it('JPEG APP13 (Photoshop/IPTC) segment → metadata flag', () => {
    const payload = [...ascii('Photoshop 3.0'), 0]
    const app13 = [0xff, 0xed, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload]
    const r = inspectTheme('image/jpeg', new Uint8Array([0xff, 0xd8, ...app13, ...jpeg(256, 256).slice(2)]))
    expect(r.ok && r.info.exif).toBe(true)
  })

  it('XMP packet after the image data (no marker) → caught by the signature search', () => {
    const tail = ascii('http://ns.adobe.com/xap/1.0/')
    const r = inspectTheme('image/jpeg', new Uint8Array([...jpeg(256, 256), ...tail]))
    expect(r.ok && r.info.exif).toBe(true)
  })

  it('extended XMP namespace after the image data → caught by the signature search', () => {
    const r = inspectTheme('image/jpeg', new Uint8Array([...jpeg(256, 256), ...ascii('http://ns.adobe.com/xmp/extension/')]))
    expect(r.ok && r.info.exif).toBe(true)
  })

  it('Exif signature after the image data (no marker) → caught by the signature search', () => {
    const r = inspectTheme('image/jpeg', new Uint8Array([...jpeg(256, 256), 0x45, 0x78, 0x69, 0x66, 0, 0]))
    expect(r.ok && r.info.exif).toBe(true)
  })

  it('clean JPEG with an ICC-free header → no metadata flag', () => {
    const r = inspectTheme('image/jpeg', jpeg(256, 256))
    expect(r.ok && r.info.exif).toBe(false)
  })
})

describe('GIF', () => {
  it('a single-frame GIF is a still', () => {
    const r = inspectTheme('image/gif', gif(256, 256, [{ w: 256, h: 256 }]))
    expect(r).toEqual({ ok: true, info: { mime: 'image/gif', width: 256, height: 256, hasAlpha: false, animated: false, exif: false, frames: 1 } })
  })

  it('multi-frame GIF → animated with the frame count and transparency from the graphic control block', () => {
    const r = inspectTheme('image/gif', gif(256, 256, [{ w: 256, h: 256 }, { w: 256, h: 256 }, { w: 128, h: 128, x: 64 }], { transparent: true, app: 'NETSCAPE2.0' }))
    expect(r).toEqual({ ok: true, info: { mime: 'image/gif', width: 256, height: 256, hasAlpha: true, animated: true, exif: false, frames: 3 } })
  })

  it('comment extension → refused with the metadata message', () => {
    expect(inspectTheme('image/gif', gif(256, 256, [{ w: 256, h: 256 }], { comment: true }))).toEqual({ ok: false, error: METADATA_MESSAGE })
  })

  it('application extension other than NETSCAPE2.0 → refused with the metadata message', () => {
    expect(inspectTheme('image/gif', gif(256, 256, [{ w: 256, h: 256 }], { app: 'XMP DataXMP' }))).toEqual({ ok: false, error: METADATA_MESSAGE })
  })

  it('a frame outside the logical screen → refused', () => {
    const r = inspectTheme('image/gif', gif(256, 256, [{ x: 200, w: 100, h: 10 }]))
    expect(r.ok).toBe(false)
  })

  it('wrong signature or truncated data → refused, never thrown', () => {
    expect(inspectTheme('image/gif', new Uint8Array([...ascii('GIF87b'), 1, 0, 1, 0, 0, 0, 0])).ok).toBe(false)
    const full = gif(256, 256, [{ w: 256, h: 256 }])
    expect(inspectTheme('image/gif', full.slice(0, full.length - 6)).ok).toBe(false)
  })
})

describe('format and identity', () => {
  it('declared MIME that does not match the bytes → error (magic bytes)', () => {
    const r = inspectTheme('image/jpeg', png(256, 256, 6))
    expect(r.ok).toBe(false)
  })

  it('unsupported type (SVG text) → error', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(inspectTheme('image/svg+xml', svg).ok).toBe(false)
  })
})
