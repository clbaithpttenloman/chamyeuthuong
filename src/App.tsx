import { Link, Route, Routes } from 'react-router-dom'
import site from './content/site.json'
import About from './pages/About'
import Admin from './pages/Admin'
import Home from './pages/Home'
import QrPage from './pages/QrPage'
import SendPage from './pages/SendPage'
import TeacherPage from './pages/TeacherPage'

export default function App() {
  return (
    <>
      <header className="bar">
        <Link to="/">♥ {site.title}</Link>
        <nav className="bar-nav">
          <Link to="/">Thầy cô</Link>
          <Link to="/gui-thiep">Gửi thiệp</Link>
          <Link to="/ve-clb-ai">Về CLB AI</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/thay-co/:publicId" element={<TeacherPage />} />
          <Route path="/gui-thiep" element={<SendPage />} />
          <Route path="/t/:token" element={<QrPage />} />
          <Route path="/ve-clb-ai" element={<About />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<p className="notfound">Không tìm thấy trang.</p>} />
        </Routes>
      </main>
      <footer>
        {site.organization} · {site.date}
      </footer>
    </>
  )
}
