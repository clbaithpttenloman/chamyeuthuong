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
      </section>
    </>
  )
}
