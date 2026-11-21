/**
 * GiftModerationSection — Kiểm duyệt quà (Phase 2 gift moderation).
 *
 * Two filter tabs:
 *   "Bị báo cáo" — gifts with report_count ≥ 1 (not deleted).
 *   "Đã ẩn"      — gifts with status hidden_auto or hidden_admin.
 *
 * Each row shows:
 *   - CardView card preview (using available fields; "another engineer" adds optional props later).
 *   - Gift-specific detail: nickname · class · campaign · hearts · report count · status.
 *   - Actions: Khôi phục / Ẩn / Xoá (gift), Khoá / Mở khoá (user).
 *   - Each action requires a confirm dialog stating the consequence.
 *
 * Auth: requires Google session. Typed-email sessions → 401 → Google sign-in hint.
 *
 * FR-27; ADR-8; plan.md "Admin moderation queue"; decisions.md "Keep both admin login methods".
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  type AdminCampaignRow,
  type AdminGiftItem,
  banAdminUser,
  listAdminCampaigns,
  listAdminGifts,
  updateAdminGiftStatus,
} from '../../api.ts'
import CardView from '../../components/CardView.tsx'
import {
  availableGiftActions,
  giftActionConfirmText,
  giftModerationErrorMessage,
  giftStatusLabel,
  userActionConfirmText,
  reportReasonsText,
} from './moderationHelpers.ts'

type FilterTab = 'reported' | 'hidden'

const TAB_LABELS: Record<FilterTab, string> = {
  reported: 'Bị báo cáo',
  hidden: 'Đã ẩn',
}

/** GiftModerationSection props */
export type GiftModerationSectionProps = {
  /** Called with the count of reported gifts whenever it changes (for the Admin.tsx tab badge). */
  onReportedCountChange?: (count: number) => void
  /** Called by Admin.tsx on a 401 so the sign-in state can be reset. */
  onAccessError: (e: unknown) => boolean
}

