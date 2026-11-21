// @vitest-environment node
/**
 * Home — intro, counters and the "Gửi thiệp" call to action. Finding a teacher happens
 * inside /gui-thiep (step 2), not on the home page.
 *
 * Also tests extractHomeContent — the pure function that extracts display fields from
 * campaign.content (seeded as {"home":{kicker,heading,body}} from site.json).
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import Home, { extractHomeContent } from './Home.tsx'
import site from '../content/site.json'

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

// ── extractHomeContent tests ──────────────────────────────────────────────
//
// Campaign 1 is seeded with content {"home":{kicker,heading,body}} built from
// src/content/site.json .home.  Home.tsx reads content.home.* — the shape must match.
// Ref: review.md Cycle 1 Critical; tasks.md Fix Group 5a Accept 1.
// ─────────────────────────────────────────────────────────────────────────

/** Exact seeded campaign 1 content shape (backend task seeds this from site.json). */
const SEEDED_CONTENT = { home: site.home } as const

describe('extractHomeContent — seeded campaign 1 shape {home:{kicker,heading,body}}', () => {
  it('extracts all three fields from the seeded content', () => {
    const result = extractHomeContent(SEEDED_CONTENT)
    expect(result).toEqual({
      kicker: site.home.kicker,
      heading: site.home.heading,
      body: site.home.body,
    })
  })

  it('kicker matches site.json (Ngày Nhà giáo Việt Nam 20/11/2026)', () => {
    expect(extractHomeContent(SEEDED_CONTENT)?.kicker).toBe(site.home.kicker)
  })

  it('heading matches site.json', () => {
    expect(extractHomeContent(SEEDED_CONTENT)?.heading).toBe(site.home.heading)
  })

  it('body matches site.json', () => {
    expect(extractHomeContent(SEEDED_CONTENT)?.body).toBe(site.home.body)
  })
})

describe('extractHomeContent — rejects old flat seed shape and invalid inputs', () => {
  it('returns null for flat {kicker,heading,body} (pre-fix incorrect seed shape)', () => {
    // The old seed was flat — this shape must NOT be accepted to enforce the fix
    expect(extractHomeContent(site.home)).toBeNull()
  })

  it('returns null for null', () => {
    expect(extractHomeContent(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(extractHomeContent(undefined)).toBeNull()
  })

  it('returns null for empty object (no home key)', () => {
    expect(extractHomeContent({})).toBeNull()
  })

  it('returns null when body is missing from home', () => {
    expect(extractHomeContent({ home: { kicker: 'x', heading: 'y' } })).toBeNull()
  })

  it('returns null when home is a string, not an object', () => {
    expect(extractHomeContent({ home: 'noel' })).toBeNull()
  })

  it('returns null when a field is not a string (number)', () => {
    expect(extractHomeContent({ home: { kicker: 1, heading: 'y', body: 'z' } })).toBeNull()
  })
})
