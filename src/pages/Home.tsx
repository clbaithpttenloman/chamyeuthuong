/**
 * Home page — `/`
 *
 * Renders the active campaign's home content (kicker, heading, body).
 * Falls back to src/content/site.json synchronously on first render and on
 * any fetch error — no flash, no blank screen.
 *
 * Data source: GET /api/campaigns/active → campaign.content (JSON seeded from site.json).
 * FR-3; plan.md § Frontend "/ renders the 20/11 home from the active campaign's content".
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { WallResponse } from '../../shared/api.ts'
import { getActiveCampaign, getWall } from '../api'
import site from '../content/site.json'

type HomeContent = { kicker: string; heading: string; body: string }

/** Extract home display fields from campaign.content (seeded from site.json). */
function extractHomeContent(content: unknown): HomeContent | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null
  const c = content as Record<string, unknown>
  const home = c.home as Record<string, unknown> | undefined
  if (!home || typeof home !== 'object') return null
  const { kicker, heading, body } = home
  if (typeof kicker !== 'string' || typeof heading !== 'string' || typeof body !== 'string') return null
  return { kicker, heading, body }
}

export default function Home() {
  const [totals, setTotals] = useState<WallResponse['totals'] | null>(null)
  // Initialise from site.json so the first render is instant (no flash).
  const [homeContent, setHomeContent] = useState<HomeContent>(site.home)

  useEffect(() => {
    // Update content from the active campaign (falls back to site.json init if this fails).
    getActiveCampaign()
      .then((c) => {
        const h = extractHomeContent(c.content)
        if (h) setHomeContent(h)
      })
      .catch(() => { /* keep site.json fallback */ })

    getWall()
      .then((data) => setTotals(data.totals))
      .catch(() => setTotals(null))
  }, [])

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
