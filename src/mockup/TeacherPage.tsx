/**
 * TeacherPage — /mockup/thiep/:teacherId
 *
 * Header with Thầy/Cô name and subject.
 * Grid of all approved cards for the teacher, each rendered with CardView
 * using its own template layout and the student's message + signature.
 * Empty state with CTA if no approved cards.
 * Footer CTA: "Gửi thiệp cho {title} {name}" → /mockup/gui-thiep?thay=:id
 */
import { Link, useParams } from 'react-router-dom'
import CardView from '../components/CardView.tsx'
import { CARDS, TEACHERS, TEMPLATES, sigLine } from './data.ts'

export default function TeacherPage() {
  const { teacherId } = useParams<{ teacherId: string }>()
  const teacher = TEACHERS.find((t) => t.id === Number(teacherId))

  if (!teacher) {
    return (
      <p className="notfound">
        Không tìm thấy thầy cô. Hãy quay lại trang chủ.
      </p>
    )
  }

  const approvedCards = CARDS.filter(
    (c) => c.teacherId === teacher.id && c.status === 'approved',
  )

  return (
    <div className="teacher-page">
      {/* Header */}
      <div className="teacher-page-header">
        <h1>
          {teacher.title} {teacher.name}
        </h1>
        <p className="teacher-page-meta">
          {teacher.subject} · {teacher.department}
        </p>
      </div>

      {/* Approved cards */}
      <section className="teacher-cards-section">
        <h2>Thiệp từ học sinh ({approvedCards.length})</h2>

        {approvedCards.length === 0 ? (
          <div className="teacher-empty">
            <p>Chưa có thiệp nào được duyệt. Hãy là người đầu tiên!</p>
            <Link
              to={`/mockup/gui-thiep?thay=${teacher.id}`}
              className="btn-primary-link"
            >
              Gửi lời chúc đầu tiên
            </Link>
          </div>
        ) : (
          <div className="teacher-cards-grid">
            {approvedCards.map((card) => {
              const tpl = TEMPLATES.find((t) => t.id === card.templateId)
              return (
                <div key={card.id} className="teacher-card-wrap">
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
              )
            })}
          </div>
        )}

        <Link
          to={`/mockup/gui-thiep?thay=${teacher.id}`}
          className="write-cta"
        >
          ✍ Gửi thiệp cho {teacher.title} {teacher.name}
        </Link>
      </section>
    </div>
  )
}
