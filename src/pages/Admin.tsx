/**
 * Admin — /admin
 *
 * Email verification shell → admin sections:
 *   Duyệt thiệp (default) | Mẫu thiệp | Thầy cô |
 *   Thư viện lời chúc | Thư viện ảnh | Quản trị viên
 *
 * First page load: at most 2 admin API calls
 *   1. listAdminTeachers() — auth verify + data for teacher filter
 *   2. ModerationSection loads GET /api/admin/cards?status=pending on mount
 */
import { useCallback, useEffect, useState } from 'react'
import type { AdminTeacher } from '../../shared/api.ts'
import {
  ApiError,
  clearAdminEmail,
  getAdminEmail,
  listAdminTeachers,
  setAdminEmail,
} from '../api'
import AdminsSection from './admin/AdminsSection.tsx'
import ImageLibrary from './admin/ImageLibrary.tsx'
import ModerationSection from './admin/ModerationSection.tsx'
import TeachersSection from './admin/TeachersSection.tsx'
import TemplateSection from './admin/TemplateSection.tsx'
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

// ── Email input form ──────────────────────────────────────────────────────

function EmailInputForm({ error, onSubmit }: { error: string | null; onSubmit: (e: string) => void }) {
  const [email, setEmail] = useState('')
  return (
    <section className="admin-signin">
      <h1>Nhập email quản trị</h1>
      {error && <p className="admin-signin-error" role="alert">{error}</p>}
      <form
        className="admin-form"
        onSubmit={(e) => { e.preventDefault(); onSubmit(email.trim().toLowerCase()) }}
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

// ── Section tabs ──────────────────────────────────────────────────────────

type Section = 'moderation' | 'templates' | 'teachers' | 'wishes' | 'images' | 'admins'

const SECTION_LABELS: Record<Section, string> = {
  moderation: 'Duyệt thiệp',
  templates: 'Mẫu thiệp',
  teachers: 'Thầy cô',
  wishes: 'Thư viện lời chúc',
  images: 'Thư viện ảnh',
  admins: 'Quản trị viên',
}

// ── Main admin page ───────────────────────────────────────────────────────

export default function Admin() {
  useNoIndex()

  const [adminEmail, setAdminEmailState] = useState<string | null>(() => getAdminEmail())
  const [emailError, setEmailError] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)
  const [checking, setChecking] = useState(false)

  const [teachers, setTeachers] = useState<AdminTeacher[]>([])
  const [pendingCount, setPendingCount] = useState(0)

  const [section, setSection] = useState<Section>('moderation')

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
      if (e.status === 403) return true
    }
    return false
  }, [])

  // Auth verification: load teachers list (1 API call)
  useEffect(() => {
    if (!adminEmail || verified) return
    let cancelled = false
    setChecking(true)
    setEmailError(null)
    listAdminTeachers()
      .then((ts) => {
        if (cancelled) return
        setTeachers(ts)
        // Count pending from card counts across all teachers
        const pending = ts.reduce((sum, t) => sum + t.cardCounts.pending, 0)
        setPendingCount(pending)
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

  function handleEmailSubmit(email: string) {
    if (!isValidEmailFormat(email)) { setEmailError('Email không hợp lệ'); return }
    setAdminEmail(email)
    setAdminEmailState(email)
    setEmailError(null)
  }

  function handleSignOut() {
    clearAdminEmail()
    setAdminEmailState(null)
    setVerified(false)
    setChecking(false)
    setEmailError(null)
    setTeachers([])
    setSection('moderation')
  }

  if (!adminEmail || !verified) {
    if (checking) {
      return <section className="admin-signin"><p>Đang kiểm tra…</p></section>
    }
    return <EmailInputForm error={emailError} onSubmit={handleEmailSubmit} />
  }

  return (
    <section className="admin-page">
      <div className="admin-header">
        <h1>Quản lý thiệp</h1>
        <div className="admin-header-actions">
          <button type="button" onClick={handleSignOut} className="btn-ghost">Đổi email</button>
        </div>
      </div>

      <nav className="admin-tabs" aria-label="Điều hướng quản trị">
        {(Object.entries(SECTION_LABELS) as [Section, string][]).map(([s, label]) => (
          <button
            key={s}
            type="button"
            onClick={() => setSection(s)}
            className={`tab-btn${section === s ? ' tab-btn--active' : ''}`}
            aria-current={section === s ? 'page' : undefined}
          >
            {label}
            {s === 'moderation' && pendingCount > 0 && (
              <span className="pending-badge" aria-hidden="true">{pendingCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="admin-section-content">
        {section === 'moderation' && (
          <ModerationSection
            teachers={teachers}
            pendingCount={pendingCount}
            onPendingCountChange={(delta) => setPendingCount((n) => Math.max(0, n + delta))}
            onAccessError={handleAccessError}
          />
        )}
        {section === 'templates' && (
          <TemplateSection onAccessError={handleAccessError} />
        )}
        {section === 'teachers' && (
          <TeachersSection
            teachers={teachers}
            onTeachersChange={(updater) => setTeachers((ts) => updater(ts))}
            onAccessError={handleAccessError}
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
