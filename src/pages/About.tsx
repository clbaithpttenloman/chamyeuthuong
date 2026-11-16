import site from '../content/site.json'

export default function About() {
  const { about } = site
  return (
    <>
      <section className="hero">
        <h1>{about.heading}</h1>
        <p className="lead">{about.intro}</p>
        <div className="stats">
          {about.stats.map((s) => (
            <div key={s.label}>
              <strong>{s.value}</strong>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2>{about.stepsHeading}</h2>
        <ol className="timeline">
          {about.steps.map((s) => (
            <li key={s.title}>
              <span className="when">{s.when}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </section>
      <section>
        <h2>{about.membersHeading}</h2>
        <div className="grid">
          {about.members.map((m, i) => (
            <div className="tile member" key={i}>
              <div className="avatar" aria-hidden="true">{m.name.charAt(0)}</div>
              <h3>{m.name}</h3>
              <p>{m.role}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
