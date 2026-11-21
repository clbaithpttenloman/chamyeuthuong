/**
 * AllGifts — paginated gift browser with "Nhiều tim / Mới nhất" tabs.
 *
 * Uses GET /api/campaigns/<slug>/gifts?sort=hearts|new&page= (24/page, page ≤ 50).
 * Tapping a gift calls onOpenGift(publicId) so the parent can close this dialog
 * and open GiftSheet.
 *
 * Paging uses the pure `pagingReducer` from paging.ts for:
 *   - Stale-response guard (rid)
 *   - Page only advanced on success
 *   - Retry keeps the same page
 *   - Stops at page 50
 *
 * Focus management uses `useDialog` from useDialog.ts so the Esc / trap
 * effect runs once (never re-registered on parent re-renders).
 *
 * Accessibility (NFR-4):
 *   - role="dialog" aria-modal="true"
 *   - Tabs use role="tab" / role="tabpanel"
 *   - Esc key closes (via useDialog, runs once on mount)
 *   - Focus trapped; returned to trigger on close
 */
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { getGiftList, ApiError, type NoelGiftFlat } from '../api.ts'
import { errorMessage } from './errors.ts'
import { pagingReducer, initialPagingState } from './paging.ts'
import { useDialog } from './useDialog.ts'

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

  // Keep onClose in a ref so the focus-trap effect runs once (never on re-render)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // Focus trap + Esc, runs once on mount
  useDialog({ dialogRef, onCloseRef, returnFocusRef })

  // ── Paging state ─────────────────────────────────────────────────────
  const [state, dispatch] = useReducer(pagingReducer<NoelGiftFlat>, undefined, () =>
    initialPagingState<NoelGiftFlat>('hearts'),
  )
  const ridRef = useRef(0)

  // Fetch a specific page; uses ridRef for stale-response guard
  const fetchPage = useCallback(
    async (sort: 'hearts' | 'new', page: number) => {
      if (page > 50) return
      const rid = ++ridRef.current
      dispatch({ type: 'start', rid })
      try {
        const data = await getGiftList(slug, sort, page)
        dispatch({ type: 'ok', rid, data, pageSize: 24 })
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'unknown'
        dispatch({ type: 'err', rid, error: errorMessage(code) })
      }
    },
    [slug],
  )

  // Initial load + tab change: tab action resets page to 1
  useEffect(() => {
    void fetchPage(state.tab, 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tab])

  // Load more: triggered when page increases past 1 (from 'more' dispatch)
  useEffect(() => {
    if (state.page > 1) {
      void fetchPage(state.tab, state.page)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.page])

  const handleTabChange = useCallback((tab: 'hearts' | 'new') => {
    dispatch({ type: 'tab', tab })
  }, [])

  const handleLoadMore = useCallback(() => {
    dispatch({ type: 'more' })
  }, [])

  const handleRetry = useCallback(() => {
    // Retry the failed page without incrementing page
    void fetchPage(state.tab, state.page)
  }, [fetchPage, state.tab, state.page])

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
            aria-selected={state.tab === 'hearts'}
            aria-controls={heartsPanelId}
            className={
              'all-gifts-tab' + (state.tab === 'hearts' ? ' all-gifts-tab--active' : '')
            }
            onClick={() => handleTabChange('hearts')}
          >
            ❤️ Nhiều tim
          </button>
          <button
            role="tab"
            id="all-gifts-tab-new"
            aria-selected={state.tab === 'new'}
            aria-controls={newPanelId}
            className={
              'all-gifts-tab' + (state.tab === 'new' ? ' all-gifts-tab--active' : '')
            }
            onClick={() => handleTabChange('new')}
          >
            🆕 Mới nhất
          </button>
        </div>

        {/* Gift list */}
        <div
          role="tabpanel"
          id={state.tab === 'hearts' ? heartsPanelId : newPanelId}
          aria-labelledby={state.tab === 'hearts' ? 'all-gifts-tab-hearts' : 'all-gifts-tab-new'}
          className="all-gifts-panel"
        >
          {state.error && (
            <div className="all-gifts-error-wrap" role="alert">
              <p className="all-gifts-error">{state.error}</p>
              <button type="button" className="all-gifts-retry-btn" onClick={handleRetry}>
                Thử lại
              </button>
            </div>
          )}

          {state.items.length === 0 && !state.loading && !state.error && (
            <p className="all-gifts-empty">Chưa có quà nào.</p>
          )}

          <ul className="all-gifts-list">
            {state.items.map((g, i) => (
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

          {state.loading && (
            <p className="all-gifts-loading" aria-live="polite">
              Đang tải…
            </p>
          )}

          {!state.loading && !state.error && state.hasMore && (
            <button
              type="button"
              className="all-gifts-more-btn"
              onClick={handleLoadMore}
            >
              Xem thêm
            </button>
          )}

          {!state.hasMore && state.items.length > 0 && (
            <p className="all-gifts-end">Đã xem hết {state.items.length} quà.</p>
          )}
        </div>
      </div>
    </div>
  )
}
