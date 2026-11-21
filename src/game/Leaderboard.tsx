/**
 * Leaderboard — top-10 dialog from the current tree data.
 *
 * Shows rank, nickname · class, heart count.
 * Tapping a row opens the GiftSheet for that gift.
 *
 * Data comes directly from NoelPage's mergedGifts (already sorted by rank),
 * so no extra API call is needed.
 *
 * Accessibility (NFR-4):
 *   - role="dialog" aria-modal="true" labelled by title
 *   - Esc key closes (via useDialog, runs once)
 *   - Focus trapped; returned to trigger on close
 */
import {
  useEffect,
  useRef,
  type ReactNode,
} from 'react'
import type { NoelGift } from '../api.ts'
import { useDialog } from './useDialog.ts'

export interface LeaderboardProps {
  /** All visible gifts from the tree (sorted by rank). Top-10 are shown. */
  gifts: NoelGift[]
  onClose: () => void
  /**
   * Called when the user taps a gift row.
   * Parent closes the dialog and opens GiftSheet.
   */
  onOpenGift: (publicId: string) => void
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

export default function Leaderboard({
  gifts,
  onClose,
  onOpenGift,
  returnFocusRef,
}: LeaderboardProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = 'leaderboard-title'

  // onClose ref so the focus-trap effect runs once (not on every parent re-render)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // Focus trap + Esc, runs once on mount
  useDialog({ dialogRef, onCloseRef, returnFocusRef })

  const top10 = gifts.slice(0, 10)

  return (
    <div className="noel-dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="noel-dialog leaderboard-dialog"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="noel-dialog-header">
          <h2 id={titleId} className="noel-dialog-title">🏆 Bảng xếp hạng</h2>
          <button type="button" className="noel-dialog-close" aria-label="Đóng" onClick={onClose}>
            ✕
          </button>
        </div>

        {top10.length === 0 ? (
          <p className="leaderboard-empty">Chưa có quà nào. Hãy là người đầu tiên!</p>
        ) : (
          <ol className="leaderboard-list">
            {top10.map((g) => (
              <li key={g.publicId} className="leaderboard-item">
                <button
                  type="button"
                  className="leaderboard-row"
                  onClick={() => {
                    onOpenGift(g.publicId)
                    onClose()
                  }}
                >
                  <span
                    className={
                      'leaderboard-rank' +
                      (g.rank <= 3 ? ` leaderboard-rank--top${g.rank}` : '')
                    }
                    aria-label={`Hạng ${g.rank}`}
                  >
                    {g.rank <= 3 ? ['🥇', '🥈', '🥉'][g.rank - 1] : `#${g.rank}`}
                  </span>
                  <span className="leaderboard-name">
                    {g.nickname}
                    {g.className ? (
                      <span className="leaderboard-class"> · {g.className}</span>
                    ) : null}
                  </span>
                  <span className="leaderboard-hearts" aria-label={`${g.heartCount} tim`}>
                    ❤️ {g.heartCount}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}
