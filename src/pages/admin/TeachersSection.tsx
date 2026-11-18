/**
 * TeachersSection — Thầy cô.
 *
 * List with card counts (pending/approved/hidden).
 * Form: Thầy/Cô required, name, chức vụ (default Giáo viên), subject, department, show on home.
 * QR show/download using private token URL `${origin}/t/${token}`.
 * Rotate QR token, delete teacher.
 * Bulk add with lines `Thầy|Cô Tên | Môn | Tổ` (every bulk teacher is Giáo viên).
 */
import { useState } from 'react'
import QRCode from 'qrcode'
import type { AdminTeacher, AdminTeacherInput, Role } from '../../../shared/api.ts'
import { DEFAULT_ROLE, ROLES } from '../../../shared/api.ts'
import {
  ApiError,
  bulkAdminTeachers,
  createAdminTeacher,
  deleteAdminTeacher,
  messageFor,
  rotateAdminTeacher,
  updateAdminTeacher,
} from '../../api'
import { parseBulkInput } from './bulkParse.ts'
import { toBulkItems } from './bulkMap.ts'

type TeacherForm = {
  title: 'Thầy' | 'Cô' | ''
  name: string
  subject: string
  department: string
  role: Role
  showOnHome: 0 | 1
}

function emptyForm(t?: AdminTeacher): TeacherForm {
  return {
    title: (t?.title as 'Thầy' | 'Cô') ?? '',
    name: t?.name ?? '',
    subject: t?.subject ?? '',
    department: t?.department ?? '',
    role: t?.role ?? DEFAULT_ROLE,
    showOnHome: t?.showOnHome ?? 1,
  }
}

// ── QR section ────────────────────────────────────────────────────────────

function QrSection({
  teacher,
  dataUrl,
  onClose,
}: {
  teacher: AdminTeacher
  dataUrl: string
  onClose: () => void
}) {
  const url = `${location.origin}/t/${teacher.token}`
  return (
    <div className="admin-qr">
      <h2>Mã QR — {teacher.name}</h2>
      <img src={dataUrl} alt={`Mã QR cho ${teacher.name}`} width={256} height={256} />
      <p className="qr-url">{url}</p>
      <div className="form-actions">
        <a href={dataUrl} download={`qr-${teacher.name}.png`} className="btn-link">
          Tải PNG
        </a>
        <button type="button" onClick={onClose} className="btn-ghost">Đóng</button>
      </div>
    </div>
  )
}

// ── Bulk add sub-panel ────────────────────────────────────────────────────

