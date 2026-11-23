/**
 * Register — /dang-ky. Username and password account (ADR-9). The server checks every rule;
 * the page checks only that the two password fields match before sending.
 */
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { register } from '../api'
import { authMessage } from '../auth/authMessages.ts'
import { nextPath } from '../auth/nextPath.ts'

export default function Register() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [nickname, setNickname] = useState('')
  const [className, setClassName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError('Mật khẩu nhập lại không khớp.')
      return
    }
    setBusy(true)
    try {
      await register({ username: username.trim(), password, nickname: nickname.trim(), className: className.trim() })
      navigate(nextPath(params.get('next'), window.location.origin), { replace: true })
    } catch (err) {
      setError(authMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="account-page">
      <h1>Đăng ký</h1>
      {error && <p className="admin-signin-error" role="alert">{error}</p>}
      <form className="admin-form" onSubmit={(e) => { void onSubmit(e) }}>
        <label htmlFor="reg-username">
          Tên đăng nhập
          <input id="reg-username" value={username} onChange={(e) => setUsername(e.target.value)}
            required maxLength={20} autoComplete="username" autoCapitalize="none" spellCheck={false} />
          <span className="field-hint">3–20 ký tự: chữ thường a–z, số hoặc dấu gạch dưới.</span>
        </label>
        <label htmlFor="reg-password">
          Mật khẩu
          <input id="reg-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            required minLength={8} maxLength={128} autoComplete="new-password" />
          <span className="field-hint">Ít nhất 8 ký tự. Không dùng tên đăng nhập làm mật khẩu.</span>
        </label>
        <label htmlFor="reg-confirm">
          Nhập lại mật khẩu
          <input id="reg-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            required maxLength={128} autoComplete="new-password" />
        </label>
        <label htmlFor="reg-nickname">
          Biệt danh (hiện trên bảng xếp hạng)
          <input id="reg-nickname" value={nickname} onChange={(e) => setNickname(e.target.value)}
            required maxLength={30} autoComplete="nickname" />
        </label>
        <label htmlFor="reg-class">
          Lớp (không bắt buộc)
          <input id="reg-class" value={className} onChange={(e) => setClassName(e.target.value)} maxLength={10} />
        </label>
        <div className="form-actions">
          <button type="submit" disabled={busy}>Tạo tài khoản</button>
        </div>
      </form>
      <p>Đã có tài khoản? <Link to={`/dang-nhap${params.get('next') ? `?next=${encodeURIComponent(params.get('next')!)}` : ''}`}>Đăng nhập</Link></p>
    </section>
  )
}
