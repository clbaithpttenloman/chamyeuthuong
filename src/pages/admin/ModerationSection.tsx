/**
 * ModerationSection — Duyệt thiệp (default admin tab).
 *
 * Pending cards: oldest first, paging with after= cursor.
 * Approved/hidden: newest first, paging with before= cursor.
 * Filter by status and teacher.
 * Select + bulk approve/hide (≤ 200), single approve/hide/delete.
 * Card thumbnail via CardView mini.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AdminCard, AdminTeacher } from '../../../shared/api.ts'
import {
  bulkReviewCards,
  deleteAdminCard,
  listAdminCards,
  updateAdminCard,
} from '../../api'
import CardView from '../../components/CardView.tsx'

type Status = 'pending' | 'approved' | 'hidden'
type Tab = Status

const TAB_LABELS: Record<Tab, string> = {
  pending: 'Chờ duyệt',
  approved: 'Đã duyệt',
  hidden: 'Đã ẩn',
}

export default function ModerationSection({
  teachers,
  pendingCount,
  onPendingCountChange,
  onAccessError,
}: {
  teachers: AdminTeacher[]
  pendingCount: number
  onPendingCountChange: (delta: number) => void
  onAccessError: (e: unknown) => boolean
}) {
  const [tab, setTab] = useState<Tab>('pending')
  const [teacherFilter, setTeacherFilter] = useState<number | ''>('')
  const [cards, setCards] = useState<AdminCard[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const PAGE_SIZE = 200
  // cursor: for pending oldest-first (after=), for others newest-first (before=)
  const cursorRef = useRef<number | null>(null)

  const loadCards = useCallback(async (
    status: Tab,
    teacher: number | '',
    append: boolean,
  ) => {
    setLoading(true)
    setError(null)
    try {
      const params: Parameters<typeof listAdminCards>[0] = { status }
      if (teacher) params.teacher = teacher
      if (append && cursorRef.current !== null) {
        if (status === 'pending') params.after = cursorRef.current
        else params.before = cursorRef.current
      }
      const data = await listAdminCards(params)
      setCards((prev) => append ? [...prev, ...data] : data)
      setHasMore(data.length === PAGE_SIZE)
      if (data.length > 0) {
        cursorRef.current = data[data.length - 1].id
      }
    } catch (e) {
      if (!onAccessError(e)) {
        setError(e instanceof Error ? e.message : 'Lỗi tải danh sách thiệp')
      }
    } finally {
      setLoading(false)
    }
  }, [onAccessError])

  // Reload when tab or teacher filter changes
  useEffect(() => {
    setSelected(new Set())
    cursorRef.current = null
    void loadCards(tab, teacherFilter, false)
  }, [tab, teacherFilter, loadCards])

  function handleLoadMore() {
    void loadCards(tab, teacherFilter, true)
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (selected.size === cards.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(cards.map((c) => c.id)))
    }
  }

  async function handleBulk(status: 'approved' | 'hidden') {
    if (selected.size === 0) return
    setError(null)
    const ids = [...selected]
    try {
      await bulkReviewCards({ ids, status })
      const delta = status === 'approved'
        ? -ids.filter((id) => cards.find((c) => c.id === id)?.status === 'pending').length
        : -ids.filter((id) => cards.find((c) => c.id === id)?.status === 'pending').length
      onPendingCountChange(delta)
      setCards((prev) => prev.filter((c) => !selected.has(c.id)))
      setSelected(new Set())
    } catch (e) {
      if (!onAccessError(e)) {
        setError(e instanceof Error ? e.message : 'Lỗi thao tác hàng loạt')
      }
    }
  }

  async function handleSingle(card: AdminCard, action: 'approved' | 'hidden' | 'delete') {
    setError(null)
    try {
      if (action === 'delete') {
        if (!confirm('Xóa thiệp này? Hành động không thể hoàn tác.')) return
        await deleteAdminCard(card.id)
      } else {
        await updateAdminCard(card.id, action)
        if (card.status === 'pending') onPendingCountChange(-1)
      }
      setCards((prev) => prev.filter((c) => c.id !== card.id))
      setSelected((prev) => { const next = new Set(prev); next.delete(card.id); return next })
    } catch (e) {
      if (!onAccessError(e)) {
        setError(e instanceof Error ? e.message : 'Lỗi thao tác thiệp')
      }
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="mod-header">
        <h2>
          Duyệt thiệp
          {pendingCount > 0 && (
            <span className="pending-badge" aria-label={`${pendingCount} thiệp chờ duyệt`}>
              {pendingCount}
            </span>
          )}
        </h2>
        {selected.size > 0 && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => { void handleBulk('approved') }}
            >
              Duyệt {selected.size} thiệp
            </button>
            <button
              type="button"
              className="btn-warn"
              onClick={() => { void handleBulk('hidden') }}
            >
              Ẩn {selected.size} thiệp
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="admin-tabs" role="tablist">
        {(Object.entries(TAB_LABELS) as [Tab, string][]).map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`tab-btn${tab === t ? ' tab-btn--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {label}
            {t === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="mod-filters">
        <select
          value={teacherFilter}
          onChange={(e) => setTeacherFilter(e.target.value ? Number(e.target.value) : '')}
          aria-label="Lọc theo thầy cô"
          style={{ padding: '0.4rem 0.65rem', borderRadius: '0.4rem', border: '1px solid #d6d3d1', fontSize: '0.9rem' }}
        >
          <option value="">Tất cả thầy cô</option>
          {teachers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title ? `${t.title} ` : ''}{t.name}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}
      {loading && <p className="admin-loading">Đang tải...</p>}

      {/* Select all row */}
      {!loading && cards.length > 0 && (
        <div className="mod-select-row">
          <input
            type="checkbox"
            id="mod-select-all"
            checked={selected.size === cards.length && cards.length > 0}
            onChange={toggleAll}
            aria-label="Chọn tất cả"
          />
          <label htmlFor="mod-select-all" style={{ fontSize: '0.85rem', cursor: 'pointer' }}>
            Chọn tất cả ({cards.length})
          </label>
        </div>
      )}

      {/* Card list */}
      <div className="admin-section-content" role="tabpanel">
        {!loading && cards.length === 0 && (
          <p className="admin-empty">Không có thiệp nào.</p>
        )}
        <div className="mod-list">
          {cards.map((card) => (
            <ModCard
              key={card.id}
              card={card}
              selected={selected.has(card.id)}
              onToggle={() => toggleSelect(card.id)}
              onAction={(action) => { void handleSingle(card, action) }}
            />
          ))}
        </div>

        {hasMore && !loading && (
          <div className="mod-pagination">
            <button type="button" onClick={handleLoadMore}>Tải thêm</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Card item ─────────────────────────────────────────────────────────────

function ModCard({
  card,
  selected,
  onToggle,
  onAction,
}: {
  card: AdminCard
  selected: boolean
  onToggle: () => void
  onAction: (action: 'approved' | 'hidden' | 'delete') => void
}) {
  const { teacher, template } = card
  const displayTeacher = teacher
    ? `${teacher.title ? `${teacher.title} ` : ''}${teacher.name}`
    : '—'

  return (
    <div className={`mod-item${selected ? ' mod-item--selected' : ''}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem' }}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label="Chọn thiệp này"
        />
      </div>
      <div className="mod-item-layout">
        {/* Thumbnail */}
        <div className="mod-card-thumb">
          <div className="card-mini">
            <div className="card-mini-inner">
              <CardView
                card={{
                  name: teacher?.name ?? '?',
                  subject: teacher ? '' : '',
                  message: card.message,
                  title: (teacher?.title as 'Thầy' | 'Cô' | null) ?? null,
                }}
                layout={template?.layout ?? 'classic'}
                images={{}}
                from={card.anonymous || !card.fromName
                  ? (card.fromClass ? `Một bạn học sinh · ${card.fromClass}` : 'Một bạn học sinh')
                  : (card.fromClass ? `${card.fromName} · ${card.fromClass}` : card.fromName)
                }
              />
            </div>
          </div>
        </div>

        {/* Details */}
        <div className="mod-item-content">
          <div className="mod-item-teacher">{displayTeacher}</div>
          <p className="mod-item-text">{card.message}</p>
          <div className="mod-item-meta">
            {card.anonymous
              ? (card.fromClass ? `Ẩn danh · ${card.fromClass}` : 'Ẩn danh')
              : [card.fromName, card.fromClass].filter(Boolean).join(' · ') || '—'}
            {' · '}
            {template?.name ?? '—'}
            {' · '}
            {new Date(card.createdAt).toLocaleString('vi-VN')}
          </div>
          <div className="admin-actions">
            {card.status !== 'approved' && (
              <button type="button" onClick={() => onAction('approved')}>Duyệt</button>
            )}
            {card.status !== 'hidden' && (
              <button type="button" className="btn-warn" onClick={() => onAction('hidden')}>Ẩn</button>
            )}
            <button
              type="button"
              className="btn-danger"
              onClick={() => onAction('delete')}
            >
              Xóa
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
