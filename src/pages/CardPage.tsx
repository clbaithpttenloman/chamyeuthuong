import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { type CardData, ApiError, getCard } from '../api'
import site from '../content/site.json'

type State =
  | { status: 'loading' }
  | { status: 'found'; card: CardData }
  | { status: 'notfound' }
  | { status: 'error' }

export default function CardPage() {
  const { id } = useParams<{ id: string }>()
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    if (!id) {
      setState({ status: 'notfound' })
      return
    }
    setState({ status: 'loading' })
    void getCard(id).then((card) => {
      setState(card ? { status: 'found', card } : { status: 'notfound' })
    }).catch((e) => {
      setState(e instanceof ApiError && e.status === 404 ? { status: 'notfound' } : { status: 'error' })
    })
  }, [id])

  if (state.status === 'loading') {
    return <p className="notfound">Đang tải thiệp...</p>
  }

  if (state.status === 'notfound') {
    return <p className="notfound">Không tìm thấy thiệp. Hãy quét lại mã QR.</p>
  }

  if (state.status === 'error') {
    return <p className="notfound">Có lỗi xảy ra. Vui lòng thử lại sau.</p>
  }

  const { card } = state
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
