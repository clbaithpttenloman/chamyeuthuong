/**
 * QrPage — `/t/:token`
 *
 * Teacher's private page. Shows cards from their QR link.
 *   - One random card shown first (pickRandom from qrState).
 *   - "Thiệp khác" picks another card locally (excludes current, no refetch).
 *   - "Xem tất cả N thiệp" toggles a full grid on the same page.
 *   - "Gửi thiệp" links to /gui-thiep?t=<token> (preserves the teacher's token).
 *   - Empty state shows the CLB message.
 * Data is fetched once; all navigation is local state.
 */
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { PublicCard, QrResponse } from '../../shared/api.ts'
import { roleLabel } from '../../shared/api.ts'
import { ApiError, getQr } from '../api'
import CardView from '../components/CardView.tsx'
import site from '../content/site.json'
import { pickRandom } from './qr/qrState.ts'

type State =
  | { status: 'loading' }
  | { status: 'ok'; data: QrResponse }
  | { status: 'notfound' }
  | { status: 'error' }

export default function QrPage() {
  const { token } = useParams<{ token: string }>()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [currentCard, setCurrentCard] = useState<PublicCard | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    if (!token) { setState({ status: 'notfound' }); return }
    setState({ status: 'loading' })
    setCurrentCard(null)
    setShowAll(false)
    let cancelled = false

    getQr(token)
      .then((data) => {
        if (cancelled) return
        setState({ status: 'ok', data })
        // Pick the first random card on initial load
        setCurrentCard(pickRandom(data.cards))
      })
      .catch((e) => {
        if (!cancelled) {
          if (e instanceof ApiError && e.status === 404) {
            setState({ status: 'notfound' })
          } else {
            setState({ status: 'error' })
          }
        }
      })
    return () => { cancelled = true }
  }, [token])

  if (state.status === 'loading') {
    return (
      <div className="qr-page">
        <p className="admin-loading">Đang tải thiệp...</p>
      </div>
    )
  }

  if (state.status === 'notfound') {
    return <p className="notfound">Không tìm thấy thiệp. Hãy quét lại mã QR.</p>
  }

  if (state.status === 'error') {
    return <p className="notfound">Có lỗi xảy ra. Vui lòng thử lại sau.</p>
  }

  const { teacher, cards, total } = state.data
  const displayName = teacher.title ? `${teacher.title} ${teacher.name}` : teacher.name
  const sub = roleLabel(teacher.role, teacher.subject)
  // Send link uses ?t=<token> so hidden teachers can also receive cards
  const sendLink = `/gui-thiep?t=${encodeURIComponent(token!)}`

  /* ── Empty state ────────────────────────────────────────────────────── */
  if (total === 0) {
    return (
      <div className="qr-page">
        <div className="qr-header">
          <p className="kicker">{site.title}</p>
          <h1>{displayName}</h1>
          {sub && <p className="qr-sub">{sub}</p>}
        </div>
        <div className="qr-empty">
          <p>
            Chưa có lời chúc nào được duyệt. CLB AI mời các bạn học sinh gửi lời chúc đầu tiên
            cho {displayName} nhân ngày Nhà giáo Việt Nam 20/11!
          </p>
          <Link to={sendLink} className="btn-primary-link">
            ✍ Gửi lời chúc đầu tiên
          </Link>
        </div>
      </div>
    )
  }

  /* ── Card display ───────────────────────────────────────────────────── */
  return (
    <div className="qr-page">
      {/* Teacher header */}
      <div className="qr-header">
        <p className="kicker">{site.title}</p>
        <h1>{displayName}</h1>
        {sub && <p className="qr-sub">{sub}</p>}
      </div>

      {/* Current random card */}
      {currentCard && (
        <div className="qr-card-wrap">
          <CardView
            card={{
              name: teacher.name,
              subject: teacher.subject,
              message: currentCard.message,
              title: teacher.title as 'Thầy' | 'Cô' | null,
              role: teacher.role,
            }}
            layout={currentCard.layout}
            images={currentCard.images}
            from={currentCard.from}
            ink={currentCard.ink}
            font={currentCard.font}
          />
        </div>
      )}

      <div className="qr-actions">
        {total > 1 && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setCurrentCard(pickRandom(cards, currentCard?.publicId ?? null))}
          >
            🔀 Thiệp khác
          </button>
        )}
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? 'Ẩn bớt' : (
            total > cards.length
              ? `Xem tất cả thiệp (${cards.length}/${total})`
              : `Xem tất cả ${total} thiệp`
          )}
        </button>
        <Link to={sendLink} className="btn-link-ghost">
          ✍ Gửi thiệp
        </Link>
      </div>

      {/* Full card grid (toggled) */}
      {showAll && (
        <section className="qr-all-cards">
          <h2 className="strip-heading">Tất cả {total} thiệp</h2>
          <div className="teacher-cards-grid">
            {cards.map((card) => (
              <div key={card.publicId} className="teacher-card-wrap">
                <CardView
                  card={{
                    name: teacher.name,
                    subject: teacher.subject,
                    message: card.message,
                    title: teacher.title as 'Thầy' | 'Cô' | null,
              role: teacher.role,
                  }}
                  layout={card.layout}
                  images={card.images}
                  from={card.from}
                  ink={card.ink}
                  font={card.font}
                  headingLevel="h2"
                />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
