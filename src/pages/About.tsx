import site from '../content/site.json'

export default function About() {
  const { about } = site
  return (
    <section>
      <h1>{about.heading}</h1>
      <p>{about.intro}</p>
      <ol>
        {about.steps.map((s) => (
          <li key={s.title}>
            <strong>{s.title}.</strong> {s.text}
          </li>
        ))}
      </ol>
    </section>
  )
}
