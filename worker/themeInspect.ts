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
  /** EXIF or XMP chunk present (WebP). ICC colour profiles are not metadata here. */
  exif: boolean
}

export type ThemeInspection = { ok: true; info: ThemeInfo } | { ok: false; error: string }

const u32be = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
const u32le = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
const type4 = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!)

/** Walks PNG chunks after the 8-byte signature. Returns flags for the chunks that matter. */
function scanPng(b: Uint8Array): { colourType: number; tRNS: boolean; acTL: boolean } | null {
  let colourType = -1
  let tRNS = false
  let acTL = false
  let off = 8
  while (off + 12 <= b.length) {
    const len = u32be(b, off)
    if (off + 12 + len > b.length) return null // chunk runs past the end: malformed
    const t = type4(b, off + 4)
    if (t === 'IHDR' && len >= 10) colourType = b[off + 8 + 9]!
    if (t === 'tRNS') tRNS = true
    if (t === 'acTL') acTL = true
    if (t === 'IEND') break
    off += 12 + len
  }
  return colourType < 0 ? null : { colourType, tRNS, acTL }
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
    if (t === 'EXIF' || t === 'XMP ') metadata = true
    off += 8 + size + (size & 1)
  }
  return { first, flags, alphaVp8l, animChunks, metadata }
}

/**
 * Refusal for files that carry metadata (EXIF, XMP, text chunks, comments). Published art must not
 * expose location or author data, so every such carrier is refused, not only EXIF.
 */
export const METADATA_MESSAGE = 'Ảnh có siêu dữ liệu (EXIF, XMP, chú thích văn bản). Xóa metadata rồi tải lại.'

const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt'])
/** APP1 (Exif, XMP), APP13 (Photoshop/IPTC) and COM (comment) segments. */
const JPEG_METADATA_MARKERS = new Set([0xe1, 0xed, 0xfe])
const EXIF_SIGNATURE = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]) // "Exif\0\0"
const XMP_SIGNATURES = ['http://ns.adobe.com/xap/', 'http://ns.adobe.com/xmp/extension/'].map((s) => new TextEncoder().encode(s))

function pngHasMetadata(b: Uint8Array): boolean {
  let off = 8
  while (off + 8 <= b.length) {
    if (PNG_METADATA_CHUNKS.has(type4(b, off + 4))) return true
    off += 12 + u32be(b, off)
  }
  return false
}

function containsBytes(b: Uint8Array, pattern: Uint8Array): boolean {
  for (let i = 0; i + pattern.length <= b.length; i++) {
    let j = 0
    while (j < pattern.length && b[i + j] === pattern[j]) j++
    if (j === pattern.length) return true
  }
  return false
}

/** Structural walk up to the start of the scan, then a signature search for Exif/XMP anywhere. */
function jpegHasMetadata(b: Uint8Array): boolean {
  let off = 2
  while (off + 2 <= b.length && b[off] === 0xff) {
    const marker = b[off + 1]!
    if (marker === 0xda) break // start of scan: entropy-coded data follows
    if (marker === 0xff) { off += 1; continue } // fill byte
    if (JPEG_METADATA_MARKERS.has(marker)) return true
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue }
    if (off + 4 > b.length) break
    const segLen = (b[off + 2]! << 8) | b[off + 3]!
    if (segLen < 2) break
    off += 2 + segLen
  }
  return containsBytes(b, EXIF_SIGNATURE) || XMP_SIGNATURES.some((sig) => containsBytes(b, sig))
}

export function inspectTheme(mime: string, bytes: Uint8Array): ThemeInspection {
  if (!magicOk(mime, bytes)) {
    return { ok: false, error: 'Tệp không đúng định dạng ảnh đã chọn (kiểm tra chữ ký tệp)' }
  }

  if (mime === 'image/png') {
    const scan = scanPng(bytes)
    if (!scan) return { ok: false, error: 'Tệp PNG bị hỏng hoặc không đọc được' }
    // IHDR must be the first chunk (PNG spec). Its size is read directly, so a PNG with metadata still
    // reports its size. Metadata is a separate flag from pngHasMetadata, not a parse failure.
    if (type4(bytes, 12) !== 'IHDR') return { ok: false, error: 'Tệp PNG bị hỏng hoặc không đọc được' }
    const width = u32be(bytes, 16)
    const height = u32be(bytes, 20)
    if (width === 0 || height === 0) {
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
        exif: pngHasMetadata(bytes),
      },
    }
  }

  if (mime === 'image/jpeg') {
    const dims = checkDimensions(mime, bytes)
    if (dims === 'exif') return { ok: false, error: METADATA_MESSAGE }
    if (dims === null) return { ok: false, error: 'Không đọc được kích thước ảnh JPEG' }
    return {
      ok: true,
      info: { mime, width: dims.w, height: dims.h, hasAlpha: false, animated: false, exif: jpegHasMetadata(bytes) },
    }
  }

  if (mime === 'image/webp') {
    const scan = scanWebp(bytes)
    if (!scan) return { ok: false, error: 'Tệp WebP bị hỏng hoặc không đọc được' }
    const dims = checkDimensions(mime, bytes)
    if (dims === 'exif') return { ok: false, error: METADATA_MESSAGE }
    if (dims === null) return { ok: false, error: 'Không đọc được kích thước ảnh WebP' }
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
