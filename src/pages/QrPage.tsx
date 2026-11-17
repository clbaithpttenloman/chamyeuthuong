/**
 * QrPage — `/t/:token`
 *
 * Shows a random approved card for the teacher whose private QR token matches.
 * "Thiệp khác" re-fetches (server picks a new random card).
 * "Xem tất cả N thiệp" links to the teacher's public page.
 * Empty state shows the CLB message and a CTA to send the first card.
 */
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { QrResponse } from '../../shared/api.ts'
import { ApiError, getQr } from '../api'
import CardView from '../components/CardView.tsx'
import site from '../content/site.json'

type State =
  | { status: 'loading' }
  | { status: 'ok'; data: QrResponse }
  | { status: 'notfound' }
  | { status: 'error' }

export default function QrPage() {
  const { token } = useParams<{ token: string }>()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [refetchKey, setRefetchKey] = useState(0)

  useEffect(() => {
    if (!token) { setState({ status: 'notfound' }); return }
    setState({ status: 'loading' })
    getQr(token)
      .then((data) => setState({ status: 'ok', data }))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) {
          setState({ status: 'notfound' })
        } else {
          setState({ status: 'error' })
        }
      })
  }, [token, refetchKey])

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

  const { teacher, card, total } = state.data
  const displayName = teacher.title ? `${teacher.title} ${teacher.name}` : teacher.name
  const sendLink = `/gui-thiep?thay=${encodeURIComponent(teacher.publicId)}`
  const teacherPageLink = `/thay-co/${encodeURIComponent(teacher.publicId)}`

  /* ── Empty state ────────────────────────────────────────────────────── */
  if (!card || total === 0) {
    return (
      <div className="qr-page">
        <div className="qr-empty">
          <p className="kicker">{site.title}</p>
          <h2>{displayName}</h2>
          {teacher.subject && <p className="qr-empty-sub">{teacher.subject}</p>}
          <p>
            Chưa có lời chúc nào được duyệt. CLB AI — {displayName} gửi lời cảm ơn chân
            thành đến toàn thể học sinh nhân ngày Nhà giáo Việt Nam 20/11/2026.
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
      <div className="qr-card-wrap">
        <CardView
          card={{
            name: teacher.name,
            subject: teacher.subject,
            message: card.message,
            title: teacher.title as 'Thầy' | 'Cô' | null,
          }}
          layout={card.layout}
          images={card.images}
          from={card.from}
        />
      </div>

      <div className="qr-actions">
        {total > 1 && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setRefetchKey((k) => k + 1)}
          >
            🔀 Thiệp khác
          </button>
        )}
        <Link to={teacherPageLink} className="btn-primary-link">
          Xem tất cả {total} thiệp
        </Link>
        <Link to={sendLink} className="btn-link-ghost">
          ✍ Gửi thiệp
        </Link>
      </div>
    </div>
  )
}
