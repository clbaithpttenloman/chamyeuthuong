// @vitest-environment node
/**
 * Home — intro, counters and the "Gửi thiệp" call to action. Finding a teacher happens
 * inside /gui-thiep (step 2), not on the home page.
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import Home from './Home.tsx'

const html = () => renderToString(<MemoryRouter><Home /></MemoryRouter>)

describe('Home', () => {
  it('always shows the Gửi thiệp call to action (even before the counters load)', () => {
    expect(html()).toMatch(/<a[^>]*href="\/gui-thiep"[^>]*>[^<]*Gửi thiệp/)
  })

  it('has no teacher search, tổ filter or teacher list', () => {
    const out = html()
    expect(out).not.toContain('wall-search')
    expect(out).not.toContain('wall-dept')
    expect(out).not.toContain('teacher-grid')
    expect(out).not.toContain('?thay=')
  })
})
