/**
 * MockShell — layout wrapper for all /mockup/* routes.
 *
 * Renders the sticky ribbon ("MOCKUP — dữ liệu giả"), the platform top bar,
 * nested sub-routes, and a footer.  Imported only in DEV mode via React.lazy
 * in App.tsx, so the production bundle never includes this module.
 */
import { Link, Route, Routes } from 'react-router-dom'
import site from '../content/site.json'
import './mockup.css'
import ModerationPage from './ModerationPage.tsx'
import QrPage from './QrPage.tsx'
import SendPage from './SendPage.tsx'
import TeacherPage from './TeacherPage.tsx'
import TemplateAdminPage from './TemplateAdminPage.tsx'
import WallPage from './WallPage.tsx'
import WritePage from './WritePage.tsx'

export default function MockShell() {
  return (
    <div className="mockup-wrap">
      <div className="mockup-ribbon">MOCKUP — dữ liệu giả</div>

      <header className="mockup-bar">
        <Link to="/mockup" className="mockup-logo">
          ♥ {site.title}
        </Link>
        <nav className="mockup-nav">
          <Link to="/mockup">Thầy cô</Link>
          <Link to="/mockup/gui-thiep">Gửi thiệp</Link>
          <Link to="/ve-clb-ai">Về CLB AI</Link>
          <span className="mockup-nav-sep" aria-hidden="true">|</span>
          <span className="mockup-nav-admin">
            <span className="mockup-nav-label">Admin:</span>
            <Link to="/mockup/admin-mau-thiep">Mẫu thiệp</Link>
            <Link to="/mockup/admin-duyet">Duyệt</Link>
          </span>
        </nav>
      </header>

      <main className="mockup-main">
        <Routes>
          <Route index element={<WallPage />} />
          <Route path="thiep/:teacherId" element={<TeacherPage />} />
          <Route path="gui-thiep" element={<SendPage />} />
          <Route path="viet-loi-chuc" element={<WritePage />} />
          <Route path="qr/:teacherId" element={<QrPage />} />
          <Route path="admin-mau-thiep" element={<TemplateAdminPage />} />
          <Route path="admin-duyet" element={<ModerationPage />} />
        </Routes>
      </main>

      <footer className="mockup-footer">
        {site.organization} · {site.date}
      </footer>
    </div>
  )
}
