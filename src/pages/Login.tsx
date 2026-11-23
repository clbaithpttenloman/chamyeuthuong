/**
 * Login — /dang-nhap. Username and password sign-in (ADR-9). When the account must change its
 * password (after an admin reset), the same page shows the change form before going on.
 */
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { changePassword, login } from '../api'
import { authMessage } from '../auth/authMessages.ts'
import { nextPath } from '../auth/nextPath.ts'

export default function Login() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [mustChange, setMustChange] = useState(false)
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const target = () => nextPath(params.get('next'), window.location.origin)
  const registerLink = `/dang-ky${params.get('next') ? `?next=${encodeURIComponent(params.get('next')!)}` : ''}`

  async function onLogin(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const user = await login({ username: username.trim(), password })
      if (user.mustChangePassword) {
        setMustChange(true)
        return
      }
      navigate(target(), { replace: true })
    } catch (err) {
      setError(authMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function onChange(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (next !== confirm) {
      setError('Mật khẩu nhập lại không khớp.')
      return
    }
    setBusy(true)
    try {
      await changePassword({ current: password, next })
      navigate(target(), { replace: true })
    } catch (err) {
      setError(authMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (mustChange) {
    return (
      <section className="account-page">
        <h1>Đổi mật khẩu</h1>
        <p>Quản trị viên đã đặt lại mật khẩu của bạn. Hãy đặt mật khẩu mới để tiếp tục.</p>
        {error && <p className="admin-signin-error" role="alert">{error}</p>}
        <form className="admin-form" onSubmit={(e) => { void onChange(e) }}>
          <label htmlFor="new-password">
            Mật khẩu mới
            <input id="new-password" type="password" value={next} onChange={(e) => setNext(e.target.value)}
              required minLength={8} maxLength={128} autoComplete="new-password" />
          </label>
          <label htmlFor="new-password-confirm">
            Nhập lại mật khẩu mới
            <input id="new-password-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              required maxLength={128} autoComplete="new-password" />
          </label>
          <div className="form-actions">
            <button type="submit" disabled={busy}>Đổi mật khẩu</button>
          </div>
        </form>
      </section>
    )
  }

  return (
    <section className="account-page">
      <h1>Đăng nhập</h1>
      {error && <p className="admin-signin-error" role="alert">{error}</p>}
      <form className="admin-form" onSubmit={(e) => { void onLogin(e) }}>
        <label htmlFor="login-username">
          Tên đăng nhập
          <input id="login-username" value={username} onChange={(e) => setUsername(e.target.value)}
            required maxLength={64} autoComplete="username" autoCapitalize="none" spellCheck={false} />
        </label>
        <label htmlFor="login-password">
          Mật khẩu
          <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            required maxLength={512} autoComplete="current-password" />
        </label>
        <div className="form-actions">
          <button type="submit" disabled={busy}>Đăng nhập</button>
        </div>
      </form>
      <p>Chưa có tài khoản? <Link to={registerLink}>Đăng ký</Link></p>
    </section>
  )
}
