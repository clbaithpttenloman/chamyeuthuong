/** Slot identifiers for image slots that every layout renders. Photo slot is removed. */
export const SLOTS = ['background', 'banner'] as const
export type Slot = (typeof SLOTS)[number]

export type Layout = { id: string; name: string }

/** Five preset layout definitions — id used as CSS class suffix `.card--<id>`. */
export const LAYOUTS: Layout[] = [
  { id: 'classic', name: 'Cổ điển' },
  { id: 'lotus', name: 'Hoa sen' },
  { id: 'spring', name: 'Mùa xuân' },
  { id: 'night', name: 'Đêm sao' },
  { id: 'minimal', name: 'Tối giản' },
]

/** Default layout id applied when a card has no style row. */
export const DEFAULT_LAYOUT = 'classic'

/** Returns true iff `id` is a known layout id. */
export function isLayout(id: string): boolean {
  return LAYOUTS.some((l) => l.id === id)
}

/** Returns true iff `s` is a known slot name. */
export function isSlot(s: string): boolean {
  return (SLOTS as readonly string[]).includes(s)
}
