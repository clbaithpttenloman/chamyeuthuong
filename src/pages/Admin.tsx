/**
 * Admin — /admin
 *
 * Two authentication paths (Phase 1, legacy flag on):
 *   1. Google session: "Đăng nhập bằng Google" → useMe() detects isAdmin
 *   2. Legacy email: existing email form → listAdminTeachers() verify
 *
 * Admin sections:
 *   Duyệt thiệp | Mẫu thiệp | Thầy cô | Thư viện lời chúc | Thư viện ảnh
 *   Giới thiệu CLB | Quản trị viên | Chiến dịch
 *
 * CampaignsSection requires a Google session; it shows a hint when called via legacy email.
 *
 * First page load: at most 2 admin API calls
 *   1. getMe() — Google session detection (from useMe hook)
 *   2. listAdminTeachers() — legacy email verify + data for teacher filter
 *   AboutSection loads GET /api/admin/about only when that tab is opened.
 */
import { useCallback, useEffect, useState } from 'react'
import type { AdminTeacher } from '../../shared/api.ts'
import {
  ApiError,
  clearAdminEmail,
  getAdminEmail,
  listAdminTeachers,
  logout,
  messageFor,
  setAdminEmail,
} from '../api'
import GoogleSignIn from '../auth/GoogleSignIn.tsx'
import { useMe } from '../auth/useMe.ts'
import AboutSection from './admin/AboutSection.tsx'
import AdminsSection from './admin/AdminsSection.tsx'
import CampaignsSection from './admin/CampaignsSection.tsx'
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

// ── Sign-in page ──────────────────────────────────────────────────────────

type SignInPageProps = {
  emailError: string | null
  onEmailSubmit: (e: string) => void
  onGoogleSignedIn: () => void
}

