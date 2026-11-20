// @vitest-environment node
// Tests for shared/campaign.ts — campaign utilities (red phase: module does not exist yet)
import { describe, it, expect } from 'vitest'
import {
  CAMPAIGN_KINDS,
  RESERVED_SLUGS,
  isValidSlug,
  validateSettings,
  isEffectivelyOpen,
} from './campaign.ts'

// ---- CAMPAIGN_KINDS ----

describe('CAMPAIGN_KINDS', () => {
  it('is an array', () => {
    expect(Array.isArray(CAMPAIGN_KINDS)).toBe(true)
  })

  it('contains teacher_cards', () => {
    expect(CAMPAIGN_KINDS).toContain('teacher_cards')
  })

  it('contains gift_tree', () => {
    expect(CAMPAIGN_KINDS).toContain('gift_tree')
  })

  it('has exactly 2 entries', () => {
    expect(CAMPAIGN_KINDS).toHaveLength(2)
  })
})

// ---- RESERVED_SLUGS ----

describe('RESERVED_SLUGS', () => {
  it('is an array or Set', () => {
    // Allow either Array or Set (implementation detail)
    const isIterable = Array.isArray(RESERVED_SLUGS) || RESERVED_SLUGS instanceof Set
    expect(isIterable).toBe(true)
  })

  it.each([
    'admin',
    'api',
    't',
    'gui-thiep',
    've-clb-ai',
    'assets',
    'theme',
    'g',
  ])('includes reserved slug %s', (slug) => {
    const has = Array.isArray(RESERVED_SLUGS)
      ? (RESERVED_SLUGS as string[]).includes(slug)
      : (RESERVED_SLUGS as Set<string>).has(slug)
    expect(has, `expected RESERVED_SLUGS to contain '${slug}'`).toBe(true)
  })
})

// ---- isValidSlug ----

describe('isValidSlug — accepts valid slugs', () => {
  it('accepts 2-char slug (minimum length)', () => {
    expect(isValidSlug('ab')).toBe(true)
  })

  it('accepts 32-char slug (maximum length)', () => {
    expect(isValidSlug('a'.repeat(32))).toBe(true)
  })

  it('accepts lowercase letters only', () => {
    expect(isValidSlug('abc')).toBe(true)
  })

  it('accepts digits only', () => {
    expect(isValidSlug('123')).toBe(true)
  })

  it('accepts lowercase + digits + hyphens', () => {
    expect(isValidSlug('20-11')).toBe(true)
  })

  it('accepts hyphen in the middle', () => {
    expect(isValidSlug('a-b-c')).toBe(true)
  })
})

describe('isValidSlug — rejects invalid slugs', () => {
  it('rejects single char (too short)', () => {
    expect(isValidSlug('a')).toBe(false)
  })

  it('rejects 33-char slug (too long)', () => {
    expect(isValidSlug('a'.repeat(33))).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidSlug('')).toBe(false)
  })

  it('rejects uppercase letter', () => {
    expect(isValidSlug('Ab')).toBe(false)
  })

  it('rejects all-uppercase', () => {
    expect(isValidSlug('ABC')).toBe(false)
  })

  it('rejects underscore (a_b)', () => {
    expect(isValidSlug('a_b')).toBe(false)
  })

  it('rejects space (a b)', () => {
    expect(isValidSlug('a b')).toBe(false)
  })

  it('rejects number type', () => {
    expect(isValidSlug(42)).toBe(false)
  })

  it('rejects null', () => {
    expect(isValidSlug(null)).toBe(false)
  })

  it('rejects undefined', () => {
    expect(isValidSlug(undefined)).toBe(false)
  })

  it('rejects object', () => {
    expect(isValidSlug({ slug: 'ab' })).toBe(false)
  })

  it('rejects reserved slug "admin"', () => {
    expect(isValidSlug('admin')).toBe(false)
  })

  it('rejects reserved slug "api"', () => {
    expect(isValidSlug('api')).toBe(false)
  })

  it('rejects reserved slug "t"', () => {
    expect(isValidSlug('t')).toBe(false)
  })

  it('rejects reserved slug "gui-thiep"', () => {
    expect(isValidSlug('gui-thiep')).toBe(false)
  })

  it('rejects reserved slug "ve-clb-ai"', () => {
    expect(isValidSlug('ve-clb-ai')).toBe(false)
  })

  it('rejects reserved slug "assets"', () => {
    expect(isValidSlug('assets')).toBe(false)
  })

  it('rejects reserved slug "theme"', () => {
    expect(isValidSlug('theme')).toBe(false)
  })

  it('rejects reserved slug "g"', () => {
    // 'g' is both reserved AND too short (1 char) — either reason suffices
    expect(isValidSlug('g')).toBe(false)
  })
})

