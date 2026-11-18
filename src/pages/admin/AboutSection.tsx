/**
 * AboutSection — "Giới thiệu CLB" admin tab.
 *
 * Loads current About content from GET /api/admin/about.
 * Provides form with:
 *   - Heading, intro text fields
 *   - Stats list (add / remove / move)
 *   - Steps heading + steps list (add / remove / move)
 *   - Members heading + members list (add / remove / move)
 *   - Limit counters shown as remaining counts
 *   - Live preview panel
 *   - Save via PUT /api/admin/about
 */
import { useCallback, useEffect, useState } from 'react'
import type { AboutContent } from '../../../shared/api.ts'
import {
  ABOUT_HEADING_MAX, ABOUT_INTRO_MAX,
  ABOUT_MEMBERS_MAX, ABOUT_MEMBER_NAME_MAX, ABOUT_MEMBER_ROLE_MAX,
  ABOUT_STAT_LABEL_MAX, ABOUT_STAT_VALUE_MAX, ABOUT_STATS_MAX,
  ABOUT_STEP_TEXT_MAX, ABOUT_STEP_WHEN_MAX, ABOUT_STEPS_MAX,
} from '../../../shared/api.ts'
import { getAdminAbout, messageFor, putAdminAbout } from '../../api'
import type { AboutFormFields } from './aboutForm.ts'
import { serializeAboutForm } from './aboutForm.ts'

function formFromContent(c: AboutContent): AboutFormFields {
  return {
    heading: c.heading,
    intro: c.intro,
    stats: c.stats.map((s) => ({ ...s })),
    stepsHeading: c.stepsHeading,
    steps: c.steps.map((s) => ({ ...s })),
    membersHeading: c.membersHeading,
    members: c.members.map((m) => ({ ...m })),
  }
}

function emptyForm(): AboutFormFields {
  return {
    heading: '',
    intro: '',
    stats: [],
    stepsHeading: 'Quá trình thực hiện',
    steps: [],
    membersHeading: 'Thành viên',
    members: [],
  }
}

function move<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir
  if (j < 0 || j >= arr.length) return arr
  const result = [...arr]
  ;[result[i], result[j]] = [result[j], result[i]]
  return result
}

