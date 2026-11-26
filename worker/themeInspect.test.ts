// @vitest-environment node
/**
 * Theme upload inspection (Phase 3): real format, size, transparency and animation.
 * Fixtures are built byte by byte so each rule is tested on a known input.
 */
import { describe, it, expect } from 'vitest'
import { inspectTheme } from './themeInspect.ts'

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
    expect(r).toEqual({ ok: true, info: { mime: 'image/png', width: 256, height: 256, hasAlpha: true, animated: false, exif: false } })
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
    expect(r).toEqual({ ok: true, info: { mime: 'image/webp', width: 256, height: 256, hasAlpha: true, animated: false, exif: false } })
  })

  it('VP8X animation flag (0x02) → animated', () => {
    const r = inspectTheme('image/webp', webpVp8x(256, 256, 0x12))
    expect(r.ok && r.info.animated).toBe(true)
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
    expect(r).toEqual({ ok: true, info: { mime: 'image/jpeg', width: 1080, height: 1920, hasAlpha: false, animated: false, exif: false } })
  })

  it('truncated JPEG → error', () => {
    expect(inspectTheme('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff])).ok).toBe(false)
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
