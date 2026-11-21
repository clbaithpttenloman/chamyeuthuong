// @vitest-environment node
/**
 * Tests for src/game/giftHelpers.ts — pure gift-sheet logic.
 */
import { describe, it, expect } from 'vitest'
import {
  heartButtonState,
  prevNextByRank,
  shareUrl,
  giftToCardViewProps,
  type HeartButtonParams,
} from './giftHelpers.ts'

// ── heartButtonState ──────────────────────────────────────────────────────────

const BASE: HeartButtonParams = {
  signedIn: true,
  isOwnGift: false,
  alreadyHearted: false,
  heartsLeft: 3,
  campaignOpen: true,
}

describe('heartButtonState', () => {
  it('not signed in → sign-in (highest priority)', () => {
    const s = heartButtonState({ ...BASE, signedIn: false })
    expect(s.kind).toBe('sign-in')
    expect(s.reason).toBeNull()
  })

  it('campaign closed → closed (even when signed in)', () => {
    const s = heartButtonState({ ...BASE, campaignOpen: false })
    expect(s.kind).toBe('closed')
    expect(typeof s.reason).toBe('string')
    expect(s.reason!.length).toBeGreaterThan(0)
  })

  it('own gift → own-gift', () => {
    const s = heartButtonState({ ...BASE, isOwnGift: true })
    expect(s.kind).toBe('own-gift')
    expect(typeof s.reason).toBe('string')
  })

  it('already hearted → already-hearted', () => {
    const s = heartButtonState({ ...BASE, alreadyHearted: true })
    expect(s.kind).toBe('already-hearted')
    expect(typeof s.reason).toBe('string')
  })

  it('hearts left = 0 → none-left', () => {
    const s = heartButtonState({ ...BASE, heartsLeft: 0 })
    expect(s.kind).toBe('none-left')
    expect(typeof s.reason).toBe('string')
  })

  it('hearts left < 0 → none-left', () => {
    expect(heartButtonState({ ...BASE, heartsLeft: -1 }).kind).toBe('none-left')
  })

  it('all clear → can-heart, reason null', () => {
    const s = heartButtonState(BASE)
    expect(s.kind).toBe('can-heart')
    expect(s.reason).toBeNull()
  })

  it('priority: not-signed-in beats closed', () => {
    const s = heartButtonState({ ...BASE, signedIn: false, campaignOpen: false })
    expect(s.kind).toBe('sign-in')
  })

  it('priority: closed beats own-gift', () => {
    const s = heartButtonState({ ...BASE, campaignOpen: false, isOwnGift: true })
    expect(s.kind).toBe('closed')
  })

  it('priority: own-gift beats already-hearted', () => {
    const s = heartButtonState({ ...BASE, isOwnGift: true, alreadyHearted: true })
    expect(s.kind).toBe('own-gift')
  })

  it('priority: already-hearted beats none-left', () => {
    const s = heartButtonState({ ...BASE, alreadyHearted: true, heartsLeft: 0 })
    expect(s.kind).toBe('already-hearted')
  })

  it('all disabled states have a non-empty label', () => {
    const states = [
      heartButtonState({ ...BASE, signedIn: false }),
      heartButtonState({ ...BASE, campaignOpen: false }),
      heartButtonState({ ...BASE, isOwnGift: true }),
      heartButtonState({ ...BASE, alreadyHearted: true }),
      heartButtonState({ ...BASE, heartsLeft: 0 }),
      heartButtonState(BASE),
    ]
    for (const s of states) {
      expect(typeof s.label).toBe('string')
      expect(s.label.length).toBeGreaterThan(0)
    }
  })
})

// ── prevNextByRank ────────────────────────────────────────────────────────────

