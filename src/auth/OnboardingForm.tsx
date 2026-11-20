/**
 * src/auth/OnboardingForm.tsx — nickname / class onboarding after first Google sign-in.
 *
 * Shown when the user's nickname is blank (new account). PUT /api/me to save.
 * On success calls onDone(nickname, className).
 *
 * FR-10, ADR-3; plan.md § Frontend "nickname/class onboarding".
 */
import { useState } from 'react'
import { messageFor, updateMe } from '../api.ts'

type Props = {
  onDone: (nickname: string, className: string) => void
}

export default function OnboardingForm({ onDone }: Props) {
  const [nickname, setNickname] = useState('')
  const [className, setClassName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const nick = nickname.trim()
    if (!nick || nick.length > 30) {
      setError('Tên hiển thị phải từ 1 đến 30 ký tự.')
      return
    }
    if (className.length > 10) {
      setError('Lớp học tối đa 10 ký tự.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await updateMe(nick, className.trim())
      onDone(nick, className.trim())
    } catch (e) {
      setError(messageFor(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="admin-signin">
      <h1>Hoàn tất hồ sơ</h1>
      <p>Đặt tên hiển thị để tiếp tục.</p>
      {error && (
        <p className="admin-signin-error" role="alert">{error}</p>
      )}
      <form className="admin-form" onSubmit={(e) => { void handleSubmit(e) }}>
        <label htmlFor="onboarding-nickname">
          Tên hiển thị <span aria-hidden="true">*</span>
          <input
            id="onboarding-nickname"
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={30}
            required
            autoFocus
            autoComplete="nickname"
          />
          <small>1–30 ký tự</small>
        </label>
        <label htmlFor="onboarding-class">
          Lớp
          <input
            id="onboarding-class"
            type="text"
            value={className}
            onChange={(e) => setClassName(e.target.value)}
            maxLength={10}
            autoComplete="off"
          />
          <small>Tùy chọn, tối đa 10 ký tự</small>
        </label>
        <div className="form-actions">
          <button type="submit" disabled={saving}>
            {saving ? 'Đang lưu…' : 'Tiếp tục'}
          </button>
        </div>
      </form>
    </section>
  )
}
