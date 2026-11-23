/**
 * Admin — /admin
 *
 * Signed in with a username and password (ADR-9). The account must hold the admin role and must not
 * have to change its password. Anyone else is sent to /dang-nhap. There is no typed-email login.
 *
 * Admin sections:
 *   Duyệt thiệp | Mẫu thiệp | Thầy cô | Thư viện lời chúc | Thư viện ảnh
 *   Giới thiệu CLB | Quản trị viên | Chiến dịch
 *
 * AboutSection loads GET /api/admin/about only when that tab is opened.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AdminTeacher } from '../../shared/api.ts'
import { ApiError, listAdminTeachers, logout } from '../api'
import { useMe } from '../auth/useMe.ts'
import AboutSection from './admin/AboutSection.tsx'
import AdminsSection from './admin/AdminsSection.tsx'
import CampaignsSection from './admin/CampaignsSection.tsx'
import GiftModerationSection from './admin/GiftModerationSection.tsx'
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

/** Shown when nobody is signed in, or the signed-in account is not an admin. */
function SignInPage({ message }: { message: string | null }) {
  return (
    <section className="admin-signin">
      <h1>Quản lý</h1>
      {message && <p className="admin-signin-error" role="alert">{message}</p>}
      <p>
        <Link to="/dang-nhap?next=/admin">Đăng nhập bằng tên đăng nhập và mật khẩu</Link>
      </p>
    </section>
  )
}

// ── Section tabs ──────────────────────────────────────────────────────────

type Section = 'moderation' | 'giftModeration' | 'templates' | 'teachers' | 'wishes' | 'images' | 'about' | 'admins' | 'campaigns'

const SECTION_LABELS: Record<Section, string> = {
  moderation: 'Duyệt thiệp',
  giftModeration: 'Kiểm duyệt quà',
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

  const me = useMe()
  const verified = me.user !== null && me.isAdmin && !me.user.mustChangePassword

  const [teachers, setTeachers] = useState<AdminTeacher[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  /** Count of reported gifts awaiting review (shown in the "Kiểm duyệt quà" tab badge). */
  const [giftReviewCount, setGiftReviewCount] = useState(0)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [section, setSection] = useState<Section>('moderation')

  /** Session expired or revoked (401) → re-read /api/me so the sign-in page shows. */
  const handleAccessError = useCallback((e: unknown): boolean => {
    if (e instanceof ApiError) {
      if (e.status === 401) {
        setTeachers([])
        me.refresh()
        return true
      }
      if (e.status === 403) return true
    }
    return false
  }, [me])

  /** Stable callback for GiftModerationSection so loadGifts is not re-fired on count changes. */
  const handleReportedCountChange = useCallback((count: number) => {
    setGiftReviewCount(count)
  }, [])

  // Teachers feed the moderation and teacher tabs. Loaded once the admin is verified.
  useEffect(() => {
    if (!verified || teachers.length > 0) return
    listAdminTeachers()
      .then((ts) => {
        setTeachers(ts)
        setPendingCount(ts.reduce((sum, t) => sum + t.cardCounts.pending, 0))
      })
      .catch(() => { /* non-critical; ModerationSection handles its own load */ })
  }, [verified, teachers.length])

  async function handleSignOut() {
    setSignOutError(null)
    try {
      await logout()
    } catch (e) {
      // 401: the session is already gone, so the admin is signed out.
      if (!(e instanceof ApiError && e.status === 401)) {
        setSignOutError('Đăng xuất thất bại. Phiên đăng nhập vẫn còn, vui lòng thử lại.')
        return
      }
    }
    setTeachers([])
    setPendingCount(0)
    setSection('moderation')
    me.refresh()
  }

  if (me.loading) {
    return <section className="admin-signin"><p>Đang kiểm tra…</p></section>
  }
  if (!verified) {
    if (me.user !== null && me.isAdmin && me.user.mustChangePassword) {
      return <SignInPage message="Bạn cần đổi mật khẩu trước khi vào trang quản lý." />
    }
    if (me.user !== null) {
      return (
        <section className="admin-signin">
          <h1>Quản lý</h1>
          <p className="admin-signin-error" role="alert">Tài khoản này không có quyền quản trị.</p>
          <button type="button" className="btn-ghost" onClick={() => { void handleSignOut() }}>Đăng xuất</button>
          {signOutError && <p className="admin-signin-error" role="alert">{signOutError}</p>}
        </section>
      )
    }
    return <SignInPage message={null} />
  }

  const signedInLabel = me.user?.username ?? me.user?.nickname ?? ''

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
            Đăng xuất
          </button>
          {signOutError && <p className="admin-signin-error" role="alert">{signOutError}</p>}
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
            {s === 'giftModeration' && giftReviewCount > 0 && (
              <span className="pending-badge" aria-label={`${giftReviewCount} quà cần kiểm duyệt`}>
                {giftReviewCount}
              </span>
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
        {section === 'giftModeration' && (
          <GiftModerationSection
            onReportedCountChange={handleReportedCountChange}
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
