/**
 * WallPage — /mockup
 *
 * Hero with motto and counters, search + department filter,
 * grid of mini teacher tiles (card-tile--<layout>).
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { DEPARTMENTS, NOTES, TEACHERS } from './data.ts'

export default function WallPage() {
  const [search, setSearch] = useState('')
  const [dept, setDept] = useState('')

  const filtered = useMemo(
    () =>
      TEACHERS.filter((t) => {
        const q = search.toLowerCase()
        const matchSearch =
          !q ||
          t.name.toLowerCase().includes(q) ||
          t.subject.toLowerCase().includes(q)
        const matchDept = !dept || t.department === dept
        return matchSearch && matchDept
      }),
    [search, dept],
  )

  const totalWishes = NOTES.filter((n) => n.status === 'approved').length

  return (
    <div>
      {/* Hero */}
      <section className="wall-hero">
        <p className="kicker">Ngày Nhà giáo Việt Nam 20/11/2026</p>
        <h1>Gửi thầy cô muôn vàn lời tri ân</h1>
        <p className="lead">
          Học sinh CLB AI xin gửi đến toàn thể thầy cô lời chúc chân thành nhất.
          Hãy chọn thiệp và viết lời chúc của bạn.
        </p>
        <div className="wall-counters">
          <div>
            <strong>{TEACHERS.length}</strong>
            <span>thầy cô</span>
          </div>
          <div>
            <strong>{totalWishes}</strong>
            <span>lời chúc</span>
          </div>
        </div>
        <Link to="/mockup/viet-loi-chuc" className="btn-primary-link">
          ✍ Gửi lời chúc
        </Link>
      </section>

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
          value={dept}
          onChange={(e) => setDept(e.target.value)}
          className="wall-dept"
          aria-label="Lọc theo tổ bộ môn"
        >
          <option value="">Tất cả tổ bộ môn</option>
          {DEPARTMENTS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      {/* Teacher grid */}
      <div className="teacher-grid">
        {filtered.map((t) => {
          const wishCount = NOTES.filter(
            (n) => n.teacherId === t.id && n.status === 'approved',
          ).length
          return (
            <Link
              key={t.id}
              to={`/mockup/thiep/${t.id}`}
              className={`card-tile card-tile--${t.layout}`}
              aria-label={`${t.title} ${t.name}, ${t.subject}`}
            >
              <div className="card-tile-icon">🎓</div>
              <div className="card-tile-title">
                {t.title} {t.name}
              </div>
              <div className="card-tile-subject">{t.subject}</div>
              <div className="card-tile-dept">{t.department}</div>
              <div className="card-tile-count">
                {wishCount} lời chúc
              </div>
            </Link>
          )
        })}
        {filtered.length === 0 && (
          <p className="wall-empty">Không tìm thấy thầy cô phù hợp.</p>
        )}
      </div>
    </div>
  )
}