function BulkAddPanel({
  onAdd,
  onClose,
}: {
  onAdd: (teachers: AdminTeacher[]) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const { items, invalidLines, overLimit } = parseBulkInput(text)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (invalidLines.length > 0) {
      setError(`Các dòng sau thiếu danh xưng Thầy/Cô hoặc tên: ${invalidLines.join(', ')}`)
      return
    }
    if (items.length === 0) { setError('Danh sách trống.'); return }
    if (overLimit > 0) { setError(`Tối đa 100 giáo viên mỗi lần; bớt ${overLimit} dòng.`); return }

    setSubmitting(true)
    try {
      const inputs = toBulkItems({ items, invalidLines, overLimit })
      const { created } = await bulkAdminTeachers(inputs)
      onAdd(created)
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError('Dữ liệu không hợp lệ. Kiểm tra lại danh sách.')
      } else {
        setError(messageFor(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="admin-form" onSubmit={(e) => { void handleSubmit(e) }}>
      <h2>Thêm hàng loạt</h2>
      {error && <p className="admin-error" role="alert">{error}</p>}
      <label>
        Danh sách giáo viên <span aria-hidden="true">*</span>
        <small>Mỗi dòng: Thầy/Cô Tên | Môn | Tổ bộ môn (tối đa 100 dòng)</small>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setError(null) }}
          rows={8}
          placeholder={'Thầy Nguyễn Văn A | Toán | Tổ Toán - Tin\nCô Trần Thị B | Văn | Tổ Văn - Sử\nThầy Lê Văn C'}
          required
        />
        <small>{items.length} giáo viên</small>
      </label>
      <div className="form-actions">
        <button type="submit" disabled={submitting || items.length === 0}>
          {submitting ? 'Đang thêm...' : `Thêm ${items.length} giáo viên`}
        </button>
        <button type="button" className="btn-ghost" onClick={onClose}>Hủy</button>
      </div>
    </form>
  )
}

// ── Main component ────────────────────────────────────────────────────────

export default function TeachersSection({
  teachers,
  onTeachersChange,
  onAccessError,
}: {
  teachers: AdminTeacher[]
  onTeachersChange: (updater: (ts: AdminTeacher[]) => AdminTeacher[]) => void
  onAccessError: (e: unknown) => boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<TeacherForm>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [qrData, setQrData] = useState<{ teacher: AdminTeacher; dataUrl: string } | null>(null)

  function openNew() {
    setEditing('new')
    setForm(emptyForm())
    setBulkOpen(false)
    setQrData(null)
    setError(null)
  }

  function openEdit(t: AdminTeacher) {
    setEditing(t.id)
    setForm(emptyForm(t))
    setBulkOpen(false)
    setQrData(null)
    setError(null)
  }

  function cancelEdit() {
    setEditing(null)
    setError(null)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title) { setError('Vui lòng chọn danh xưng Thầy hoặc Cô.'); return }
    setSaving(true)
    setError(null)

    const input: AdminTeacherInput = {
      title: form.title,
      name: form.name.trim(),
      ...(form.subject.trim() ? { subject: form.subject.trim() } : {}),
      ...(form.department.trim() ? { department: form.department.trim() } : {}),
      role: form.role,
      showOnHome: form.showOnHome,
    }

    try {
      if (editing === 'new') {
        const created = await createAdminTeacher(input)
        onTeachersChange((ts) => [...ts, created])
      } else if (editing !== null) {
        const updated = await updateAdminTeacher(editing, input)
        onTeachersChange((ts) => ts.map((t) => t.id === updated.id ? updated : t))
      }
      setEditing(null)
    } catch (err) {
      if (!onAccessError(err)) {
        if (err instanceof ApiError && err.status === 400) {
          setError('Không thể lưu: kiểm tra lại các trường.')
        } else {
          setError(messageFor(err))
        }
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(t: AdminTeacher) {
    if (!confirm(`Xóa ${t.title ? `${t.title} ` : ''}${t.name}? Hành động này không thể hoàn tác.`)) return
    setError(null)
    try {
      await deleteAdminTeacher(t.id)
      onTeachersChange((ts) => ts.filter((x) => x.id !== t.id))
      if (editing === t.id) cancelEdit()
      if (qrData?.teacher.id === t.id) setQrData(null)
    } catch (err) {
      if (!onAccessError(err)) {
        setError(messageFor(err))
      }
    }
  }

  async function handleRotate(t: AdminTeacher) {
    if (!confirm(`Đổi mã QR của "${t.name}"? Mã cũ sẽ không còn hoạt động.`)) return
    setError(null)
    try {
      const { token } = await rotateAdminTeacher(t.id)
      const updated = { ...t, token }
      onTeachersChange((ts) => ts.map((x) => x.id === t.id ? updated : x))
      if (qrData?.teacher.id === t.id) {
        const url = `${location.origin}/t/${token}`
        const dataUrl = await QRCode.toDataURL(url, { margin: 2, width: 256 })
        setQrData({ teacher: updated, dataUrl })
      }
    } catch (err) {
      if (!onAccessError(err)) {
        setError(messageFor(err))
      }
    }
  }

  async function handleShowQr(t: AdminTeacher) {
    try {
      const url = `${location.origin}/t/${t.token}`
      const dataUrl = await QRCode.toDataURL(url, { margin: 2, width: 256 })
      setQrData({ teacher: t, dataUrl })
      setEditing(null)
      setBulkOpen(false)
    } catch {
      setError('Lỗi tạo mã QR')
    }
  }

  const showForm = editing !== null
  const counts = (t: AdminTeacher) =>
    `${t.cardCounts.pending} chờ · ${t.cardCounts.approved} duyệt · ${t.cardCounts.hidden} ẩn`

  return (
    <div>
      <div className="admin-header">
        <h2 style={{ margin: 0 }}>Thầy cô</h2>
        <div className="admin-header-actions">
          <button type="button" onClick={openNew} disabled={showForm || bulkOpen}>
            + Thêm giáo viên
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => { setBulkOpen(true); setEditing(null); setQrData(null); setError(null) }}
            disabled={showForm || bulkOpen}
          >
            Thêm hàng loạt
          </button>
        </div>
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {/* Bulk add panel */}
      {bulkOpen && (
        <BulkAddPanel
          onAdd={(created) => { onTeachersChange((ts) => [...ts, ...created]) }}
          onClose={() => setBulkOpen(false)}
        />
      )}

      {/* Add/edit form */}
      {showForm && (
        <form className="admin-form" onSubmit={(e) => { void handleSave(e) }}>
          <h2>{editing === 'new' ? 'Thêm giáo viên' : 'Sửa giáo viên'}</h2>

          <label>
            Danh xưng <span aria-hidden="true">*</span>
            <select
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value as 'Thầy' | 'Cô' | '' }))}
              required
            >
              <option value="" disabled>Chọn Thầy/Cô</option>
              <option value="Thầy">Thầy</option>
              <option value="Cô">Cô</option>
            </select>
          </label>

          <label>
            Họ tên <span aria-hidden="true">*</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              maxLength={80}
              required
            />
          </label>

          <label>
            Chức vụ
            <select
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))}
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            {form.role !== DEFAULT_ROLE && <small>Thiệp và trang chủ chỉ hiện chức vụ, không hiện môn và tổ.</small>}
          </label>

          <label>
            Môn dạy
            <input
              type="text"
              value={form.subject}
              onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
              maxLength={80}
            />
          </label>

          <label>
            Tổ bộ môn
            <input
              type="text"
              value={form.department}
              onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))}
              maxLength={80}
            />
          </label>

          <label className="write-anon" style={{ gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={form.showOnHome === 1}
              onChange={(e) => setForm((f) => ({ ...f, showOnHome: e.target.checked ? 1 : 0 }))}
            />
            Hiện trên trang chủ
          </label>

          <div className="form-actions">
            <button type="submit" disabled={saving || !form.title || !form.name.trim()}>
              {saving ? 'Đang lưu...' : editing === 'new' ? 'Thêm' : 'Lưu thay đổi'}
            </button>
            <button type="button" className="btn-ghost" onClick={cancelEdit}>Hủy</button>
          </div>
        </form>
      )}

      {/* QR section */}
      {qrData && (
        <QrSection
          teacher={qrData.teacher}
          dataUrl={qrData.dataUrl}
          onClose={() => setQrData(null)}
        />
      )}

      {/* Teacher table */}
      {teachers.length === 0 && !showForm && !bulkOpen && (
        <p className="admin-empty">Chưa có giáo viên nào.</p>
      )}

      {teachers.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Danh xưng</th>
                <th>Họ tên</th>
                <th>Chức vụ</th>
                <th>Môn</th>
                <th>Tổ</th>
                <th>Trang chủ</th>
                <th>Thiệp</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {teachers.map((t) => (
                <tr key={t.id} className={editing === t.id ? 'row-active' : undefined}>
                  <td>{t.title ?? '—'}</td>
                  <td>{t.name}</td>
                  <td>{t.role}</td>
                  <td>{t.subject || '—'}</td>
                  <td>{t.department || '—'}</td>
                  <td>{t.showOnHome ? '✓' : '—'}</td>
                  <td style={{ fontSize: '0.8rem', color: '#78716c' }}>{counts(t)}</td>
                  <td className="admin-actions">
                    <button type="button" onClick={() => openEdit(t)}>Sửa</button>
                    <button
                      type="button"
                      onClick={() => { void handleShowQr(t) }}
                      aria-label={`Xem mã QR cho ${t.name}`}
                    >
                      QR
                    </button>
                    <button
                      type="button"
                      className="btn-warn"
                      onClick={() => { void handleRotate(t) }}
                      aria-label={`Đổi mã QR của ${t.name}`}
                    >
                      Đổi mã
                    </button>
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={() => { void handleDelete(t) }}
                      aria-label={`Xóa giáo viên ${t.name}`}
                    >
                      Xóa
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
