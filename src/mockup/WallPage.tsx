/**
 * WallPage — /mockup
 *
 * Hero with motto and counters (thầy cô, thiệp đã duyệt).
 * A horizontal "Thiệp mới nhất" strip of small rendered cards.
 * Search + department filter.
 * Teacher grid tiles showing number of approved cards per teacher.
 * CTA "Gửi thiệp".
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import CardView from '../components/CardView.tsx'
import { CARDS, DEPARTMENTS, TEACHERS, TEMPLATES, sigLine } from './data.ts'

export default function WallPage() {
  const [search, setSearch] = useState('')
  const [dept, setDept] = useState('')

  const approvedCards = useMemo(
    () => CARDS.filter((c) => c.status === 'approved'),
    [],
  )

  const newestCards = useMemo(
    // Newest first by id (mockup ids are in creation order), one card per teacher so the strip varies.
    () => {
      const seen = new Set<number>()
      return [...approvedCards]
        .sort((a, b) => b.id - a.id)
        .filter((c) => (seen.has(c.teacherId) ? false : (seen.add(c.teacherId), true)))
        .slice(0, 6)
    },
    [approvedCards],
  )

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

  return (
    <div>
      {/* Hero */}
      <section className="wall-hero">
        <p className="kicker">Ngày Nhà giáo Việt Nam 20/11/2026</p>
        <h1>Gửi thầy cô muôn vàn lời tri ân</h1>
        <p className="lead">
          Học sinh CLB AI xin gửi đến toàn thể thầy cô lời chúc chân thành
          nhất. Hãy chọn mẫu thiệp và viết lời chúc của bạn.
        </p>
        <div className="wall-counters">
          <div>
            <strong>{TEACHERS.length}</strong>
            <span>thầy cô</span>
          </div>
          <div>
            <strong>{approvedCards.length}</strong>
            <span>thiệp đã duyệt</span>
          </div>
        </div>
        <Link to="/mockup/gui-thiep" className="btn-primary-link">
          ✍ Gửi thiệp
        </Link>
      </section>

      {/* Newest cards strip */}
      {newestCards.length > 0 && (
        <section className="newest-strip-wrap">
          <h2 className="strip-heading">Thiệp mới nhất</h2>
          <div className="newest-strip">
            {newestCards.map((card) => {
              const teacher = TEACHERS.find((t) => t.id === card.teacherId)
              const tpl = TEMPLATES.find((t) => t.id === card.templateId)
              if (!teacher || !tpl) return null
              return (
                <Link
                  key={card.id}
                  to={`/mockup/thiep/${teacher.id}`}
                  className="strip-card-link"
                  aria-label={`Thiệp cho ${teacher.title} ${teacher.name}`}
                >
                  <div className="card-mini">
                    <div className="card-mini-inner">
                      <CardView
                        card={{
                          name: teacher.name,
                          subject: teacher.subject,
                          message: card.message,
                          title: teacher.title,
                        }}
                        layout={tpl.layout}
                        images={{}}
                        from={sigLine(card)}
                      />
                    </div>
                  </div>
                  <span className="strip-card-label">
                    {teacher.title} {teacher.name}
                  </span>
                </Link>
              )
            })}
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
          const cardCount = approvedCards.filter(
            (c) => c.teacherId === t.id,
          ).length
          const layout =
            TEMPLATES.find(
              (tpl) =>
                approvedCards.find((c) => c.teacherId === t.id)?.templateId ===
                tpl.id,
            )?.layout ?? 'classic'
          return (
            <Link
              key={t.id}
              to={`/mockup/thiep/${t.id}`}
              className={`card-tile card-tile--${layout}`}
              aria-label={`${t.title} ${t.name}, ${t.subject}`}
            >
              <div className="card-tile-icon">🎓</div>
              <div className="card-tile-title">
                {t.title} {t.name}
              </div>
              <div className="card-tile-subject">{t.subject}</div>
              <div className="card-tile-dept">{t.department}</div>
              <div className="card-tile-count">
                {cardCount === 0 ? 'Chưa có thiệp' : `${cardCount} thiệp`}
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
