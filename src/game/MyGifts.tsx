/**
 * MyGifts — "Quà của tôi" panel + account management (FR-13, ADR-8).
 *
 * Shows:
 *   - Own gifts with rank and status
 *       visible:   rank #N · ❤️ M · "Xoá" (with confirm)
 *       hidden:    "Đang chờ xem xét" badge, no delete
 *   - "Đăng xuất" button
 *   - "Xoá tài khoản" with a confirm dialog listing what is deleted
 *       Refused (pending_review): informative message, no delete
 *
 * Accessibility (NFR-4):
 *   - role="dialog" aria-modal="true" labelled by title
 *   - Esc key closes innermost open layer first (via useDialog)
 *   - Focus trapped; returned to trigger on close
 *   - Confirm dialogs trap focus via useDialog.pushLayer
 *
 * Changes (review cycle 1):
 *   - deleteMyAccount: always sign out locally even if logout() fails
 *   - Logout errors caught and shown
 *   - Confirm dialogs push/pop useDialog layers: Esc and Tab target the
 *     innermost confirm before the base dialog
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  getMyGifts,
  deleteMyGift,
  deleteMyAccount,
  logout,
  ApiError,
} from '../api.ts'
import type { NoelGift } from '../api.ts'
import { errorMessage } from './errors.ts'
import { useDialog } from './useDialog.ts'

type MyGift = NoelGift & { status: string }

export interface MyGiftsProps {
  slug: string
  onClose: () => void
  onSignOut: () => void
  onOpenGift: (publicId: string) => void
  onGiftDeleted: (publicId: string) => void
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

export default function MyGifts({
  slug,
  onClose,
  onSignOut,
  onOpenGift,
  onGiftDeleted,
  returnFocusRef,
}: MyGiftsProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = 'my-gifts-title'

  // onClose ref so the focus-trap effect runs once
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // Focus trap + Esc (runs once on mount); returns pushLayer / popLayer for confirms
  const { pushLayer, popLayer } = useDialog({ dialogRef, onCloseRef, returnFocusRef })

  const [gifts, setGifts] = useState<MyGift[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Confirm: delete a specific gift
  const confirmDeleteGiftRef = useRef<HTMLDivElement>(null)
  const [confirmDeleteGift, setConfirmDeleteGift] = useState<string | null>(null)
  const [deletingGift, setDeletingGift] = useState(false)
  const [deleteGiftError, setDeleteGiftError] = useState<string | null>(null)

  // Track the button that opened each confirm (for focus return)
  const deleteGiftOpenerRef = useRef<HTMLButtonElement | null>(null)
  const deleteAccountOpenerRef = useRef<HTMLButtonElement | null>(null)

  // Confirm: delete account
  const confirmDeleteAccountRef = useRef<HTMLDivElement>(null)
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false)
  const [deletingAccount, setDeletingAccount] = useState(false)
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  // ── Load gifts ───────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    getMyGifts(slug)
      .then((list) => {
        if (alive) setGifts(list as MyGift[])
      })
      .catch((err: unknown) => {
        if (alive) {
          const code = err instanceof ApiError ? err.code : 'unknown'
          setError(errorMessage(code))
        }
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [slug])

  // ── Push / pop confirm layers ─────────────────────────────────────────
  // Esc and Tab target the innermost open confirm, not the base dialog.
  useEffect(() => {
    if (confirmDeleteGift && confirmDeleteGiftRef.current) {
      pushLayer(
        confirmDeleteGiftRef.current,
        () => { setConfirmDeleteGift(null); setDeleteGiftError(null) },
        deleteGiftOpenerRef.current,
      )
      return () => popLayer(deleteGiftOpenerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmDeleteGift])

  useEffect(() => {
    if (confirmDeleteAccount && confirmDeleteAccountRef.current) {
      pushLayer(
        confirmDeleteAccountRef.current,
        () => { setConfirmDeleteAccount(false); setDeleteAccountError(null) },
        deleteAccountOpenerRef.current,
      )
      return () => popLayer(deleteAccountOpenerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmDeleteAccount])

  // ── Delete gift ──────────────────────────────────────────────────────
  const handleDeleteGift = useCallback(
    async (publicId: string) => {
      setDeletingGift(true)
      setDeleteGiftError(null)
      try {
        await deleteMyGift(publicId)
        setGifts((prev) => prev.filter((g) => g.publicId !== publicId))
        setConfirmDeleteGift(null)
        onGiftDeleted(publicId)
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'unknown'
        setDeleteGiftError(errorMessage(code))
      } finally {
        setDeletingGift(false)
      }
    },
    [onGiftDeleted],
  )

  // ── Delete account ───────────────────────────────────────────────────
  // Always sign out locally even if logout() fails.
  const handleDeleteAccount = useCallback(async () => {
    setDeletingAccount(true)
    setDeleteAccountError(null)
    setLogoutError(null)
    try {
      await deleteMyAccount()
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown'
      if (code === 'pending_review') {
        setDeleteAccountError(
          'Bạn có quà đang chờ xem xét. Vui lòng chờ kiểm duyệt xong trước khi xoá tài khoản.',
        )
        setDeletingAccount(false)
        setConfirmDeleteAccount(false)
        return
      }
      setDeleteAccountError(errorMessage(code))
      setDeletingAccount(false)
      setConfirmDeleteAccount(false)
      return
    }
    // deleteMyAccount succeeded — always sign out locally
    try {
      await logout()
    } catch (err) {
      // Logout failure is non-fatal: we already deleted the account
      const code = err instanceof ApiError ? err.code : 'unknown'
      setLogoutError(errorMessage(code))
    }
    setDeletingAccount(false)
    onSignOut()
    onClose()
  }, [onSignOut, onClose])

  // ── Sign out ─────────────────────────────────────────────────────────
  const handleSignOut = useCallback(async () => {
    setLogoutError(null)
    try {
      await logout()
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown'
      setLogoutError(errorMessage(code))
      return
    }
    onSignOut()
    onClose()
  }, [onSignOut, onClose])

  // ── Render ────────────────────────────────────────────────────────────

  const visibleGifts = gifts.filter((g) => g.status === 'visible')
  const hiddenGifts = gifts.filter(
    (g) => g.status === 'hidden_auto' || g.status === 'hidden_admin',
  )

  return (
    <div className="noel-dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="noel-dialog my-gifts-dialog"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="noel-dialog-header">
          <h2 id={titleId} className="noel-dialog-title">🎁 Quà của tôi</h2>
          <button type="button" className="noel-dialog-close" aria-label="Đóng" onClick={onClose}>
            ✕
          </button>
        </div>

        {loading && <p className="my-gifts-loading">Đang tải…</p>}
        {error && <p className="my-gifts-error" role="alert">{error}</p>}

        {!loading && gifts.length === 0 && !error && (
          <p className="my-gifts-empty">Bạn chưa có quà nào. Hãy treo quà đầu tiên!</p>
        )}

        {visibleGifts.length > 0 && (
          <section className="my-gifts-section">
            <h3 className="my-gifts-section-title">Quà hiển thị ({visibleGifts.length})</h3>
            <ul className="my-gifts-list">
              {visibleGifts.map((g) => (
                <li key={g.publicId} className="my-gifts-item">
                  <button
                    type="button"
                    className="my-gifts-row"
                    onClick={() => {
                      onOpenGift(g.publicId)
                      onClose()
                    }}
                  >
                    <span className="my-gifts-rank" aria-label={`Hạng ${g.rank}`}>
                      #{g.rank}
                    </span>
                    <span className="my-gifts-name">
                      {g.nickname}
                      {g.className ? ` · ${g.className}` : ''}
                    </span>
                    <span className="my-gifts-hearts" aria-label={`${g.heartCount} tim`}>
                      ❤️ {g.heartCount}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="my-gifts-delete-btn"
                    aria-label={`Xoá quà của ${g.nickname}`}
                    ref={(el) => {
                      if (confirmDeleteGift === g.publicId) deleteGiftOpenerRef.current = el
                    }}
                    onClick={(e) => {
                      deleteGiftOpenerRef.current = e.currentTarget
                      e.stopPropagation()
                      setConfirmDeleteGift(g.publicId)
                      setDeleteGiftError(null)
                    }}
                  >
                    Xoá
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {hiddenGifts.length > 0 && (
          <section className="my-gifts-section">
            <h3 className="my-gifts-section-title">Đang chờ xem xét ({hiddenGifts.length})</h3>
            <ul className="my-gifts-list">
              {hiddenGifts.map((g) => (
                <li key={g.publicId} className="my-gifts-item my-gifts-item--hidden">
                  <span className="my-gifts-name">
                    {g.nickname}
                    {g.className ? ` · ${g.className}` : ''}
                  </span>
                  <span className="my-gifts-status-badge">Đang chờ xem xét</span>
                </li>
              ))}
            </ul>
            <p className="my-gifts-hidden-note">
              Quà đang chờ kiểm duyệt không thể xoá hoặc xem trước.
            </p>
          </section>
        )}

        {deleteAccountError && (
          <p className="my-gifts-error" role="alert">{deleteAccountError}</p>
        )}
        {logoutError && (
          <p className="my-gifts-error" role="alert">{logoutError}</p>
        )}

        <div className="my-gifts-actions">
          <button
            type="button"
            className="my-gifts-signout-btn"
            onClick={handleSignOut}
          >
            Đăng xuất
          </button>
          <button
            type="button"
            className="my-gifts-delete-account-btn"
            ref={(el) => { deleteAccountOpenerRef.current = el }}
            onClick={() => {
              setConfirmDeleteAccount(true)
              setDeleteAccountError(null)
              setLogoutError(null)
            }}
          >
            Xoá tài khoản
          </button>
        </div>
      </div>

      {/* ── Confirm delete gift ───────────────────────────────────── */}
      {confirmDeleteGift && (
        <div
          ref={confirmDeleteGiftRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-delete-gift-title"
          className="noel-confirm-backdrop"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="noel-confirm-dialog">
            <h3 id="confirm-delete-gift-title">Xoá quà?</h3>
            <p>Quà sẽ bị xoá vĩnh viễn và bạn sẽ được thêm 1 slot trống.</p>
            {deleteGiftError && (
              <p className="noel-confirm-error" role="alert">{deleteGiftError}</p>
            )}
            <div className="noel-confirm-actions">
              <button
                type="button"
                disabled={deletingGift}
                onClick={() => { void handleDeleteGift(confirmDeleteGift) }}
              >
                {deletingGift ? 'Đang xoá…' : 'Xoá'}
              </button>
              <button
                type="button"
                onClick={() => { setConfirmDeleteGift(null); setDeleteGiftError(null) }}
              >
                Huỷ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm delete account ────────────────────────────────── */}
      {confirmDeleteAccount && (
        <div
          ref={confirmDeleteAccountRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-delete-account-title"
          className="noel-confirm-backdrop"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="noel-confirm-dialog">
            <h3 id="confirm-delete-account-title">Xoá tài khoản?</h3>
            <p>Thao tác này sẽ xoá vĩnh viễn:</p>
            <ul className="noel-confirm-list">
              <li>Tất cả quà của bạn</li>
              <li>Tất cả tim bạn đã thả</li>
              <li>Tất cả báo cáo bạn đã gửi</li>
            </ul>
            <p><strong>Thao tác này không thể hoàn tác.</strong></p>
            {deleteAccountError && (
              <p className="noel-confirm-error" role="alert">{deleteAccountError}</p>
            )}
            <div className="noel-confirm-actions">
              <button
                type="button"
                className="noel-confirm-danger-btn"
                disabled={deletingAccount}
                onClick={() => { void handleDeleteAccount() }}
              >
                {deletingAccount ? 'Đang xoá…' : 'Xoá tài khoản'}
              </button>
              <button
                type="button"
                onClick={() => { setConfirmDeleteAccount(false); setDeleteAccountError(null) }}
              >
                Huỷ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
