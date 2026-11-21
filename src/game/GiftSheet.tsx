/**
 * GiftSheet — dialog that opens a gift and shows the card inside.
 *
 * Opening sequence (FR-23, AC-17):
 *   1. Box + lid animation via animateBoxOpen (fade-only under reduced motion)
 *   2. Card revealed (CardView with gift → card props mapping from giftHelpers)
 *
 * Heart button states (FR-24, AC-12): sign-in / own-gift / already-hearted / none-left / closed / can-heart
 *   - On heart: burstHearts at button position + call onHeart(publicId) → parent updates state
 *   - Optimistic count managed by parent (mergeHeart); parent provides merged heartCount
 *
 * Report (FR-26, ADR-8): reason picker (inappropriate / spam / other), confirm, "Đã gửi báo cáo"
 * Share (FR-25a): Web Share API or copy /<slug>/g/<publicId> with "Đã sao chép" feedback
 * Prev / next: by rank via prevNextByRank from giftHelpers
 *
 * Accessibility (NFR-4):
 *   - role="dialog" aria-modal="true" labelled by title id
 *   - Esc key closes
 *   - Focus trapped inside; returned to trigger on close
 *   - prefers-reduced-motion: fade only, no box-open transform
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import CardView from '../components/CardView.tsx'
import { animateBoxOpen, burstHearts } from './timelines.ts'
import {
  heartButtonState,
  prevNextByRank,
  shareUrl,
  giftToCardViewProps,
  type GiftForCard,
} from './giftHelpers.ts'
import { errorMessage } from './errors.ts'
import { DEFAULT_THEME_URLS } from './defaultTheme.ts'
import { ApiError } from '../api.ts'
import type { MeUser, ReportReason } from '../api.ts'
import site from '../content/site.json'
import { useDialog } from './useDialog.ts'

// ── Props ─────────────────────────────────────────────────────────────────────

export interface GiftSheetGift extends GiftForCard {
  boxStyle: number
  ornamentStyle: number
  createdAt: string
}

export interface GiftSheetProps {
  /** The gift to display (heartCount may be optimistically overridden by parent). */
  gift: GiftSheetGift
  /** All visible gifts for prev/next navigation (includes tree + ground). */
  allGifts: GiftSheetGift[]
  slug: string
  campaignName: string
  campaignOpen: boolean
  user: MeUser | null
  heartsLeft: number
  heartedPublicIds: ReadonlySet<string>
  myPublicIds: ReadonlySet<string>
  /** Called when the user picks a different gift (prev/next). */
  onNavigate: (publicId: string) => void
  /** Called when the sheet should close. */
  onClose: () => void
  /** Campaign templates; the gift's background image is looked up by its template id. */
  templates?: ReadonlyArray<{ id: number; images: Record<string, string> }>
  /**
   * Called when the user hearts this gift.
   * Parent handles the API call and state update.
   * Throws ApiError on failure.
   */
  onHeart: (publicId: string) => Promise<void>
  /**
   * Called when the user reports this gift.
   * Throws ApiError on failure.
   */
  onReport: (publicId: string, reason: ReportReason) => Promise<void>
  /** Called when user clicks sign-in (from heart button in sign-in state). */
  onSignIn: () => void
  /** Element to return focus to when the dialog closes. */
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function GiftSheet({
  templates,
  gift,
  allGifts,
  slug,
  campaignName,
  campaignOpen,
  user,
  heartsLeft,
  heartedPublicIds,
  myPublicIds,
  onNavigate,
  onClose,
  onHeart,
  onReport,
  onSignIn,
  returnFocusRef,
}: GiftSheetProps): ReactNode {
  const reduced = prefersReducedMotion()
  const dialogRef = useRef<HTMLDivElement>(null)

  // onClose ref so the focus-trap effect runs once (not on every parent re-render)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // Focus trap + Esc, runs once on mount
  useDialog({ dialogRef, onCloseRef, returnFocusRef })

  // ── Animation phase ───────────────────────────────────────────────────
  const [phase, setPhase] = useState<'animating' | 'card'>('animating')
  const boxRef   = useRef<HTMLDivElement>(null)
  const lidRef   = useRef<HTMLDivElement>(null)
  const sparksRef = useRef<HTMLDivElement>(null)

  // Run box-open animation on mount (and when gift changes — same phase reset)
  useEffect(() => {
    setPhase('animating')
  }, [gift.publicId])

  useEffect(() => {
    if (phase !== 'animating') return
    const boxEl    = boxRef.current
    const lidEl    = lidRef.current
    const sparksEl = sparksRef.current
    if (!boxEl || !lidEl || !sparksEl) { setPhase('card'); return }

    let alive = true
    // Bug #3 fix: safety timeout ensures we always reach 'card' within 2 s even
    // if WAAPI animations are paused (hidden tab, reduced-motion, missing img).
    const safety = setTimeout(() => { if (alive) { setPhase('card') } }, 2000)
    animateBoxOpen({ box: boxEl, lid: lidEl, sparks: sparksEl }, reduced)
      .then(() => { clearTimeout(safety); if (alive) setPhase('card') })
      .catch(() => { clearTimeout(safety); if (alive) setPhase('card') })
    return () => { alive = false; clearTimeout(safety) }
  }, [phase, reduced])

  // ── Heart action ──────────────────────────────────────────────────────
  const [heartLoading, setHeartLoading] = useState(false)
  const [heartError, setHeartError] = useState<string | null>(null)

  const handleHeartClick = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    setHeartLoading(true)
    setHeartError(null)
    try {
      await onHeart(gift.publicId)
      burstHearts(x, y, reduced)
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown'
      setHeartError(errorMessage(code))
    } finally {
      setHeartLoading(false)
    }
  }, [gift.publicId, onHeart, reduced])

  // ── Report flow ───────────────────────────────────────────────────────
  const [reportPhase, setReportPhase] = useState<'hidden' | 'picker' | 'done'>('hidden')
  const [reportReason, setReportReason] = useState<ReportReason>('inappropriate')
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)

  const handleReportSubmit = useCallback(async () => {
    setReportLoading(true)
    setReportError(null)
    try {
      await onReport(gift.publicId, reportReason)
      setReportPhase('done')
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown'
      setReportError(errorMessage(code))
    } finally {
      setReportLoading(false)
    }
  }, [gift.publicId, onReport, reportReason])

  // Reset report state when gift changes
  useEffect(() => {
    setReportPhase('hidden')
    setReportReason('inappropriate')
    setReportError(null)
    setHeartError(null)
  }, [gift.publicId])

  // ── Share ─────────────────────────────────────────────────────────────
  const [shareFeedback, setShareFeedback] = useState<string | null>(null)

  const handleShare = useCallback(async () => {
    const url = window.location.origin + shareUrl(slug, gift.publicId)
    const title = `${gift.nickname} · ${gift.className || ''} — ${campaignName}`

    if (navigator.share) {
      try {
        await navigator.share({ title, url })
        return
      } catch {
        // User cancelled or share failed — fall through to copy
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      setShareFeedback('Đã sao chép!')
      setTimeout(() => setShareFeedback(null), 2500)
    } catch {
      setShareFeedback('Không thể sao chép.')
      setTimeout(() => setShareFeedback(null), 2500)
    }
  }, [slug, gift.publicId, gift.nickname, gift.className, campaignName])

  // ── Heart button state ────────────────────────────────────────────────
  const hbState = heartButtonState({
    signedIn: !!user,
    isOwnGift: myPublicIds.has(gift.publicId),
    alreadyHearted: heartedPublicIds.has(gift.publicId),
    heartsLeft,
    campaignOpen,
  })

  // ── Prev / next ───────────────────────────────────────────────────────
  const { prev, next } = prevNextByRank(allGifts, gift.publicId)

  // ── Card props ────────────────────────────────────────────────────────
  const cardProps = giftToCardViewProps({
    gift,
    campaignName,
    backgroundToken: templates?.find((t) => t.id === gift.backgroundTemplateId)?.images.background ?? null,
    stamp: `${site.title} · Noel`,
  })

  // ── Box image URL for animation ───────────────────────────────────────
  const boxKey = `box_${gift.boxStyle}_closed` as keyof typeof DEFAULT_THEME_URLS
  const boxUrl = DEFAULT_THEME_URLS[boxKey] ?? DEFAULT_THEME_URLS.box_1_closed

  // ── Render ────────────────────────────────────────────────────────────

  const titleId = 'gift-sheet-title'

  return (
    <div
      className="gift-sheet-backdrop"
      onClick={onClose}
      aria-hidden="false"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="gift-sheet-dialog"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="gift-sheet-header">
          <h2 id={titleId} className="gift-sheet-title">
            {gift.nickname}{gift.className ? ` · ${gift.className}` : ''}
          </h2>
          <button
            type="button"
            className="gift-sheet-close"
            aria-label="Đóng"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* ── Animation phase ───────────────────────────────────────── */}
        {phase === 'animating' && (
          <div className="gift-sheet-anim" aria-hidden="true">
            <div className="gift-sheet-sparks" ref={sparksRef} />
            <div className="gift-sheet-lid" ref={lidRef} />
            <div className="gift-sheet-box" ref={boxRef}>
              <img
                src={boxUrl}
                alt=""
                className="gift-sheet-box-img"
                draggable={false}
              />
            </div>
          </div>
        )}

        {/* ── Card + actions ────────────────────────────────────────── */}
        {phase === 'card' && (
          <div className="gift-sheet-body">
            {/* Card */}
            <div className="gift-sheet-card">
              <CardView
                card={cardProps.card}
                layout={cardProps.layout}
                images={cardProps.images}
                from={cardProps.from}
                font={cardProps.font}
                ink={cardProps.ink}
                toLine={cardProps.toLine}
                subLine={cardProps.subLine}
                stamp={cardProps.stamp}
                headingLevel="h2"
              />
            </div>

            {/* Meta info */}
            <div className="gift-sheet-meta">
              <span className="gift-sheet-nickname">
                {gift.nickname}{gift.className ? ` · ${gift.className}` : ''}
              </span>
              <span className="gift-sheet-hearts" aria-label={`${gift.heartCount} tim`}>
                ❤️ {gift.heartCount}
              </span>
              <span className="gift-sheet-rank" aria-label={`Hạng ${gift.rank}`}>
                #{gift.rank}
              </span>
            </div>

            {/* Heart button */}
            <div className="gift-sheet-heart-wrap">
              {hbState.kind === 'sign-in' ? (
                <button
                  type="button"
                  className="gift-sheet-heart-btn"
                  onClick={onSignIn}
                >
                  {hbState.label}
                </button>
              ) : (
                <button
                  type="button"
                  className="gift-sheet-heart-btn"
                  disabled={hbState.kind !== 'can-heart' || heartLoading}
                  onClick={hbState.kind === 'can-heart' ? handleHeartClick : undefined}
                  aria-pressed={hbState.kind === 'already-hearted'}
                >
                  {heartLoading ? 'Đang xử lý…' : hbState.label}
                </button>
              )}
              {hbState.reason && (
                <p className="gift-sheet-heart-reason" role="note">
                  {hbState.reason}
                </p>
              )}
              {heartError && (
                <p className="gift-sheet-error" role="alert">
                  {heartError}
                </p>
              )}
            </div>

            {/* Report flow */}
            <div className="gift-sheet-report-wrap">
              {reportPhase === 'hidden' && (
                <button
                  type="button"
                  className="gift-sheet-report-toggle"
                  onClick={() => setReportPhase('picker')}
                >
                  Báo cáo
                </button>
              )}
              {reportPhase === 'picker' && (
                <div className="gift-sheet-report-picker">
                  <p className="gift-sheet-report-label">Lý do báo cáo:</p>
                  <label>
                    <input
                      type="radio"
                      name="report-reason"
                      value="inappropriate"
                      checked={reportReason === 'inappropriate'}
                      onChange={() => setReportReason('inappropriate')}
                    />
                    {' '}Nội dung không phù hợp
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="report-reason"
                      value="spam"
                      checked={reportReason === 'spam'}
                      onChange={() => setReportReason('spam')}
                    />
                    {' '}Spam
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="report-reason"
                      value="other"
                      checked={reportReason === 'other'}
                      onChange={() => setReportReason('other')}
                    />
                    {' '}Khác
                  </label>
                  {reportError && (
                    <p className="gift-sheet-error" role="alert">{reportError}</p>
                  )}
                  <div className="gift-sheet-report-actions">
                    <button
                      type="button"
                      disabled={reportLoading}
                      onClick={handleReportSubmit}
                    >
                      {reportLoading ? 'Đang gửi…' : 'Xác nhận báo cáo'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setReportPhase('hidden'); setReportError(null) }}
                    >
                      Huỷ
                    </button>
                  </div>
                </div>
              )}
              {reportPhase === 'done' && (
                <p className="gift-sheet-report-done" role="status">
                  Đã gửi báo cáo
                </p>
              )}
            </div>

            {/* Share */}
            <div className="gift-sheet-share-wrap">
              <button
                type="button"
                className="gift-sheet-share-btn"
                onClick={handleShare}
                aria-label="Chia sẻ quà này"
              >
                🔗 Chia sẻ
              </button>
              {shareFeedback && (
                <span role="status" className="gift-sheet-share-feedback">
                  {shareFeedback}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── Prev / Next navigation ────────────────────────────────── */}
        <div className="gift-sheet-nav" aria-label="Điều hướng quà">
          <button
            type="button"
            className="gift-sheet-nav-btn"
            disabled={!prev}
            onClick={() => prev && onNavigate(prev)}
            aria-label="Quà trước"
          >
            ← Trước
          </button>
          <button
            type="button"
            className="gift-sheet-nav-btn"
            disabled={!next}
            onClick={() => next && onNavigate(next)}
            aria-label="Quà tiếp theo"
          >
            Sau →
          </button>
        </div>
      </div>
    </div>
  )
}
