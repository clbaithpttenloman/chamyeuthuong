import site from '../content/site.json'

export default function Home() {
  return (
    <section className="hero">
      <p className="tag">{site.message}</p>
      <h1>{site.home.heading}</h1>
      <p>{site.home.body}</p>
    </section>
  )
}