function SignInPage({ emailError, onEmailSubmit, onGoogleSignedIn }: SignInPageProps) {
  const [email, setEmail] = useState('')

  return (
    <section className="admin-signin">
      <h1>Quản lý</h1>

      {/* Google sign-in (primary path in Phase 1+) */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', marginTop: 0, marginBottom: '0.75rem' }}>
          Đăng nhập bằng Google
        </h2>
        <GoogleSignIn onSignedIn={onGoogleSignedIn} />
      </div>

      <hr style={{ margin: '1.5rem 0', borderColor: '#fed7aa' }} />

      {/* Legacy email path (while ADMIN_LEGACY_LOGIN = "1") */}
      <div>
        <h2 style={{ fontSize: '1rem', marginTop: 0, marginBottom: '0.5rem' }}>
          Hoặc nhập email quản trị
        </h2>
        {emailError && <p className="admin-signin-error" role="alert">{emailError}</p>}
        <form
          className="admin-form"
          style={{ background: 'none', border: 'none', padding: 0 }}
          onSubmit={(e) => { e.preventDefault(); onEmailSubmit(email.trim().toLowerCase()) }}
        >
          <label htmlFor="admin-email-input">
            Email
            <input
              id="admin-email-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              required
              autoComplete="email"
            />
          </label>
          <div className="form-actions">
            <button type="submit">Đăng nhập bằng email</button>
          </div>
        </form>
      </div>
    </section>
  )
}

// ── Section tabs ──────────────────────────────────────────────────────────

type Section = 'moderation' | 'templates' | 'teachers' | 'wishes' | 'images' | 'about' | 'admins' | 'campaigns'

const SECTION_LABELS: Record<Section, string> = {
  moderation: 'Duyệt thiệp',
  templates: 'Mẫu thiệp',
  teachers: 'Thầy cô',
  wishes: 'Thư viện lời chúc',
  images: 'Thư viện ảnh',
  about: 'Giới thiệu CLB',
  admins: 'Quản trị viên',
  campaigns: 'Chiến dịch',
}

// ── Main admin page ───────────────────────────────────────────────────────

export default function Admin() {
  useNoIndex()

  // ── Google session path ──────────────────────────────────────────────
  const me = useMe()
  // Track whether Google sign-in was confirmed in this session
  // (avoids depending on me.isAdmin after a re-render that might not have refreshed yet).
  const [googleVerified, setGoogleVerified] = useState(false)

  // Sync googleVerified when useMe resolves an existing session.
  useEffect(() => {
    if (!me.loading && me.isAdmin) setGoogleVerified(true)
  }, [me.loading, me.isAdmin])

  // ── Legacy email path ────────────────────────────────────────────────
  const [adminEmail, setAdminEmailState] = useState<string | null>(() => getAdminEmail())
  const [emailError, setEmailError] = useState<string | null>(null)
  const [legacyVerified, setLegacyVerified] = useState(false)
  const [checking, setChecking] = useState(false)

  const [teachers, setTeachers] = useState<AdminTeacher[]>([])
  const [pendingCount, setPendingCount] = useState(0)

  const [section, setSection] = useState<Section>('moderation')

  // Combined: verified if either path succeeds.
  const verified = googleVerified || legacyVerified

  const handleAccessError = useCallback((e: unknown): boolean => {
    if (e instanceof ApiError) {
      if (e.status === 401) {
        clearAdminEmail()
        setAdminEmailState(null)
        setLegacyVerified(false)
        setChecking(false)
        setEmailError('Email này chưa có quyền quản trị')
        setTeachers([])
        return true
      }
      if (e.status === 403) return true
    }
    return false
  }, [])

  // Load teachers for the legacy email path
  useEffect(() => {
    if (!adminEmail || legacyVerified) return
    let cancelled = false
    setChecking(true)
    setEmailError(null)
    listAdminTeachers()
      .then((ts) => {
        if (cancelled) return
        setTeachers(ts)
        const pending = ts.reduce((sum, t) => sum + t.cardCounts.pending, 0)
        setPendingCount(pending)
        setLegacyVerified(true)
      })
      .catch((e) => {
        if (cancelled) return
        clearAdminEmail()
        setAdminEmailState(null)
        if (e instanceof ApiError && e.status === 401) {
          setEmailError('Email này chưa có quyền quản trị')
        } else {
          setEmailError(messageFor(e))
        }
      })
      .finally(() => { if (!cancelled) setChecking(false) })
    return () => { cancelled = true }
  }, [adminEmail, legacyVerified])

  // Load teachers for the Google session path (after googleVerified becomes true)
  useEffect(() => {
    if (!googleVerified || teachers.length > 0) return
    listAdminTeachers()
      .then((ts) => {
        setTeachers(ts)
        setPendingCount(ts.reduce((sum, t) => sum + t.cardCounts.pending, 0))
      })
      .catch(() => { /* non-critical; ModerationSection handles its own load */ })
  }, [googleVerified, teachers.length])

  function handleEmailSubmit(email: string) {
    if (!isValidEmailFormat(email)) { setEmailError('Email không hợp lệ'); return }
    setAdminEmail(email)
    setAdminEmailState(email)
    setEmailError(null)
  }

  async function handleSignOut() {
    // Revoke Google session if one is active
    if (me.user !== null || googleVerified) {
      await logout().catch(() => {})
    }
    // Reset all auth state
    setGoogleVerified(false)
    clearAdminEmail()
    setAdminEmailState(null)
    setLegacyVerified(false)
    setChecking(false)
    setEmailError(null)
    setTeachers([])
    setPendingCount(0)
    setSection('moderation')
  }

  // Show loading while Google session check is in progress (before legacy email can help)
  if (!verified) {
    if (me.loading || checking) {
      return <section className="admin-signin"><p>Đang kiểm tra…</p></section>
    }
    return (
      <SignInPage
        emailError={emailError}
        onEmailSubmit={handleEmailSubmit}
        onGoogleSignedIn={() => { me.refresh(); setGoogleVerified(true) }}
      />
    )
  }

  const signedInLabel = me.user?.nickname
    ? `${me.user.nickname} (Google)`
    : adminEmail ?? ''

  return (
    <section className="admin-page">
      <div className="admin-header">
        <h1>Quản lý</h1>
        <div className="admin-header-actions">
          {signedInLabel && <span style={{ fontSize: '0.85rem', color: '#78716c' }}>{signedInLabel}</span>}
          <button
            type="button"
            onClick={() => { void handleSignOut() }}
            className="btn-ghost"
          >
            {googleVerified ? 'Đăng xuất' : 'Đổi email'}
          </button>
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
        {section === 'about' && (
          <AboutSection onAccessError={handleAccessError} />
        )}
        {section === 'admins' && (
          <AdminsSection onAccessError={handleAccessError} />
        )}
        {section === 'campaigns' && (
          <CampaignsSection onAccessError={handleAccessError} />
        )}
      </div>
    </section>
  )
}
