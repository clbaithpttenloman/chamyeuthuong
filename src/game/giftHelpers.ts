/**
 * src/game/giftHelpers.ts — pure logic for the Noel gift sheet.
 *
 * Extracted so it can be unit-tested independently of React.
 *
 * Covers:
 *   heartButtonState  — which heart button state to render (FR-24, AC-12)
 *   prevNextByRank    — prev/next gift navigation by rank
 *   shareUrl          — /<slug>/g/<publicId> (FR-25a)
 *   giftToCardViewProps — maps a gift item to CardView props (docs/tech.md "Reusing card v3")
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal shape of a gift needed for navigation and card-view mapping. */
export interface GiftForCard {
  publicId: string
  rank: number
  layout: string
  font: string
  ink: string
  message: string
  nickname: string
  className: string
  heartCount: number
  backgroundTemplateId: number | null
}

// ── Heart button state ────────────────────────────────────────────────────────

/** All possible heart button states. `reason` text is shown below the button. */
export type HeartButtonState =
  | { kind: 'sign-in';        label: string; reason: null   }
  | { kind: 'closed';         label: string; reason: string }
  | { kind: 'own-gift';       label: string; reason: string }
  | { kind: 'already-hearted'; label: string; reason: string }
  | { kind: 'none-left';      label: string; reason: string }
  | { kind: 'can-heart';      label: string; reason: null   }

export interface HeartButtonParams {
  signedIn: boolean
  isOwnGift: boolean
  alreadyHearted: boolean
  heartsLeft: number
  campaignOpen: boolean
}

/**
 * Returns the correct heart button state given user + campaign context.
 * Pure function: no side effects, deterministic, unit-testable.
 *
 * Priority order (matches AC-12 diagnosis order from ADR-7):
 *   1. Not signed in → sign-in
 *   2. Campaign closed → closed
 *   3. Own gift → own-gift
 *   4. Already hearted → already-hearted
 *   5. Hearts exhausted → none-left
 *   6. All clear → can-heart
 */
export function heartButtonState(params: HeartButtonParams): HeartButtonState {
  if (!params.signedIn) {
    return { kind: 'sign-in', label: '❤️ Thả tim', reason: null }
  }
  if (!params.campaignOpen) {
    return { kind: 'closed', label: '❤️ Thả tim', reason: 'Chiến dịch đã kết thúc' }
  }
  if (params.isOwnGift) {
    return { kind: 'own-gift', label: '❤️ Thả tim', reason: 'Đây là quà của bạn' }
  }
  if (params.alreadyHearted) {
    return { kind: 'already-hearted', label: '❤️ Đã thả tim', reason: 'Bạn đã thả tim rồi' }
  }
  if (params.heartsLeft <= 0) {
    return { kind: 'none-left', label: '❤️ Thả tim', reason: 'Bạn đã dùng hết tim hôm nay' }
  }
  return { kind: 'can-heart', label: '❤️ Thả tim', reason: null }
}

// ── Prev / next navigation ────────────────────────────────────────────────────

/**
 * Returns the publicId of the previous and next gift in rank order.
 * `prev` = lower rank number (better rank); `next` = higher rank number.
 * Returns null when there is no neighbour.
 */
export function prevNextByRank(
  gifts: Array<{ publicId: string; rank: number }>,
  currentPublicId: string,
): { prev: string | null; next: string | null } {
  if (!gifts.length) return { prev: null, next: null }

  const sorted = [...gifts].sort((a, b) => a.rank - b.rank)
  const idx = sorted.findIndex((g) => g.publicId === currentPublicId)

  if (idx === -1) return { prev: null, next: null }

  return {
    prev: idx > 0 ? sorted[idx - 1]!.publicId : null,
    next: idx < sorted.length - 1 ? sorted[idx + 1]!.publicId : null,
  }
}

// ── Share URL ─────────────────────────────────────────────────────────────────

/**
 * Returns the share URL for a gift. FR-25a.
 * Always a relative path (the browser resolves it against the current origin).
 */
export function shareUrl(slug: string, publicId: string): string {
  return `/${slug}/g/${publicId}`
}

// ── Gift → CardView props ─────────────────────────────────────────────────────

/** Props that CardView accepts from a gift item. */
export interface GiftCardViewProps {
  card: { name: string; subject: string; message: string; title?: null }
  toLine: null
  subLine: null
  stamp: string
  from: string
  layout: string
  images: Record<string, string>
  font: string
  ink: string
}

/**
 * Maps a gift item to CardView props.
 *
 * Per docs/tech.md "Reusing card v3":
 *   card = { name: campaignName, subject: '', message: gift.message }
 *   toLine = null   (hide "Kính gửi" — no teacher being addressed)
 *   subLine = null  (no role/subject line)
 *   stamp = "${site.title} · Noel"
 *   from = "<nickname> · <class>" (or just nickname when class is empty)
 *
 * backgroundToken comes from the campaign templates list (null → no background image).
 */
export function giftToCardViewProps(params: {
  gift: GiftForCard
  campaignName: string
  backgroundToken: string | null
  stamp: string
}): GiftCardViewProps {
  const { gift, campaignName, backgroundToken, stamp } = params
  const from = gift.className
    ? `${gift.nickname} · ${gift.className}`
    : gift.nickname

  return {
    card: { name: campaignName, subject: '', message: gift.message, title: null },
    toLine: null,
    subLine: null,
    stamp,
    from,
    layout: gift.layout,
    images: backgroundToken ? { background: backgroundToken } : {},
    font: gift.font,
    ink: gift.ink,
  }
}
