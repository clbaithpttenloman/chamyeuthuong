/** Admin-facing checklist text for one theme slot. Pure, so the section and its test share it. */
import type { ThemeSlotSpec } from '../../../shared/themeSlots.ts'

const FORMAT_LABEL: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
}

export function slotChecklist(spec: ThemeSlotSpec): string[] {
  const background = spec.transparent === true
    ? 'phải trong suốt'
    : spec.transparent === false
      ? 'không được trong suốt'
      : 'có thể trong suốt hoặc không'
  return [
    `Kích thước: ${spec.width}×${spec.height} px`,
    `Định dạng: ${spec.formats.map((f) => FORMAT_LABEL[f] ?? f).join(', ')}`,
    `Nền: ${background}`,
    `Dung lượng tối đa: ${Math.round(spec.maxBytes / 1024)} KB`,
  ]
}
