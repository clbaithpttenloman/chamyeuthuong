/**
 * Tests for src/pages/admin/moderationHelpers.ts
 *
 * Pure logic: action availability by status, confirm texts, error messages, status labels.
 * No DOM or React required.
 */
import { describe, it, expect } from 'vitest'
import {
  availableGiftActions,
  giftActionConfirmText,
  userActionConfirmText,
  giftModerationErrorMessage,
  giftStatusLabel,
  ERROR_CODE_MESSAGES,
  type GiftStatus,
} from './moderationHelpers.ts'
import { reportReasonsText } from './moderationHelpers.ts'

// ── availableGiftActions ──────────────────────────────────────────────────────

describe('availableGiftActions', () => {
  it('visible → [hide, delete] (no restore — it is already visible)', () => {
    const actions = availableGiftActions('visible')
    expect(actions).not.toContain('restore')
    expect(actions).toContain('hide')
    expect(actions).toContain('delete')
  })

  it('hidden_auto → [restore, hide, delete]', () => {
    const actions = availableGiftActions('hidden_auto')
    expect(actions).toContain('restore')
    expect(actions).toContain('hide')
    expect(actions).toContain('delete')
  })

  it('hidden_admin → [restore, delete] (no hide — already explicitly hidden)', () => {
    const actions = availableGiftActions('hidden_admin')
    expect(actions).toContain('restore')
    expect(actions).not.toContain('hide')
    expect(actions).toContain('delete')
  })

  it('deleted → [restore] (no hide or delete — already deleted)', () => {
    const actions = availableGiftActions('deleted')
    expect(actions).toContain('restore')
    expect(actions).not.toContain('hide')
    expect(actions).not.toContain('delete')
  })

  it('visible does not include restore', () => {
    expect(availableGiftActions('visible')).not.toContain('restore')
  })
})

// ── giftActionConfirmText ─────────────────────────────────────────────────────

describe('giftActionConfirmText', () => {
  it('restore confirm mentions restoring and that old reports are acknowledged', () => {
    const text = giftActionConfirmText('restore')
    expect(text.length).toBeGreaterThan(10)
    expect(text).toContain('Khôi phục')
  })

  it('hide confirm mentions hiding', () => {
    const text = giftActionConfirmText('hide')
    expect(text).toContain('Ẩn')
  })

  it('delete confirm mentions permanent deletion', () => {
    const text = giftActionConfirmText('delete')
    expect(text).toContain('Xoá')
    // Must warn it is irreversible
    expect(text).toMatch(/vĩnh viễn|không thể hoàn tác/i)
  })

  it('all actions return non-empty Vietnamese strings', () => {
    for (const action of ['restore', 'hide', 'delete'] as const) {
      const text = giftActionConfirmText(action)
      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
    }
  })
})

// ── userActionConfirmText ─────────────────────────────────────────────────────

describe('userActionConfirmText', () => {
  it('ban confirm mentions hiding gifts and removing hearts', () => {
    const text = userActionConfirmText('ban')
    expect(text).toContain('Khoá')
    expect(text).toMatch(/quà|ẩn/i)
    expect(text).toMatch(/tim/i)
  })

  it('unban confirm mentions restoring gifts but NOT hearts', () => {
    const text = userActionConfirmText('unban')
    expect(text).toContain('Mở khoá')
    // Must mention that hearts are NOT restored
    expect(text).toMatch(/tim không/i)
  })

  it('both actions return non-empty strings', () => {
    expect(userActionConfirmText('ban').length).toBeGreaterThan(0)
    expect(userActionConfirmText('unban').length).toBeGreaterThan(0)
  })
})

// ── giftModerationErrorMessage ────────────────────────────────────────────────

describe('giftModerationErrorMessage', () => {
  it('401 returns a Google sign-in hint (typed email not accepted)', () => {
    const msg = giftModerationErrorMessage(401, 'unauthorized')
    expect(msg).toMatch(/Google/i)
    expect(msg.length).toBeGreaterThan(10)
  })

  it('403 returns a permissions message', () => {
    const msg = giftModerationErrorMessage(403, 'forbidden')
    expect(msg).toMatch(/quyền/i)
  })

  it('404 returns a not-found message', () => {
    const msg = giftModerationErrorMessage(404, 'not_found')
    expect(msg).toMatch(/không tìm thấy/i)
  })

  it('400 with known code returns that code message', () => {
    const msg = giftModerationErrorMessage(400, 'bad_request')
    expect(msg).toBe(ERROR_CODE_MESSAGES['bad_request'])
  })

  it('400 with unknown code returns generic message', () => {
    const msg = giftModerationErrorMessage(400, 'some_unknown_code')
    expect(typeof msg).toBe('string')
    expect(msg.length).toBeGreaterThan(0)
  })

  it('429 returns a rate-limit message', () => {
    const msg = giftModerationErrorMessage(429, 'rate_limited')
    expect(msg).toMatch(/quá nhiều/i)
  })

  it('5xx returns a connection/server error message', () => {
    const msg = giftModerationErrorMessage(500, 'server_error')
    expect(typeof msg).toBe('string')
    expect(msg.length).toBeGreaterThan(0)
  })
})

// ── giftStatusLabel ───────────────────────────────────────────────────────────

describe('giftStatusLabel', () => {
  const cases: Array<[GiftStatus, RegExp]> = [
    ['visible', /hiển thị/i],
    ['hidden_auto', /ẩn tự động/i],
    ['hidden_admin', /ẩn bởi quản trị/i],
    ['deleted', /đã xoá/i],
  ]

  it.each(cases)('%s returns a Vietnamese label matching %s', (status, pattern) => {
    expect(giftStatusLabel(status)).toMatch(pattern)
  })

  it('all statuses return non-empty strings', () => {
    const statuses: GiftStatus[] = ['visible', 'hidden_auto', 'hidden_admin', 'deleted']
    for (const s of statuses) {
      expect(giftStatusLabel(s).length).toBeGreaterThan(0)
    }
  })
})

// ── ERROR_CODE_MESSAGES ───────────────────────────────────────────────────────

describe('ERROR_CODE_MESSAGES', () => {
  it('has entries for common error codes', () => {
    expect(typeof ERROR_CODE_MESSAGES['bad_request']).toBe('string')
    expect(typeof ERROR_CODE_MESSAGES['not_found']).toBe('string')
    expect(typeof ERROR_CODE_MESSAGES['forbidden']).toBe('string')
    expect(typeof ERROR_CODE_MESSAGES['conflict']).toBe('string')
  })
})

describe('reportReasonsText', () => {
  it('lists non-zero reasons in a fixed order', () => {
    expect(reportReasonsText({ inappropriate: 2, spam: 1, other: 0 })).toBe('2 không phù hợp, 1 spam')
    expect(reportReasonsText({ inappropriate: 0, spam: 0, other: 3 })).toBe('3 lý do khác')
  })
  it('empty when nothing is counted or the field is missing', () => {
    expect(reportReasonsText({ inappropriate: 0, spam: 0, other: 0 })).toBe('')
    expect(reportReasonsText(undefined)).toBe('')
  })
})
