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
  /** Animated: APNG (refused everywhere), animated WebP, or a GIF with more than one frame. */
  animated: boolean
  /** EXIF, XMP or a GIF comment/application block present. ICC colour profiles are not metadata here. */
  exif: boolean
  /** Frame count: 1 for stills, WebP ANMF count, or GIF image descriptor count. */
  frames: number
}

export type ThemeInspection = { ok: true; info: ThemeInfo } | { ok: false; error: string }

const u32be = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
const u32le = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
const type4 = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!)
const u24le = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) >>> 0
const u16le = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8)) >>> 0

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
type Rect = { x: number; y: number; w: number; h: number }

function scanWebp(b: Uint8Array): { first: string; flags: number; alphaVp8l: boolean; animChunks: boolean; metadata: boolean; rects: Rect[] } | null {
  if (b.length < 20) return null
  let off = 12
  let first = ''
  let flags = 0
  let alphaVp8l = false
  let animChunks = false
  let metadata = false
  const rects: Rect[] = []
  while (off + 8 <= b.length) {
    const size = u32le(b, off + 4)
    if (off + 8 + size > b.length) return null
    const t = type4(b, off)
    if (!first) first = t
    if (t === 'VP8X') flags = b[off + 8]!
    if (t === 'VP8L' && size >= 5) alphaVp8l = ((u32le(b, off + 9) >>> 28) & 1) === 1
    if (t === 'ANIM') animChunks = true
    if (t === 'ANMF') {
      // ANMF payload: X/2 (3 bytes), Y/2 (3), width-1 (3), height-1 (3), duration (3), flags (1)
      if (size < 16) return null
      animChunks = true
      rects.push({ x: u24le(b, off + 8) * 2, y: u24le(b, off + 11) * 2, w: u24le(b, off + 14) + 1, h: u24le(b, off + 17) + 1 })
    }
    if (t === 'EXIF' || t === 'XMP ') metadata = true
    off += 8 + size + (size & 1)
  }
  return { first, flags, alphaVp8l, animChunks, metadata, rects }
}

/** Skips a GIF sub-block chain. Returns the offset after the zero terminator, or -1 when it overruns. */
function skipSubBlocks(b: Uint8Array, off: number): number {
  for (;;) {
    if (off >= b.length) return -1
    const size = b[off]!
    off += 1
    if (size === 0) return off
    off += size
    if (off > b.length) return -1
  }
}

const GIF_BROKEN = 'Tệp GIF bị hỏng hoặc không đọc được'
const GIF_MAX_BLOCKS = 512

/**
 * Walks a GIF: logical screen size, every image descriptor (frame count, frame rectangle inside the
 * canvas), graphic control (transparency), and extensions. Comment, plain-text and unknown
 * application extensions count as metadata. NETSCAPE2.0 (loop count) and ANIMEXTS1.0 are allowed.
 */
