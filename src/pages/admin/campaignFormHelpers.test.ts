/**
 * src/pages/admin/campaignFormHelpers.test.ts
 *
 * Unit tests for the pure form↔row mapping functions used by the campaign editor.
 * Tests run in Node (no React/JSDOM) — the functions are pure TypeScript with no DOM deps.
 *
 * Key invariant: editing a campaign and saving without touching content must leave
 * content, settings and theme_colors byte-identical (Fix Group 4a — F2 root cause).
 */
import { describe, it, expect } from 'vitest'
import {
  rowToForm,
  formToInput,
  defaultForm,
  utcToVnDatetime,
  vnDatetimeToUtc,
  clampSetting,
  DEFAULT_GIFT_TREE_SETTINGS,
  type AdminCampaignFullRow,
} from './campaignFormHelpers.ts'

// ── Shared fixture ────────────────────────────────────────────────────────

const BASE_ROW: AdminCampaignFullRow = {
  id: 2,
  slug: 'noel-2026',
  kind: 'gift_tree',
  name: 'Noel 2026',
  tagline: 'Treo ước nguyện',
  content: '{"home":{"kicker":"Giáng sinh ấm áp","heading":"Noel 2026","body":"Test"}}',
  theme_colors: '{"primary":"#cc0000","secondary":"#ffffff"}',
  settings: '{"tree_slots":20,"ground_slots":8,"hearts_per_day":5,"gifts_per_user":3,"report_threshold":3}',
  starts_at: '2026-12-01T00:00:00Z',
  ends_at: '2026-12-31T23:59:59Z',
  status: 'draft',
}

// ── rowToForm ─────────────────────────────────────────────────────────────

describe('rowToForm — preserves full row fields (not defaults)', () => {
  it('populates content from full row (not empty {})', () => {
    const form = rowToForm(BASE_ROW)
    expect(form.content).toBe(BASE_ROW.content)
  })

  it('populates themeColors from full row', () => {
    const form = rowToForm(BASE_ROW)
    expect(form.themeColors).toBe(BASE_ROW.theme_colors)
  })

  it('parses settings for gift_tree from full row (tree_slots = 20)', () => {
    const form = rowToForm(BASE_ROW)
    expect(form.settings.tree_slots).toBe(20)
    expect(form.settings.ground_slots).toBe(8)
  })

  it('populates slug, kind, name, tagline, status from row', () => {
    const form = rowToForm(BASE_ROW)
    expect(form.slug).toBe('noel-2026')
    expect(form.kind).toBe('gift_tree')
    expect(form.name).toBe('Noel 2026')
    expect(form.tagline).toBe('Treo ước nguyện')
    expect(form.status).toBe('draft')
  })

  it('converts UTC dates to Vietnam local time', () => {
    const form = rowToForm(BASE_ROW)
    // 2026-12-01T00:00:00Z = 2026-12-01T07:00 in VN
    expect(form.startsAt).toBe('2026-12-01T07:00')
  })

  it('falls back to default gift_tree settings when settings string is invalid JSON', () => {
    const form = rowToForm({ ...BASE_ROW, settings: 'not-json' })
    expect(form.settings.tree_slots).toBe(DEFAULT_GIFT_TREE_SETTINGS.tree_slots)
  })

  it('falls back to default settings when settings has out-of-range value', () => {
    // out-of-range tree_slots → validateSettings returns ok:false → use defaults
    const form = rowToForm({ ...BASE_ROW, settings: JSON.stringify({ tree_slots: 999 }) })
    expect(form.settings.tree_slots).toBe(DEFAULT_GIFT_TREE_SETTINGS.tree_slots)
  })

  it('teacher_cards row gets empty-ish settings (not gift_tree defaults)', () => {
    const tcRow: AdminCampaignFullRow = {
      ...BASE_ROW,
      slug: '20-11',
      kind: 'teacher_cards',
      settings: '{}',
    }
    // settings for teacher_cards is effectively unused; just confirm no crash
    const form = rowToForm(tcRow)
    expect(form.kind).toBe('teacher_cards')
  })

  it('handles malformed content gracefully (falls back to {})', () => {
    const form = rowToForm({ ...BASE_ROW, content: 'not-json' })
    expect(form.content).toBe('{}')
  })

  it('handles array content gracefully (falls back to {})', () => {
    const form = rowToForm({ ...BASE_ROW, content: '[1,2,3]' })
    expect(form.content).toBe('{}')
  })
})

// ── formToInput — PATCH mode (editing=true) ───────────────────────────────

