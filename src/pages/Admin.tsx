import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import {
  type AdminRow,
  type TeacherRow,
  ApiError,
  addAdmin,
  clearAdminEmail,
  createTeacher,
  deleteTeacher,
  getAdminEmail,
  listAdmins,
  listTeachers,
  removeAdmin,
  rotateTeacherToken,
  setAdminEmail,
  updateTeacher,
} from '../api'

/** Inject <meta name="robots" content="noindex"> while this component is mounted. */
function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex'
    document.head.appendChild(meta)
    return () => { document.head.removeChild(meta) }
  }, [])
}

type EditDraft = { name: string; subject: string; message: string; status: string }

function emptyDraft(t?: TeacherRow): EditDraft {
  return {
    name: t?.name ?? '',
    subject: t?.subject ?? '',
    message: t?.message ?? '',
    status: t?.status ?? 'draft',
  }
}

// ── Email input form ──────────────────────────────────────────────────────────

function EmailInputForm({
  error,
  onSubmit,
}: {
  error: string | null
  onSubmit: (email: string) => void
}) {
  const [email, setEmail] = useState('')
  return (
    <section className="admin-signin">
      <h1>Nhập email quản trị</h1>
      {error && (
        <p className="admin-signin-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(email.trim().toLowerCase())
        }}
      >
        <label>
          Email <span aria-hidden="true">*</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            required
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
        </label>
        <div className="form-actions">
          <button type="submit">Đăng nhập</button>
        </div>
      </form>
    </section>
  )
}

// ── Add teacher form ─────────────────────────────────────────────────────────

function AddForm({
  onSave,
  onCancel,
}: {
  onSave: (name: string, subject: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  return (
    <form
      className="admin-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(name, subject)
      }}
    >
      <h2>Thêm giáo viên</h2>
      <label>
        Họ tên <span aria-hidden="true">*</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          required
        />
      </label>
      <label>
        Môn dạy
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={80}
        />
      </label>
      <div className="form-actions">
        <button type="submit">Lưu</button>
        <button type="button" onClick={onCancel} className="btn-ghost">Hủy</button>
      </div>
    </form>
  )
}

// ── Edit teacher form ────────────────────────────────────────────────────────

function EditForm({
  teacher,
  onSave,
  onCancel,
}: {
  teacher: TeacherRow
  onSave: (draft: EditDraft) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<EditDraft>(() => emptyDraft(teacher))
  return (
    <form
      className="admin-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(draft)
      }}
    >
      <h2>Sửa thiệp — {teacher.name}</h2>
      <label>
        Họ tên <span aria-hidden="true">*</span>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          maxLength={80}
          required
        />
      </label>
      <label>
        Môn dạy
        <input
          type="text"
          value={draft.subject}
          onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
          maxLength={80}
        />
      </label>
      <label>
        Lời chúc
        <textarea
          value={draft.message}
          onChange={(e) => setDraft((d) => ({ ...d, message: e.target.value }))}
          maxLength={600}
          rows={5}
        />
        <small>{draft.message.length}/600 ký tự</small>
      </label>
      <label>
        Trạng thái
        <select
          value={draft.status}
          onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
        >
          <option value="draft">Nháp</option>
          <option value="published">Đã phát hành</option>
        </select>
      </label>
      <div className="form-actions">
        <button type="submit">Lưu thay đổi</button>
        <button type="button" onClick={onCancel} className="btn-ghost">Hủy</button>
      </div>
    </form>
  )
}

// ── QR section ───────────────────────────────────────────────────────────────

function QrSection({
  teacher,
  dataUrl,
  onClose,
}: {
  teacher: TeacherRow
  dataUrl: string
  onClose: () => void
}) {
  return (
    <div className="admin-qr">
      <h2>Mã QR — {teacher.name}</h2>
      <img src={dataUrl} alt={`Mã QR cho ${teacher.name}`} width={256} height={256} />
      <p className="qr-url">{location.origin}/t/{teacher.token}</p>
      <div className="form-actions">
        <a href={dataUrl} download={`thiep-${teacher.id}.png`} className="btn-link">
          Tải PNG
        </a>
        <button onClick={onClose} className="btn-ghost">Đóng</button>
      </div>
    </div>
  )
}

// ── Main admin page ───────────────────────────────────────────────────────────

