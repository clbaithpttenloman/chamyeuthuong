/**
 * Browser-side image compression.
 *
 * Resizes to maxDim px on the longest side, then encodes as WebP (or JPEG
 * fallback), shrinking quality step-by-step until the blob fits within
 * maxBytes.  If all quality steps are exhausted the canvas is halved and the
 * loop retries — this dimension step-down repeats until the canvas is 1×1.
 *
 * Requires OffscreenCanvas + createImageBitmap (all modern browsers).  When
 * called without a canvas environment AND without an injected encoder (i.e.
 * in an unsupported browser) it throws a Vietnamese "trình duyệt không hỗ trợ"
 * error — it never silently returns the original blob (which would preserve
 * EXIF data and bypass the size limit).
 *
 * The encoder parameter makes the loops unit-testable without a real browser
 * canvas: inject a stub that returns a Blob of a known size and type.
 *
 * Default: maxBytes = 307200 (300 KB), maxDim = 1280.
 */

type Encoder = (canvas: OffscreenCanvas, mime: string, quality: number) => Promise<Blob>

const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25, 0.15, 0.1]

export async function compressImage(
  blob: Blob,
  options: { maxBytes?: number; maxDim?: number } = {},
  encoder?: Encoder,
): Promise<Blob> {
  const maxBytes = options.maxBytes ?? 307200
  const maxDim = options.maxDim ?? 1280

  if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined') {
    // ── Browser path ────────────────────────────────────────────────────────
    const enc: Encoder = encoder ?? makeBrowserEncoder()

    const srcBitmap = await createImageBitmap(blob)
    const scale = Math.min(1, maxDim / Math.max(srcBitmap.width, srcBitmap.height, 1))
    let w = Math.max(1, Math.round(srcBitmap.width * scale))
    let h = Math.max(1, Math.round(srcBitmap.height * scale))
    srcBitmap.close()

    // Quality + dimension step-down loop
    for (;;) {
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
      if (ctx) {
        const bm = await createImageBitmap(blob)
        ctx.drawImage(bm, 0, 0, w, h)
        bm.close()
      }

      const result = await tryQualities(enc, canvas, maxBytes)
      if (result !== null) return result

      // Quality exhausted — step down dimensions and retry
      if (w <= 1 && h <= 1) break
      w = Math.max(1, Math.floor(w / 2))
      h = Math.max(1, Math.floor(h / 2))
    }
  } else if (encoder) {
    // ── Test / non-browser path with injected encoder ────────────────────────
    // Use maxDim as the initial stub canvas size so dimension step-down tests
    // can observe decreasing widths across iterations.
    let w = maxDim
    let h = maxDim

    for (;;) {
      const canvas = { width: w, height: h } as unknown as OffscreenCanvas

      const result = await tryQualities(encoder, canvas, maxBytes)
      if (result !== null) return result

      if (w <= 1 && h <= 1) break
      w = Math.max(1, Math.floor(w / 2))
      h = Math.max(1, Math.floor(h / 2))
    }
  } else {
    // ── No canvas support, no encoder ────────────────────────────────────────
    // Returning the original blob silently is forbidden: it keeps EXIF and
    // bypasses the 300 KB limit.  Throw a user-visible error instead.
    throw new Error(
      'Trình duyệt không hỗ trợ nén ảnh. Vui lòng dùng trình duyệt hiện đại.',
    )
  }

  throw new Error(
    'Không thể nén ảnh về dưới 300 KB. Vui lòng chọn ảnh nhỏ hơn.',
  )
}

/**
 * Try all quality steps for all supported MIME types.
 * Returns the first blob that fits within maxBytes AND has the expected type,
 * or null if none qualify (caller should step down dimensions and retry).
 *
 * Type check: `convertToBlob` may return PNG when WebP encoding is unsupported;
 * we reject such results so the loop falls through to JPEG.
 */
async function tryQualities(
  enc: Encoder,
  canvas: OffscreenCanvas,
  maxBytes: number,
): Promise<Blob | null> {
  for (const targetMime of ['image/webp', 'image/jpeg'] as const) {
    for (const quality of QUALITY_STEPS) {
      const result = await enc(canvas, targetMime, quality)
      if (result.size <= maxBytes && result.type === targetMime) return result
    }
  }
  return null
}

/**
 * Default encoder for the browser path: delegates to OffscreenCanvas.convertToBlob.
 * Only called when OffscreenCanvas is confirmed present.
 */
function makeBrowserEncoder(): Encoder {
  return (canvas: OffscreenCanvas, mime: string, quality: number): Promise<Blob> =>
    canvas.convertToBlob({ type: mime, quality })
}
