/**
 * SendPage — `/gui-thiep`
 *
 * 4-step card-sending flow:
 *   Step 1 — Chọn mẫu thiệp  (from /api/templates)
 *   Step 2 — Chọn thầy cô    (from /api/wall; skipped when ?thay or ?t is valid)
 *   Step 3 — Viết lời chúc   (message, suggestion chips, identity, anonymous)
 *   Step 4 — Đã gửi          (pending, awaiting approval)
 *
 * URL params:
 *   ?thay=<id>   — preselect teacher by numeric id (from home tile, show_on_home=1 only)
 *   ?t=<token>   — preselect teacher via QR token (hidden teachers OK); resolves via getQr
 *
 * Submit uses teacherId or teacherToken accordingly.
 * Success step links to home only (no teacher page — cards are private).
 */
import { useEffect, useMemo, useReducer, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { TeacherProfile, TemplatePublic, WallTeacher, WishPublic } from '../../shared/api.ts'
import { formatFrom, departmentLabel, roleLabel } from '../../shared/api.ts'
import { fillWish } from '../../shared/wish.ts'
import { ApiError, getPublicWishes, getQr, getTemplates, getWall, submitCard } from '../api'
import CardView from '../components/CardView.tsx'
import { FONTS, INKS } from '../../shared/fonts.ts'
import { initialState, isTextValid, parsePreselect, sendReducer } from './send/sendReducer.ts'
import { resolveTeacherById } from './send/resolveTeacher.ts'

const PREVIEW_CARD = {
  name: 'Tên thầy cô',
  subject: 'Môn học',
  message: 'Lời chúc chân thành từ học sinh CLB AI đến thầy cô nhân ngày 20/11.',
  title: 'Thầy' as const,
}

// ── Stepper ───────────────────────────────────────────────────────────────

function Stepper({ step }: { step: number }) {
  const steps = ['1. Chọn mẫu thiệp', '2. Chọn thầy cô', '3. Viết lời chúc', '4. Đã gửi']
  return (
    <div className="write-stepper" aria-label="Các bước">
      {steps.map((label, i) => {
        const n = i + 1
        const cls =
          step > n ? ' write-step--done' : step === n ? ' write-step--active' : ''
        return (
          <span key={n} className={`write-step${cls}`}>{label}</span>
        )
      })}
    </div>
  )
}

// ── Error messages ────────────────────────────────────────────────────────

function submitErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 400) return 'Dữ liệu không hợp lệ. Vui lòng kiểm tra lại lời chúc và thông tin.'
    if (e.status === 404) return 'Không tìm thấy thầy cô hoặc mẫu thiệp. Vui lòng chọn lại.'
    if (e.status === 409) return 'Đang có quá nhiều thiệp chờ duyệt. Vui lòng thử lại sau ít phút.'
    if (e.status === 429) return 'Bạn đã gửi quá nhiều thiệp. Vui lòng thử lại sau.'
  }
  return 'Có lỗi xảy ra. Vui lòng thử lại.'
}

// ── Main page ─────────────────────────────────────────────────────────────

