/**
 * CampaignPage — /:slug
 *
 * Phase 1: simple page showing name, tagline and open/closed state.
 * The gift tree and full game UI ship in Phase 2.
 *
 * FR-4, FR-6; plan.md § Frontend.
 */
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getCampaign, ApiError } from '../api'
import type { CampaignData } from '../api'

export default function CampaignPage() {
  const { slug } = useParams<{ slug: string }>()
  const [campaign, setCampaign] = useState<CampaignData | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!slug) return
    setLoading(true)
    setNotFound(false)
    getCampaign(slug)
      .then((c) => { setCampaign(c); setLoading(false) })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) setNotFound(true)
        setLoading(false)
      })
  }, [slug])

  if (loading) {
    return (
      <section className="wall-hero">
        <p className="admin-loading">Đang tải…</p>
      </section>
    )
  }

  if (notFound || !campaign) {
    return (
      <section className="wall-hero">
        <p>Không tìm thấy chiến dịch.</p>
      </section>
    )
  }

  const kindLabel = campaign.kind === 'gift_tree' ? 'Cây Thông Điều Ước' : 'Ngày Nhà giáo Việt Nam'

  return (
    <section className="wall-hero">
      <p className="kicker">{kindLabel}</p>
      <h1>{campaign.name}</h1>
      {campaign.tagline && <p className="lead">{campaign.tagline}</p>}
      {!campaign.open && (
        <p className="note">
          {campaign.status === 'closed'
            ? 'Chiến dịch đã kết thúc.'
            : 'Chiến dịch sắp diễn ra — hãy quay lại sau!'}
        </p>
      )}
    </section>
  )
}