export default function AboutSection({
  onAccessError,
}: {
  onAccessError: (e: unknown) => boolean
}) {
  const [form, setForm] = useState<AboutFormFields>(emptyForm())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getAdminAbout()
      setForm(formFromContent(data))
    } catch (e) {
      if (!onAccessError(e)) setError(messageFor(e))
    } finally {
      setLoading(false)
    }
  }, [onAccessError])

  useEffect(() => { void load() }, [load])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSuccess(false)
    try {
      const body = serializeAboutForm(form)
      const saved = await putAdminAbout(body)
      setForm(formFromContent(saved))
      setSuccess(true)
    } catch (err) {
      if (!onAccessError(err)) setError(messageFor(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="admin-loading">Đang tải nội dung CLB...</p>

  return (
    <div className="teacher-editor">
      <div className="teacher-editor-panels">
        {/* Form */}
        <form className="admin-form teacher-editor-form" onSubmit={(e) => { void handleSave(e) }}>
          <h2>Chỉnh sửa nội dung "Về CLB AI"</h2>

          {error && <p className="admin-error" role="alert">{error}</p>}
          {success && <p className="admin-success" role="status">Đã lưu thành công.</p>}

          {/* Heading */}
          <label>
            Tiêu đề <small>({form.heading.length}/{ABOUT_HEADING_MAX})</small>
            <input
              type="text"
              value={form.heading}
              onChange={(e) => setForm((f) => ({ ...f, heading: e.target.value }))}
              maxLength={ABOUT_HEADING_MAX}
              required
            />
          </label>

          {/* Intro */}
          <label>
            Giới thiệu <small>({form.intro.length}/{ABOUT_INTRO_MAX})</small>
            <textarea
              value={form.intro}
              onChange={(e) => setForm((f) => ({ ...f, intro: e.target.value }))}
              maxLength={ABOUT_INTRO_MAX}
              rows={4}
              required
            />
          </label>

          {/* Stats */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <strong style={{ fontSize: '0.9rem' }}>Số liệu ({form.stats.length}/{ABOUT_STATS_MAX})</strong>
              {form.stats.length < ABOUT_STATS_MAX && (
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, stats: [...f.stats, { value: '', label: '' }] }))}
                >
                  + Thêm
                </button>
              )}
            </div>
            {form.stats.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={s.value}
                  onChange={(e) => setForm((f) => { const ss = [...f.stats]; ss[i] = { ...ss[i], value: e.target.value }; return { ...f, stats: ss } })}
                  placeholder="Giá trị"
                  maxLength={ABOUT_STAT_VALUE_MAX}
                  style={{ width: '5rem' }}
                  aria-label={`Giá trị số liệu ${i + 1}`}
                />
                <input
                  type="text"
                  value={s.label}
                  onChange={(e) => setForm((f) => { const ss = [...f.stats]; ss[i] = { ...ss[i], label: e.target.value }; return { ...f, stats: ss } })}
                  placeholder="Nhãn"
                  maxLength={ABOUT_STAT_LABEL_MAX}
                  style={{ flex: 1, minWidth: '8rem' }}
                  aria-label={`Nhãn số liệu ${i + 1}`}
                />
                <button type="button" className="btn-ghost" onClick={() => setForm((f) => ({ ...f, stats: move(f.stats, i, -1) }))} aria-label="Lên" disabled={i === 0}>↑</button>
                <button type="button" className="btn-ghost" onClick={() => setForm((f) => ({ ...f, stats: move(f.stats, i, 1) }))} aria-label="Xuống" disabled={i === form.stats.length - 1}>↓</button>
                <button type="button" className="btn-danger" onClick={() => setForm((f) => ({ ...f, stats: f.stats.filter((_, j) => j !== i) }))} aria-label="Xóa">✕</button>
              </div>
            ))}
          </div>

          {/* Steps heading */}
          <label>
            Tiêu đề quá trình <small>({form.stepsHeading.length}/{ABOUT_HEADING_MAX})</small>
            <input
              type="text"
              value={form.stepsHeading}
              onChange={(e) => setForm((f) => ({ ...f, stepsHeading: e.target.value }))}
              maxLength={ABOUT_HEADING_MAX}
            />
          </label>

          {/* Steps */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <strong style={{ fontSize: '0.9rem' }}>Mốc thời gian ({form.steps.length}/{ABOUT_STEPS_MAX})</strong>
              {form.steps.length < ABOUT_STEPS_MAX && (
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, steps: [...f.steps, { when: '', title: '', text: '' }] }))}
                >
                  + Thêm
                </button>
              )}
            </div>
            {form.steps.map((s, i) => (
              <div key={i} style={{ padding: '0.6rem', background: '#fafaf9', border: '1px solid #e7e5e4', borderRadius: '0.4rem', marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.3rem', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    value={s.when}
                    onChange={(e) => setForm((f) => { const ss = [...f.steps]; ss[i] = { ...ss[i], when: e.target.value }; return { ...f, steps: ss } })}
                    placeholder="Thời điểm"
                    maxLength={ABOUT_STEP_WHEN_MAX}
                    style={{ width: '7rem' }}
                    aria-label={`Thời điểm mốc ${i + 1}`}
                  />
                  <input
                    type="text"
                    value={s.title}
                    onChange={(e) => setForm((f) => { const ss = [...f.steps]; ss[i] = { ...ss[i], title: e.target.value }; return { ...f, steps: ss } })}
                    placeholder="Tiêu đề"
                    maxLength={ABOUT_HEADING_MAX}
                    style={{ flex: 1, minWidth: '10rem' }}
                    aria-label={`Tiêu đề mốc ${i + 1}`}
                  />
                  <button type="button" className="btn-ghost" onClick={() => setForm((f) => ({ ...f, steps: move(f.steps, i, -1) }))} aria-label="Lên" disabled={i === 0}>↑</button>
                  <button type="button" className="btn-ghost" onClick={() => setForm((f) => ({ ...f, steps: move(f.steps, i, 1) }))} aria-label="Xuống" disabled={i === form.steps.length - 1}>↓</button>
                  <button type="button" className="btn-danger" onClick={() => setForm((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))} aria-label="Xóa">✕</button>
                </div>
                <textarea
                  value={s.text}
                  onChange={(e) => setForm((f) => { const ss = [...f.steps]; ss[i] = { ...ss[i], text: e.target.value }; return { ...f, steps: ss } })}
                  placeholder="Mô tả (không bắt buộc)"
                  maxLength={ABOUT_STEP_TEXT_MAX}
                  rows={2}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                  aria-label={`Mô tả mốc ${i + 1}`}
                />
              </div>
            ))}
          </div>

          {/* Members heading */}
          <label>
            Tiêu đề thành viên <small>({form.membersHeading.length}/{ABOUT_HEADING_MAX})</small>
            <input
              type="text"
              value={form.membersHeading}
              onChange={(e) => setForm((f) => ({ ...f, membersHeading: e.target.value }))}
              maxLength={ABOUT_HEADING_MAX}
            />
          </label>

          {/* Members */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <strong style={{ fontSize: '0.9rem' }}>Thành viên ({form.members.length}/{ABOUT_MEMBERS_MAX})</strong>
              {form.members.length < ABOUT_MEMBERS_MAX && (
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, members: [...f.members, { name: '', role: '' }] }))}
                >
                  + Thêm
                </button>
              )}
            </div>
            {form.members.map((m, i) => (
              <div key={i} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={m.name}
                  onChange={(e) => setForm((f) => { const ms = [...f.members]; ms[i] = { ...ms[i], name: e.target.value }; return { ...f, members: ms } })}
                  placeholder="Họ và tên"
                  maxLength={ABOUT_MEMBER_NAME_MAX}
                  style={{ flex: 1, minWidth: '8rem' }}
                  aria-label={`Tên thành viên ${i + 1}`}
                />
                <input
                  type="text"
                  value={m.role}
                  onChange={(e) => setForm((f) => { const ms = [...f.members]; ms[i] = { ...ms[i], role: e.target.value }; return { ...f, members: ms } })}
                  placeholder="Vai trò"
                  maxLength={ABOUT_MEMBER_ROLE_MAX}
                  style={{ flex: 1, minWidth: '8rem' }}
                  aria-label={`Vai trò thành viên ${i + 1}`}
                />
                <button type="button" className="btn-ghost" onClick={() => setForm((f) => ({ ...f, members: move(f.members, i, -1) }))} aria-label="Lên" disabled={i === 0}>↑</button>
                <button type="button" className="btn-ghost" onClick={() => setForm((f) => ({ ...f, members: move(f.members, i, 1) }))} aria-label="Xuống" disabled={i === form.members.length - 1}>↓</button>
                <button type="button" className="btn-danger" onClick={() => setForm((f) => ({ ...f, members: f.members.filter((_, j) => j !== i) }))} aria-label="Xóa">✕</button>
              </div>
            ))}
          </div>

          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={saving || !form.heading.trim()}>
              {saving ? 'Đang lưu...' : 'Lưu nội dung'}
            </button>
          </div>
        </form>

        {/* Live preview */}
        <div className="teacher-editor-preview">
          <p className="kicker" style={{ marginBottom: '0.5rem' }}>Xem trước</p>
          <div style={{ background: '#fff', border: '1px solid #fed7aa', borderRadius: '0.9rem', padding: '1.25rem', maxHeight: '70vh', overflowY: 'auto' }}>
            {form.heading && <h2 style={{ marginTop: 0 }}>{form.heading}</h2>}
            {form.intro && <p style={{ whiteSpace: 'pre-line', fontSize: '0.9rem', color: '#57534e' }}>{form.intro}</p>}
            {form.stats.length > 0 && (
              <div className="stats" style={{ justifyContent: 'flex-start', gap: '1rem' }}>
                {form.stats.map((s, i) => (
                  <div key={i}>
                    <strong style={{ fontSize: '1.4rem' }}>{s.value}</strong>
                    <span style={{ fontSize: '0.8rem' }}>{s.label}</span>
                  </div>
                ))}
              </div>
            )}
            {form.steps.length > 0 && (
              <>
                {form.stepsHeading && <h3>{form.stepsHeading}</h3>}
                <ol className="timeline" style={{ fontSize: '0.85rem' }}>
                  {form.steps.map((s, i) => (
                    <li key={i}>
                      <span className="when">{s.when}</span>
                      <strong style={{ display: 'block' }}>{s.title}</strong>
                      {s.text && <p style={{ margin: 0, color: '#57534e', whiteSpace: 'pre-line' }}>{s.text}</p>}
                    </li>
                  ))}
                </ol>
              </>
            )}
            {form.members.length > 0 && (
              <>
                {form.membersHeading && <h3>{form.membersHeading}</h3>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.85rem' }}>
                  {form.members.map((m, i) => (
                    <div key={i}>
                      <strong>{m.name}</strong> — <span style={{ color: '#78716c' }}>{m.role}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
