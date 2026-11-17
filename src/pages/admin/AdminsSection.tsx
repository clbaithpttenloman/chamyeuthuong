/**
 * AdminsSection — manage which emails have admin access.
 * Extracted from Admin.tsx so each section lives in its own file.
 */
import { useEffect, useState } from 'react'
import {
  type AdminRow,
  ApiError,
  addAdmin,
  listAdmins,
  messageFor,
  removeAdmin,
} from '../../api'

function isValidEmailFormat(raw: string): boolean {
  const trimmed = raw.trim()
  if (!/^[\x00-\x7F]*$/.test(trimmed)) return false
  const email = trimmed.toLowerCase()
  if (!email || email.length > 254) return false
  const atIdx = email.indexOf('@')
  if (atIdx <= 0 || atIdx !== email.lastIndexOf('@')) return false
  const local = email.slice(0, atIdx)
  const domain = email.slice(atIdx + 1)
  if (!/^[a-z0-9._%+\-]+$/.test(local)) return false
  const labels = domain.split('.')
  if (labels.length < 2) return false
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l))
}

export default function AdminsSection({
  onAccessError,
}: {
  onAccessError: (e: unknown) => boolean
}) {
  const [admins, setAdmins] = useState<AdminRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [emailInput, setEmailInput] = useState('')

  useEffect(() => {
    setLoading(true)
    listAdmins()
      .then((rows) => { setAdmins(rows) })
      .catch((e) => {
        if (!onAccessError(e)) {
          setError(messageFor(e))
        }
      })
      .finally(() => { setLoading(false) })
  }, [onAccessError])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!isValidEmailFormat(emailInput)) {
      setError('Email không hợp lệ')
      return
    }
    try {
      const created = await addAdmin(emailInput)
      setAdmins((as) => [...as, created])
      setAdding(false)
      setEmailInput('')
    } catch (err) {
      if (!onAccessError(err)) {
        if (err instanceof ApiError && err.status === 409) {
          setError('Email đã là quản trị viên')
        } else if (err instanceof ApiError && err.status === 400) {
          setError('Email không hợp lệ')
        } else {
          setError(messageFor(err))
        }
      }
    }
  }

  async function handleRemove(a: AdminRow) {
    if (!confirm(`Xóa quản trị viên "${a.email}"? Hành động này không thể hoàn tác.`)) return
    setError(null)
    try {
      await removeAdmin(a.id)
      setAdmins((as) => as.filter((x) => x.id !== a.id))
    } catch (err) {
      if (!onAccessError(err)) {
        if (err instanceof ApiError && err.status === 409) {
          setError('Không thể xóa quản trị viên cuối cùng')
        } else {
          setError(messageFor(err))
        }
      }
    }
  }

  return (
    <div>
      <div className="admin-subsection-header">
        <h2>Quản trị viên</h2>
        <button
          onClick={() => { setAdding(true); setError(null) }}
          disabled={adding}
        >
          + Thêm quản trị viên
        </button>
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {adding && (
        <form className="admin-form" onSubmit={(e) => { void handleAdd(e) }}>
          <h2>Thêm quản trị viên</h2>
          <label>
            Email <span aria-hidden="true">*</span>
            <input
              type="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
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
              onClick={() => { setAdding(false); setEmailInput(''); setError(null) }}
            >
              Hủy
            </button>
          </div>
        </form>
      )}

      {loading && <p className="admin-loading">Đang tải...</p>}

      {!loading && admins.length === 0 && (
        <p className="admin-empty">Chưa có quản trị viên nào.</p>
      )}

      {!loading && admins.length > 0 && (
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
                      onClick={() => { void handleRemove(a) }}
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
    </div>
  )
}
