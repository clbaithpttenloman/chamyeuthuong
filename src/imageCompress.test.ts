// @vitest-environment node
/**
 * Tests for src/imageCompress.ts
 * Failing until Group 2 creates src/imageCompress.ts.
 *
 * Contract:
 *   compressImage(
 *     blob: Blob,
 *     options?: { maxBytes?: number; maxDim?: number },
 *     encoder?: (canvas: OffscreenCanvas, mime: string, quality: number) => Promise<Blob>
 *   ): Promise<Blob>
 *
 * The encoder parameter makes the size-reduction loop unit-testable without a real browser canvas.
 * Default: maxBytes = 307200 (300 KB), maxDim = 1280.
 */

// This import fails until imageCompress.ts is created → all tests in this file fail
import { compressImage } from './imageCompress.ts'
import { describe, it, expect } from 'vitest'

// ---- Helpers ----

/** Build a Blob of exactly `size` bytes. */
function blobOfSize(size: number, type = 'image/jpeg'): Blob {
  return new Blob([new Uint8Array(size).fill(0x20)], { type })
}

/** Encoder stub: returns a blob of `size` bytes on each call. */
function encoderReturning(size: number, type = 'image/webp') {
  return async (_canvas: unknown, _mime: string, _quality: number): Promise<Blob> =>
    blobOfSize(size, type)
}

// ===================================================================
// Size reduction loop
// ===================================================================

describe('compressImage — size reduction loop', () => {
  it('when encoder immediately returns ≤ maxBytes, returns that blob', async () => {
    const input = blobOfSize(500000, 'image/jpeg')
    const encoder = encoderReturning(200000)
    const result = await compressImage(input, { maxBytes: 307200 }, encoder)
    expect(result.size).toBeLessThanOrEqual(307200)
  })

  it('when encoder always returns over maxBytes, reduces quality until it fits or gives up', async () => {
    // Encoder returns decreasing size on successive calls (simulates quality reduction)
    let call = 0
    const sizes = [400000, 350000, 300000, 200000]
    const encoder = async (): Promise<Blob> => blobOfSize(sizes[call++] ?? 100000)
    const result = await compressImage(blobOfSize(600000, 'image/jpeg'), { maxBytes: 307200 }, encoder)
    expect(result.size).toBeLessThanOrEqual(307200)
  })

  it('callable without an encoder argument (uses default implementation)', async () => {
    // Should not throw even without a canvas environment; may return original or throw
    // as a stub until real implementation is in place
    const input = blobOfSize(100, 'image/jpeg')
    await expect(compressImage(input)).resolves.toBeDefined()
  })

  it('output MIME type is image/webp (preferred) or image/jpeg (fallback)', async () => {
    const encoder = encoderReturning(1000, 'image/webp')
    const result = await compressImage(blobOfSize(100000, 'image/jpeg'), {}, encoder)
    expect(['image/webp', 'image/jpeg']).toContain(result.type)
  })

  it('encoder is called with decreasing quality values when output is too large', async () => {
    const qualities: number[] = []
    const encoder = async (_c: unknown, _m: string, q: number): Promise<Blob> => {
      qualities.push(q)
      // Always return over-limit until quality drops below 0.4
      return blobOfSize(q < 0.4 ? 100000 : 500000)
    }
    await compressImage(blobOfSize(600000, 'image/jpeg'), { maxBytes: 307200 }, encoder)
    // Quality sequence must be strictly decreasing
    for (let i = 1; i < qualities.length; i++) {
      expect(qualities[i]).toBeLessThan(qualities[i - 1])
    }
  })
})

describe('compressImage — injectable encoder contract', () => {
  it('encoder receives an OffscreenCanvas-like object as first argument', async () => {
    let canvasArg: unknown
    const encoder = async (c: unknown): Promise<Blob> => { canvasArg = c; return blobOfSize(1000) }
    await compressImage(blobOfSize(100000, 'image/jpeg'), {}, encoder)
    expect(canvasArg).toBeDefined()
    // Should have width and height
    expect(typeof (canvasArg as { width?: number }).width).toBe('number')
    expect(typeof (canvasArg as { height?: number }).height).toBe('number')
  })

  it('encoder receives the target MIME type as second argument', async () => {
    let mimeArg: string | undefined
    const encoder = async (_c: unknown, m: string): Promise<Blob> => { mimeArg = m; return blobOfSize(1000) }
    await compressImage(blobOfSize(100000, 'image/jpeg'), {}, encoder)
    expect(typeof mimeArg).toBe('string')
    expect(mimeArg).toMatch(/^image\//)
  })

  it('encoder receives a quality value between 0 and 1 as third argument', async () => {
    let qualityArg: number | undefined
    const encoder = async (_c: unknown, _m: string, q: number): Promise<Blob> => { qualityArg = q; return blobOfSize(1000) }
    await compressImage(blobOfSize(100000, 'image/jpeg'), {}, encoder)
    expect(typeof qualityArg).toBe('number')
    expect(qualityArg).toBeGreaterThan(0)
    expect(qualityArg).toBeLessThanOrEqual(1)
  })
})
