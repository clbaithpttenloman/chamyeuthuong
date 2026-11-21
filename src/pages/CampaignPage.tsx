/**
 * CampaignPage — /:slug and /:slug/g/:publicId
 *
 * Dispatches to the right page component based on campaign kind:
 *   teacher_cards → existing Phase 1 simple view (unchanged)
 *   gift_tree     → NoelPage (lazy-loaded; FR-19–28)
 *
 * The /:slug/g/:publicId route passes focusPublicId to NoelPage, which
 * rotates the tree to that gift and opens the GiftSheet on mount (FR-25a).
 *
 * NoelPage is lazy-loaded with React.lazy so the teacher-cards home's
 * first load does not include game code (NFR-2).
 *
 * FR-4, FR-6; plan.md § Frontend.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getCampaign, ApiError } from '../api'
import ErrorBoundary from '../components/ErrorBoundary.tsx'
import type { CampaignData } from '../api'

// NoelPage is lazy so teacher-cards pages never load game code
const NoelPage = lazy(() => import('../game/NoelPage.tsx'))

export default function CampaignPage() {
  const { slug, publicId } = useParams<{ slug: string; publicId?: string }>()
  const [campaign, setCampaign] = useState<CampaignData | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [networkError, setNetworkError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    setNetworkError(false)
    getCampaign(slug)
      .then((c) => {
        if (cancelled) return
        setCampaign(c)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 404) {
          setNotFound(true)
        } else {
          setNetworkError(true)
        }
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [slug, retryCount])

  if (loading) {
    return (
      <section className="wall-hero">
        <p className="admin-loading">Đang tải…</p>
      </section>
    )
  }

  // Check network error before not-found so a transient failure shows a retry option
  // rather than a misleading "not found" message.
  if (networkError) {
    return (
      <section className="wall-hero">
        <p>Không kết nối được. Thử lại.</p>
        <button
          type="button"
          className="btn-primary-link"
          onClick={() => setRetryCount((c) => c + 1)}
        >
          Thử lại
        </button>
      </section>
    )
  }

  if (notFound || !campaign || !slug) {
    return (
      <section className="wall-hero">
        <p>Không tìm thấy chiến dịch.</p>
      </section>
    )
  }

  // gift_tree campaigns render the Noel page (lazy-loaded)
  if (campaign.kind === 'gift_tree') {
    return (
      <ErrorBoundary>
        <Suspense fallback={<p className="admin-loading">Đang tải…</p>}>
          <NoelPage slug={slug} focusPublicId={publicId} />
        </Suspense>
      </ErrorBoundary>
    )
  }

  // teacher_cards campaigns: existing Phase 1 view (unchanged)
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
