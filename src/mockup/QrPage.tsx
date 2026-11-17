/**
 * QrPage — /mockup/qr/:teacherId
 *
 * Simulates what the physical QR code opens:
 *   - A random approved card for that teacher rendered in full
 *   - "Thiệp khác" button to shuffle to a different card
 *   - "Xem tất cả N thiệp" link to the teacher page
 *   - If no approved card: a friendly placeholder with the CLB message
 *     and a "Gửi lời chúc đầu tiên" CTA
 */
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import CardView from '../components/CardView.tsx'
import { CARDS, TEACHERS, TEMPLATES, sigLine } from './data.ts'
import site from '../content/site.json'

export default function QrPage() {
  const { teacherId } = useParams<{ teacherId: string }>()
  const teacherIdNum = Number(teacherId)

  const teacher = TEACHERS.find((t) => t.id === teacherIdNum)
  const approvedCards = teacher
    ? CARDS.filter((c) => c.teacherId === teacher.id && c.status === 'approved')
    : []

  const [idx, setIdx] = useState(() =>
    approvedCards.length > 0
      ? Math.floor(Math.random() * approvedCards.length)
      : 0,
  )

  if (!teacher) {
    return <p className="notfound">Không tìm thấy thầy cô. Hãy quay lại trang chủ.</p>
  }

  /* ── Empty state ─────────────────────────────────────────────────────── */
  if (approvedCards.length === 0) {
    return (
      <div className="qr-page">
        <div className="qr-empty">
          <p className="kicker">{site.title}</p>
          <h2>
            {teacher.title} {teacher.name}
          </h2>
          <p className="qr-empty-sub">{teacher.subject}</p>
          <p>
            Chưa có lời chúc nào được duyệt. CLB AI — {teacher.title}{' '}
            {teacher.name} gửi lời cảm ơn chân thành đến toàn thể học sinh nhân
            ngày Nhà giáo Việt Nam 20/11/2026.
          </p>
          <Link
            to={`/mockup/gui-thiep?thay=${teacher.id}`}
            className="btn-primary-link"
          >
            ✍ Gửi lời chúc đầu tiên
          </Link>
        </div>
      </div>
    )
  }

  /* ── Shuffle card ────────────────────────────────────────────────────── */
  function handleShuffle() {
    if (approvedCards.length <= 1) return
    setIdx((prev) => {
      let next = prev
      while (next === prev) next = Math.floor(Math.random() * approvedCards.length)
      return next
    })
  }

  const card = approvedCards[idx]!
  const tpl = TEMPLATES.find((t) => t.id === card.templateId)

  return (
    <div className="qr-page">
      <div className="qr-card-wrap">
        <CardView
          card={{
            name: teacher.name,
            subject: teacher.subject,
            message: card.message,
            title: teacher.title,
          }}
          layout={tpl?.layout ?? 'classic'}
          images={{}}
          from={sigLine(card)}
        />
      </div>

      <div className="qr-actions">
        {approvedCards.length > 1 && (
          <button type="button" className="btn-ghost" onClick={handleShuffle}>
            🔀 Thiệp khác
          </button>
        )}
        <Link
          to={`/mockup/thiep/${teacher.id}`}
          className="btn-primary-link"
        >
          Xem tất cả {approvedCards.length} thiệp
        </Link>
        <Link
          to={`/mockup/gui-thiep?thay=${teacher.id}`}
          className="btn-link-ghost"
        >
          ✍ Gửi thiệp
        </Link>
      </div>
    </div>
  )
}
