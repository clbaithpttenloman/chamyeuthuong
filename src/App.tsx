import { lazy, Suspense } from 'react'
import { Link, Route, Routes, useLocation } from 'react-router-dom'
import site from './content/site.json'
import About from './pages/About'
import Admin from './pages/Admin'
import CardPage from './pages/CardPage'
import Home from './pages/Home'

// DEV-only: lazy-load the mockup shell inside the import.meta.env.DEV condition
// so Vite replaces the condition with `false` at build time and Rollup
// tree-shakes the entire branch — nothing from src/mockup/ reaches the bundle.
const MockShell = import.meta.env.DEV
  ? lazy(() => import('./mockup/MockShell.tsx'))
  : null

export default function App() {
  const location = useLocation()
  // Also guarded by import.meta.env.DEV so the string '/mockup' lives only in a
  // dead branch after Vite substitution → tree-shaken from the production bundle.
  const isMockup = import.meta.env.DEV && location.pathname.startsWith('/mockup')

  return (
    <>
      {!isMockup && (
        <header className="bar">
          <Link to="/">♥ {site.title}</Link>
          <Link to="/ve-clb-ai">Về CLB AI</Link>
        </header>
      )}
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/t/:id" element={<CardPage />} />
          <Route path="/ve-clb-ai" element={<About />} />
          <Route path="/admin" element={<Admin />} />
          {import.meta.env.DEV && MockShell !== null && (
            <Route
              path="/mockup/*"
              element={
                <Suspense fallback={<></>}>
                  <MockShell />
                </Suspense>
              }
            />
          )}
          <Route path="*" element={<p>Không tìm thấy trang.</p>} />
        </Routes>
      </main>
      {!isMockup && (
        <footer>
          {site.organization} · {site.date}
        </footer>
      )}
    </>
  )
}
