/**
 * GiftModerationSection — Kiểm duyệt quà (Phase 2 gift moderation).
 *
 * Two filter tabs:
 *   "Bị báo cáo" — gifts with report_count ≥ 1 (not deleted).
 *   "Đã ẩn"      — gifts with status hidden_auto or hidden_admin.
 *
 * Plus a tombstone sub-section: "Tài khoản đã xoá bị khoá" (banned_identity rows).
 *
 * Each row shows:
 *   - CardView card preview (Noel props: toLine=null, Noel stamp, from line).
 *   - Gift-specific detail: nickname · class · campaign · hearts · report count · status.
 *   - Actions: Khôi phục / Ẩn / Xoá (gift), Khoá/Mở khoá (user) from gift.userBanned.
 *   - Each action requires a confirm dialog stating the consequence.
 *
 * Auth: requires Google session. Typed-email sessions → 401 → Google sign-in hint.
 *
 * FR-27; ADR-8; plan.md "Admin moderation queue"; decisions.md "Phase 2 review cycle 1".
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  type AdminCampaignRow,
  type AdminGiftItem,
  type AdminTombstoneItem,
  banAdminUser,
  deleteAdminTombstone,
  listAdminCampaigns,
  listAdminGifts,
  listAdminTombstones,
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
import site from '../../content/site.json'

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

  // Campaign map: campaignId → name (loaded once).
  const [campaignNames, setCampaignNames] = useState<Map<number, string>>(new Map())
  const campaignsLoaded = useRef(false)

  // Tombstones
  const [tombstones, setTombstones] = useState<AdminTombstoneItem[]>([])
  const [tombstonesLoading, setTombstonesLoading] = useState(false)
  const [tombstonesError, setTombstonesError] = useState<string | null>(null)

  // Stale-response guard: each loadGifts call gets a unique request id; responses
  // from an older request (different tab) are discarded.
  const currentRidRef = useRef(0)

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

  // Load tombstones once
  useEffect(() => {
    setTombstonesLoading(true)
    listAdminTombstones()
      .then((rows) => { setTombstones(rows); setTombstonesLoading(false) })
      .catch(() => { setTombstonesError('Không tải được danh sách tài khoản.'); setTombstonesLoading(false) })
  }, [])

  const loadGifts = useCallback(async (filter: FilterTab) => {
    const rid = ++currentRidRef.current
    setLoading(true)
    setError(null)
    setNeedsGoogle(false)
    try {
      const data = await listAdminGifts(filter)
      // Stale-response guard: discard if a newer request was started
      if (rid !== currentRidRef.current) return
      setGifts(data)
      if (filter === 'reported' && onReportedCountChange) {
        onReportedCountChange(data.length)
      }
    } catch (e) {
      if (rid !== currentRidRef.current) return
      if (e instanceof ApiError && e.status === 401) {
        setNeedsGoogle(true)
        onAccessError(e)
      } else if (!onAccessError(e)) {
        setError(giftModerationErrorMessage(
          e instanceof ApiError ? e.status : 500,
          e instanceof ApiError ? e.code : 'unknown',
        ))
      }
    } finally {
      if (rid === currentRidRef.current) setLoading(false)
    }
  }, [onAccessError, onReportedCountChange])

  useEffect(() => {
    void loadGifts(tab)
  }, [tab, loadGifts])

  // ── Action handlers ───────────────────────────────────────────────────────

  const handleGiftAction = useCallback(async (
    gift: AdminGiftItem,
    action: 'restore' | 'hide' | 'delete',
    buttonRef: React.RefObject<HTMLButtonElement | null>,
  ) => {
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
      // Remove from list immediately; use functional update for accurate count
      setGifts((prev) => {
        const next = prev.filter((g) => g.id !== gift.id)
        if (tab === 'reported' && onReportedCountChange) {
          onReportedCountChange(next.length)
        }
        return next
      })
    } catch (e) {
      buttonRef.current?.focus()
      if (!onAccessError(e)) {
        setError(giftModerationErrorMessage(
          e instanceof ApiError ? e.status : 500,
          e instanceof ApiError ? e.code : 'unknown',
        ))
      }
    }
  }, [tab, onAccessError, onReportedCountChange])

  const handleUserAction = useCallback(async (
    gift: AdminGiftItem,
    action: 'ban' | 'unban',
    buttonRef: React.RefObject<HTMLButtonElement | null>,
  ) => {
    const confirmMsg = userActionConfirmText(action)
    if (!window.confirm(confirmMsg)) {
      buttonRef.current?.focus()
      return
    }

    setError(null)
    try {
      await banAdminUser(gift.userId, action === 'ban')
      // Update the gift's userBanned field in the local list
      setGifts((prev) =>
        prev.map((g) =>
          g.userId === gift.userId ? { ...g, userBanned: action === 'ban' } : g,
        ),
      )
      // A ban hides the user's gifts — reload to reflect removals from this list
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
  }, [tab, loadGifts, onAccessError])

  const handleRemoveTombstone = useCallback(async (id: number) => {
    if (!window.confirm('Gỡ khóa tài khoản đã xoá này? Người dùng có thể đăng nhập lại bằng cùng tài khoản Google.')) return
    try {
      await deleteAdminTombstone(id)
      setTombstones((prev) => prev.filter((t) => t.id !== id))
    } catch {
      setTombstonesError('Không thể gỡ khóa. Vui lòng thử lại.')
    }
  }, [])

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
              campaignName={campaignNames.get(gift.campaignId)}
              onGiftAction={(action, ref) => { void handleGiftAction(gift, action, ref) }}
              onUserAction={(action, ref) => { void handleUserAction(gift, action, ref) }}
            />
          ))}
        </div>
      </div>

      {/* Tombstone section */}
      <TombstoneSection
        tombstones={tombstones}
        loading={tombstonesLoading}
        error={tombstonesError}
        onRemove={handleRemoveTombstone}
      />
    </div>
  )
}