export default function GiftModerationSection({
  onReportedCountChange,
  onAccessError,
}: GiftModerationSectionProps) {
  const [tab, setTab] = useState<FilterTab>('reported')
  const [gifts, setGifts] = useState<AdminGiftItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsGoogle, setNeedsGoogle] = useState(false)

  // Track banned user IDs locally so the button toggles correctly within the session.
  const [bannedUsers, setBannedUsers] = useState<Set<number>>(new Set())

  // Campaign map: campaignId → name (loaded once).
  const [campaignNames, setCampaignNames] = useState<Map<number, string>>(new Map())
  const campaignsLoaded = useRef(false)

  // Load campaigns for the name column (best-effort; not critical).
  useEffect(() => {
    if (campaignsLoaded.current) return
    campaignsLoaded.current = true
    listAdminCampaigns()
      .then((rows: AdminCampaignRow[]) => {
        setCampaignNames(new Map(rows.map((r) => [r.id, r.name])))
      })
      .catch(() => { /* non-critical; campaign name column shows id fallback */ })
  }, [])

  const loadGifts = useCallback(async (filter: FilterTab) => {
    setLoading(true)
    setError(null)
    setNeedsGoogle(false)
    try {
      const data = await listAdminGifts(filter)
      setGifts(data)
      if (filter === 'reported' && onReportedCountChange) {
        onReportedCountChange(data.length)
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setNeedsGoogle(true)
        // Also bubble up — Admin.tsx may reset the sign-in gate.
        onAccessError(e)
      } else if (!onAccessError(e)) {
        setError(giftModerationErrorMessage(
          e instanceof ApiError ? e.status : 500,
          e instanceof ApiError ? e.code : 'unknown',
        ))
      }
    } finally {
      setLoading(false)
    }
  }, [onAccessError, onReportedCountChange])

  useEffect(() => {
    void loadGifts(tab)
  }, [tab, loadGifts])

  // ── Action handlers ───────────────────────────────────────────────────────

  async function handleGiftAction(
    gift: AdminGiftItem,
    action: 'restore' | 'hide' | 'delete',
    buttonRef: React.RefObject<HTMLButtonElement | null>,
  ) {
    const confirmMsg = giftActionConfirmText(action)
    if (!window.confirm(confirmMsg)) {
      buttonRef.current?.focus()
      return
    }

    const statusMap = {
      restore: 'visible' as const,
      hide: 'hidden_admin' as const,
      delete: 'deleted' as const,
    }

    setError(null)
    try {
      await updateAdminGiftStatus(gift.id, statusMap[action])
      // Remove from list (the gift's status changed; reload will reconcile).
      setGifts((prev) => prev.filter((g) => g.id !== gift.id))
      if (tab === 'reported' && onReportedCountChange) {
        onReportedCountChange(Math.max(0, gifts.length - 1))
      }
    } catch (e) {
      buttonRef.current?.focus()
      if (!onAccessError(e)) {
        setError(giftModerationErrorMessage(
          e instanceof ApiError ? e.status : 500,
          e instanceof ApiError ? e.code : 'unknown',
        ))
      }
    }
  }

  async function handleUserAction(
    gift: AdminGiftItem,
    action: 'ban' | 'unban',
    buttonRef: React.RefObject<HTMLButtonElement | null>,
  ) {
    const confirmMsg = userActionConfirmText(action)
    if (!window.confirm(confirmMsg)) {
      buttonRef.current?.focus()
      return
    }

    setError(null)
    try {
      await banAdminUser(gift.userId, action === 'ban')
      // Update local banned state so the button toggles.
      setBannedUsers((prev) => {
        const next = new Set(prev)
        if (action === 'ban') next.add(gift.userId)
        else next.delete(gift.userId)
        return next
      })
      // A ban hides the user's gifts — reload to reflect any removals from this list.
      if (action === 'ban') void loadGifts(tab)
    } catch (e) {
      buttonRef.current?.focus()
      if (!onAccessError(e)) {
        setError(giftModerationErrorMessage(
          e instanceof ApiError ? e.status : 500,
          e instanceof ApiError ? e.code : 'unknown',
        ))
      }
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (needsGoogle) {
    return (
      <div>
        <h2>Kiểm duyệt quà</h2>
        <p className="admin-error" role="alert">
          Kiểm duyệt quà yêu cầu đăng nhập bằng Google.
          Vui lòng đăng nhập bằng Google ở phần đăng nhập trên.
          (Email được nhập tay không có quyền truy cập tính năng này.)
        </p>
      </div>
    )
  }

  const reportedCount = tab === 'reported' ? gifts.length : undefined

  return (
    <div>
      {/* Section heading */}
      <h2 style={{ marginBottom: '0.75rem' }}>Kiểm duyệt quà</h2>

      {/* Tab navigation */}
      <div className="admin-tabs" role="tablist" aria-label="Lọc quà cần kiểm duyệt">
        {(Object.entries(TAB_LABELS) as [FilterTab, string][]).map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`tab-btn${tab === t ? ' tab-btn--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {label}
            {t === 'reported' && reportedCount !== undefined && reportedCount > 0 && (
              <span className="pending-badge" aria-label={`${reportedCount} quà bị báo cáo`}>
                {reportedCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}
      {loading && <p className="admin-loading">Đang tải...</p>}

      {/* Gift list */}
      <div role="tabpanel" aria-label={TAB_LABELS[tab]}>
        {!loading && gifts.length === 0 && (
          <p className="admin-empty">Không có quà nào cần kiểm duyệt.</p>
        )}
        <div className="mod-list">
          {gifts.map((gift) => (
            <GiftModerationRow
              key={gift.id}
              gift={gift}
              isBanned={bannedUsers.has(gift.userId)}
              campaignName={campaignNames.get(gift.campaignId)}
              onGiftAction={(action, ref) => { void handleGiftAction(gift, action, ref) }}
              onUserAction={(action, ref) => { void handleUserAction(gift, action, ref) }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Gift row ──────────────────────────────────────────────────────────────────

type GiftModerationRowProps = {
  gift: AdminGiftItem
  isBanned: boolean
  campaignName: string | undefined
  onGiftAction: (
    action: 'restore' | 'hide' | 'delete',
    ref: React.RefObject<HTMLButtonElement | null>,
  ) => void
  onUserAction: (
    action: 'ban' | 'unban',
    ref: React.RefObject<HTMLButtonElement | null>,
  ) => void
}

function GiftModerationRow({
  gift,
  isBanned,
  campaignName,
  onGiftAction,
  onUserAction,
}: GiftModerationRowProps) {
  const restoreRef = useRef<HTMLButtonElement>(null)
  const hideRef = useRef<HTMLButtonElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const banRef = useRef<HTMLButtonElement>(null)
  const unbanRef = useRef<HTMLButtonElement>(null)

  const actions = availableGiftActions(gift.status as Parameters<typeof availableGiftActions>[0])

  // Build the card preview with what the endpoint provides.
  // CardView currently renders teacher-card semantics; "another engineer" will add optional props.
  // We render as-is and place gift-specific lines beside it.
  const previewCard = {
    name: gift.nickname,          // gift sender nickname as the card name line
    subject: gift.className,      // class as subject line (best available fit)
    message: gift.message,
    title: null as null,
  }

  const campaignLabel = campaignName ?? `Chiến dịch ${gift.campaignId}`
  const statusLabel = giftStatusLabel(gift.status as Parameters<typeof giftStatusLabel>[0])

  return (
    <article
      className="mod-item"
      aria-label={`Quà của ${gift.nickname}, ${gift.className}`}
    >
      <div className="mod-item-layout">
        {/* Card preview — CardView rendered as-is; gift info lines placed beside it */}
        <div className="mod-card-thumb" aria-hidden="true">
          <div className="card-mini">
            <CardView
              card={previewCard}
              layout={gift.layout}
              font={gift.font}
              ink={gift.ink}
              images={{}}
              from={`${gift.nickname} · ${gift.className}`}
              headingLevel="h2"
            />
          </div>
        </div>

        {/* Gift-specific details */}
        <div className="mod-item-content">
          {/* Sender info */}
          <div className="mod-item-teacher">
            <strong>{gift.nickname}</strong>
            {' · '}
            {gift.className}
            {isBanned && (
              <span
                className="pending-badge"
                style={{ marginLeft: '0.4rem', background: '#ef4444' }}
                aria-label="Người dùng đã bị khoá"
              >
                Đã khoá
              </span>
            )}
          </div>

          {/* Campaign + stats */}
          <div className="mod-item-meta">
            <span aria-label="Chiến dịch">{campaignLabel}</span>
            {' · '}
            <span aria-label={`${gift.heartCount} tim`}>
              ♥ {gift.heartCount}
            </span>
            {' · '}
            <span aria-label={`${gift.reportCount} báo cáo: ${reportReasonsText(gift.reportReasons)}`}>
              🚩 {gift.reportCount} báo cáo{gift.reportCount > 0 ? ` (${reportReasonsText(gift.reportReasons)})` : ''}
            </span>
            {' · '}
            <span
              className={`status-badge ${gift.status === 'visible' ? 'status-published' : 'status-draft'}`}
              aria-label={`Trạng thái: ${statusLabel}`}
            >
              {statusLabel}
            </span>
          </div>

          {/* Message preview */}
          <p className="mod-item-text">{gift.message}</p>

          {/* Creation time */}
          <div className="mod-item-meta" style={{ marginBottom: '0.5rem' }}>
            {new Date(gift.createdAt).toLocaleString('vi-VN')}
          </div>

          {/* Gift moderation actions */}
          <div className="admin-actions" aria-label="Thao tác với quà">
            {actions.includes('restore') && (
              <button
                ref={restoreRef}
                type="button"
                onClick={() => onGiftAction('restore', restoreRef)}
                aria-label={`Khôi phục quà của ${gift.nickname}`}
              >
                Khôi phục
              </button>
            )}
            {actions.includes('hide') && (
              <button
                ref={hideRef}
                type="button"
                className="btn-warn"
                onClick={() => onGiftAction('hide', hideRef)}
                aria-label={`Ẩn quà của ${gift.nickname}`}
              >
                Ẩn
              </button>
            )}
            {actions.includes('delete') && (
              <button
                ref={deleteRef}
                type="button"
                className="btn-danger"
                onClick={() => onGiftAction('delete', deleteRef)}
                aria-label={`Xoá vĩnh viễn quà của ${gift.nickname}`}
              >
                Xoá
              </button>
            )}
          </div>

          {/* User moderation actions */}
          <div
            className="admin-actions"
            aria-label="Thao tác với người dùng"
            style={{ marginTop: '0.25rem' }}
          >
            {!isBanned ? (
              <button
                ref={banRef}
                type="button"
                className="btn-danger"
                onClick={() => onUserAction('ban', banRef)}
                aria-label={`Khoá tài khoản ${gift.nickname} (userId ${gift.userId})`}
              >
                Khoá người dùng
              </button>
            ) : (
              <button
                ref={unbanRef}
                type="button"
                className="btn-warn"
                onClick={() => onUserAction('unban', unbanRef)}
                aria-label={`Mở khoá tài khoản userId ${gift.userId}`}
              >
                Mở khoá người dùng
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}