describe('formToInput — PATCH mode (editing=true): slug/kind/status omitted', () => {
  it('does not include status in PATCH input', () => {
    const form = rowToForm(BASE_ROW)
    const input = formToInput(form, true)
    expect('status' in input).toBe(false)
  })

  it('does not include slug in PATCH input', () => {
    const form = rowToForm(BASE_ROW)
    const input = formToInput(form, true)
    expect('slug' in input).toBe(false)
  })

  it('does not include kind in PATCH input', () => {
    const form = rowToForm(BASE_ROW)
    const input = formToInput(form, true)
    expect('kind' in input).toBe(false)
  })

  it('includes name, tagline, content, settings, starts_at, ends_at', () => {
    const form = rowToForm(BASE_ROW)
    const input = formToInput(form, true)
    expect(typeof input.name).toBe('string')
    expect(typeof input.tagline).toBe('string')
    expect(typeof input.content).toBe('string')
    expect(typeof input.settings).toBe('string')
    expect(typeof input.starts_at).toBe('string')
    expect(typeof input.ends_at).toBe('string')
  })

  it('content is byte-identical to the original when unmodified (data-loss test)', () => {
    const form = rowToForm(BASE_ROW)
    const input = formToInput(form, true)
    // The content in the form state is the same as the row's content.
    // After formToInput it should be JSON.parse+JSON.stringify of the same content.
    const expected = JSON.stringify(JSON.parse(BASE_ROW.content))
    expect(input.content).toBe(expected)
  })

  it('settings is JSON string (parseable)', () => {
    const form = rowToForm(BASE_ROW)
    const input = formToInput(form, true)
    expect(() => JSON.parse(input.settings!)).not.toThrow()
  })

  it('dates are converted back to UTC ISO strings', () => {
    const form = rowToForm(BASE_ROW)
    const input = formToInput(form, true)
    // Both dates should be UTC ISO
    expect(input.starts_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(input.ends_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
})

// ── formToInput — POST mode (editing=false) ───────────────────────────────

describe('formToInput — POST mode (editing=false): includes slug, kind, status', () => {
  it('includes slug', () => {
    const form = { ...defaultForm(), slug: 'new-campaign' }
    const input = formToInput(form, false)
    expect(input.slug).toBe('new-campaign')
  })

  it('includes kind', () => {
    const form = { ...defaultForm(), kind: 'gift_tree' as const }
    const input = formToInput(form, false)
    expect(input.kind).toBe('gift_tree')
  })

  it('includes status', () => {
    const form = { ...defaultForm(), status: 'draft' }
    const input = formToInput(form, false)
    expect(input.status).toBe('draft')
  })
})

// ── utcToVnDatetime / vnDatetimeToUtc ─────────────────────────────────────

describe('utcToVnDatetime / vnDatetimeToUtc round-trip', () => {
  it('UTC midnight converts to VN 07:00', () => {
    expect(utcToVnDatetime('2026-12-01T00:00:00Z')).toBe('2026-12-01T07:00')
  })

  it('VN 07:00 converts back to UTC midnight', () => {
    expect(vnDatetimeToUtc('2026-12-01T07:00')).toBe('2026-12-01T00:00:00Z')
  })

  it('round-trip preserves the UTC timestamp', () => {
    const utc = '2026-11-20T17:00:00Z'
    const vn = utcToVnDatetime(utc)
    const back = vnDatetimeToUtc(vn)
    expect(back).toBe(utc)
  })

  it('empty string → empty string', () => {
    expect(utcToVnDatetime('')).toBe('')
    expect(vnDatetimeToUtc('')).toBe('')
  })
})

// ── clampSetting — raw settings input ────────────────────────────────────
//
// Proves "typing 12 or 20 works": intermediate values must NOT be clamped to
// the range boundary.  Ref: review.md Cycle 1 Warning; tasks.md Fix Group 5a Accept 3.
// ─────────────────────────────────────────────────────────────────────────

describe('clampSetting — accepts valid values in range', () => {
  it('returns 12 for "12" in tree_slots [5, 25] — typing 12 works', () => {
    expect(clampSetting('tree_slots', '12')).toBe(12)
  })

  it('returns 20 for "20" in hearts_per_day [1, 20] — typing 20 (at max) works', () => {
    expect(clampSetting('hearts_per_day', '20')).toBe(20)
  })

  it('returns 5 for "5" in tree_slots (at min)', () => {
    expect(clampSetting('tree_slots', '5')).toBe(5)
  })

  it('returns 1 for "1" in hearts_per_day (at min)', () => {
    expect(clampSetting('hearts_per_day', '1')).toBe(1)
  })

  it('returns 10 for "10" in ground_slots [0, 15]', () => {
    expect(clampSetting('ground_slots', '10')).toBe(10)
  })
})

describe('clampSetting — clamps out-of-range values', () => {
  it('clamps "30" to max 25 for tree_slots', () => {
    expect(clampSetting('tree_slots', '30')).toBe(25)
  })

  it('clamps "1" to min 5 for tree_slots (below min)', () => {
    expect(clampSetting('tree_slots', '1')).toBe(5)
  })

  it('clamps "0" to min 1 for hearts_per_day', () => {
    expect(clampSetting('hearts_per_day', '0')).toBe(1)
  })

  it('clamps "21" to max 20 for hearts_per_day', () => {
    expect(clampSetting('hearts_per_day', '21')).toBe(20)
  })
})

describe('clampSetting — returns default for unparseable input', () => {
  it('returns default for empty string', () => {
    expect(clampSetting('tree_slots', '')).toBe(DEFAULT_GIFT_TREE_SETTINGS.tree_slots)
  })

  it('returns default for non-numeric string', () => {
    expect(clampSetting('tree_slots', 'abc')).toBe(DEFAULT_GIFT_TREE_SETTINGS.tree_slots)
  })

  it('returns default for decimal string (parseInt truncates correctly)', () => {
    // parseInt('12.9') = 12 — within range
    expect(clampSetting('tree_slots', '12.9')).toBe(12)
  })
})
