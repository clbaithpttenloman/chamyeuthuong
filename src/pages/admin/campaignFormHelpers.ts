/**
 * src/pages/admin/campaignFormHelpers.ts — pure form↔row mapping for the campaign editor.
 *
 * Extracted so the mapping logic can be unit-tested without a React environment.
 *
 * rowToForm: converts a full admin campaign row (including content/settings/theme_colors)
 *            into CampaignFormState for the editor form.
 * formToInput: converts CampaignFormState into the snake_case input sent to the API.
 *              For PATCH (editing=true) slug, kind, and status are omitted — they are
 *              immutable or controlled via dedicated activate/close endpoints.
 */

import { CAMPAIGN_KINDS, validateSettings } from '../../../shared/campaign.ts'
import type { CampaignKind } from '../../../shared/campaign.ts'
import type { AdminCampaignInput } from '../../api.ts'

// ── Date helpers (Vietnam = UTC+7, no DST) ────────────────────────────────

const VN_OFFSET_MS = 7 * 60 * 60 * 1000

/** "YYYY-MM-DDTHH:MM" in Vietnam time ← UTC ISO string */
export function utcToVnDatetime(utcStr: string): string {
  if (!utcStr) return ''
  const d = new Date(utcStr)
  if (isNaN(d.getTime())) return ''
  const vnDate = new Date(d.getTime() + VN_OFFSET_MS)
  return vnDate.toISOString().slice(0, 16)
}

/** UTC ISO string ← "YYYY-MM-DDTHH:MM" in Vietnam time */
export function vnDatetimeToUtc(localStr: string): string {
  if (!localStr) return ''
  const d = new Date(localStr + ':00+07:00')
  if (isNaN(d.getTime())) return ''
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// ── Settings ──────────────────────────────────────────────────────────────

export type GiftTreeSettings = {
  report_threshold: number
  hearts_per_day: number
  gifts_per_user: number
  tree_slots: number
  ground_slots: number
}

export const DEFAULT_GIFT_TREE_SETTINGS: GiftTreeSettings = {
  report_threshold: 3,
  hearts_per_day: 5,
  gifts_per_user: 3,
  tree_slots: 15,
  ground_slots: 10,
}

export const GIFT_TREE_RANGES: Record<keyof GiftTreeSettings, [number, number, string]> = {
  report_threshold: [2, 20, 'Báo cáo tự ẩn sau'],
  hearts_per_day: [1, 20, 'Tim mỗi ngày'],
  gifts_per_user: [1, 10, 'Quà mỗi người'],
  tree_slots: [5, 25, 'Ô trên cây'],
  ground_slots: [0, 15, 'Ô dưới đất'],
}

/**
 * Parse and clamp a raw settings input string.
 * Returns the default for the key when the value is empty, NaN, or out of range.
 * Used to separate display (raw string while typing) from validated numbers (blur/submit).
 * Exported for unit testing.
 */
export function clampSetting(key: keyof GiftTreeSettings, raw: string): number {
  const [min, max] = GIFT_TREE_RANGES[key]
  const n = parseInt(raw, 10)
  if (isNaN(n)) return DEFAULT_GIFT_TREE_SETTINGS[key]
  return Math.max(min, Math.min(max, n))
}

// ── Form state type ───────────────────────────────────────────────────────

export type CampaignFormState = {
  slug: string
  kind: CampaignKind
  name: string
  tagline: string
  content: string        // raw JSON string
  themeColors: string    // raw JSON string (kept for display; not in PATCH body)
  startsAt: string       // Vietnam local datetime "YYYY-MM-DDTHH:MM"
  endsAt: string
  status: string
  settings: GiftTreeSettings
}

export type AdminCampaignFullRow = {
  id: number
  slug: string
  kind: string
  name: string
  tagline: string
  content: string
  theme_colors: string
  settings: string
  starts_at: string
  ends_at: string
  status: string
  created_at?: string
  created_by?: string
}

/** Default form state used when creating a new campaign. */
export function defaultForm(): CampaignFormState {
  return {
    slug: '',
    kind: 'teacher_cards',
    name: '',
    tagline: '',
    content: '{}',
    themeColors: '{}',
    startsAt: '',
    endsAt: '',
    status: 'draft',
    settings: { ...DEFAULT_GIFT_TREE_SETTINGS },
  }
}

/** Parse a JSON object string; returns '{}' on any parse failure. */
function safeJsonObj(s: string): string {
  try {
    const v = JSON.parse(s)
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return s
  } catch { /* ignore */ }
  return '{}'
}

/** Parse settings from a JSON string with defaults for the given kind. */
function parseSettings(kind: string, raw: string): GiftTreeSettings {
  if (kind !== 'gift_tree') return { ...DEFAULT_GIFT_TREE_SETTINGS }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_GIFT_TREE_SETTINGS }
    }
    const result = validateSettings('gift_tree', parsed)
    return result.ok ? (result.value as GiftTreeSettings) : { ...DEFAULT_GIFT_TREE_SETTINGS }
  } catch {
    return { ...DEFAULT_GIFT_TREE_SETTINGS }
  }
}

/**
 * Convert a full admin campaign row into form state for the editor.
 * Preserves content, theme_colors, and settings from the full row — not defaults.
 */
export function rowToForm(row: AdminCampaignFullRow): CampaignFormState {
  const kind = CAMPAIGN_KINDS.includes(row.kind as CampaignKind)
    ? (row.kind as CampaignKind)
    : 'teacher_cards'
  return {
    slug: row.slug,
    kind,
    name: row.name,
    tagline: row.tagline,
    content: safeJsonObj(row.content),
    themeColors: safeJsonObj(row.theme_colors),
    startsAt: utcToVnDatetime(row.starts_at),
    endsAt: utcToVnDatetime(row.ends_at),
    status: row.status,
    settings: parseSettings(kind, row.settings),
  }
}

/**
 * Convert form state into the API input sent on save.
 *
 * editing=true  (PATCH): omits slug, kind, status — these are immutable or
 *   controlled via /activate and /close endpoints.
 * editing=false (POST): includes slug, kind, status.
 */
export function formToInput(form: CampaignFormState, editing: boolean): AdminCampaignInput {
  const startsUtc = vnDatetimeToUtc(form.startsAt)
  const endsUtc = vnDatetimeToUtc(form.endsAt)
  const settingsResult = validateSettings(form.kind, form.settings)
  const settingsStr = settingsResult.ok ? JSON.stringify(settingsResult.value) : '{}'

  // Normalise content: parse then re-stringify to canonical form
  let contentStr: string
  try {
    contentStr = JSON.stringify(JSON.parse(form.content))
  } catch {
    contentStr = '{}'
  }

  if (editing) {
    // PATCH: slug, kind, status must NOT be sent (immutable or via dedicated endpoints)
    return {
      name: form.name.trim(),
      tagline: form.tagline.trim(),
      content: contentStr,
      settings: settingsStr,
      starts_at: startsUtc,
      ends_at: endsUtc,
    }
  }

  // POST: include all fields
  return {
    slug: form.slug,
    kind: form.kind,
    name: form.name.trim(),
    tagline: form.tagline.trim(),
    content: contentStr,
    settings: settingsStr,
    starts_at: startsUtc,
    ends_at: endsUtc,
    status: form.status,
  }
}
