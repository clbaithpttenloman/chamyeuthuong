/**
 * src/routes.ts — React Router route definitions.
 *
 * Exported as ROUTES so App.tsx and tests can reference them directly.
 * Routes: / | /gui-thiep | /t/:token | /ve-clb-ai | /admin | * (not-found)
 *
 * Uses React.createElement to avoid needing a .tsx extension for this file
 * (the authoritative routes.test.ts imports from './routes.ts').
 */
import { createElement, type ReactNode } from 'react'
import About from './pages/About'
import Admin from './pages/Admin'
import Home from './pages/Home'
import QrPage from './pages/QrPage'
import SendPage from './pages/SendPage'

export type RouteEntry = { path: string; element: ReactNode }

export const ROUTES: RouteEntry[] = [
  { path: '/', element: createElement(Home) },
  { path: '/gui-thiep', element: createElement(SendPage) },
  { path: '/t/:token', element: createElement(QrPage) },
  { path: '/ve-clb-ai', element: createElement(About) },
  { path: '/admin', element: createElement(Admin) },
  { path: '*', element: createElement('p', { className: 'notfound' }, 'Không tìm thấy trang.') },
]