export default function Admin() {
  useNoIndex()

  // ── Admin email (sessionStorage key `adminEmail`) ─────────────────────────
  const [adminEmail, setAdminEmailState] = useState<string | null>(
    () => getAdminEmail()
  )
  const [emailError, setEmailError] = useState<string | null>(null)

  const [teachers, setTeachers] = useState<TeacherRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editTeacher, setEditTeacher] = useState<TeacherRow | null>(null)
  const [qrData, setQrData] = useState<{ teacher: TeacherRow; dataUrl: string } | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)

  // Admin management state
  const [admins, setAdmins] = useState<AdminRow[]>([])
  const [adminsLoading, setAdminsLoading] = useState(false)
  const [adminsError, setAdminsError] = useState<string | null>(null)
  const [addingAdmin, setAddingAdmin] = useState(false)
  const [adminEmailInput, setAdminEmailInput] = useState('')

  // ── Error handler ────────────────────────────────────────────────────────
  /** Returns true when the error was an auth error (caller should not set generic error). */
  const handleAccessError = useCallback((e: unknown): boolean => {
    if (e instanceof ApiError) {
      if (e.status === 401) {
        // api.ts already cleared sessionStorage via clearAdminEmail(); sync local state
        setAdminEmailState(null)
        setEmailError('Email này chưa có quyền quản trị')
        setTeachers([])
        setAdmins([])
        return true
      }
      if (e.status === 403) {
        setError('Yêu cầu bị từ chối.')
        return true
      }
    }
    return false
  }, [])

  // ── Data loaders ─────────────────────────────────────────────────────────
  const loadTeachers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setTeachers(await listTeachers())
    } catch (e) {
      if (!handleAccessError(e)) {
        setError(e instanceof Error ? e.message : 'Lỗi không xác định')
      }
    } finally {
      setLoading(false)
    }
  }, [handleAccessError])

  const loadAdmins = useCallback(async () => {
    setAdminsLoading(true)
    try {
      setAdmins(await listAdmins())
    } catch (e) {
      if (!handleAccessError(e)) {
        setAdminsError(e instanceof Error ? e.message : 'Lỗi tải danh sách quản trị viên')
      }
    } finally {
      setAdminsLoading(false)
    }
  }, [handleAccessError])

  // Load teachers and admins once email is set
  useEffect(() => {
    if (adminEmail) {
      void loadTeachers()
      void loadAdmins()
    }
  }, [adminEmail, loadTeachers, loadAdmins])

  // ── Email form submit ────────────────────────────────────────────────────
  function handleEmailSubmit(email: string) {
    setAdminEmail(email)       // persist to sessionStorage
    setAdminEmailState(email)  // update React state → triggers load effect
    setEmailError(null)
  }

  // ── Sign-out / change email ──────────────────────────────────────────────
  function handleSignOut() {
    clearAdminEmail()
    setAdminEmailState(null)
    setEmailError(null)
    setTeachers([])
    setAdmins([])
    setError(null)
    setAdminsError(null)
    setAdding(false)
    setEditTeacher(null)
    setQrData(null)
    setAddingAdmin(false)
    setAdminEmailInput('')
  }

  // ── Teacher CRUD handlers ─────────────────────────────────────────────────

  async function handleAdd(name: string, subject: string) {
    setError(null)
    try {
      const created = await createTeacher(name, subject || undefined)
      setTeachers((ts) => [...ts, created])
      setAdding(false)
    } catch (e) {
      if (!handleAccessError(e)) setError(e instanceof Error ? e.message : 'Lỗi thêm giáo viên')
    }
  }

  async function handleSaveEdit(draft: EditDraft) {
    if (!editTeacher) return
    setError(null)
    try {
      const updated = await updateTeacher(editTeacher.id, draft)
      setTeachers((ts) => ts.map((t) => (t.id === updated.id ? updated : t)))
      if (qrData?.teacher.id === updated.id) {
        const url = `${location.origin}/t/${updated.token}`
        setQrData({ teacher: updated, dataUrl: await QRCode.toDataURL(url, { margin: 2, width: 256 }) })
      }
      setEditTeacher(null)
    } catch (e) {
      if (!handleAccessError(e)) setError(e instanceof Error ? e.message : 'Lỗi cập nhật')
    }
  }

  async function handleToggleStatus(t: TeacherRow) {
    setError(null)
    try {
      const updated = await updateTeacher(t.id, {
        name: t.name,
        subject: t.subject,
        message: t.message,
        status: t.status === 'published' ? 'draft' : 'published',
      })
      setTeachers((ts) => ts.map((x) => (x.id === updated.id ? updated : x)))
      if (editTeacher?.id === updated.id) setEditTeacher(updated)
    } catch (e) {
      if (!handleAccessError(e)) {
        if (e instanceof ApiError && e.status === 400 && t.status === 'draft') {
          setError(`Không thể phát hành "${t.name}": lời chúc không được để trống`)
        } else {
          setError(e instanceof Error ? e.message : 'Lỗi cập nhật trạng thái')
        }
      }
    }
  }

  async function handleDelete(t: TeacherRow) {
    if (!confirm(`Xóa giáo viên "${t.name}"? Hành động này không thể hoàn tác.`)) return
    setError(null)
    try {
      await deleteTeacher(t.id)
      setTeachers((ts) => ts.filter((x) => x.id !== t.id))
      if (editTeacher?.id === t.id) setEditTeacher(null)
      if (qrData?.teacher.id === t.id) setQrData(null)
    } catch (e) {
      if (!handleAccessError(e)) setError(e instanceof Error ? e.message : 'Lỗi xóa giáo viên')
    }
  }

  async function handleRotate(t: TeacherRow) {
    if (!confirm(`Đổi mã QR của "${t.name}"? Mã cũ sẽ không còn hoạt động.`)) return
    setError(null)
    try {
      const { token } = await rotateTeacherToken(t.id)
      const updated = { ...t, token }
      setTeachers((ts) => ts.map((x) => (x.id === t.id ? updated : x)))
      if (editTeacher?.id === t.id) setEditTeacher(updated)
      if (qrData?.teacher.id === t.id) {
        const url = `${location.origin}/t/${token}`
        setQrData({ teacher: updated, dataUrl: await QRCode.toDataURL(url, { margin: 2, width: 256 }) })
      }
    } catch (e) {
      if (!handleAccessError(e)) setError(e instanceof Error ? e.message : 'Lỗi đổi mã')
    }
  }

  async function handleShowQr(t: TeacherRow) {
    try {
      const url = `${location.origin}/t/${t.token}`
      const dataUrl = await QRCode.toDataURL(url, { margin: 2, width: 256 })
      setQrData({ teacher: t, dataUrl })
      setEditTeacher(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi tạo mã QR')
    }
  }

  async function handleCopyUrl(t: TeacherRow) {
    try {
      await navigator.clipboard.writeText(`${location.origin}/t/${t.token}`)
      setCopiedId(t.id)
      setTimeout(() => setCopiedId((x) => (x === t.id ? null : x)), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi sao chép URL')
    }
  }

  // ── Admin management handlers ─────────────────────────────────────────────

  async function handleAddAdmin(e: React.FormEvent) {
    e.preventDefault()
    setAdminsError(null)
    try {
      const created = await addAdmin(adminEmailInput)
      setAdmins((as) => [...as, created])
      setAddingAdmin(false)
      setAdminEmailInput('')
    } catch (err) {
      if (!handleAccessError(err)) {
        if (err instanceof ApiError && err.status === 409) {
          setAdminsError('Email đã là quản trị viên')
        } else if (err instanceof ApiError && err.status === 400) {
          setAdminsError('Email không hợp lệ')
        } else {
          setAdminsError(err instanceof Error ? err.message : 'Lỗi thêm quản trị viên')
        }
      }
    }
  }

  async function handleRemoveAdmin(a: AdminRow) {
    if (!confirm(`Xóa quản trị viên "${a.email}"? Hành động này không thể hoàn tác.`)) return
    setAdminsError(null)
    try {
      await removeAdmin(a.id)
      setAdmins((as) => as.filter((x) => x.id !== a.id))
    } catch (err) {
      if (!handleAccessError(err)) {
        if (err instanceof ApiError && err.status === 409) {
          setAdminsError('Không thể xóa quản trị viên cuối cùng')
        } else {
          setAdminsError(err instanceof Error ? err.message : 'Lỗi xóa quản trị viên')
        }
      }
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (!adminEmail) {
    return <EmailInputForm error={emailError} onSubmit={handleEmailSubmit} />
  }

  // Email is set → show admin interface
  return (
    <section className="admin-page">
      <div className="admin-header">
        <h1>Quản lý giáo viên</h1>
        <div className="admin-header-actions">
          <button
            onClick={() => { setAdding(true); setEditTeacher(null) }}
            disabled={adding}
          >
            + Thêm giáo viên
          </button>
          <button onClick={handleSignOut} className="btn-ghost">Đổi email</button>
        </div>
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {adding && (
        <AddForm
          onSave={(name, subject) => { void handleAdd(name, subject) }}
          onCancel={() => setAdding(false)}
        />
      )}

      {loading && <p className="admin-loading">Đang tải...</p>}

      {!loading && !adding && teachers.length === 0 && (
        <p className="admin-empty">Chưa có giáo viên nào. Nhấn &ldquo;+ Thêm giáo viên&rdquo; để bắt đầu.</p>
      )}

      {teachers.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Họ tên</th>
                <th>Môn</th>
                <th>Trạng thái</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {teachers.map((t) => (
                <tr key={t.id} className={editTeacher?.id === t.id ? 'row-active' : undefined}>
                  <td>{t.name}</td>
                  <td>{t.subject || '—'}</td>
                  <td>
                    <span className={`status-badge status-${t.status}`}>
                      {t.status === 'published' ? 'Đã phát hành' : 'Nháp'}
                    </span>
                  </td>
                  <td className="admin-actions">
                    <button
                      onClick={() => { setEditTeacher(t); setQrData(null) }}
                      aria-label={`Sửa thiệp của ${t.name}`}
                    >
                      Sửa
                    </button>
                    <button
                      onClick={() => { void handleToggleStatus(t) }}
                      aria-label={
                        t.status === 'published'
                          ? `Chuyển "${t.name}" về nháp`
                          : `Phát hành thiệp của ${t.name}`
                      }
                    >
                      {t.status === 'published' ? 'Về nháp' : 'Phát hành'}
                    </button>
                    <button
                      onClick={() => { void handleCopyUrl(t) }}
                      aria-label={`Sao chép URL thiệp của ${t.name}`}
                    >
                      {copiedId === t.id ? '✓ Đã sao chép' : 'Sao chép URL'}
                    </button>
                    <button
                      onClick={() => { void handleShowQr(t) }}
                      aria-label={`Xem mã QR cho ${t.name}`}
                    >
                      QR
                    </button>
                    <button
                      onClick={() => { void handleRotate(t) }}
                      aria-label={`Đổi mã QR của ${t.name}`}
                      className="btn-warn"
                    >
                      Đổi mã
                    </button>
                    <button
                      onClick={() => { void handleDelete(t) }}
                      aria-label={`Xóa giáo viên ${t.name}`}
                      className="btn-danger"
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

      {editTeacher && (
        <EditForm
          key={editTeacher.id}
          teacher={editTeacher}
          onSave={(draft) => { void handleSaveEdit(draft) }}
          onCancel={() => setEditTeacher(null)}
        />
      )}

      {qrData && (
        <QrSection
          teacher={qrData.teacher}
          dataUrl={qrData.dataUrl}
          onClose={() => setQrData(null)}
        />
      )}

      {/* ── Quản trị viên ───────────────────────────────────────────────── */}
      <div className="admin-subsection-header">
        <h2>Quản trị viên</h2>
        <button
          onClick={() => { setAddingAdmin(true); setAdminsError(null) }}
          disabled={addingAdmin}
        >
          + Thêm quản trị viên
        </button>
      </div>

      {adminsError && <p className="admin-error" role="alert">{adminsError}</p>}

      {addingAdmin && (
        <form className="admin-form" onSubmit={(e) => { void handleAddAdmin(e) }}>
          <h2>Thêm quản trị viên</h2>
          <label>
            Email <span aria-hidden="true">*</span>
            <input
              type="email"
              value={adminEmailInput}
              onChange={(e) => setAdminEmailInput(e.target.value)}
              maxLength={254}
              required
              autoFocus
            />
          </label>
          <div className="form-actions">
            <button type="submit">Thêm</button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => { setAddingAdmin(false); setAdminEmailInput(''); setAdminsError(null) }}
            >
              Hủy
            </button>
          </div>
        </form>
      )}

      {adminsLoading && <p className="admin-loading">Đang tải...</p>}

      {!adminsLoading && admins.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Thêm bởi</th>
                <th>Ngày thêm</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id}>
                  <td>{a.email}</td>
                  <td>{a.created_by}</td>
                  <td>{new Date(a.created_at).toLocaleDateString('vi-VN')}</td>
                  <td className="admin-actions">
                    <button
                      onClick={() => { void handleRemoveAdmin(a) }}
                      className="btn-danger"
                      aria-label={`Xóa quản trị viên ${a.email}`}
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
    </section>
  )
}
