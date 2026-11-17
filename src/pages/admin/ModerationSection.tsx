/**
 * ModerationSection — Duyệt thiệp (default admin tab).
 *
 * Pending cards: oldest first, paging with after= cursor.
 * Approved/hidden: newest first, paging with before= cursor.
 * Filter by status and teacher.
 * Select + bulk approve/hide (≤ MAX_REVIEW_IDS), single approve/hide/delete.
 * "Chọn tất cả" is capped at MAX_REVIEW_IDS with a Vietnamese notice.
 * Card thumbnail via CardView mini.
 * Stale responses when tab/teacher filter changes are dropped via cancel flag.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AdminCard, AdminTeacher } from '../../../shared/api.ts'
import { MAX_REVIEW_IDS, PAGE_SIZE, formatFrom } from '../../../shared/api.ts'
import {
  bulkReviewCards,
  deleteAdminCard,
  listAdminCards,
  messageFor,
  updateAdminCard,
} from '../../api'
import CardView from '../../components/CardView.tsx'
import { toggleAll, toggleOne } from './moderationSelection.ts'

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
  const [selectionCapNotice, setSelectionCapNotice] = useState<string | null>(null)

  // cursor: for pending oldest-first (after=), for others newest-first (before=)
  const cursorRef = useRef<number | null>(null)
  // Stale-response guard: each call captures its generation; state updates are
  // dropped if another call has started since (tab / teacher-filter changed).
  const loadGenRef = useRef(0)

  const loadCards = useCallback(async (
    status: Tab,
    teacher: number | '',
    append: boolean,
  ) => {
    const gen = ++loadGenRef.current
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
      if (gen !== loadGenRef.current) return  // stale — a newer load superseded this one
      setCards((prev) => append ? [...prev, ...data] : data)
      setHasMore(data.length === PAGE_SIZE)
      if (data.length > 0) {
        cursorRef.current = data[data.length - 1].id
      }
    } catch (e) {
      if (gen !== loadGenRef.current) return  // stale error from a superseded request
      if (!onAccessError(e)) {
        setError(messageFor(e))
      }
    } finally {
      if (gen === loadGenRef.current) setLoading(false)
    }
  }, [onAccessError])

  // Reload when tab or teacher filter changes
  useEffect(() => {
    setSelected(new Set())
    setSelectionCapNotice(null)
    cursorRef.current = null
    void loadCards(tab, teacherFilter, false)
  }, [tab, teacherFilter, loadCards])

  function handleLoadMore() {
    void loadCards(tab, teacherFilter, true)
  }

  function handleToggleSelect(id: number) {
    const result = toggleOne(id, selected)
    setSelected(result.selected)
    if (result.notice) setSelectionCapNotice(result.notice)
  }

  function handleToggleAll() {
    const result = toggleAll(cards.map((c) => c.id), selected)
    setSelected(result.selected)
    setSelectionCapNotice(result.capNotice)
  }

  async function handleBulk(status: 'approved' | 'hidden') {
    if (selected.size === 0) return
    setError(null)
    const ids = [...selected]
    try {
      await bulkReviewCards({ ids, status })
      const delta = -ids.filter((id) => cards.find((c) => c.id === id)?.status === 'pending').length
      onPendingCountChange(delta)
      setCards((prev) => prev.filter((c) => !selected.has(c.id)))
      setSelected(new Set())
      setSelectionCapNotice(null)    } catch (e) {
      if (!onAccessError(e)) {
        setError(messageFor(e))
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
      setSelected((prev) => { const next = new Set(prev); next.delete(card.id); return next })    } catch (e) {
      if (!onAccessError(e)) {
        setError(messageFor(e))
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
            checked={selected.size > 0 && selected.size === Math.min(cards.length, MAX_REVIEW_IDS)}
            onChange={handleToggleAll}
            aria-label="Chọn tất cả"
          />
          <label htmlFor="mod-select-all" style={{ fontSize: '0.85rem', cursor: 'pointer' }}>
            Chọn tất cả ({cards.length})
          </label>
          {selectionCapNotice && (
            <span className="admin-notice" role="status" style={{ fontSize: '0.8rem', color: '#a16207', marginLeft: '0.5rem' }}>
              {selectionCapNotice}
            </span>
          )}
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
              onToggle={() => handleToggleSelect(card.id)}
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

  const fromStr = formatFrom({
    fromName: card.fromName,
    fromClass: card.fromClass,
    anonymous: card.anonymous,
  })

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
                  subject: '',
                  message: card.message,
                  title: (teacher?.title as 'Thầy' | 'Cô' | null) ?? null,
                }}
                layout={template?.layout ?? 'classic'}
                images={{}}
                from={fromStr}
                headingLevel="h2"
              />
            </div>
          </div>
        </div>

        {/* Details */}
        <div className="mod-item-content">
          <div className="mod-item-teacher">{displayTeacher}</div>
          <p className="mod-item-text">{card.message}</p>
          <div className="mod-item-meta">
            {fromStr}
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
