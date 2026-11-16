import { useCallback, useEffect, useState } from 'react'
import {
  type TeacherRow,
  ApiError,
  clearAdminEmail,
  getAdminEmail,
  listTeachers,
  setAdminEmail,
} from '../api'
import AdminsSection from './admin/AdminsSection.tsx'
import BulkCreate from './admin/BulkCreate.tsx'
import ImageLibrary from './admin/ImageLibrary.tsx'
import TeachersSection from './admin/TeachersSection.tsx'
import WishLibrary from './admin/WishLibrary.tsx'

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

/**
 * Client-side email format check that mirrors the server's normalizeEmail rules.
 */
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

// ── Section tabs ──────────────────────────────────────────────────────────────

type Section = 'teachers' | 'bulk' | 'wishes' | 'images' | 'admins'

const SECTION_LABELS: Record<Section, string> = {
  teachers: 'Thiệp',
  bulk: 'Tạo hàng loạt',
  wishes: 'Thư viện lời chúc',
  images: 'Thư viện ảnh',
  admins: 'Quản trị viên',
}

// ── Main admin page ───────────────────────────────────────────────────────────

export default function Admin() {
  useNoIndex()

  const [adminEmail, setAdminEmailState] = useState<string | null>(
    () => getAdminEmail(),
  )
  const [emailError, setEmailError] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)
  const [checking, setChecking] = useState(false)

  // Teachers state: loaded on verification (1 API call on page load).
  const [teachers, setTeachers] = useState<TeacherRow[]>([])

  // Active section tab
  const [section, setSection] = useState<Section>('teachers')

  // ── Error handler ────────────────────────────────────────────────────────
  const handleAccessError = useCallback((e: unknown): boolean => {
    if (e instanceof ApiError) {
      if (e.status === 401) {
        clearAdminEmail()
        setAdminEmailState(null)
        setVerified(false)
        setChecking(false)
        setEmailError('Email này chưa có quyền quản trị')
        setTeachers([])
        return true
      }
      if (e.status === 403) {
        return true
      }
    }
    return false
  }, [])

  // ── Verification effect ───────────────────────────────────────────────────
  useEffect(() => {
    if (!adminEmail || verified) return
    let cancelled = false
    setChecking(true)
    setEmailError(null)
    listTeachers()
      .then((ts) => {
        if (cancelled) return
        setTeachers(ts)
        setVerified(true)
      })
      .catch((e) => {
        if (cancelled) return
        clearAdminEmail()
        setAdminEmailState(null)
        if (e instanceof ApiError && e.status === 401) {
          setEmailError('Email này chưa có quyền quản trị')
        } else {
          setEmailError(e instanceof Error ? e.message : 'Lỗi kết nối, thử lại')
        }
      })
      .finally(() => { if (!cancelled) setChecking(false) })
    return () => { cancelled = true }
  }, [adminEmail, verified])

  // ── Email form submit ────────────────────────────────────────────────────
  function handleEmailSubmit(email: string) {
    if (!isValidEmailFormat(email)) {
      setEmailError('Email không hợp lệ')
      return
    }
    setAdminEmail(email)
    setAdminEmailState(email)
    setEmailError(null)
  }

  // ── Sign-out ─────────────────────────────────────────────────────────────
  function handleSignOut() {
    clearAdminEmail()
    setAdminEmailState(null)
    setVerified(false)
    setChecking(false)
    setEmailError(null)
    setTeachers([])
    setSection('teachers')
  }

  // ── Pre-verification states ───────────────────────────────────────────────
  if (!adminEmail || !verified) {
    if (checking) {
      return (
        <section className="admin-signin">
          <p>Đang kiểm tra…</p>
        </section>
      )
    }
    return <EmailInputForm error={emailError} onSubmit={handleEmailSubmit} />
  }

  // ── Admin shell ───────────────────────────────────────────────────────────
  return (
    <section className="admin-page">
      <div className="admin-header">
        <h1>Quản lý thiệp</h1>
        <div className="admin-header-actions">
          <button onClick={handleSignOut} className="btn-ghost">Đổi email</button>
        </div>
      </div>

      {/* Section tabs */}
      <nav className="admin-tabs" aria-label="Điều hướng quản trị">
        {(Object.keys(SECTION_LABELS) as Section[]).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`tab-btn${section === s ? ' tab-btn--active' : ''}`}
            aria-current={section === s ? 'page' : undefined}
          >
            {SECTION_LABELS[s]}
          </button>
        ))}
      </nav>

      <div className="admin-section-content">
        {section === 'teachers' && (
          <TeachersSection
            teachers={teachers}
            onTeachersChange={(updater) => setTeachers((ts) => updater(ts))}
            onAccessError={handleAccessError}
          />
        )}
        {section === 'bulk' && (
          <BulkCreate
            onAccessError={handleAccessError}
            onTeachersCreated={(newTeachers) => setTeachers((ts) => [...ts, ...newTeachers])}
          />
        )}
        {section === 'wishes' && (
          <WishLibrary onAccessError={handleAccessError} />
        )}
        {section === 'images' && (
          <ImageLibrary onAccessError={handleAccessError} />
        )}
        {section === 'admins' && (
          <AdminsSection onAccessError={handleAccessError} />
        )}
      </div>
    </section>
  )
}