export default function SendPage() {
  const [searchParams] = useSearchParams()
  // ?t= (QR token) wins over ?thay= (numeric id); see parsePreselect
  const { byId: preselectedById, byToken: preselectedByToken } =
    parsePreselect(searchParams.get('thay'), searchParams.get('t'))

  const [state, dispatch] = useReducer(
    sendReducer,
    undefined,
    () => initialState(preselectedById, preselectedByToken),
  )

  // Loaded data
  const [templates, setTemplates] = useState<TemplatePublic[]>([])
  const [wallTeachers, setWallTeachers] = useState<WallTeacher[]>([])
  const [wishes, setWishes] = useState<WishPublic[]>([])
  const [loadingData, setLoadingData] = useState(true)
  const [loadErrors, setLoadErrors] = useState<string | null>(null)

  // Teacher info once a teacher is selected / resolved
  const [teacherInfo, setTeacherInfo] = useState<TeacherProfile | null>(null)
  // Set to true when a preselected teacher id could not be resolved from the wall
  const [teacherNotFound, setTeacherNotFound] = useState(false)

  // Search/filter for teacher picker (step 2)
  const [teacherSearch, setTeacherSearch] = useState('')
  const [deptFilter, setDeptFilter] = useState('')

  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setLoadingData(true)
    setLoadErrors(null)

    // For ?t=<token> param, also load QR data to resolve teacher profile
    const extra = preselectedByToken ? [getQr(preselectedByToken)] : []

    Promise.allSettled([
      getTemplates(),
      getWall(),
      getPublicWishes(),
      ...extra,
    ]).then(([tplsRes, wallRes, wsRes, qrRes]) => {
      if (tplsRes.status === 'fulfilled') setTemplates(tplsRes.value)
      if (wsRes.status === 'fulfilled') setWishes(wsRes.value)

      let wallTeachersLoaded: WallTeacher[] = []
      if (wallRes.status === 'fulfilled') {
        wallTeachersLoaded = wallRes.value.teachers
        setWallTeachers(wallTeachersLoaded)
      }

      // Report which requests failed
      const failed: string[] = []
      if (tplsRes.status === 'rejected') failed.push('mẫu thiệp')
      if (wallRes.status === 'rejected') failed.push('danh sách thầy cô')
      if (wsRes.status === 'rejected') failed.push('gợi ý lời chúc')
      if (failed.length > 0) setLoadErrors(`Không thể tải: ${failed.join(', ')}.`)

      // Resolve preselected teacher
      if (preselectedById !== null) {
        const profile = resolveTeacherById(preselectedById, wallTeachersLoaded)
        if (profile) setTeacherInfo(profile)
        else { setTeacherNotFound(true); dispatch({ type: 'CLEAR_PRESELECT' }) }
      } else if (preselectedByToken !== null && (!qrRes || qrRes.status === 'rejected')) {
        setTeacherNotFound(true)
        dispatch({ type: 'CLEAR_PRESELECT' })
      } else if (preselectedByToken !== null && qrRes && qrRes.status === 'fulfilled') {
        const t = qrRes.value.teacher
        setTeacherInfo({
          id: t.id,
          title: t.title,
          name: t.name,
          subject: t.subject,
          department: t.department,
          role: t.role,
        })
      }
    }).finally(() => setLoadingData(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When a teacher is selected in step 2 from the wall picker
  function handleSelectTeacher(t: WallTeacher) {
    setTeacherInfo({
      id: t.id,
      title: t.title,
      name: t.name,
      subject: t.subject,
      department: t.department,
      role: t.role,
    })
    dispatch({ type: 'SELECT_TEACHER', id: t.id })
  }

  function handleGoBack() {
    dispatch({ type: 'GO_BACK' })
  }

  const isCustomInk = !INKS.some((i) => i.value === state.ink)

  // Suggestion chips filled with teacher data
  const chips = useMemo(() => {
    if (!teacherInfo) return []
    return wishes.slice(0, 6).map((w) =>
      fillWish(w.body, {
        name: teacherInfo.name,
        subject: teacherInfo.subject,
        title: teacherInfo.title ?? undefined,
      }),
    )
  }, [wishes, teacherInfo])

  // Current template (for preview)
  const currentTemplate = useMemo(
    () => (state.templateId !== null ? templates.find((t) => t.id === state.templateId) ?? null : null),
    [templates, state.templateId],
  )

  // Departments for filter dropdown
  const departments = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const t of wallTeachers) {
      if (t.department && !seen.has(t.department)) {
        seen.add(t.department)
        result.push(t.department)
      }
    }
    return result
  }, [wallTeachers])

  // Filtered teachers for step 2
  const filteredTeachers = useMemo(
    () =>
      wallTeachers.filter((t) => {
        const q = teacherSearch.toLowerCase()
        const matchSearch =
          !q ||
          t.name.toLowerCase().includes(q) ||
          t.subject.toLowerCase().includes(q)
        const matchDept = !deptFilter || t.department === deptFilter
        return matchSearch && matchDept
      }),
    [wallTeachers, teacherSearch, deptFilter],
  )

  async function handleSubmit() {
    if (!state.templateId) return
    // Need at least one teacher identifier and non-empty text
    if (state.teacherId === null && state.teacherToken === null) return
    if (!state.text.trim()) return

    setSubmitting(true)
    dispatch({ type: 'SET_ERROR', error: '' })
    try {
      await submitCard({
        ...(state.teacherToken !== null
          ? { teacherToken: state.teacherToken }
          : { teacherId: state.teacherId! }),
        templateId: state.templateId,
        message: state.text,
        fromName: state.anonymous ? undefined : state.fromName || undefined,
        fromClass: state.fromClass || undefined,
        anonymous: state.anonymous,
        font: state.font,
        ink: state.ink,
      })
      dispatch({ type: 'SUBMIT_SUCCESS' })
    } catch (e) {
      dispatch({ type: 'SET_ERROR', error: submitErrorMessage(e) })
    } finally {
      setSubmitting(false)
    }
  }

  /* ── Step 1: choose template ─────────────────────────────────────────── */
  if (state.step === 1) {
    return (
      <div className="write-page">
        <Stepper step={1} />
        <h2>Chọn mẫu thiệp</h2>
        {loadingData && <p className="admin-loading">Đang tải mẫu thiệp...</p>}
        {loadErrors && <p className="admin-error" role="alert">{loadErrors}</p>}
        {!loadingData && teacherNotFound && (
          <p className="admin-error" role="alert">Không tìm thấy thầy cô. Vui lòng chọn thầy cô ở bước 2.</p>
        )}
        <div className="template-gallery">
          {templates.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              className={`template-tile${state.templateId === tpl.id ? ' template-tile--selected' : ''}`}
              onClick={() => dispatch({ type: 'SELECT_TEMPLATE', templateId: tpl.id })}
              aria-label={`Chọn mẫu ${tpl.name}`}
            >
              <div className="card-mini">
                <CardView
                  card={PREVIEW_CARD}
                  layout={tpl.layout}
                  images={tpl.images}
                  headingLevel="h2"
                />
              </div>
              <span className="template-tile-name">{tpl.name}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  /* ── Step 2: choose teacher ──────────────────────────────────────────── */
  if (state.step === 2) {
    return (
      <div className="write-page">
        <Stepper step={2} />
        <div className="write-teacher-header">
          <h2 style={{ margin: 0 }}>Chọn thầy cô</h2>
          <button type="button" className="btn-ghost" onClick={handleGoBack}>
            ← Chọn lại mẫu
          </button>
        </div>

        <div className="wall-filters" style={{ marginTop: '1rem' }}>
          <input
            type="search"
            placeholder="Tìm theo tên hoặc môn học..."
            value={teacherSearch}
            onChange={(e) => setTeacherSearch(e.target.value)}
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
            {departments.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>

        {loadingData && <p className="admin-loading">Đang tải danh sách thầy cô...</p>}
        {loadErrors && <p className="admin-error" role="alert">{loadErrors}</p>}

        <div className="teacher-grid">
          {filteredTeachers.map((t) => {
            const displayName = t.title ? `${t.title} ${t.name}` : t.name
            const sub = roleLabel(t.role, t.subject)
            const dept = departmentLabel(t.role, t.subject, t.department)
            return (
              <button
                key={t.id}
                type="button"
                className="card-tile card-tile--classic"
                onClick={() => handleSelectTeacher(t)}
                aria-label={`Chọn ${displayName}`}
              >
                <div className="card-tile-icon">🎓</div>
                <div className="card-tile-title">{displayName}</div>
                {sub && <div className="card-tile-subject">{sub}</div>}
                {dept && <div className="card-tile-dept">{dept}</div>}
                <div className="card-tile-count">
                  {t.cardCount === 0 ? 'Chưa có thiệp' : `${t.cardCount} thiệp`}
                </div>
              </button>
            )
          })}
          {!loadingData && filteredTeachers.length === 0 && (
            <p className="wall-empty">Không tìm thấy thầy cô phù hợp.</p>
          )}
        </div>
      </div>
    )
  }

  /* ── Step 3: write ───────────────────────────────────────────────────── */
  if (state.step === 3) {
    if (!currentTemplate || !teacherInfo) {
      return (
        <div className="write-page">
          <Stepper step={1} />
          <p>Không tìm thấy mẫu thiệp hoặc thầy cô. Vui lòng chọn lại.</p>
          <button type="button" className="btn-primary" onClick={() => dispatch({ type: 'RESET' })}>
            Bắt đầu lại
          </button>
        </div>
      )
    }

    const displayName = teacherInfo.title ? `${teacherInfo.title} ${teacherInfo.name}` : teacherInfo.name
    const cpCount = [...state.text].length
    const previewFrom = formatFrom({
      fromName: state.anonymous ? '' : state.fromName,
      fromClass: state.fromClass,
      anonymous: state.anonymous,
    })

    return (
      <div className="write-page">
        <Stepper step={3} />

        <div className="write-teacher-header">
          <span className="write-teacher-name">Viết lời chúc cho {displayName}</span>
          <button type="button" className="btn-ghost" onClick={handleGoBack}>
            ← Quay lại
          </button>
        </div>

        {state.error && (
          <p className="admin-error" role="alert">{state.error}</p>
        )}

        <div className="write-layout">
          <div className="write-form">
            {/* Suggestion chips */}
            {chips.length > 0 && (
              <div className="suggestion-chips">
                <p className="chips-label">Gợi ý lời chúc</p>
                <div className="chips-row">
                  {chips.map((chip, i) => (
                    <button
                      key={i}
                      type="button"
                      className="chip"
                      onClick={() => dispatch({ type: 'SET_TEXT', text: chip })}
                      title={chip}
                    >
                      {chip.length > 42 ? chip.slice(0, 42) + '…' : chip}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Textarea */}
            <label className="write-label">
              Lời chúc của bạn <span aria-hidden="true">*</span>
              <textarea
                className="write-textarea"
                value={state.text}
                onChange={(e) => dispatch({ type: 'SET_TEXT', text: e.target.value })}
                rows={5}
                placeholder="Viết lời chúc của bạn..."
                aria-describedby="char-count"
              />
              <span
                id="char-count"
                className={`char-counter${cpCount >= 300 ? ' char-counter--limit' : ''}`}
              >
                {cpCount}/300
              </span>
            </label>

            {/* Font (student pen) */}
            <fieldset className="write-choice">
              <legend className="write-label">Font chữ</legend>
              <div className="font-options">
                {FONTS.map((f) => (
                  <label key={f.id} className={`font-option${state.font === f.id ? ' font-option--selected' : ''}`}>
                    <input
                      type="radio"
                      name="font"
                      value={f.id}
                      checked={state.font === f.id}
                      onChange={() => dispatch({ type: 'SET_FONT', font: f.id })}
                    />
                    <span className="font-option-sample" style={{ fontFamily: f.stack }}>Kính gửi thầy cô</span>
                    <span className="font-option-label">{f.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Ink colour: student pen colours, then custom */}
            <fieldset className="write-choice">
              <legend className="write-label">Màu mực</legend>
              <div className="ink-options">
                {INKS.map((ink) => (
                  <label key={ink.value} className={`ink-option${state.ink === ink.value ? ' ink-option--selected' : ''}`}>
                    <input
                      type="radio"
                      name="ink"
                      value={ink.value}
                      checked={state.ink === ink.value}
                      onChange={() => dispatch({ type: 'SET_INK', ink: ink.value })}
                    />
                    <span className="ink-dot" style={{ background: ink.value }} aria-hidden="true" />
                    {ink.label}
                  </label>
                ))}
                <label className={`ink-option${isCustomInk ? ' ink-option--selected' : ''}`}>
                  <input
                    type="color"
                    value={state.ink}
                    onChange={(e) => dispatch({ type: 'SET_INK', ink: e.target.value })}
                    aria-label="Chọn màu mực khác"
                  />
                  Màu khác
                </label>
              </div>
            </fieldset>

            {/* Optional name + class */}
            <div className="write-identity">
              <label className="write-label">
                Tên của bạn
                <input
                  type="text"
                  className="write-input"
                  value={state.fromName}
                  onChange={(e) => dispatch({ type: 'SET_FROM_NAME', name: e.target.value })}
                  placeholder="Không bắt buộc"
                  disabled={state.anonymous}
                  aria-disabled={state.anonymous}
                />
              </label>
              <label className="write-label">
                Lớp
                <input
                  type="text"
                  className="write-input"
                  value={state.fromClass}
                  onChange={(e) => dispatch({ type: 'SET_FROM_CLASS', cls: e.target.value })}
                  placeholder="VD: 11A3"
                />
              </label>
            </div>

            {/* Anonymous toggle */}
            <label className="write-anon">
              <input
                type="checkbox"
                checked={state.anonymous}
                onChange={(e) => dispatch({ type: 'SET_ANONYMOUS', anonymous: e.target.checked })}
              />
              Gửi ẩn danh
            </label>

            <button
              type="button"
              className="btn-primary"
              onClick={() => { void handleSubmit() }}
              disabled={!isTextValid(state.text) || submitting}
            >
              {submitting ? 'Đang gửi...' : 'Gửi thiệp →'}
            </button>
          </div>

          {/* Live preview */}
          <div className="write-preview">
            <p className="preview-label">Xem trước thiệp</p>
            <div className="write-preview-card">
              <CardView
                card={{
                  name: teacherInfo.name,
                  subject: teacherInfo.subject,
                  message: state.text || 'Lời chúc của bạn sẽ hiện ở đây...',
                  title: teacherInfo.title as 'Thầy' | 'Cô' | null,
                  role: teacherInfo.role,
                }}
                layout={currentTemplate.layout}
                images={currentTemplate.images}
                from={previewFrom}
                ink={state.ink}
                font={state.font}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  /* ── Step 4: thank you ───────────────────────────────────────────────── */
  if (state.step === 4) {
    return (
      <div className="write-page write-thanks">
        <Stepper step={4} />
        <div className="thanks-box">
          <p className="thanks-icon">🎉</p>
          <h2>Đã gửi thành công!</h2>
          <p>
            Thiệp của bạn sẽ hiện sau khi CLB duyệt.
          </p>
          <div className="thanks-actions">
            {/* Dispatch RESET before navigation so the reducer is at step 1 when the same
                route re-renders (same-route Link does not remount the component). */}
            <Link to="/gui-thiep" className="btn-primary-link" onClick={() => dispatch({ type: 'RESET' })}>
              Gửi thêm thiệp
            </Link>
            <Link to="/" className="btn-link-ghost">
              Về trang chủ
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return null
}
