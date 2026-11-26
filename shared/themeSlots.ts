/**
 * Theme slot specs for the gift tree (Phase 3, ADR-5, FR-14..FR-17). Shared by the worker (server
 * validation) and the admin editor (pre-check and checklist), so the rules are written once.
 *
 * Three kinds of slot:
 *   - none:   one still image.
 *   - loop:   an animated GIF or animated WebP that the browser loops (star, overlay_loop). Frame
 *             count is limited; a still image is also accepted.
 *   - sprite: a PNG or WebP sheet of 512×512 cells, read left→right, top→bottom. Frame count = cells.
 *             The admin declares the playback speed (fps) on upload. The box plays it once when opened.
 */

export type ThemeFormat = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export type ThemeAnimation = 'none' | 'loop' | 'sprite'

export type ThemeSlotSpec = {
  slot: string
  /** Purpose shown in the admin editor. */
  purpose: string
  formats: ReadonlyArray<ThemeFormat>
  /** Exact size for none/loop; the cell size (512) for sprite sheets. */
  width: number
  height: number
  /** true: transparency required; false: transparency refused; null: either. */
  transparent: boolean | null
  maxBytes: number
  animation: ThemeAnimation
  /** loop: allowed frame count. */
  frames?: { min: number; max: number }
  /** sprite: allowed playback speed, declared on upload. */
  fps?: { min: number; max: number }
}

/** Decoded animation cap: frames × width × height × 4 bytes. Stops a small file from forcing a huge decode. */
export const MAX_DECODED_BYTES = 64 * 1024 * 1024
/** Sprite sheets: each cell is 512 px, the sheet is at most 2048×2048, 2–4 cells per side, 6–16 cells in total. */
export const SPRITE_CELL = 512
export const SPRITE_MAX_SIDE = 2048
export const SPRITE_SIDE_CELLS = { min: 2, max: 4 } as const
export const SPRITE_TOTAL_CELLS = { min: 6, max: 16 } as const

const KB = 1024
const PNG_WEBP: ThemeFormat[] = ['image/png', 'image/webp']
const ALL_RASTER: ThemeFormat[] = ['image/jpeg', 'image/png', 'image/webp']
const LOOP_FORMATS: ThemeFormat[] = ['image/png', 'image/webp', 'image/gif']
const OVERLAY_FORMATS: ThemeFormat[] = ['image/webp', 'image/gif']

const STILL = { animation: 'none' as const }

function ornament(n: number): ThemeSlotSpec {
  return { slot: `ornament_${n}`, purpose: `Vật trang trí ${n}`, formats: PNG_WEBP, width: 256, height: 256, transparent: true, maxBytes: 150 * KB, ...STILL }
}
function boxClosed(n: number): ThemeSlotSpec {
  return { slot: `box_${n}_closed`, purpose: `Hộp quà ${n} (đóng)`, formats: PNG_WEBP, width: 512, height: 512, transparent: true, maxBytes: 200 * KB, ...STILL }
}
function boxOpen(n: number): ThemeSlotSpec {
  return {
    slot: `box_${n}_open`, purpose: `Hộp quà ${n} (hoạt ảnh mở)`, formats: PNG_WEBP,
    width: SPRITE_CELL, height: SPRITE_CELL, transparent: true, maxBytes: 1024 * KB,
    animation: 'sprite', fps: { min: 12, max: 30 },
  }
}

export const THEME_SLOTS: ReadonlyArray<ThemeSlotSpec> = [
  { slot: 'sky_portrait', purpose: 'Nền màn hình dọc (điện thoại)', formats: ALL_RASTER, width: 1080, height: 1920, transparent: false, maxBytes: 600 * KB, ...STILL },
  { slot: 'sky_landscape', purpose: 'Nền màn hình ngang (máy tính)', formats: ALL_RASTER, width: 1920, height: 1080, transparent: false, maxBytes: 600 * KB, ...STILL },
  { slot: 'layer_far', purpose: 'Cảnh xa phía sau cây', formats: PNG_WEBP, width: 1920, height: 600, transparent: true, maxBytes: 400 * KB, ...STILL },
  { slot: 'layer_ground', purpose: 'Nền tuyết phía trước', formats: PNG_WEBP, width: 1920, height: 500, transparent: true, maxBytes: 400 * KB, ...STILL },
  { slot: 'tree', purpose: 'Cây thông (không có đồ trang trí)', formats: PNG_WEBP, width: 1200, height: 1600, transparent: true, maxBytes: 800 * KB, ...STILL },
  {
    slot: 'star', purpose: 'Ngôi sao trên ngọn', formats: LOOP_FORMATS, width: 256, height: 256, transparent: true, maxBytes: 300 * KB,
    animation: 'loop', frames: { min: 1, max: 24 },
  },
  ornament(1), ornament(2), ornament(3), ornament(4), ornament(5), ornament(6),
  boxClosed(1), boxClosed(2), boxClosed(3), boxClosed(4), boxClosed(5), boxClosed(6),
  boxOpen(1), boxOpen(2), boxOpen(3), boxOpen(4), boxOpen(5), boxOpen(6),
  {
    slot: 'overlay_loop', purpose: 'Hiệu ứng phủ màn hình (tuyết, lấp lánh)', formats: OVERLAY_FORMATS, width: 540, height: 960, transparent: true, maxBytes: 800 * KB,
    animation: 'loop', frames: { min: 1, max: 30 },
  },
]

export function getSlotSpec(slot: string): ThemeSlotSpec | undefined {
  return THEME_SLOTS.find((s) => s.slot === slot)
}