export function parseGif(b: Uint8Array): { ok: true; width: number; height: number; frames: number; transparent: boolean; metadata: boolean } | { ok: false; error: string } {
  if (b.length < 13) return { ok: false, error: GIF_BROKEN }
  const width = u16le(b, 6)
  const height = u16le(b, 8)
  if (width === 0 || height === 0) return { ok: false, error: 'Không đọc được kích thước ảnh GIF' }
  const flags = b[10]!
  let off = 13
  if (flags & 0x80) off += 3 * 2 ** ((flags & 7) + 1)
  let frames = 0
  let transparent = false
  let metadata = false
  for (let blocks = 0; ; blocks++) {
    if (blocks > GIF_MAX_BLOCKS) return { ok: false, error: 'Tệp GIF có quá nhiều khối dữ liệu' }
    if (off >= b.length) return { ok: false, error: GIF_BROKEN }
    const introducer = b[off]!
    if (introducer === 0x3b) break // trailer
    if (introducer === 0x21) {
      if (off + 2 > b.length) return { ok: false, error: GIF_BROKEN }
      const label = b[off + 1]!
      if (label === 0xf9) {
        // Graphic control: off+2 = block size (4), off+3 = packed flags (bit 0 = transparency)
        if (off + 4 > b.length) return { ok: false, error: GIF_BROKEN }
        if (b[off + 3]! & 1) transparent = true
      } else if (label === 0xff) {
        const app = off + 3
        const id = app + 11 <= b.length ? String.fromCharCode(...b.subarray(app, app + 11)) : ''
        // NETSCAPE2.0 and ANIMEXTS1.0 carry loop counts. Their payload bytes are skipped, not scanned: uploads
        // are admin-only and are served as sandboxed, nosniff images, so the bytes are never executed.
        if (id !== 'NETSCAPE2.0' && id !== 'ANIMEXTS1.0') metadata = true
      } else {
        metadata = true // comment (0xfe), plain text (0x01) and unknown extensions
      }
      const next = skipSubBlocks(b, off + 2)
      if (next < 0) return { ok: false, error: GIF_BROKEN }
      off = next
    } else if (introducer === 0x2c) {
      if (off + 10 > b.length) return { ok: false, error: GIF_BROKEN }
      const x = u16le(b, off + 1)
      const y = u16le(b, off + 3)
      const w = u16le(b, off + 5)
      const h = u16le(b, off + 7)
      if (w === 0 || h === 0 || x + w > width || y + h > height) {
        return { ok: false, error: `Khung hình GIF nằm ngoài khung ảnh (${x + w}×${y + h} trên ${width}×${height})` }
      }
      const packed = b[off + 9]!
      off += 10
      if (packed & 0x80) off += 3 * 2 ** ((packed & 7) + 1)
      off += 1 // LZW minimum code size
      const next = skipSubBlocks(b, off)
      if (next < 0) return { ok: false, error: GIF_BROKEN }
      off = next
      frames++
    } else {
      return { ok: false, error: GIF_BROKEN }
    }
  }
  if (frames === 0) return { ok: false, error: 'Tệp GIF không có khung hình' }
  return { ok: true, width, height, frames, transparent, metadata }
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
  if (mime === 'image/gif') {
    const sig = type4(bytes, 0)
    if (sig !== 'GIF8' || (bytes[4] !== 0x37 && bytes[4] !== 0x39) || bytes[5] !== 0x61) {
      return { ok: false, error: 'Tệp không đúng định dạng ảnh đã chọn (kiểm tra chữ ký tệp)' }
    }
    const gif = parseGif(bytes)
    if (!gif.ok) return gif
    if (gif.metadata) return { ok: false, error: METADATA_MESSAGE }
    return {
      ok: true,
      info: { mime, width: gif.width, height: gif.height, hasAlpha: gif.transparent, animated: gif.frames > 1, exif: false, frames: gif.frames },
    }
  }

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
        frames: 1,
      },
    }
  }

  if (mime === 'image/jpeg') {
    const dims = checkDimensions(mime, bytes)
    if (dims === 'exif') return { ok: false, error: METADATA_MESSAGE }
    if (dims === null) return { ok: false, error: 'Không đọc được kích thước ảnh JPEG' }
    return {
      ok: true,
      info: { mime, width: dims.w, height: dims.h, hasAlpha: false, animated: false, exif: jpegHasMetadata(bytes), frames: 1 },
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
    if (animated) {
      if (scan.rects.length === 0) return { ok: false, error: 'Ảnh WebP động không có khung hình' }
      for (const r of scan.rects) {
        if (r.x + r.w > dims.w || r.y + r.h > dims.h) {
          return { ok: false, error: `Khung hình WebP nằm ngoài khung ảnh (${r.x + r.w}×${r.y + r.h} trên ${dims.w}×${dims.h})` }
        }
      }
    }
    return {
      ok: true,
      info: { mime, width: dims.w, height: dims.h, hasAlpha, animated, exif: scan.metadata, frames: animated ? Math.max(scan.rects.length, 1) : 1 },
    }
  }

  return { ok: false, error: 'Định dạng không được hỗ trợ (chỉ PNG, JPEG, WebP)' }
}
