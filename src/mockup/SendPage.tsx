/**
 * SendPage — /mockup/gui-thiep (?thay=:teacherId)
 *
 * 4-step card-sending flow (all client state, no API):
 *   1 Chọn mẫu thiệp — template gallery (small CardView previews)
 *   2 Chọn thầy cô  — teacher grid with search (skipped when ?thay is a valid id)
 *   3 Viết lời chúc — textarea ≤300, suggestion chips, optional name/lớp,
 *                     anonymous toggle, live full CardView preview
 *   4 Đã gửi        — awaiting approval, links back
 */
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { fillWish } from '../../shared/wish.ts'
import CardView from '../components/CardView.tsx'
import {
  CARDS,
  DEPARTMENTS,
  TEACHERS,
  TEMPLATES,
  WISH_TEMPLATES,
  sigLine,
} from './data.ts'

type Step = 1 | 2 | 3 | 4
const MAX_CHARS = 300

/** Sample card data for template preview tiles. */
const PREVIEW_CARD = {
  name: 'Tên thầy cô',
  subject: 'Môn học',
  message: 'Lời chúc chân thành từ học sinh CLB AI đến thầy cô nhân ngày 20/11.',
  title: 'Thầy' as const,
}

function Stepper({ step }: { step: Step }) {
  const steps: Array<{ label: string; n: Step }> = [
    { label: '1. Chọn mẫu thiệp', n: 1 },
    { label: '2. Chọn thầy cô',   n: 2 },
    { label: '3. Viết lời chúc',  n: 3 },
    { label: '4. Đã gửi',         n: 4 },
  ]
  return (
    <div className="write-stepper" aria-label="Các bước">
      {steps.map(({ label, n }) => {
        const stepNum = step as number
        const cls =
          stepNum > n
            ? ' write-step--done'
            : stepNum === n
              ? ' write-step--active'
              : ''
        return (
          <span key={n} className={`write-step${cls}`}>
            {label}
          </span>
        )
      })}
    </div>
  )
}

