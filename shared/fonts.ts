/**
 * Student choices when writing a card (card v3): font and ink colour.
 *
 * Both values end up in a `style` on public pages, and the CSP allows inline styles, so the
 * only control is validation: the server accepts only these ids / `#rrggbb`, and every
 * renderer goes through resolveFont / resolveInk. A stored font id never reaches CSS itself —
 * it maps to the fixed `stack` below.
 */

export type Font = { id: string; family: string; label: string; stack: string }

/** Supported fonts, all with a Vietnamese subset (self-hosted via @fontsource, 400 weight). */
export const FONTS: Font[] = [
  { id: 'patrick-hand', family: 'Patrick Hand', label: 'Bút bi', stack: "'Patrick Hand', 'Be Vietnam Pro', sans-serif" },
  { id: 'pangolin', family: 'Pangolin', label: 'Bút dạ', stack: "'Pangolin', 'Be Vietnam Pro', sans-serif" },
  { id: 'itim', family: 'Itim', label: 'Chữ tròn', stack: "'Itim', 'Be Vietnam Pro', sans-serif" },
  { id: 'mali', family: 'Mali', label: 'Nét mảnh', stack: "'Mali', 'Be Vietnam Pro', sans-serif" },
  { id: 'charm', family: 'Charm', label: 'Thư pháp', stack: "'Charm', 'Lora', serif" },
  { id: 'be-vietnam-pro', family: 'Be Vietnam Pro', label: 'Chữ in', stack: "'Be Vietnam Pro', system-ui, sans-serif" },
  { id: 'lora', family: 'Lora', label: 'Có chân', stack: "'Lora', Georgia, serif" },
]
export const DEFAULT_FONT = 'patrick-hand'

const fontsById = new Map(FONTS.map((f) => [f.id, f]))

/** Exact id match (Map lookup, so prototype keys such as `__proto__` are rejected). */
export function isFont(v: unknown): v is string {
  return typeof v === 'string' && fontsById.has(v)
}

/** Read fallback: unknown or retired ids render with the default font. */
export function resolveFont(v: unknown): Font {
  return (typeof v === 'string' && fontsById.get(v)) || fontsById.get(DEFAULT_FONT)!
}

/** Student pen colours. Custom colours are any #rrggbb. */
export const INKS = [
  { value: '#1d3fa6', label: 'Xanh' },
  { value: '#1c1917', label: 'Đen' },
  { value: '#6b21a8', label: 'Tím' },
] as const
export const DEFAULT_INK = '#1d3fa6'

/** Submit validation on the raw string: `#` + 6 hex digits, either case, nothing else. */
export function isInkInput(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
}

/** Lowercase a value that passed isInkInput (the stored form; DB CHECK expects lowercase). */
export function normalizeInk(v: string): string {
  return v.toLowerCase()
}

/** Read fallback: only a stored lowercase #rrggbb is used; anything else → the default ink. */
export function resolveInk(v: unknown): string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v) ? v : DEFAULT_INK
}
