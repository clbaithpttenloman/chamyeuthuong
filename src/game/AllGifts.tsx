/**
 * AllGifts — paginated gift browser with "Nhiều tim / Mới nhất" tabs.
 *
 * Uses GET /api/campaigns/<slug>/gifts?sort=hearts|new&page= (24/page, page ≤ 50).
 * Tapping a gift calls onOpenGift(publicId) so the parent can close this dialog
 * and open GiftSheet.
 *
 * Accessibility (NFR-4):
 *   - role="dialog" aria-modal="true"
 *   - Tabs use role="tab" / role="tabpanel"
 *   - Esc key closes
 *   - Focus trapped; returned to trigger on close
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { getGiftList, ApiError, type NoelGiftFlat } from '../api.ts'
import { errorMessage } from './errors.ts'

export interface AllGiftsProps {
  slug: string
  onClose: () => void
  /**
   * Called when the user taps a gift.
   * Parent closes the dialog and opens GiftSheet.
   */
  onOpenGift: (publicId: string) => void
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

export default function AllGifts({
  slug,
  onClose,
  onOpenGift,
  returnFocusRef,
}: AllGiftsProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = 'all-gifts-title'

  const [tab, setTab] = useState<'hearts' | 'new'>('hearts')
  const [gifts, setGifts] = useState<NoelGiftFlat[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // ── Focus trap + Esc ─────────────────────────────────────────────────
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const returnTarget = returnFocusRef?.current ?? null
    dialog.focus()

    const getFocusable = (): HTMLElement[] =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = getFocusable()
      if (!focusable.length) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (e.shiftKey) {
        if (document.activeElement === first || document.activeElement === dialog) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      returnTarget?.focus()
    }
  }, [onClose]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load page ────────────────────────────────────────────────────────
  const loadPage = useCallback(
    async (sort: 'hearts' | 'new', p: number, reset: boolean) => {
      if (p > 50) {
        setHasMore(false)
        return
      }
      setLoading(true)
      setFetchError(null)
      try {
        const batch = await getGiftList(slug, sort, p)
        setGifts((prev) => (reset ? batch : [...prev, ...batch]))
        setHasMore(batch.length === 24 && p < 50)
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'unknown'
        setFetchError(errorMessage(code))
      } finally {
        setLoading(false)
      }
    },
    [slug],
  )

  // Initial load + tab change
  useEffect(() => {
    setGifts([])
    setPage(1)
    setHasMore(true)
    void loadPage(tab, 1, true)
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLoadMore = useCallback(() => {
    const next = page + 1
    setPage(next)
    void loadPage(tab, next, false)
  }, [page, tab, loadPage])

  // ── Render ────────────────────────────────────────────────────────────

  const heartsPanelId = 'all-gifts-panel-hearts'
  const newPanelId = 'all-gifts-panel-new'

  return (
    <div className="noel-dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="noel-dialog all-gifts-dialog"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="noel-dialog-header">
          <h2 id={titleId} className="noel-dialog-title">🎄 Tất cả quà</h2>
          <button type="button" className="noel-dialog-close" aria-label="Đóng" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div
          role="tablist"
          aria-label="Sắp xếp quà"
          className="all-gifts-tabs"
        >
          <button
            role="tab"
            id="all-gifts-tab-hearts"
            aria-selected={tab === 'hearts'}
            aria-controls={heartsPanelId}
            className={
              'all-gifts-tab' + (tab === 'hearts' ? ' all-gifts-tab--active' : '')
            }
            onClick={() => setTab('hearts')}
          >
            ❤️ Nhiều tim
          </button>
          <button
            role="tab"
            id="all-gifts-tab-new"
            aria-selected={tab === 'new'}
            aria-controls={newPanelId}
            className={
              'all-gifts-tab' + (tab === 'new' ? ' all-gifts-tab--active' : '')
            }
            onClick={() => setTab('new')}
          >
            🆕 Mới nhất
          </button>
        </div>

        {/* Gift list */}
        <div
          role="tabpanel"
          id={tab === 'hearts' ? heartsPanelId : newPanelId}
          aria-labelledby={tab === 'hearts' ? 'all-gifts-tab-hearts' : 'all-gifts-tab-new'}
          className="all-gifts-panel"
        >
          {fetchError && (
            <p className="all-gifts-error" role="alert">{fetchError}</p>
          )}

          {gifts.length === 0 && !loading && !fetchError && (
            <p className="all-gifts-empty">Chưa có quà nào.</p>
          )}

          <ul className="all-gifts-list">
            {gifts.map((g, i) => (
              <li key={g.publicId} className="all-gifts-item">
                <button
                  type="button"
                  className="all-gifts-row"
                  onClick={() => {
                    onOpenGift(g.publicId)
                    onClose()
                  }}
                >
                  <span
                    className="all-gifts-position"
                    aria-label={`Thứ ${i + 1}`}
                  >
                    {i + 1}
                  </span>
                  <span className="all-gifts-name">
                    {g.nickname}
                    {g.className ? (
                      <span className="all-gifts-class"> · {g.className}</span>
                    ) : null}
                  </span>
                  <span
                    className="all-gifts-hearts"
                    aria-label={`${g.heartCount} tim`}
                  >
                    ❤️ {g.heartCount}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {loading && (
            <p className="all-gifts-loading" aria-live="polite">
              Đang tải…
            </p>
          )}

          {!loading && hasMore && (
            <button
              type="button"
              className="all-gifts-more-btn"
              onClick={handleLoadMore}
            >
              Xem thêm
            </button>
          )}

          {!hasMore && gifts.length > 0 && (
            <p className="all-gifts-end">Đã xem hết {gifts.length} quà.</p>
          )}
        </div>
      </div>
    </div>
  )
}
