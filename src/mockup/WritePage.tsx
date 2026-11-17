/**
 * WritePage — /mockup/viet-loi-chuc (+ ?thiep=:id)
 *
 * 3-step write flow (all client state, no API):
 *   1. Chọn thiệp — grid with search (skipped when ?thiep=:id is present)
 *   2. Viết lời chúc — textarea, suggestion chips, optional name/class,
 *      anonymous toggle, live note preview tinted by the teacher's layout
 *   3. Đã gửi — thank-you state
 */
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { fillWish } from '../../shared/wish.ts'
import { NOTES, TEACHERS, WISH_TEMPLATES } from './data.ts'

type Step = 1 | 2 | 3
const MAX_CHARS = 300

export default function WritePage() {
  const [searchParams] = useSearchParams()
  const thiepParam = searchParams.get('thiep')
  const rawId = thiepParam ? Number(thiepParam) : null
  const initTeacherId =
    rawId !== null && Number.isFinite(rawId) && rawId > 0 ? rawId : null
  const initStep: Step = initTeacherId !== null ? 2 : 1

  const [step, setStep] = useState<Step>(initStep)
  const [teacherId, setTeacherId] = useState<number | null>(initTeacherId)
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [studentClass, setStudentClass] = useState('')
  const [anonymous, setAnonymous] = useState(false)
  const [tileSearch, setTileSearch] = useState('')

  const teacher =
    teacherId !== null
      ? (TEACHERS.find((t) => t.id === teacherId) ?? null)
      : null

  const filteredTeachers = TEACHERS.filter((t) => {
    const q = tileSearch.toLowerCase()
    return (
      !q ||
      t.name.toLowerCase().includes(q) ||
      t.subject.toLowerCase().includes(q)
    )
  })

  const chips = teacher
    ? WISH_TEMPLATES.slice(0, 6).map((tpl) =>
        fillWish(tpl, {
          name: teacher.name,
          subject: teacher.subject,
          title: teacher.title,
        }),
      )
    : []

  const previewName = anonymous
    ? 'Ẩn danh'
    : name.trim() || 'Học sinh'

  function handleSelectTeacher(id: number) {
    setTeacherId(id)
    setStep(2)
  }

  function handleSubmit() {
    if (!text.trim()) return
    setStep(3)
  }

  const stepperEl = (active: Step) => (
    <div className="write-stepper" aria-label="Các bước">
      <span className={`write-step${active > 1 ? ' write-step--done' : active === 1 ? ' write-step--active' : ''}`}>
        1. Chọn thiệp
      </span>
      <span className={`write-step${active > 2 ? ' write-step--done' : active === 2 ? ' write-step--active' : ''}`}>
        2. Viết lời chúc
      </span>
      <span className={`write-step${active === 3 ? ' write-step--active' : ''}`}>
        3. Đã gửi
      </span>
    </div>
  )

  /* ── Step 1: choose teacher ───────────────────────────────────────────── */
  if (step === 1) {
    return (
      <div className="write-page">
        {stepperEl(1)}
        <h2>Chọn thiệp thầy cô</h2>
        <input
          type="search"
          placeholder="Tìm theo tên hoặc môn học..."
          value={tileSearch}
          onChange={(e) => setTileSearch(e.target.value)}
          className="wall-search"
          aria-label="Tìm kiếm thầy cô"
          style={{ marginBottom: '1rem' }}
        />
        <div className="teacher-grid">
          {filteredTeachers.map((t) => {
            const count = NOTES.filter(
              (n) => n.teacherId === t.id && n.status === 'approved',
            ).length
            return (
              <button
                key={t.id}
                className={`card-tile card-tile--${t.layout}`}
                onClick={() => handleSelectTeacher(t.id)}
                aria-label={`Chọn thiệp ${t.title} ${t.name}`}
              >
                <div className="card-tile-icon">🎓</div>
                <div className="card-tile-title">
                  {t.title} {t.name}
                </div>
                <div className="card-tile-subject">{t.subject}</div>
                <div className="card-tile-count">{count} lời chúc</div>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  /* ── Step 2: write wish ───────────────────────────────────────────────── */
  if (step === 2 && teacher !== null) {
    return (
      <div className="write-page">
        {stepperEl(2)}

        <div className="write-teacher-header">
          <span className="write-teacher-name">
            Viết lời chúc cho {teacher.title} {teacher.name}
          </span>
          {/* Only show "back" if the user entered through step 1 (no ?thiep param) */}
          {initTeacherId === null && (
            <button className="btn-ghost" onClick={() => setStep(1)}>
              ← Chọn lại
            </button>
          )}
        </div>

        <div className="write-layout">
          <div className="write-form">
            {/* Suggestion chips */}
            <div className="suggestion-chips">
              <p className="chips-label">Gợi ý lời chúc</p>
              <div className="chips-row">
                {chips.map((chip, i) => (
                  <button
                    key={i}
                    className="chip"
                    onClick={() => setText(chip.slice(0, MAX_CHARS))}
                    title={chip}
                  >
                    {chip.length > 42 ? chip.slice(0, 42) + '…' : chip}
                  </button>
                ))}
              </div>
            </div>

            {/* Textarea */}
            <label className="write-label">
              Lời chúc của bạn
              <textarea
                className="write-textarea"
                value={text}
                onChange={(e) =>
                  setText(e.target.value.slice(0, MAX_CHARS))
                }
                rows={5}
                placeholder="Viết lời chúc của bạn..."
                aria-describedby="char-count"
              />
              <span
                id="char-count"
                className={`char-counter${text.length >= MAX_CHARS ? ' char-counter--limit' : ''}`}
              >
                {text.length}/{MAX_CHARS}
              </span>
            </label>

            {/* Optional name + class */}
            <div className="write-identity">
              <label className="write-label">
                Tên của bạn
                <input
                  type="text"
                  className="write-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Không bắt buộc"
                  disabled={anonymous}
                  aria-disabled={anonymous}
                />
              </label>
              <label className="write-label">
                Lớp
                <input
                  type="text"
                  className="write-input"
                  value={studentClass}
                  onChange={(e) => setStudentClass(e.target.value)}
                  placeholder="VD: 11A3"
                  disabled={anonymous}
                  aria-disabled={anonymous}
                />
              </label>
            </div>

            {/* Anonymous toggle */}
            <label className="write-anon">
              <input
                type="checkbox"
                checked={anonymous}
                onChange={(e) => setAnonymous(e.target.checked)}
              />
              Gửi ẩn danh
            </label>

            <button
              className="btn-primary"
              onClick={handleSubmit}
              disabled={!text.trim()}
            >
              Gửi lời chúc →
            </button>
          </div>

          {/* Live preview */}
          <div className="write-preview">
            <p className="preview-label">Xem trước</p>
            <div
              className={`note-card note-card--${teacher.layout} note-card--preview`}
            >
              <p className="note-text">
                {text || 'Lời chúc của bạn sẽ hiện ở đây...'}
              </p>
              <div className="note-meta">
                <span className="note-author">
                  {previewName}
                  {studentClass && !anonymous ? ` · ${studentClass}` : ''}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  /* ── Step 3: thank-you ────────────────────────────────────────────────── */
  if (step === 3) {
    return (
      <div className="write-page write-thanks">
        {stepperEl(3)}
        <div className="thanks-box">
          <p className="thanks-icon">🎉</p>
          <h2>Đã gửi thành công!</h2>
          <p>Lời chúc sẽ hiện sau khi CLB duyệt.</p>
          <div className="thanks-actions">
            {teacher !== null && (
              <Link
                to={`/mockup/thiep/${teacher.id}`}
                className="btn-primary-link"
              >
                Xem trang của {teacher.title} {teacher.name}
              </Link>
            )}
            <Link to="/mockup" className="btn-link-ghost">
              Về trang chủ
            </Link>
          </div>
        </div>
      </div>
    )
  }

  /* Fallback: step 2 reached without a valid teacher (bad ?thiep param) */
  return (
    <div className="write-page">
      {stepperEl(1)}
      <p>Vui lòng chọn thiệp trước.</p>
      <button className="btn-primary" onClick={() => setStep(1)}>
        Chọn thiệp
      </button>
    </div>
  )
}
