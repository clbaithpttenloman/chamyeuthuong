/**
 * Card layouts (card v3): a layout is geometry, not a colour theme.
 * `ratio` fixes the card shape; `zone` is where the wish is written, in % of the card.
 * The template's background image is the whole card face; admins pick an image that
 * leaves the zone clear.
 */

/** The only image slot a template has. Banner and photo were removed. */
export const SLOTS = ['background'] as const
export type Slot = (typeof SLOTS)[number]

export type Ratio = 'portrait' | 'landscape'
export type Zone = { x: number; y: number; w: number; h: number }
export type Layout = { id: string; name: string; ratio: Ratio; zone: Zone }

/** Six common physical-card layouts: portrait 3:4, landscape 4:3. */
export const LAYOUTS: Layout[] = [
  { id: 'doc-giua', name: 'Dọc – giữa', ratio: 'portrait', zone: { x: 14, y: 16, w: 72, h: 68 } },
  { id: 'doc-duoi', name: 'Dọc – nửa dưới', ratio: 'portrait', zone: { x: 9, y: 44, w: 82, h: 50 } },
  { id: 'doc-tren', name: 'Dọc – nửa trên', ratio: 'portrait', zone: { x: 9, y: 6, w: 82, h: 50 } },
  { id: 'ngang-giua', name: 'Ngang – giữa', ratio: 'landscape', zone: { x: 18, y: 14, w: 64, h: 72 } },
  { id: 'ngang-phai', name: 'Ngang – nửa phải', ratio: 'landscape', zone: { x: 47, y: 9, w: 47, h: 82 } },
  { id: 'ngang-trai', name: 'Ngang – nửa trái', ratio: 'landscape', zone: { x: 6, y: 9, w: 47, h: 82 } },
]

export const DEFAULT_LAYOUT = 'doc-giua'

/** Pre-v3 colour themes still stored in old template rows, mapped at read time. */
export const LEGACY_LAYOUTS: Readonly<Record<string, string>> = Object.freeze({
  classic: 'doc-giua',
  lotus: 'doc-giua',
  spring: 'doc-giua',
  minimal: 'doc-giua',
  night: 'ngang-giua',
})

const byId = new Map(LAYOUTS.map((l) => [l.id, l]))
const legacy = new Map(Object.entries(LEGACY_LAYOUTS))

/** Write validation: true only for the six current ids (legacy ids are rejected). */
export function isLayout(id: string): boolean {
  return byId.has(id)
}

/** Read: current id → itself; legacy id → mapped layout; anything else → the default. */
export function resolveLayout(id: unknown): Layout {
  if (typeof id === 'string') {
    const found = byId.get(id) ?? byId.get(legacy.get(id) ?? '')
    if (found) return found
  }
  return byId.get(DEFAULT_LAYOUT)!
}

/** Returns true iff `s` is a known slot name. */
export function isSlot(s: string): boolean {
  return (SLOTS as readonly string[]).includes(s)
}
