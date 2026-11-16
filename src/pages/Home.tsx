import { Link } from 'react-router-dom'
import { cards } from '../cards'
import site from '../content/site.json'

export default function Home() {
  const { home } = site
  return (
    <>
      <section className="hero">
        <p className="kicker">{home.kicker}</p>
        <h1>{home.heading}</h1>
        <p className="lead">{home.body}</p>
        <p className="motto">{site.message}</p>
      </section>
      <section>
        <h2>{home.wishesHeading}</h2>
        <div className="grid">
          {home.wishes.map((w) => (
            <div className="tile" key={w.title}>
              <h3>{w.title}</h3>
              <p>{w.text}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="note">
        <p>{home.qrNote}</p>
        {/* Mockup helper: lets us preview a personal card without scanning. Not included in production builds. */}
        {import.meta.env.DEV && (
          <p>
            <Link to={`/t/${cards[0].id}`}>Xem thiệp mẫu</Link>
          </p>
        )}
      </section>
    </>
  )
}
