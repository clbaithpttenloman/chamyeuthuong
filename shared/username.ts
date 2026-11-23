/** Username rules for password accounts (ADR-9, FR-32). Shared by worker and client. */

/** Names that must never be registered (admin-looking or staff-looking). */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin',
  'quantri',
  'root',
  'system',
  'clbai',
  'giamthi',
  'support',
])

export type UsernameResult =
  | { ok: true; value: string }
  | { ok: false; code: 'username_invalid' | 'username_reserved' }

const RAW_MAX = 64
const PATTERN = /^[a-z0-9_]{3,20}$/

/**
 * Trims and lower-cases a raw username, then checks the pattern and the reserved list.
 * The raw length is checked before any string work so oversized input costs nothing.
 */
export function normalizeUsername(raw: unknown): UsernameResult {
  if (typeof raw !== 'string' || raw.length > RAW_MAX) return { ok: false, code: 'username_invalid' }
  const value = raw.trim().toLowerCase()
  if (!PATTERN.test(value)) return { ok: false, code: 'username_invalid' }
  if (RESERVED_USERNAMES.has(value)) return { ok: false, code: 'username_reserved' }
  return { ok: true, value }
}
