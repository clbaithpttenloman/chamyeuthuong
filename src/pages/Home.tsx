/**
 * Home page — `/`
 *
 * Intro, counters (teachers on the wall, approved cards) and the "Gửi thiệp" call to action.
 * Finding a teacher happens inside /gui-thiep (step 2: search + tổ filter), not here.
 * No card content is shown — cards are private to each teacher's QR page.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { WallResponse } from '../../shared/api.ts'
import { getWall } from '../api'
import site from '../content/site.json'

export default function Home() {
  const [totals, setTotals] = useState<WallResponse['totals'] | null>(null)

  useEffect(() => {
    getWall()
      .then((data) => setTotals(data.totals))
      .catch(() => setTotals(null)) // counters are optional; the page still works without them
  }, [])

  return (
    <section className="wall-hero">
      <p className="kicker">{site.home.kicker}</p>
      <h1>{site.home.heading}</h1>
      <p className="lead">{site.home.body}</p>
      {totals && (
        <div className="wall-counters">
          <div>
            <strong>{totals.teachers}</strong>
            <span>thầy cô</span>
          </div>
          <div>
            <strong>{totals.cards}</strong>
            <span>thiệp đã duyệt</span>
          </div>
        </div>
      )}
      <Link to="/gui-thiep" className="btn-primary-link">
        ✍ Gửi thiệp
      </Link>
    </section>
  )
}
