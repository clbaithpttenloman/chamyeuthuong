/**
 * ModerationPage — /mockup/admin-duyet
 *
 * Tabs: Chờ duyệt / Đã duyệt / Đã ẩn
 * Each item shows a small card thumbnail (template layout) beside the text.
 * Duyệt / Ẩn buttons; Chờ duyệt tab has a bulk-approve action.
 * All state is local — no API calls.
 */
import { useState } from 'react'
import CardView from '../components/CardView.tsx'
import { CARDS, TEACHERS, TEMPLATES, cardLayout, sigLine, type Card, type CardStatus } from './data.ts'

type Tab = CardStatus

const TAB_LABELS: Record<Tab, string> = {
  pending:  'Chờ duyệt',
  approved: 'Đã duyệt',
  hidden:   'Đã ẩn',
}

export default function ModerationPage() {
  const [cards, setCards] = useState<Card[]>(CARDS)
  const [tab, setTab] = useState<Tab>('pending')

  const pendingCount = cards.filter((c) => c.status === 'pending').length
  const visible = cards.filter((c) => c.status === tab)

  function approve(id: number) {
    setCards((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, status: 'approved' as const } : c,
      ),
    )
  }

  function hide(id: number) {
    setCards((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, status: 'hidden' as const } : c,
      ),
    )
  }

  function bulkApprove() {
    setCards((prev) =>
      prev.map((c) =>
        c.status === 'pending' ? { ...c, status: 'approved' as const } : c,
      ),
    )
  }

  return (
    <div className="mod-page">
      <div className="mod-header">
        <h1>Duyệt thiệp</h1>
        {tab === 'pending' && pendingCount > 0 && (
          <button type="button" onClick={bulkApprove}>
            Duyệt tất cả ({pendingCount})
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="admin-tabs" role="tablist">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`tab-btn${tab === t ? ' tab-btn--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
            {t === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="admin-section-content" role="tabpanel">
        {visible.length === 0 ? (
          <p className="admin-empty">Không có thiệp nào.</p>
        ) : (
          <div className="mod-list">
            {visible.map((card) => {
              const teacher = TEACHERS.find((t) => t.id === card.teacherId)
              const tpl = TEMPLATES.find((t) => t.id === card.templateId)
              return (
                <div key={card.id} className="mod-item">
                  <div className="mod-item-layout">
                    {/* Card thumbnail */}
                    <div className="mod-card-thumb">
                      <div className="card-mini">
                        <div className="card-mini-inner">
                          <CardView
                            card={{
                              name: teacher?.name ?? '?',
                              subject: teacher?.subject ?? '',
                              message: card.message,
                              title: teacher?.title,
                            }}
                            layout={tpl?.layout ?? cardLayout(card)}
                            images={{}}
                            from={sigLine(card)}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Item details */}
                    <div className="mod-item-content">
                      <div className="mod-item-teacher">
                        {teacher
                          ? `${teacher.title} ${teacher.name} · ${teacher.subject}`
                          : '—'}
                      </div>
                      <p className="mod-item-text">{card.message}</p>
                      <div className="mod-item-meta">
                        {sigLine(card)} · {tpl?.name ?? '—'} · {card.createdAt}
                      </div>
                      <div className="admin-actions">
                        {card.status !== 'approved' && (
                          <button type="button" onClick={() => approve(card.id)}>
                            Duyệt
                          </button>
                        )}
                        {card.status !== 'hidden' && (
                          <button
                            type="button"
                            className="btn-warn"
                            onClick={() => hide(card.id)}
                          >
                            Ẩn
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
