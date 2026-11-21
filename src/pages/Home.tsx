/**
 * Home page — `/`
 *
 * Renders the active campaign's home content by kind:
 *   teacher_cards → existing 20/11 wall (kicker, heading, body, counters, send button)
 *   gift_tree     → NoelPage (lazy-loaded; FR-19–28)
 *
 * Falls back to src/content/site.json synchronously on first render and on
 * any fetch error — no flash, no blank screen for teacher_cards.
 *
 * Data source: GET /api/campaigns/active → campaign.content (JSON seeded from site.json).
 * FR-3; plan.md § Frontend.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { WallResponse } from '../../shared/api.ts'
import { getActiveCampaign, getWall } from '../api'
import type { CampaignData } from '../api'
import site from '../content/site.json'

type HomeContent = { kicker: string; heading: string; body: string }

/**
 * Extract home display fields from campaign.content (seeded from site.json).
 * Expects shape `{"home":{"kicker":…,"heading":…,"body":…}}`.
 * Exported for unit testing.
 */
export function extractHomeContent(content: unknown): HomeContent | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null
  const c = content as Record<string, unknown>
  const home = c.home as Record<string, unknown> | undefined
  if (!home || typeof home !== 'object') return null
  const { kicker, heading, body } = home
  if (typeof kicker !== 'string' || typeof heading !== 'string' || typeof body !== 'string') return null
  return { kicker, heading, body }
}

// NoelPage is lazy so teacher-cards home never loads game code (NFR-2)
const NoelPage = lazy(() => import('../game/NoelPage.tsx'))

export default function Home() {
  const [campaign, setCampaign] = useState<CampaignData | null>(null)
  const [totals, setTotals] = useState<WallResponse['totals'] | null>(null)
  // Initialise from site.json so the first render is instant (no flash).
  const [homeContent, setHomeContent] = useState<HomeContent>(site.home)

  useEffect(() => {
    // Update content from the active campaign (falls back to site.json init if this fails).
    getActiveCampaign()
      .then((c) => {
        setCampaign(c)
        if (c.kind === 'teacher_cards') {
          const h = extractHomeContent(c.content)
          if (h) setHomeContent(h)
        }
      })
      .catch(() => { /* keep site.json fallback */ })

    getWall()
      .then((data) => setTotals(data.totals))
      .catch(() => setTotals(null))
  }, [])

  // gift_tree active campaign → show Noel game page
  if (campaign?.kind === 'gift_tree') {
    return (
      <Suspense fallback={<p className="admin-loading">Đang tải…</p>}>
        <NoelPage slug={campaign.slug} />
      </Suspense>
    )
  }

  // teacher_cards (or not yet loaded) → existing 20/11 home (unchanged behavior)
  return (
    <section className="wall-hero">
      <p className="kicker">{homeContent.kicker}</p>
      <h1>{homeContent.heading}</h1>
      <p className="lead">{homeContent.body}</p>
      {totals && (
        <div className="wall-counters">
          <div>
            <strong>{totals.teachers}</strong>
            <span>thầy cô</span>
          </div>
          <div>
            <strong>{totals.cards}</strong>
            <span>thiệp đã duyệt</span>
          </div>
        </div>
      )}
      <Link to="/gui-thiep" className="btn-primary-link">
        ✍ Gửi thiệp
      </Link>
    </section>
  )
}
