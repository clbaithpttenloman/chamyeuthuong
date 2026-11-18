/**
 * About page — `/ve-clb-ai`
 *
 * Reads content from GET /api/about (dynamic, editable by admin).
 * Shows loading and error states.
 */
import { useEffect, useState } from 'react'
import type { AboutContent } from '../../shared/api.ts'
import { getAbout } from '../api'

type State =
  | { status: 'loading' }
  | { status: 'ok'; data: AboutContent }
  | { status: 'error' }

export default function About() {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    getAbout()
      .then((data) => setState({ status: 'ok', data }))
      .catch(() => setState({ status: 'error' }))
  }, [])

  if (state.status === 'loading') {
    return <section className="hero"><p className="admin-loading">Đang tải...</p></section>
  }

  if (state.status === 'error') {
    return <section className="hero"><p>Không thể tải nội dung. Vui lòng tải lại trang.</p></section>
  }

  const about = state.data

  return (
    <>
      <section className="hero">
        <h1>{about.heading}</h1>
        <p className="lead" style={{ whiteSpace: 'pre-line' }}>{about.intro}</p>
        {about.stats.length > 0 && (
          <div className="stats">
            {about.stats.map((s, i) => (
              <div key={i}>
                <strong>{s.value}</strong>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      {about.steps.length > 0 && (
        <section>
          <h2>{about.stepsHeading}</h2>
          <ol className="timeline">
            {about.steps.map((s, i) => (
              <li key={i}>
                <span className="when">{s.when}</span>
                <h3>{s.title}</h3>
                {s.text && <p style={{ whiteSpace: 'pre-line' }}>{s.text}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}
      {about.members.length > 0 && (
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
      )}
    </>
  )
}
