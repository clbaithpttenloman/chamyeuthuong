import { useParams } from 'react-router-dom'
import { findCard } from '../cards'
import site from '../content/site.json'

export default function CardPage() {
  const card = findCard(useParams().id)
  if (!card) return <p>Không tìm thấy thiệp. Hãy quét lại mã QR.</p>
  return (
    <article className="card">
      <p className="tag">{site.title}</p>
      <h1>Kính gửi {card.name}</h1>
      {card.subject && <p className="sub">{card.subject}</p>}
      <p className="msg">{card.message}</p>
      <p className="from">{site.organization}</p>
    </article>
  )
}
