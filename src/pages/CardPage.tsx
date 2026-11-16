import { useParams } from 'react-router-dom'
import { findCard } from '../cards'
import site from '../content/site.json'

export default function CardPage() {
  const card = findCard(useParams().id)
  if (!card) return <p className="notfound">Không tìm thấy thiệp. Hãy quét lại mã QR.</p>
  return (
    <article className="card">
      <p className="kicker">{site.title}</p>
      <p className="to">Kính gửi</p>
      <h1>{card.name}</h1>
      {card.subject && <p className="sub">{card.subject}</p>}
      <hr />
      <p className="msg">{card.message}</p>
      <p className="from">
        Học sinh {site.organization}
        <br />
        {site.date}
      </p>
    </article>
  )
}