export type ThemeImageInfo = {
  mime: string
  size: number
  width: number
  height: number
  hasAlpha: boolean
  animated: boolean
  /** Frame count: 1 for a still, the GIF or WebP frame count for an animation. */
  frames?: number
}

/**
 * One uploaded slot as the game receives it. fps and the grid (cols × rows) are set for sprite slots;
 * stills and loops have a 1×1 grid and fps null.
 */
export type ThemeAsset = { url: string; frames: number; fps: number | null; cols: number; rows: number }

/** Builds the ThemeAsset the game receives from a stored row. */
export function themeAssetFor(token: string, frames: number, fps: number | null, width: number, height: number, sprite: boolean): ThemeAsset {
  return {
    url: `/api/theme-image/${token}`,
    frames,
    fps,
    cols: sprite ? width / SPRITE_CELL : 1,
    rows: sprite ? height / SPRITE_CELL : 1,
  }
}

export type ThemeValidation = { ok: true; frames: number; fps: number | null } | { ok: false; errors: string[] }

/** Formats the size limit in KB, as the editor shows it. */
function kb(bytes: number): string {
  return `${Math.round(bytes / KB)} KB`
}

/** Sprite sheet cells per side and in total, or null when the sheet size is invalid. */
export function spriteCells(width: number, height: number): { cols: number; rows: number } | null {
  if (width % SPRITE_CELL !== 0 || height % SPRITE_CELL !== 0) return null
  if (width > SPRITE_MAX_SIDE || height > SPRITE_MAX_SIDE) return null
  return { cols: width / SPRITE_CELL, rows: height / SPRITE_CELL }
}

/**
 * Checks one uploaded image against its slot. Every message names the rule and, where a number is
 * involved, the actual value (AC-7). The caller has already read the file's real format and size.
 * On success, returns the frame count to store and the declared fps for sprites.
 */
export function validateThemeImage(spec: ThemeSlotSpec, img: ThemeImageInfo, fps: number | null = null): ThemeValidation {
  const errors: string[] = []
  const frames = img.frames ?? 1

  if (!(spec.formats as ReadonlyArray<string>).includes(img.mime)) {
    errors.push(`Định dạng không được chấp nhận (${img.mime}). Chỉ dùng: ${spec.formats.join(', ')}`)
  }

  if (img.mime === 'image/png' && img.animated) {
    errors.push('APNG chưa được hỗ trợ. Xuất sang GIF hoặc WebP động.')
  } else if (spec.animation === 'sprite') {
    if (img.animated) errors.push('Lưới khung hình phải là ảnh tĩnh (một ảnh chứa tất cả ô).')
    const cells = spriteCells(img.width, img.height)
    if (!cells) {
      errors.push(`Lưới khung hình phải có kích thước bội số ${SPRITE_CELL} px, tối đa ${SPRITE_MAX_SIDE}×${SPRITE_MAX_SIDE} (ảnh của bạn ${img.width}×${img.height})`)
    } else {
      const sideOk = (n: number) => n >= SPRITE_SIDE_CELLS.min && n <= SPRITE_SIDE_CELLS.max
      const total = cells.cols * cells.rows
      if (!sideOk(cells.cols) || !sideOk(cells.rows) || total < SPRITE_TOTAL_CELLS.min || total > SPRITE_TOTAL_CELLS.max) {
        errors.push(`Lưới phải có 2–4 ô mỗi cạnh và 6–16 khung hình (ảnh của bạn ${cells.cols}×${cells.rows} ô = ${total} khung)`)
      }
    }
    if (!spec.fps || fps === null || !Number.isInteger(fps) || fps < spec.fps.min || fps > spec.fps.max) {
      errors.push(`Khai báo tốc độ từ ${spec.fps?.min ?? 12} đến ${spec.fps?.max ?? 30} khung hình/giây (fps)`)
    }
  } else {
    if (img.width !== spec.width || img.height !== spec.height) {
      errors.push(`Kích thước phải ${spec.width}×${spec.height} (ảnh của bạn ${img.width}×${img.height})`)
    }
    if (img.animated) {
      if (spec.animation !== 'loop' || !spec.frames) {
        errors.push('Ảnh động chưa được hỗ trợ cho ô này. Dùng ảnh tĩnh.')
      } else if (frames < spec.frames.min || frames > spec.frames.max) {
        errors.push(`Ảnh động có ${frames} khung hình, cần từ ${spec.frames.min} đến ${spec.frames.max} khung`)
      } else if (frames * img.width * img.height * 4 > MAX_DECODED_BYTES) {
        // Exact dimensions already pin the canvas for every loop slot. This guard is a backstop for a future
        // slot that relaxes the exact size, so it cannot be removed on the assumption that it is redundant.
        const mb = Math.round((frames * img.width * img.height * 4) / (1024 * 1024))
        errors.push(`Ảnh động quá lớn khi giải nén (${mb} MB, tối đa 64 MB). Giảm kích thước hoặc số khung`)
      }
    }
  }

  if (spec.transparent === true && !img.hasAlpha) {
    errors.push('Ảnh phải có nền trong suốt')
  }
  if (spec.transparent === false && img.hasAlpha) {
    errors.push('Ảnh này không được có nền trong suốt')
  }
  if (img.size > spec.maxBytes) {
    errors.push(`Dung lượng tối đa ${kb(spec.maxBytes)} (ảnh của bạn ${kb(img.size)})`)
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, frames: spec.animation === 'sprite' ? (img.width / SPRITE_CELL) * (img.height / SPRITE_CELL) : frames, fps: spec.animation === 'sprite' ? fps : null }
}
