/**
 * AdminsSection — who holds the admin role (ADR-9).
 *
 * Admins are accounts, not emails: grant by username, revoke from the list, reset a password
 * (shown once), and read the audit log. The server enforces the rules (no self-revoke, never the
 * last admin); this section only shows the refusal in Vietnamese.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  grantAdminRole,
  listAdminAccounts,
  listAuditRows,
  resetUserPassword,
  revokeAdminRole,
  type AdminAccount,
  type AuditRow,
} from '../../api'

type Props = { onAccessError: (e: unknown) => boolean }

const ERROR_TEXT: Record<string, string> = {
  not_found: 'Không tìm thấy tài khoản với tên đăng nhập này.',
  conflict: 'Tài khoản này đã là quản trị viên.',
  cannot_revoke_self: 'Bạn không thể tự gỡ quyền quản trị của mình.',
  last_admin: 'Phải còn ít nhất một quản trị viên.',
  bad_request: 'Dữ liệu không hợp lệ.',
  unavailable: 'Có lỗi xảy ra, vui lòng thử lại.',
}

function textFor(e: unknown): string {
  if (e instanceof ApiError) return ERROR_TEXT[e.code] ?? 'Có lỗi xảy ra, vui lòng thử lại.'
  return 'Lỗi kết nối, vui lòng thử lại.'
}

const ACTION_TEXT: Record<string, string> = {
  first_account: 'Tài khoản đầu tiên',
  reset_password: 'Đặt lại mật khẩu',
  grant_admin: 'Cấp quyền quản trị',
  revoke_admin: 'Gỡ quyền quản trị',
  ban: 'Khóa tài khoản',
  unban: 'Mở khóa tài khoản',
  hide_gift: 'Ẩn quà',
  restore_gift: 'Khôi phục quà',
  delete_gift: 'Xóa quà',
  remove_tombstone: 'Gỡ khóa đã xóa',
}

export default function AdminsSection({ onAccessError }: Props) {
  const [admins, setAdmins] = useState<AdminAccount[]>([])
  const [audit, setAudit] = useState<AuditRow[]>([])
  const [username, setUsername] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tempPassword, setTempPassword] = useState<{ userId: number; value: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const [a, log] = await Promise.all([listAdminAccounts(), listAuditRows()])
      setAdmins(a)
      setAudit(log)
    } catch (e) {
      if (!onAccessError(e)) setError(textFor(e))
    }
  }, [onAccessError])

  useEffect(() => { void load() }, [load])

  async function handleGrant(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    const name = username.trim().toLowerCase()
    if (!name) return
    try {
      await grantAdminRole(name)
      setUsername('')
      setMessage(`Đã cấp quyền quản trị cho ${name}.`)
      await load()
    } catch (err) {
      if (!onAccessError(err)) setError(textFor(err))
    }
  }

  async function handleRevoke(userId: number, label: string) {
    setError(null)
    setMessage(null)
    try {
      await revokeAdminRole(userId)
      setMessage(`Đã gỡ quyền quản trị của ${label}.`)
      await load()
    } catch (err) {
      if (!onAccessError(err)) setError(textFor(err))
    }
  }

  async function handleReset(userId: number) {
    setError(null)
    setMessage(null)
    try {
      const value = await resetUserPassword(userId)
      setTempPassword({ userId, value })
      await load()
    } catch (err) {
      if (!onAccessError(err)) setError(textFor(err))
    }
  }

  return (
    <div className="admins-section">
      <h2>Quản trị viên</h2>
      {error && <p className="admin-signin-error" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}

      <form className="admin-form" onSubmit={(e) => { void handleGrant(e) }}>
        <label htmlFor="admin-grant-username">
          Tên đăng nhập cần cấp quyền
          <input
            id="admin-grant-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={20}
            autoComplete="off"
          />
        </label>
        <div className="form-actions">
          <button type="submit" disabled={!username.trim()}>Cấp quyền quản trị</button>
        </div>
      </form>

      <table className="admin-table">
        <thead>
          <tr>
            <th scope="col">Tên đăng nhập</th>
            <th scope="col">Biệt danh</th>
            <th scope="col">Cấp lúc</th>
            <th scope="col"><span className="sr-only">Thao tác</span></th>
          </tr>
        </thead>
        <tbody>
          {admins.map((a) => (
            <tr key={a.userId}>
              <td>{a.username ?? '—'}</td>
              <td>{a.nickname}</td>
              <td>{new Date(a.grantedAt).toLocaleString('vi-VN')}</td>
              <td>
                <button type="button" className="btn-ghost" onClick={() => { void handleReset(a.userId) }}>
                  Đặt lại mật khẩu
                </button>{' '}
                <button type="button" className="btn-ghost" onClick={() => { void handleRevoke(a.userId, a.username ?? `#${a.userId}`) }}>
                  Gỡ quyền
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {tempPassword && (
        <div role="status" className="temp-password">
          <p>
            Mật khẩu tạm thời cho tài khoản #{tempPassword.userId} (chỉ hiện một lần, có hiệu lực 72 giờ):
          </p>
          <p><code>{tempPassword.value}</code></p>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => { void navigator.clipboard?.writeText(tempPassword.value) }}
          >
            Sao chép
          </button>{' '}
          <button type="button" className="btn-ghost" onClick={() => setTempPassword(null)}>Đã ghi lại</button>
        </div>
      )}

      <h3>Lịch sử thao tác</h3>
      <table className="admin-table">
        <thead>
          <tr>
            <th scope="col">Thời gian</th>
            <th scope="col">Thao tác</th>
            <th scope="col">Tài khoản tác động</th>
          </tr>
        </thead>
        <tbody>
          {audit.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.at).toLocaleString('vi-VN')}</td>
              <td>{ACTION_TEXT[r.action] ?? r.action}</td>
              <td>{r.targetUserId ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