// ---- validateSettings — teacher_cards ----

describe('validateSettings — teacher_cards', () => {
  it('empty {} is valid', () => {
    const result = validateSettings('teacher_cards', {})
    expect(result.ok).toBe(true)
  })

  it('empty {} returns a value with defaults', () => {
    const result = validateSettings('teacher_cards', {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBeDefined()
    }
  })

  it('null settings → not ok', () => {
    const result = validateSettings('teacher_cards', null)
    expect(result.ok).toBe(false)
  })

  it('array settings → not ok', () => {
    const result = validateSettings('teacher_cards', [])
    expect(result.ok).toBe(false)
  })

  it('string settings → not ok', () => {
    const result = validateSettings('teacher_cards', 'bad')
    expect(result.ok).toBe(false)
  })
})

// ---- validateSettings — gift_tree ranges ----

describe('validateSettings — gift_tree field ranges', () => {
  it('empty {} is valid with defaults applied', () => {
    const result = validateSettings('gift_tree', {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.report_threshold).toBe(3)
      expect(result.value.hearts_per_day).toBe(5)
      expect(result.value.gifts_per_user).toBe(3)
      expect(result.value.tree_slots).toBe(15)
      expect(result.value.ground_slots).toBe(10)
    }
  })

  it('report_threshold below minimum (1) → not ok with field=report_threshold', () => {
    const result = validateSettings('gift_tree', { report_threshold: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.field).toBe('report_threshold')
  })

  it('report_threshold at minimum (2) → ok', () => {
    const result = validateSettings('gift_tree', { report_threshold: 2 })
    expect(result.ok).toBe(true)
  })

  it('report_threshold above maximum (21) → not ok', () => {
    const result = validateSettings('gift_tree', { report_threshold: 21 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.field).toBe('report_threshold')
  })

  it('report_threshold at maximum (20) → ok', () => {
    const result = validateSettings('gift_tree', { report_threshold: 20 })
    expect(result.ok).toBe(true)
  })

  it('hearts_per_day below minimum (0) → not ok', () => {
    const result = validateSettings('gift_tree', { hearts_per_day: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.field).toBe('hearts_per_day')
  })

  it('hearts_per_day at minimum (1) → ok', () => {
    const result = validateSettings('gift_tree', { hearts_per_day: 1 })
    expect(result.ok).toBe(true)
  })

  it('hearts_per_day above maximum (21) → not ok', () => {
    const result = validateSettings('gift_tree', { hearts_per_day: 21 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.field).toBe('hearts_per_day')
  })

  it('hearts_per_day at maximum (20) → ok', () => {
    const result = validateSettings('gift_tree', { hearts_per_day: 20 })
    expect(result.ok).toBe(true)
  })

  it('gifts_per_user below minimum (0) → not ok', () => {
    const result = validateSettings('gift_tree', { gifts_per_user: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.field).toBe('gifts_per_user')
  })

  it('gifts_per_user at minimum (1) → ok', () => {
    const result = validateSettings('gift_tree', { gifts_per_user: 1 })
    expect(result.ok).toBe(true)
  })

  it('gifts_per_user above maximum (11) → not ok', () => {
    const result = validateSettings('gift_tree', { gifts_per_user: 11 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.field).toBe('gifts_per_user')
  })

  it('gifts_per_user at maximum (10) → ok', () => {
    const result = validateSettings('gift_tree', { gifts_per_user: 10 })
    expect(result.ok).toBe(true)
  })

  it('tree_slots below minimum (4) → not ok', () => {
    const result = validateSettings('gift_tree', { tree_slots: 4 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.field).toBe('tree_slots')
  })

  it('tree_slots at minimum (5) → ok', () => {
    const result = validateSettings('gift_tree', { tree_slots: 5 })
    expect(result.ok).toBe(true)
  })

  it('tree_slots above maximum (26) → not ok', () => {
    const result = validateSettings('gift_tree', { tree_slots: 26 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.field).toBe('tree_slots')
  })

  it('tree_slots at maximum (25) → ok', () => {
    const result = validateSettings('gift_tree', { tree_slots: 25 })
    expect(result.ok).toBe(true)
  })

  it('ground_slots at minimum (0) → ok', () => {
    const result = validateSettings('gift_tree', { ground_slots: 0 })
    expect(result.ok).toBe(true)
  })

  it('ground_slots below minimum (-1) → not ok', () => {
    const result = validateSettings('gift_tree', { ground_slots: -1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.field).toBe('ground_slots')
  })

  it('ground_slots above maximum (16) → not ok', () => {
    const result = validateSettings('gift_tree', { ground_slots: 16 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.field).toBe('ground_slots')
  })

  it('ground_slots at maximum (15) → ok', () => {
    const result = validateSettings('gift_tree', { ground_slots: 15 })
    expect(result.ok).toBe(true)
  })

  it('all fields at valid non-default values → ok, values round-trip', () => {
    const input = { report_threshold: 5, hearts_per_day: 10, gifts_per_user: 2, tree_slots: 20, ground_slots: 5 }
    const result = validateSettings('gift_tree', input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.report_threshold).toBe(5)
      expect(result.value.hearts_per_day).toBe(10)
      expect(result.value.gifts_per_user).toBe(2)
      expect(result.value.tree_slots).toBe(20)
      expect(result.value.ground_slots).toBe(5)
    }
  })

  it('missing fields get defaults filled in', () => {
    const result = validateSettings('gift_tree', { tree_slots: 20 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.report_threshold).toBe(3)
      expect(result.value.hearts_per_day).toBe(5)
      expect(result.value.gifts_per_user).toBe(3)
      expect(result.value.tree_slots).toBe(20)
      expect(result.value.ground_slots).toBe(10)
    }
  })

  it('unknown kind → not ok', () => {
    const result = validateSettings('unknown_kind' as 'teacher_cards', {})
    expect(result.ok).toBe(false)
  })
})

// ---- isEffectivelyOpen ----

describe('isEffectivelyOpen', () => {
  const OPEN_CAMPAIGN = {
    status: 'active' as const,
    starts_at: '2026-11-01T00:00:00Z',
    ends_at: '2026-12-31T23:59:59Z',
  }

  it('active + now within dates → true', () => {
    expect(isEffectivelyOpen(OPEN_CAMPAIGN, new Date('2026-11-20T12:00:00Z'))).toBe(true)
  })

  it('active + now before starts_at → false', () => {
    expect(isEffectivelyOpen(OPEN_CAMPAIGN, new Date('2026-10-31T23:59:59Z'))).toBe(false)
  })

  it('active + now after ends_at → false', () => {
    expect(isEffectivelyOpen(OPEN_CAMPAIGN, new Date('2027-01-01T00:00:00Z'))).toBe(false)
  })

  it('draft + now within dates → false', () => {
    expect(isEffectivelyOpen({ ...OPEN_CAMPAIGN, status: 'draft' }, new Date('2026-11-20T12:00:00Z'))).toBe(false)
  })

  it('closed + now within dates → false', () => {
    expect(isEffectivelyOpen({ ...OPEN_CAMPAIGN, status: 'closed' }, new Date('2026-11-20T12:00:00Z'))).toBe(false)
  })

  it('boundary: now === starts_at → true (inclusive)', () => {
    expect(isEffectivelyOpen(OPEN_CAMPAIGN, new Date('2026-11-01T00:00:00Z'))).toBe(true)
  })

  it('boundary: now === ends_at → true (inclusive)', () => {
    expect(isEffectivelyOpen(OPEN_CAMPAIGN, new Date('2026-12-31T23:59:59Z'))).toBe(true)
  })

  it('1 second before ends_at → true', () => {
    expect(isEffectivelyOpen(OPEN_CAMPAIGN, new Date('2026-12-31T23:59:58Z'))).toBe(true)
  })

  it('1 second after ends_at → false', () => {
    expect(isEffectivelyOpen(OPEN_CAMPAIGN, new Date('2027-01-01T00:00:00Z'))).toBe(false)
  })
})
