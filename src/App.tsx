import { Link, Route, Routes } from 'react-router-dom'
import site from './content/site.json'
import About from './pages/About'
import CardPage from './pages/CardPage'
import Home from './pages/Home'

export default function App() {
  return (
    <>
      <header className="bar">
        <Link to="/">♥ {site.title}</Link>
        <Link to="/ve-clb-ai">Về CLB AI</Link>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/t/:id" element={<CardPage />} />
          <Route path="/ve-clb-ai" element={<About />} />
          <Route path="*" element={<p>Không tìm thấy trang.</p>} />
        </Routes>
      </main>
      <footer>
        {site.organization} · {site.date}
      </footer>
    </>
  )
}