describe('prevNextByRank', () => {
  const GIFTS = [
    { publicId: 'a', rank: 1 },
    { publicId: 'b', rank: 2 },
    { publicId: 'c', rank: 3 },
  ]

  it('first gift has no prev, has next', () => {
    expect(prevNextByRank(GIFTS, 'a')).toEqual({ prev: null, next: 'b' })
  })

  it('last gift has prev, has no next', () => {
    expect(prevNextByRank(GIFTS, 'c')).toEqual({ prev: 'b', next: null })
  })

  it('middle gift has both prev and next', () => {
    expect(prevNextByRank(GIFTS, 'b')).toEqual({ prev: 'a', next: 'c' })
  })

  it('unknown publicId → both null', () => {
    expect(prevNextByRank(GIFTS, 'z')).toEqual({ prev: null, next: null })
  })

  it('empty gifts → both null', () => {
    expect(prevNextByRank([], 'a')).toEqual({ prev: null, next: null })
  })

  it('single gift → both null', () => {
    expect(prevNextByRank([{ publicId: 'x', rank: 1 }], 'x')).toEqual({ prev: null, next: null })
  })

  it('sorts by rank regardless of input order', () => {
    const unordered = [
      { publicId: 'c', rank: 3 },
      { publicId: 'a', rank: 1 },
      { publicId: 'b', rank: 2 },
    ]
    expect(prevNextByRank(unordered, 'b')).toEqual({ prev: 'a', next: 'c' })
  })

  it('does not mutate the input array', () => {
    const arr = [{ publicId: 'b', rank: 2 }, { publicId: 'a', rank: 1 }]
    const before = arr.map((g) => g.publicId).join(',')
    prevNextByRank(arr, 'a')
    expect(arr.map((g) => g.publicId).join(',')).toBe(before)
  })
})

// ── shareUrl ──────────────────────────────────────────────────────────────────

describe('shareUrl', () => {
  it('returns /<slug>/g/<publicId>', () => {
    expect(shareUrl('noel', 'abc123')).toBe('/noel/g/abc123')
  })

  it('works with the 20-11 slug', () => {
    expect(shareUrl('20-11', 'xyz')).toBe('/20-11/g/xyz')
  })

  it('is a relative path (starts with /)', () => {
    expect(shareUrl('test', 'id').startsWith('/')).toBe(true)
  })
})

// ── giftToCardViewProps ───────────────────────────────────────────────────────

const GIFT = {
  publicId: 'abc',
  rank: 1,
  layout: 'doc-giua',
  font: 'lora',
  ink: '#123456',
  message: 'Chúc mừng Giáng sinh!',
  nickname: 'Minh Anh',
  className: '11A1',
  heartCount: 10,
  backgroundTemplateId: null,
}

describe('giftToCardViewProps', () => {
  const params = { gift: GIFT, campaignName: 'Cây Thông Điều Ước', backgroundToken: null, stamp: 'AI · Noel' }
  const props = giftToCardViewProps(params)

  it('toLine is null (hides "Kính gửi")', () => {
    expect(props.toLine).toBeNull()
  })

  it('subLine is null (hides role/subject line)', () => {
    expect(props.subLine).toBeNull()
  })

  it('card.name = campaign name (the heading)', () => {
    expect(props.card.name).toBe('Cây Thông Điều Ước')
  })

  it('card.message = gift message', () => {
    expect(props.card.message).toBe('Chúc mừng Giáng sinh!')
  })

  it('card.subject is empty string', () => {
    expect(props.card.subject).toBe('')
  })

  it('from = "nickname · class"', () => {
    expect(props.from).toBe('Minh Anh · 11A1')
  })

  it('from = just nickname when class is empty', () => {
    const p = giftToCardViewProps({ ...params, gift: { ...GIFT, className: '' } })
    expect(p.from).toBe('Minh Anh')
  })

  it('stamp passes through', () => {
    expect(props.stamp).toBe('AI · Noel')
  })

  it('layout, font, ink pass through', () => {
    expect(props.layout).toBe('doc-giua')
    expect(props.font).toBe('lora')
    expect(props.ink).toBe('#123456')
  })

  it('no background token → empty images', () => {
    expect(props.images).toEqual({})
  })

  it('with background token → images.background = token', () => {
    const p = giftToCardViewProps({ ...params, backgroundToken: 'abc1234567890123' })
    expect(p.images).toEqual({ background: 'abc1234567890123' })
  })
})