export default function SendPage() {
  const [searchParams] = useSearchParams()
  const thayParam = searchParams.get('thay')
  const rawThay = thayParam ? Number(thayParam) : null
  const preselectedTeacherId =
    rawThay !== null && Number.isFinite(rawThay) && rawThay > 0
      ? (TEACHERS.find((t) => t.id === rawThay)?.id ?? null)
      : null

  const [step, setStep] = useState<Step>(1)
  const [templateId, setTemplateId] = useState<number | null>(null)
  const [teacherId, setTeacherId] = useState<number | null>(preselectedTeacherId)
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [studentClass, setStudentClass] = useState('')
  const [anonymous, setAnonymous] = useState(false)
  const [tileSearch, setTileSearch] = useState('')
  const [deptFilter, setDeptFilter] = useState('')

  const teacher =
    teacherId !== null
      ? (TEACHERS.find((t) => t.id === teacherId) ?? null)
      : null
  const template =
    templateId !== null
      ? (TEMPLATES.find((t) => t.id === templateId) ?? null)
      : null

  const filteredTeachers = TEACHERS.filter((t) => {
    const q = tileSearch.toLowerCase()
    const matchSearch =
      !q ||
      t.name.toLowerCase().includes(q) ||
      t.subject.toLowerCase().includes(q)
    const matchDept = !deptFilter || t.department === deptFilter
    return matchSearch && matchDept
  })

  const chips =
    teacher !== null
      ? WISH_TEMPLATES.slice(0, 6).map((tpl) =>
          fillWish(tpl, {
            name: teacher.name,
            subject: teacher.subject,
            title: teacher.title,
          }),
        )
      : []

  const previewFrom = anonymous
    ? 'Một bạn học sinh'
    : [name.trim() || null, studentClass.trim() || null]
        .filter(Boolean)
        .join(' · ') || 'Học sinh'

  function afterTemplateSelect(tplId: number) {
    setTemplateId(tplId)
    // Skip step 2 when teacher is preselected via ?thay
    if (preselectedTeacherId !== null) {
      setStep(3)
    } else {
      setStep(2)
    }
  }

  function afterTeacherSelect(tid: number) {
    setTeacherId(tid)
    setStep(3)
  }

  function handleSubmit() {
    if (!text.trim()) return
    setStep(4)
  }

  /* ── Step 1: choose template ───────────────────────────────────────────── */
  if (step === 1) {
    return (
      <div className="write-page">
        <Stepper step={step} />
        <h2>Chọn mẫu thiệp</h2>
        <div className="template-gallery">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              className={`template-tile${templateId === tpl.id ? ' template-tile--selected' : ''}`}
              onClick={() => afterTemplateSelect(tpl.id)}
              aria-label={`Chọn mẫu ${tpl.name}`}
            >
              <div className="card-mini">
                <div className="card-mini-inner">
                  <CardView
                    card={PREVIEW_CARD}
                    layout={tpl.layout}
                    images={{}}
                  />
                </div>
              </div>
              <span className="template-tile-name">{tpl.name}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  /* ── Step 2: choose teacher ────────────────────────────────────────────── */
  if (step === 2) {
    return (
      <div className="write-page">
        <Stepper step={step} />
        <div className="write-teacher-header">
          <h2 style={{ margin: 0 }}>Chọn thầy cô</h2>
          <button className="btn-ghost" onClick={() => setStep(1)}>
            ← Chọn lại mẫu
          </button>
        </div>

        <div className="wall-filters" style={{ marginTop: '1rem' }}>
          <input
            type="search"
            placeholder="Tìm theo tên hoặc môn học..."
            value={tileSearch}
            onChange={(e) => setTileSearch(e.target.value)}
            className="wall-search"
            aria-label="Tìm kiếm thầy cô"
          />
          <select
            value={deptFilter}
            onChange={(e) => setDeptFilter(e.target.value)}
            className="wall-dept"
            aria-label="Lọc theo tổ bộ môn"
          >
            <option value="">Tất cả tổ</option>
            {DEPARTMENTS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>

        <div className="teacher-grid">
          {filteredTeachers.map((t) => {
            const count = CARDS.filter(
              (c) => c.teacherId === t.id && c.status === 'approved',
            ).length
            return (
              <button
                key={t.id}
                type="button"
                className={`card-tile card-tile--${template?.layout ?? 'classic'}`}
                onClick={() => afterTeacherSelect(t.id)}
                aria-label={`Chọn ${t.title} ${t.name}`}
              >
                <div className="card-tile-icon">🎓</div>
                <div className="card-tile-title">{t.title} {t.name}</div>
                <div className="card-tile-subject">{t.subject}</div>
                <div className="card-tile-dept">{t.department}</div>
                <div className="card-tile-count">{count} thiệp</div>
              </button>
            )
          })}
          {filteredTeachers.length === 0 && (
            <p className="wall-empty">Không tìm thấy thầy cô phù hợp.</p>
          )}
        </div>
      </div>
    )
  }

  /* ── Step 3: write ─────────────────────────────────────────────────────── */
  if (step === 3 && teacher !== null && template !== null) {
    return (
      <div className="write-page">
        <Stepper step={step} />

        <div className="write-teacher-header">
          <span className="write-teacher-name">
            Viết lời chúc cho {teacher.title} {teacher.name}
          </span>
          <button
            className="btn-ghost"
            onClick={() =>
              preselectedTeacherId !== null ? setStep(1) : setStep(2)
            }
          >
            ← Quay lại
          </button>
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
                    type="button"
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
                onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
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
              type="button"
              className="btn-primary"
              onClick={handleSubmit}
              disabled={!text.trim()}
            >
              Gửi thiệp →
            </button>
          </div>

          {/* Live full CardView preview */}
          <div className="write-preview">
            <p className="preview-label">Xem trước thiệp</p>
            <div className="write-preview-card">
              <CardView
                card={{
                  name: teacher.name,
                  subject: teacher.subject,
                  message: text || 'Lời chúc của bạn sẽ hiện ở đây...',
                  title: teacher.title,
                }}
                layout={template.layout}
                images={{}}
                from={previewFrom}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  /* ── Step 4: thank you ─────────────────────────────────────────────────── */
  if (step === 4) {
    const sentCard: Parameters<typeof sigLine>[0] = {
      id: 0,
      templateId: templateId ?? 1,
      teacherId: teacherId ?? 0,
      message: text,
      fromName: anonymous ? undefined : name.trim() || undefined,
      fromClass: anonymous ? undefined : studentClass.trim() || undefined,
      anonymous,
      status: 'pending',
      createdAt: 'vừa xong',
    }
    const displayFrom = sigLine(sentCard)

    return (
      <div className="write-page write-thanks">
        <Stepper step={step} />
        <div className="thanks-box">
          <p className="thanks-icon">🎉</p>
          <h2>Đã gửi thành công!</h2>
          <p>
            Lời chúc của <strong>{displayFrom}</strong> sẽ hiện sau khi CLB
            duyệt.
          </p>
          <div className="thanks-actions">
            {teacher !== null && (
              <Link
                to={`/mockup/thiep/${teacher.id}`}
                className="btn-primary-link"
              >
                Xem thiệp của {teacher.title} {teacher.name}
              </Link>
            )}
            <Link to="/mockup/gui-thiep" className="btn-link-ghost">
              Gửi thêm thiệp
            </Link>
            <Link to="/mockup" className="btn-link-ghost">
              Về trang chủ
            </Link>
          </div>
        </div>
      </div>
    )
  }

  /* Fallback: bad ?thay param — no teacher found after skipping step 2 */
  return (
    <div className="write-page">
      <Stepper step={1} />
      <p>Không tìm thấy thầy cô. Vui lòng chọn lại.</p>
      <button type="button" className="btn-primary" onClick={() => setStep(1)}>
        Bắt đầu lại
      </button>
    </div>
  )
}
