/**
 * ModerationPage — /mockup/admin-duyet
 *
 * Tabs: Chờ duyệt / Đã duyệt / Đã ẩn
 * Each item has Duyệt / Ẩn buttons; Chờ duyệt tab has a bulk-approve action.
 * All state is local — no API calls.
 */
import { useState } from 'react'
import { NOTES, TEACHERS } from './data.ts'
import type { Note, NoteStatus } from './data.ts'

type Tab = NoteStatus

const TAB_LABELS: Record<Tab, string> = {
  pending: 'Chờ duyệt',
  approved: 'Đã duyệt',
  hidden: 'Đã ẩn',
}

export default function ModerationPage() {
  const [notes, setNotes] = useState<Note[]>(NOTES)
  const [tab, setTab] = useState<Tab>('pending')

  const pendingCount = notes.filter((n) => n.status === 'pending').length
  const visible = notes.filter((n) => n.status === tab)

  function approve(id: number) {
    setNotes((prev) =>
      prev.map((n) =>
        n.id === id ? { ...n, status: 'approved' as const } : n,
      ),
    )
  }

  function hide(id: number) {
    setNotes((prev) =>
      prev.map((n) =>
        n.id === id ? { ...n, status: 'hidden' as const } : n,
      ),
    )
  }

  function bulkApprove() {
    setNotes((prev) =>
      prev.map((n) =>
        n.status === 'pending' ? { ...n, status: 'approved' as const } : n,
      ),
    )
  }

  return (
    <div className="mod-page">
      <div className="mod-header">
        <h1>Duyệt lời chúc</h1>
        {tab === 'pending' && pendingCount > 0 && (
          <button onClick={bulkApprove}>
            Duyệt tất cả ({pendingCount})
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="admin-tabs" role="tablist">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
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
          <p className="admin-empty">Không có lời chúc nào.</p>
        ) : (
          <div className="mod-list">
            {visible.map((note) => {
              const teacher = TEACHERS.find((t) => t.id === note.teacherId)
              return (
                <div key={note.id} className="mod-item">
                  <div className="mod-item-teacher">
                    {teacher
                      ? `${teacher.title} ${teacher.name} · ${teacher.subject}`
                      : '—'}
                  </div>
                  <p className="mod-item-text">{note.text}</p>
                  <div className="mod-item-meta">
                    {note.displayName ?? 'Ẩn danh'} · {note.className} ·{' '}
                    {note.relativeTime}
                  </div>
                  <div className="admin-actions">
                    {note.status !== 'approved' && (
                      <button onClick={() => approve(note.id)}>Duyệt</button>
                    )}
                    {note.status !== 'hidden' && (
                      <button
                        className="btn-warn"
                        onClick={() => hide(note.id)}
                      >
                        Ẩn
                      </button>
                    )}
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
