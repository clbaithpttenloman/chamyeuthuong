/**
 * Verifies that every default-theme file:
 *   - exists and is a valid WebP (magic bytes RIFF...WEBP)
 *   - has the correct canvas dimensions (VP8X/VP8/VP8L header parse)
 *   - carries the VP8X alpha flag where transparency is required
 *   - is within the slot's byte-size budget
 *   - Total ≤ 3 MB
 *
 * Header parsing mirrors worker/images.ts parseWebP / magicOk logic,
 * implemented inline to avoid pulling in Worker-specific imports.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = join(import.meta.dirname, '..', 'public', 'theme', 'gift_tree', 'default')

function readSlot(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(BASE, name)))
}

// --- WebP header helpers ---

function isWebP(b: Uint8Array): boolean {
  return (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50   // WEBP
  )
}

function fourCC(b: Uint8Array): string {
  return String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0)
}

/** Parse VP8X, VP8 (lossy), VP8L (lossless) canvas dimensions. Returns null on failure. */
function parseWebPDims(b: Uint8Array): { w: number; h: number } | null {
  if (!isWebP(b)) return null
  const cc = fourCC(b)

  if (cc === 'VP8X') {
    if (b.length < 30) return null
    const w = 1 + (b[24]! | ((b[25]! << 8)) | ((b[26]! << 16)))
    const h = 1 + (b[27]! | ((b[28]! << 8)) | ((b[29]! << 16)))
    return { w, h }
  }
  if (cc === 'VP8 ') {
    // Key-frame start code at offset 23-25: 0x9d 0x01 0x2a
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    const w = (b[26]! | (b[27]! << 8)) & 0x3fff
    const h = (b[28]! | (b[29]! << 8)) & 0x3fff
    return { w, h }
  }
  if (cc === 'VP8L') {
    if (b.length < 25 || b[20] !== 0x2f) return null
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
    const w = 1 + (bits & 0x3fff)
    const h = 1 + ((bits >> 14) & 0x3fff)
    return { w, h }
  }
  return null
}

/**
 * Returns true if the VP8X flags byte (b[20]) has the Alpha flag set.
 * Per libwebp format_constants.h: ALPHA_FLAG = 0x00000010 (bit 4 of the LE 32-bit flags field,
 * i.e. bit 4 of byte 20 in the RIFF stream).
 */
function vp8xHasAlpha(b: Uint8Array): boolean {
  return b.length >= 21 && fourCC(b) === 'VP8X' && (b[20]! & 0x10) !== 0
}

// --- Slot catalogue ---

const KB = 1024
const MB = 1024 * KB

type SlotSpec = {
  file: string
  w: number
  h: number
  transparent: boolean
  maxBytes: number
}

const SLOTS: SlotSpec[] = [
  { file: 'sky_portrait.webp',   w: 1080, h: 1920, transparent: false, maxBytes: 600 * KB },
  { file: 'sky_landscape.webp',  w: 1920, h: 1080, transparent: false, maxBytes: 600 * KB },
  { file: 'layer_ground.webp',   w: 1920, h:  500, transparent: true,  maxBytes: 400 * KB },
  { file: 'tree.webp',           w: 1200, h: 1600, transparent: true,  maxBytes: 800 * KB },
  { file: 'star.webp',           w:  256, h:  256, transparent: true,  maxBytes: 300 * KB },
  { file: 'ornament_1.webp',     w:  256, h:  256, transparent: true,  maxBytes: 150 * KB },
  { file: 'ornament_2.webp',     w:  256, h:  256, transparent: true,  maxBytes: 150 * KB },
  { file: 'ornament_3.webp',     w:  256, h:  256, transparent: true,  maxBytes: 150 * KB },
  { file: 'ornament_4.webp',     w:  256, h:  256, transparent: true,  maxBytes: 150 * KB },
  { file: 'ornament_5.webp',     w:  256, h:  256, transparent: true,  maxBytes: 150 * KB },
  { file: 'ornament_6.webp',     w:  256, h:  256, transparent: true,  maxBytes: 150 * KB },
  { file: 'box_1_closed.webp',   w:  512, h:  512, transparent: true,  maxBytes: 200 * KB },
  { file: 'box_2_closed.webp',   w:  512, h:  512, transparent: true,  maxBytes: 200 * KB },
  { file: 'box_3_closed.webp',   w:  512, h:  512, transparent: true,  maxBytes: 200 * KB },
  { file: 'box_4_closed.webp',   w:  512, h:  512, transparent: true,  maxBytes: 200 * KB },
  { file: 'box_5_closed.webp',   w:  512, h:  512, transparent: true,  maxBytes: 200 * KB },
  { file: 'box_6_closed.webp',   w:  512, h:  512, transparent: true,  maxBytes: 200 * KB },
]

// --- Tests ---

describe('default theme files', () => {
  it('total size ≤ 3 MB', () => {
    const total = SLOTS.reduce(
      (sum, s) => sum + readFileSync(join(BASE, s.file)).length,
      0,
    )
    expect(total).toBeLessThanOrEqual(3 * MB)
  })

  SLOTS.forEach(({ file, w, h, transparent, maxBytes }) => {
    describe(file, () => {
      it('has WebP magic bytes', () => {
        expect(isWebP(readSlot(file))).toBe(true)
      })

      it(`canvas dimensions ${w}×${h}`, () => {
        const dims = parseWebPDims(readSlot(file))
        expect(dims).not.toBeNull()
        expect(dims!.w).toBe(w)
        expect(dims!.h).toBe(h)
      })

      if (transparent) {
        it('VP8X format with alpha flag set', () => {
          const b = readSlot(file)
          expect(fourCC(b)).toBe('VP8X')
          expect(vp8xHasAlpha(b)).toBe(true)
        })
      }

      it(`byte size ≤ ${maxBytes / KB} KB`, () => {
        expect(readFileSync(join(BASE, file)).length).toBeLessThanOrEqual(maxBytes)
      })
    })
  })
})
