/**
 * TeacherPage — /mockup/thiep/:id
 *
 * Renders the full CardView for the selected teacher, then a masonry wall
 * of approved student notes, and a CTA to write a wish.
 */
import { Link, useParams } from 'react-router-dom'
import CardView from '../components/CardView.tsx'
import { NOTES, TEACHERS } from './data.ts'

export default function TeacherPage() {
  const { id } = useParams<{ id: string }>()
  const teacher = TEACHERS.find((t) => t.id === Number(id))

  if (!teacher) {
    return <p className="notfound">Không tìm thấy thiệp. Hãy quay lại trang chủ.</p>
  }

  const approvedNotes = NOTES.filter(
    (n) => n.teacherId === teacher.id && n.status === 'approved',
  )

  return (
    <div className="teacher-page">
      {/* Full card — images={} means no image slots rendered */}
      <CardView
        card={{
          name: teacher.name,
          subject: teacher.subject,
          message: teacher.message,
          title: teacher.title,
        }}
        layout={teacher.layout}
        images={{}}
      />

      {/* Student wishes wall */}
      <section className="teacher-notes-section">
        <h2>Lời chúc từ học sinh ({approvedNotes.length})</h2>

        {approvedNotes.length === 0 ? (
          <p style={{ color: '#78716c' }}>Chưa có lời chúc nào. Hãy là người đầu tiên!</p>
        ) : (
          <div className="notes-wall">
            {approvedNotes.map((note) => (
              <div
                key={note.id}
                className={`note-card note-card--${teacher.layout}`}
              >
                <p className="note-text">{note.text}</p>
                <div className="note-meta">
                  <span className="note-author">
                    {note.displayName ?? 'Một bạn học sinh'} · {note.className}
                  </span>
                  <span className="note-time">{note.relativeTime}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <Link
          to={`/mockup/viet-loi-chuc?thiep=${teacher.id}`}
          className="write-cta"
        >
          ✍ Viết lời chúc cho {teacher.title} {teacher.name}
        </Link>
      </section>
    </div>
  )
}
