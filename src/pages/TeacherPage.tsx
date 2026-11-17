/**
 * TeacherPage — `/thay-co/:publicId`
 *
 * Shows all approved cards for a teacher, plus a CTA to send a new card.
 * Stale responses from previous publicId are silently dropped.
 */
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { PublicCard, TeacherPageResponse } from '../../shared/api.ts'
import { ApiError, getTeacherPage } from '../api'
import CardView from '../components/CardView.tsx'

type State =
  | { status: 'loading' }
  | { status: 'ok'; data: TeacherPageResponse }
  | { status: 'notfound' }
  | { status: 'error' }

export default function TeacherPage() {
  const { publicId } = useParams<{ publicId: string }>()
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    if (!publicId) { setState({ status: 'notfound' }); return }
    setState({ status: 'loading' })
    let cancelled = false
    getTeacherPage(publicId)
      .then((data) => { if (!cancelled) setState({ status: 'ok', data }) })
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
  }, [publicId])

  if (state.status === 'loading') {
    return <p className="notfound">Đang tải...</p>
  }

  if (state.status === 'notfound') {
    return (
      <p className="notfound">
        Không tìm thấy thầy cô. <Link to="/">Về trang chủ</Link>
      </p>
    )
  }

  if (state.status === 'error') {
    return <p className="notfound">Có lỗi xảy ra. Vui lòng thử lại sau.</p>
  }

  const { teacher, cards, total } = state.data
  const displayName = teacher.title ? `${teacher.title} ${teacher.name}` : teacher.name
  const sendLink = `/gui-thiep?thay=${encodeURIComponent(teacher.publicId)}`

  return (
    <div className="teacher-page">
      <div className="teacher-page-header">
        <h1>{displayName}</h1>
        {(teacher.subject || teacher.department) && (
          <p className="teacher-page-meta">
            {[teacher.subject, teacher.department].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>

      <section className="teacher-cards-section">
        <h2>Thiệp từ học sinh ({total})</h2>

        {cards.length === 0 ? (
          <div className="teacher-empty">
            <p>Chưa có thiệp nào được duyệt. Hãy là người đầu tiên!</p>
            <Link to={sendLink} className="btn-primary-link">
              Gửi lời chúc đầu tiên
            </Link>
          </div>
        ) : (
          <div className="teacher-cards-grid">
            {cards.map((card) => (
              <CardWrap key={card.publicId} card={card} teacherName={teacher.name} teacherTitle={teacher.title} />
            ))}
          </div>
        )}

        <Link to={sendLink} className="write-cta">
          ✍ Gửi thiệp cho {displayName}
        </Link>
      </section>
    </div>
  )
}

function CardWrap({ card, teacherName, teacherTitle }: {
  card: PublicCard
  teacherName: string
  teacherTitle: string | null
}) {
  return (
    <div className="teacher-card-wrap">
      <CardView
        card={{
          name: teacherName,
          subject: '',
          message: card.message,
          title: teacherTitle as 'Thầy' | 'Cô' | null,
        }}
        layout={card.layout}
        images={card.images}
        from={card.from}
        headingLevel="h2"
      />
    </div>
  )
}
