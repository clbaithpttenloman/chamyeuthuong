/** Admin-facing checklist text for one theme slot. Pure, so the section and its test share it. */
import { SPRITE_CELL, SPRITE_MAX_SIDE, SPRITE_SIDE_CELLS, SPRITE_TOTAL_CELLS, type ThemeSlotSpec } from '../../../shared/themeSlots.ts'

const FORMAT_LABEL: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
}

function animationLine(spec: ThemeSlotSpec): string {
  if (spec.animation === 'loop' && spec.frames) {
    return `Hoạt ảnh: GIF hoặc WebP động lặp tự động, tối đa ${spec.frames.max} khung hình (ảnh tĩnh cũng được)`
  }
  if (spec.animation === 'sprite' && spec.fps) {
    return `Hoạt ảnh: lưới khung hình, chạy một lần khi mở hộp. Ô ${SPRITE_CELL}×${SPRITE_CELL} px, ${SPRITE_SIDE_CELLS.min}–${SPRITE_SIDE_CELLS.max} ô mỗi cạnh, ${SPRITE_TOTAL_CELLS.min}–${SPRITE_TOTAL_CELLS.max} khung, tối đa ${SPRITE_MAX_SIDE}×${SPRITE_MAX_SIDE} px. Khai báo ${spec.fps.min}–${spec.fps.max} fps khi tải lên`
  }
  return 'Hoạt ảnh: không (ảnh tĩnh)'
}

export function slotChecklist(spec: ThemeSlotSpec): string[] {
  const background = spec.transparent === true
    ? 'phải trong suốt'
    : spec.transparent === false
      ? 'không được trong suốt'
      : 'có thể trong suốt hoặc không'
  const size = spec.animation === 'sprite'
    ? `Kích thước: ô ${SPRITE_CELL}×${SPRITE_CELL} px (lưới ghép từ các ô)`
    : `Kích thước: ${spec.width}×${spec.height} px`
  return [
    size,
    `Định dạng: ${spec.formats.map((f) => FORMAT_LABEL[f] ?? f).join(', ')}`,
    `Nền: ${background}`,
    animationLine(spec),
    `Dung lượng tối đa: ${Math.round(spec.maxBytes / 1024)} KB`,
  ]
}
