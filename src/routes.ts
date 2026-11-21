/**
 * src/routes.ts — React Router route definitions.
 *
 * Exported as ROUTES so App.tsx and tests can reference them directly.
 * Routes: / | /gui-thiep | /t/:token | /ve-clb-ai | /admin | /:slug/g/:publicId | /:slug | * (not-found)
 *
 * /:slug/g/:publicId — share link (FR-25a); renders CampaignPage which passes focusPublicId
 *   to NoelPage, rotating the tree to that gift and opening the GiftSheet on mount.
 *   Placed before /:slug so it matches the more-specific two-segment path first.
 *
 * /:slug is placed AFTER all named routes and /:slug/g/:publicId.
 * Reserved slugs (admin, api, t, gui-thiep, ve-clb-ai, assets, theme, g) are
 * rejected by isValidSlug and never match the /:slug route.
 *
 * Uses React.createElement to avoid needing a .tsx extension for this file
 * (the authoritative routes.test.ts imports from './routes.ts').
 *
 * matchCampaignSlug(pathname) is exported for routing helpers and tests.
 * It returns the slug string when the pathname is a valid single-segment
 * campaign path, or null otherwise (reserved, invalid, multi-segment, etc.).
 */
import { createElement, type ReactNode } from 'react'
import { isValidSlug } from '../shared/campaign.ts'
import About from './pages/About'
import Admin from './pages/Admin'
import CampaignPage from './pages/CampaignPage'
import Home from './pages/Home'
import QrPage from './pages/QrPage'
import SendPage from './pages/SendPage'

export type RouteEntry = { path: string; element: ReactNode }

/**
 * Returns the campaign slug when pathname is a valid campaign path, otherwise null.
 *
 * Rules:
 *   - Must start with "/"
 *   - Single path segment only (no extra slashes after the slug)
 *   - Trailing slash accepted: /noel/ → "noel"
 *   - Slug must pass isValidSlug (2–32 chars, [a-z0-9-], not reserved)
 */
export function matchCampaignSlug(pathname: string): string | null {
  if (!pathname.startsWith('/')) return null
  const stripped = pathname.slice(1) // remove leading /
  // Strip optional trailing slash: /noel/ → noel
  const segment = stripped.endsWith('/') ? stripped.slice(0, -1) : stripped
  // Reject empty (root path) or multi-segment paths
  if (!segment || segment.includes('/')) return null
  if (!isValidSlug(segment)) return null
  return segment
}

export const ROUTES: RouteEntry[] = [
  { path: '/', element: createElement(Home) },
  { path: '/gui-thiep', element: createElement(SendPage) },
  { path: '/t/:token', element: createElement(QrPage) },
  { path: '/ve-clb-ai', element: createElement(About) },
  { path: '/admin', element: createElement(Admin) },
  // Share link: /:slug/g/:publicId — more specific than /:slug, so placed first
  // CampaignPage reads both params; passes focusPublicId to NoelPage (FR-25a)
  { path: '/:slug/g/:publicId', element: createElement(CampaignPage) },
  // /:slug must come after all named routes and the share link so it never shadows them
  { path: '/:slug', element: createElement(CampaignPage) },
  { path: '*', element: createElement('p', { className: 'notfound' }, 'Không tìm thấy trang.') },
]
