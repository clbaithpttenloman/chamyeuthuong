/**
 * shared/campaign.ts — campaign model utilities shared between worker and frontend.
 *
 * CAMPAIGN_KINDS:    the two supported campaign types.
 * RESERVED_SLUGS:   path segments that must never match a campaign slug.
 * isValidSlug:      validates a slug by length, charset, and reserved words.
 * validateSettings: validates + fills defaults for per-kind settings.
 * isEffectivelyOpen: status=active AND now BETWEEN starts_at AND ends_at (inclusive).
 */

export const CAMPAIGN_KINDS = ['teacher_cards', 'gift_tree'] as const
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number]

export const RESERVED_SLUGS: Set<string> = new Set([
  'admin',
  'api',
  't',
  'gui-thiep',
  've-clb-ai',
  'assets',
  'theme',
  'g',
  'dang-ky',
  'dang-nhap',
])

/** True iff the value is a valid, non-reserved campaign slug. */
export function isValidSlug(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length < 2 || value.length > 32) return false
  if (!/^[a-z0-9-]+$/.test(value)) return false
  if (RESERVED_SLUGS.has(value)) return false
  return true
}

// ---- Settings ----

/** Settings for teacher_cards campaigns (no configurable numeric fields). */
type TeacherCardsSettings = Record<string, never>

/** Settings for gift_tree campaigns. */
export interface GiftTreeSettings {
  report_threshold: number  // 2–20, default 3
  hearts_per_day: number    // 1–20, default 5
  gifts_per_user: number    // 1–10, default 3
  tree_slots: number        // 5–25, default 15
  ground_slots: number      // 0–15, default 10
}

/** Discriminated result used by validateSettings. */
export type SettingsResult<T> =
  | { ok: true; value: T }
  | { ok: false; field: string }

const GIFT_TREE_DEFAULTS: GiftTreeSettings = {
  report_threshold: 3,
  hearts_per_day: 5,
  gifts_per_user: 3,
  tree_slots: 15,
  ground_slots: 10,
}

const GIFT_TREE_RANGES: Record<keyof GiftTreeSettings, [number, number]> = {
  report_threshold: [2, 20],
  hearts_per_day: [1, 20],
  gifts_per_user: [1, 10],
  tree_slots: [5, 25],
  ground_slots: [0, 15],
}

/**
 * Validates settings for the given kind, fills missing fields with defaults, and returns
 * `{ ok: true, value }` on success or `{ ok: false, field }` on the first invalid field.
 */
export function validateSettings(
  kind: CampaignKind,
  settings: unknown,
): SettingsResult<GiftTreeSettings | TeacherCardsSettings> {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, field: 'settings' }
  }
  const s = settings as Record<string, unknown>

  if (kind === 'teacher_cards') {
    return { ok: true, value: {} as TeacherCardsSettings }
  }

  if (kind === 'gift_tree') {
    const out = { ...GIFT_TREE_DEFAULTS }
    for (const field of Object.keys(GIFT_TREE_RANGES) as (keyof GiftTreeSettings)[]) {
      const raw = s[field]
      if (raw === undefined) continue // use default
      const [min, max] = GIFT_TREE_RANGES[field]
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
        return { ok: false, field }
      }
      out[field] = raw
    }
    return { ok: true, value: out }
  }

  return { ok: false, field: 'kind' }
}

// ---- Effective-open check ----

type CampaignRow = {
  status: 'draft' | 'active' | 'closed'
  starts_at: string // ISO UTC
  ends_at: string   // ISO UTC
}

/**
 * Returns true iff the campaign is status=active AND `now` falls within [starts_at, ends_at]
 * (both endpoints inclusive, second precision — truncates sub-second parts so the check
 * is consistent with the SQL BETWEEN using nowSecond() on both sides).
 */
export function isEffectivelyOpen(campaign: CampaignRow, now: Date): boolean {
  if (campaign.status !== 'active') return false
  // Truncate to second precision on both sides to avoid string-ordering edge where
  // '...T23:59:59.999Z' compares greater than stored '...T23:59:59Z'. Also prevents
  // the inverse edge where now > ends_at by sub-second when the last second is valid.
  const toSecMs = (iso: string) => Math.floor(new Date(iso).getTime() / 1000) * 1000
  const start = toSecMs(campaign.starts_at)
  const end   = toSecMs(campaign.ends_at)
  const t     = Math.floor(now.getTime() / 1000) * 1000
  return t >= start && t <= end
}
