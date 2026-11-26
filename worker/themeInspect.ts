/**
 * Inspects an uploaded theme image (Phase 3, FR-16, FR-17): real format, width and height,
 * transparency and animation. Reuses the 20/11 magic-byte and dimension parsers in images.ts;
 * adds the alpha and animation checks that the 20/11 library never needed.
 *
 * Every chunk and segment length is checked against the remaining bytes before it is read, so a
 * crafted file cannot run the loop past the buffer.
 */
import { checkDimensions, magicOk } from './images.ts'

export type ThemeInfo = {
  mime: string
  width: number
  height: number
  /** Real transparency: an alpha channel, a tRNS chunk, or a WebP alpha flag. */
  hasAlpha: boolean
  /** Animated PNG (APNG), animated WebP. Refused in the static cut. */
  animated: boolean
  /** Metadata chunks (EXIF, XMP, ICC profile). Refused: uploads are stripped of metadata. */
  exif: boolean
}

export type ThemeInspection = { ok: true; info: ThemeInfo } | { ok: false; error: string }

const u32be = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
const u32le = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
const type4 = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!)

/** Walks PNG chunks after the 8-byte signature. Returns flags for the chunks that matter. */
function scanPng(b: Uint8Array): { colourType: number; tRNS: boolean; acTL: boolean; eXIf: boolean } | null {
  let colourType = -1
  let tRNS = false
  let acTL = false
  let eXIf = false
  let off = 8
  while (off + 12 <= b.length) {
    const len = u32be(b, off)
    if (off + 12 + len > b.length) return null // chunk runs past the end: malformed
    const t = type4(b, off + 4)
    if (t === 'IHDR' && len >= 10) colourType = b[off + 8 + 9]!
    if (t === 'tRNS') tRNS = true
    if (t === 'acTL') acTL = true
    if (t === 'eXIf') eXIf = true
    if (t === 'IEND') break
    off += 12 + len
  }
  return colourType < 0 ? null : { colourType, tRNS, acTL, eXIf }
}

/** Walks RIFF chunks of a WebP file. Returns the first chunk type plus the flags that matter. */
function scanWebp(b: Uint8Array): { first: string; flags: number; alphaVp8l: boolean; animChunks: boolean; metadata: boolean } | null {
  if (b.length < 20) return null
  let off = 12
  let first = ''
  let flags = 0
  let alphaVp8l = false
  let animChunks = false
  let metadata = false
  while (off + 8 <= b.length) {
    const size = u32le(b, off + 4)
    if (off + 8 + size > b.length) return null
    const t = type4(b, off)
    if (!first) first = t
    if (t === 'VP8X') flags = b[off + 8]!
    if (t === 'VP8L' && size >= 5) alphaVp8l = ((u32le(b, off + 9) >>> 28) & 1) === 1
    if (t === 'ANIM' || t === 'ANMF') animChunks = true
    if (t === 'EXIF' || t === 'XMP ' || t === 'ICCP') metadata = true
    off += 8 + size + (size & 1)
  }
  return { first, flags, alphaVp8l, animChunks, metadata }
}

export function inspectTheme(mime: string, bytes: Uint8Array): ThemeInspection {
  if (!magicOk(mime, bytes)) {
    return { ok: false, error: 'Tệp không đúng định dạng ảnh đã chọn (kiểm tra chữ ký tệp)' }
  }

  if (mime === 'image/png') {
    const scan = scanPng(bytes)
    if (!scan) return { ok: false, error: 'Tệp PNG bị hỏng hoặc không đọc được' }
    // The 20/11 parser returns the size, or 'exif' when an eXIf chunk is present. Read the IHDR
    // directly in that case, so the size is still known and the metadata flag is set.
    const dims = checkDimensions(mime, bytes)
    const width = u32be(bytes, 16)
    const height = u32be(bytes, 20)
    if (dims === null || (width === 0 || height === 0)) {
      return { ok: false, error: 'Không đọc được kích thước ảnh PNG' }
    }
    return {
      ok: true,
      info: {
        mime,
        width,
        height,
        hasAlpha: scan.colourType === 4 || scan.colourType === 6 || scan.tRNS,
        animated: scan.acTL,
        exif: scan.eXIf || dims === 'exif',
      },
    }
  }

  if (mime === 'image/jpeg') {
    const dims = checkDimensions(mime, bytes)
    if (dims === null || dims === 'exif') return { ok: false, error: 'Không đọc được kích thước ảnh JPEG' }
    return {
      ok: true,
      info: { mime, width: dims.w, height: dims.h, hasAlpha: false, animated: false, exif: false },
    }
  }

  if (mime === 'image/webp') {
    const scan = scanWebp(bytes)
    if (!scan) return { ok: false, error: 'Tệp WebP bị hỏng hoặc không đọc được' }
    const dims = checkDimensions(mime, bytes)
    if (dims === null || dims === 'exif') return { ok: false, error: 'Không đọc được kích thước ảnh WebP' }
    const vp8x = scan.first === 'VP8X'
    const hasAlpha = vp8x ? (scan.flags & 0x10) !== 0 : scan.alphaVp8l
    const animated = vp8x ? (scan.flags & 0x02) !== 0 || scan.animChunks : scan.animChunks
    return {
      ok: true,
      info: { mime, width: dims.w, height: dims.h, hasAlpha, animated, exif: scan.metadata },
    }
  }

  return { ok: false, error: 'Định dạng không được hỗ trợ (chỉ PNG, JPEG, WebP)' }
}
