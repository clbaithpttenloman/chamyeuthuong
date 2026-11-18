import { Link, Route, Routes } from 'react-router-dom'
import site from './content/site.json'
import { ROUTES } from './routes.ts'

export default function App() {
  return (
    <>
      <header className="bar">
        <Link to="/">♥ {site.title}</Link>
        <nav className="bar-nav">
          <Link to="/gui-thiep">Gửi thiệp</Link>
          <Link to="/ve-clb-ai">Về CLB AI</Link>
        </nav>
      </header>
      <main>
        <Routes>
          {ROUTES.map((route) => (
            <Route key={route.path} path={route.path} element={route.element} />
          ))}
        </Routes>
      </main>
      <footer>
        {site.organization} · {site.date}
      </footer>
    </>
  )
}
