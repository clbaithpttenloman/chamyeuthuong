/**
 * Wall page — `/`
 *
 * Hero with platform intro and counters, newest cards strip, search + filter,
 * teacher grid tiles with approved card counts, CTA to send a card.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PublicCard, WallResponse, WallTeacher } from '../../shared/api.ts'
import { getWall } from '../api'
import CardView from '../components/CardView.tsx'
import site from '../content/site.json'

type State =
  | { status: 'loading' }
  | { status: 'ok'; data: WallResponse }
  | { status: 'error' }

const EMPTY: never[] = []

export default function Home() {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [search, setSearch] = useState('')
  const [deptFilter, setDeptFilter] = useState('')

  useEffect(() => {
    setState({ status: 'loading' })
    getWall()
      .then((data) => setState({ status: 'ok', data }))
      .catch(() => setState({ status: 'error' }))
  }, [])

  // Hooks must run on every render, so derive from possibly-missing data before any early return.
  const teachers = state.status === 'ok' ? state.data.teachers : EMPTY

  // Collect unique departments from the teacher list for the filter dropdown
  const departments = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const t of teachers) {
      if (t.department && !seen.has(t.department)) {
        seen.add(t.department)
        result.push(t.department)
      }
    }
    return result
  }, [teachers])

  const filtered = useMemo(
    () =>
      teachers.filter((t) => {
        const q = search.toLowerCase()
        const matchSearch =
          !q ||
          t.name.toLowerCase().includes(q) ||
          t.subject.toLowerCase().includes(q)
        const matchDept = !deptFilter || t.department === deptFilter
        return matchSearch && matchDept
      }),
    [teachers, search, deptFilter],
  )

  if (state.status === 'loading') {
    return (
      <section className="wall-hero">
        <p className="kicker">{site.home.kicker}</p>
        <h1>{site.home.heading}</h1>
        <p className="lead admin-loading">Đang tải...</p>
      </section>
    )
  }

  if (state.status === 'error') {
    return (
      <section className="wall-hero">
        <p className="kicker">{site.home.kicker}</p>
        <h1>{site.home.heading}</h1>
        <p className="lead">Không thể tải dữ liệu. Vui lòng tải lại trang.</p>
      </section>
    )
  }

  const { latest, totals } = state.data

  return (
    <div>
      {/* Hero */}
      <section className="wall-hero">
        <p className="kicker">{site.home.kicker}</p>
        <h1>{site.home.heading}</h1>
        <p className="lead">{site.home.body}</p>
        <div className="wall-counters">
          <div>
            <strong>{totals.teachers}</strong>
            <span>thầy cô</span>
          </div>
          <div>
            <strong>{totals.cards}</strong>
            <span>thiệp đã duyệt</span>
          </div>
        </div>
        <Link to="/gui-thiep" className="btn-primary-link">
          ✍ Gửi thiệp
        </Link>
      </section>

      {/* Newest cards strip */}
      {latest.length > 0 && (
        <section className="newest-strip-wrap">
          <h2 className="strip-heading">Thiệp mới nhất</h2>
          <div className="newest-strip">
            {latest.map((card) => (
              <LatestCardLink key={card.publicId} card={card} />
            ))}
          </div>
        </section>
      )}

      {/* Search + filter */}
      <div className="wall-filters">
        <input
          type="search"
          placeholder="Tìm theo tên hoặc môn học..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="wall-search"
          aria-label="Tìm kiếm thầy cô"
        />
        <select
          value={deptFilter}
          onChange={(e) => setDeptFilter(e.target.value)}
          className="wall-dept"
          aria-label="Lọc theo tổ bộ môn"
        >
          <option value="">Tất cả tổ bộ môn</option>
          {departments.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>

      {/* Teacher grid */}
      <div className="teacher-grid">
        {filtered.map((t) => (
          <TeacherTile key={t.publicId} teacher={t} />
        ))}
        {filtered.length === 0 && (
          <p className="wall-empty">Không tìm thấy thầy cô phù hợp.</p>
        )}
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────

type LatestWithTeacher = PublicCard & { teacher: { publicId: string; title: string | null; name: string } }

function LatestCardLink({ card }: { card: LatestWithTeacher }) {
  const { teacher } = card
  const displayName = teacher.title ? `${teacher.title} ${teacher.name}` : teacher.name
  return (
    <Link
      to={`/thay-co/${encodeURIComponent(teacher.publicId)}`}
      className="strip-card-link"
      aria-label={`Thiệp cho ${displayName}`}
    >
      <div className="card-mini">
        <div className="card-mini-inner">
          <CardView
            card={{ name: teacher.name, subject: '', message: card.message, title: (teacher.title as 'Thầy' | 'Cô' | null) }}
            layout={card.layout}
            images={card.images}
            from={card.from}
          />
        </div>
      </div>
      <span className="strip-card-label">{displayName}</span>
    </Link>
  )
}

function TeacherTile({ teacher }: { teacher: WallTeacher }) {
  const displayName = teacher.title ? `${teacher.title} ${teacher.name}` : teacher.name
  return (
    <Link
      to={`/thay-co/${encodeURIComponent(teacher.publicId)}`}
      className={`card-tile card-tile--classic`}
      aria-label={`${displayName}, ${teacher.subject}`}
    >
      <div className="card-tile-icon">🎓</div>
      <div className="card-tile-title">{displayName}</div>
      <div className="card-tile-subject">{teacher.subject}</div>
      {teacher.department && <div className="card-tile-dept">{teacher.department}</div>}
      <div className="card-tile-count">
        {teacher.cardCount === 0 ? 'Chưa có thiệp' : `${teacher.cardCount} thiệp`}
      </div>
    </Link>
  )
}