// ── Tombstone section ─────────────────────────────────────────────────────────

function TombstoneSection({
  tombstones,
  loading,
  error,
  onRemove,
}: {
  tombstones: AdminTombstoneItem[]
  loading: boolean
  error: string | null
  onRemove: (id: number) => void
}) {
  return (
    <section style={{ marginTop: '2rem' }}>
      <h3 style={{ marginBottom: '0.5rem' }}>Tài khoản đã xoá bị khoá</h3>
      <p className="admin-hint" style={{ fontSize: '0.875rem', color: '#78716c', marginBottom: '0.75rem' }}>
        Những tài khoản này đã xoá tài khoản trong khi bị khoá. Người dùng không thể đăng nhập lại cho đến khi được gỡ khóa.
      </p>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {loading && <p className="admin-loading">Đang tải…</p>}
      {!loading && tombstones.length === 0 && (
        <p className="admin-empty">Không có tài khoản nào bị khoá sau khi xoá.</p>
      )}
      {tombstones.map((t) => (
        <div
          key={t.id}
          className="mod-item"
          style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.5rem 0' }}
        >
          <span style={{ fontSize: '0.875rem', color: '#78716c' }}>
            ID #{t.id} · {new Date(t.createdAt).toLocaleString('vi-VN')}
          </span>
          <button
            type="button"
            className="btn-warn"
            onClick={() => onRemove(t.id)}
            aria-label={`Gỡ khóa tài khoản tombstone ${t.id}`}
          >
            Gỡ khóa
          </button>
        </div>
      ))}
    </section>
  )
}

// ── Gift row ──────────────────────────────────────────────────────────────────

type GiftModerationRowProps = {
  gift: AdminGiftItem
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
  campaignName,
  onGiftAction,
  onUserAction,
}: GiftModerationRowProps) {
  const restoreRef = useRef<HTMLButtonElement>(null)
  const hideRef = useRef<HTMLButtonElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const banRef = useRef<HTMLButtonElement>(null)

  const actions = availableGiftActions(gift.status as Parameters<typeof availableGiftActions>[0])

  // Noel card preview props: use campaign name for card name line (matches giftToCardViewProps),
  // toLine=null and subLine=null hide the teacher-card greeting/subject lines.
  const campaignLabel = campaignName ?? `Chiến dịch ${gift.campaignId}`
  const previewCard = {
    name: campaignLabel,
    subject: '',
    message: gift.message,
    title: null as null,
  }
  const statusLabel = giftStatusLabel(gift.status as Parameters<typeof giftStatusLabel>[0])
  const isBanned = gift.userBanned

  return (
    <article
      className="mod-item"
      aria-label={`Quà của ${gift.nickname}, ${gift.className}`}
    >
      <div className="mod-item-layout">
        {/* Card preview with Noel semantics */}
        <div className="mod-card-thumb" aria-hidden="true">
          <div className="card-mini">
            <CardView
              card={previewCard}
              layout={gift.layout}
              font={gift.font}
              ink={gift.ink}
              images={{}}
              from={`${gift.nickname}${gift.className ? ` · ${gift.className}` : ''}`}
              toLine={null}
              subLine={null}
              stamp={`${site.title} · Noel`}
              headingLevel="h2"
            />
          </div>
        </div>

        {/* Gift-specific details */}
        <div className="mod-item-content">
          {/* Sender info */}
          <div className="mod-item-teacher">
            <strong>{gift.nickname}</strong>
            {gift.className ? <> · {gift.className}</> : null}
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

          {/* User moderation: Khoá/Mở khoá chosen from gift.userBanned */}
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
                ref={banRef}
                type="button"
                className="btn-warn"
                onClick={() => onUserAction('unban', banRef)}
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
