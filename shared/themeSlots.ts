/**
 * Theme slot specs for the gift tree (Phase 3, ADR-5, FR-14..FR-17). Shared by the worker (server
 * validation) and the admin editor (pre-check and checklist), so the rules are written once.
 *
 * Static-images cut: animated GIF/WebP, sprite grids (box openings), layer_far and overlay_loop are
 * not in this list. Their absence is deliberate: they belong to a later cut.
 */

export type ThemeFormat = 'image/png' | 'image/jpeg' | 'image/webp'

export type ThemeSlotSpec = {
  slot: string
  /** Purpose shown in the admin editor. */
  purpose: string
  formats: ReadonlyArray<ThemeFormat>
  width: number
  height: number
  /** true: transparency required; false: transparency refused; null: either. */
  transparent: boolean | null
  maxBytes: number
}

const KB = 1024
const PNG_WEBP: ThemeFormat[] = ['image/png', 'image/webp']
const ALL_RASTER: ThemeFormat[] = ['image/jpeg', 'image/png', 'image/webp']

function ornament(n: number): ThemeSlotSpec {
  return { slot: `ornament_${n}`, purpose: `Vật trang trí ${n}`, formats: PNG_WEBP, width: 256, height: 256, transparent: true, maxBytes: 150 * KB }
}
function box(n: number): ThemeSlotSpec {
  return { slot: `box_${n}_closed`, purpose: `Hộp quà ${n} (đóng)`, formats: PNG_WEBP, width: 512, height: 512, transparent: true, maxBytes: 200 * KB }
}

export const THEME_SLOTS: ReadonlyArray<ThemeSlotSpec> = [
  { slot: 'sky_portrait', purpose: 'Nền màn hình dọc (điện thoại)', formats: ALL_RASTER, width: 1080, height: 1920, transparent: false, maxBytes: 600 * KB },
  { slot: 'sky_landscape', purpose: 'Nền màn hình ngang (máy tính)', formats: ALL_RASTER, width: 1920, height: 1080, transparent: false, maxBytes: 600 * KB },
  { slot: 'layer_ground', purpose: 'Nền tuyết phía trước', formats: PNG_WEBP, width: 1920, height: 500, transparent: true, maxBytes: 400 * KB },
  { slot: 'tree', purpose: 'Cây thông (không có đồ trang trí)', formats: PNG_WEBP, width: 1200, height: 1600, transparent: true, maxBytes: 800 * KB },
  { slot: 'star', purpose: 'Ngôi sao trên ngọn', formats: PNG_WEBP, width: 256, height: 256, transparent: true, maxBytes: 300 * KB },
  ornament(1), ornament(2), ornament(3), ornament(4), ornament(5), ornament(6),
  box(1), box(2), box(3), box(4), box(5), box(6),
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
}

export type ThemeValidation = { ok: true } | { ok: false; errors: string[] }

/** Formats the size limit in KB, as the editor shows it. */
function kb(bytes: number): string {
  return `${Math.round(bytes / KB)} KB`
}

/**
 * Checks one uploaded image against its slot. Every message names the rule and, where a number is
 * involved, the actual value (AC-7). The caller has already read the file's real format and size.
 */
export function validateThemeImage(spec: ThemeSlotSpec, img: ThemeImageInfo): ThemeValidation {
  const errors: string[] = []
  if (!(spec.formats as ReadonlyArray<string>).includes(img.mime)) {
    errors.push(`Định dạng không được chấp nhận (${img.mime}). Chỉ dùng: ${spec.formats.join(', ')}`)
  }
  if (img.animated) {
    errors.push('Ảnh động chưa được hỗ trợ ở phiên bản này. Dùng ảnh tĩnh.')
  }
  if (img.width !== spec.width || img.height !== spec.height) {
    errors.push(`Kích thước phải ${spec.width}×${spec.height} (ảnh của bạn ${img.width}×${img.height})`)
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
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
