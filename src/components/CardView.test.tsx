// @vitest-environment node
/**
 * CardView (card v3) — a physical-card face: fixed ratio from the layout, background image at
 * 100%, writing zone positioned by the layout, text in the student's ink and font.
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import CardView from './CardView.tsx'
import { LAYOUTS } from '../../shared/layouts.ts'

type CardData = Parameters<typeof CardView>[0]['card']
const baseCard: CardData = { name: 'Nguyễn Văn A', subject: 'Toán', message: 'Chúc mừng!' }
const TOKEN = 'imgabc1234567890'
const html = (props: Partial<Parameters<typeof CardView>[0]> = {}) =>
  renderToString(<CardView card={baseCard} layout="doc-giua" images={{}} {...props} />)

describe('CardView — layout: ratio and writing zone', () => {
  for (const l of LAYOUTS) {
    it(`${l.id}: ${l.ratio} card, zone at the layout's position`, () => {
      const out = html({ layout: l.id })
      expect(out).toContain(`card--${l.ratio}`)
      expect(out).toContain(`data-layout="${l.id}"`)
      const z = l.zone
      expect(out).toContain(`left:${z.x}%;top:${z.y}%;width:${z.w}%;height:${z.h}%`)
    })
  }

  it('legacy layout ids render with their mapped layout', () => {
    expect(html({ layout: 'night' })).toContain('data-layout="ngang-giua"')
    expect(html({ layout: 'lotus' })).toContain('data-layout="doc-giua"')
  })

  it('an arbitrary layout string is never rendered; the default layout is used', () => {
    const out = html({ layout: 'evil"><script>alert(1)</script>' })
    expect(out).not.toContain('evil')
    expect(out).not.toContain('<script>')
    expect(out).toContain('data-layout="doc-giua"')
  })

  it('showZone adds the dashed-zone marker used by the admin editor', () => {
    expect(html({ showZone: true })).toContain('card--show-zone')
    expect(html()).not.toContain('card--show-zone')
  })
})

describe('CardView — background image only', () => {
  it('renders /api/image/<token> as the card background for a valid token', () => {
    const out = html({ images: { background: TOKEN } })
    expect(out).toContain(`/api/image/${TOKEN}`)
    expect(out).toContain('card--has-bg')
  })

  it('ignores tokens that fail validation (length, case, characters)', () => {
    for (const bad of ['short', 'imgabc12345678901', 'IMGABC1234567890', 'imgabc12345678)a', '../../../x/y/z/w']) {
      const out = html({ images: { background: bad } })
      expect(out).not.toContain('/api/image/')
      expect(out).not.toContain('card--has-bg')
    }
  })

  it('banner and photo tokens are ignored entirely (no img element, no URL)', () => {
    const out = html({ images: { banner: TOKEN, photo: 'img0000000000002' } })
    expect(out).not.toContain('/api/image/')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('card-banner')
  })
})

describe('CardView — ink and font (student choices)', () => {
  it('defaults: blue ink and the Bút bi stack', () => {
    const out = html()
    expect(out).toContain('color:#1d3fa6')
    expect(out).toContain('font-family:&#x27;Patrick Hand&#x27;')
  })

  it('valid ink and font are applied', () => {
    const out = html({ ink: '#6b21a8', font: 'lora' })
    expect(out).toContain('color:#6b21a8')
    expect(out).toContain('font-family:&#x27;Lora&#x27;')
  })

  it('invalid ink or font never reaches the style; defaults are used', () => {
    const out = html({ ink: 'red;background:url(https://evil)', font: "x'; color: red" })
    expect(out).not.toContain('evil')
    expect(out).not.toContain('color:red')
    expect(out).toContain('color:#1d3fa6')
    expect(out).toContain('font-family:&#x27;Patrick Hand&#x27;')
  })
})

describe('CardView — written content', () => {
  it('renders "Kính gửi", the name with its title, the message and the stamp', () => {
    const out = html({ card: { ...baseCard, title: 'Cô' } })
    expect(out).toContain('Kính gửi')
    expect(out).toContain('Cô Nguyễn Văn A')
    expect(out).toContain('Chúc mừng!')
    expect(out).toContain('AI - Chạm yêu thương')
  })

  it('name only when title is null or undefined', () => {
    expect(html({ card: { ...baseCard, title: null } })).toMatch(/>Nguyễn Văn A</)
    expect(html()).toMatch(/>Nguyễn Văn A</)
  })

  it('headingLevel h2 renders the name as h2', () => {
    expect(html({ headingLevel: 'h2' })).toMatch(/<h2[^>]*>Nguyễn Văn A<\/h2>/)
  })

  it('message keeps newlines as text (pre-line), no <br>', () => {
    const out = html({ card: { ...baseCard, message: 'Dòng 1\nDòng 2' } })
    expect(out).toContain('Dòng 1\nDòng 2')
    expect(out).not.toContain('<br')
  })

  it('from prop replaces the default signature; default signature mentions Học sinh', () => {
    expect(html()).toContain('Học sinh')
    const out = html({ from: 'Minh Anh · 11A1' })
    expect(out).toContain('Minh Anh · 11A1')
    expect(out).not.toContain('Học sinh')
  })

  it('message text is escaped, never HTML', () => {
    const out = html({ card: { ...baseCard, message: '<img src=x onerror=alert(1)>' } })
    expect(out).not.toContain('<img src=x')
    expect(out).toContain('&lt;img')
  })
})

describe('CardView — chức vụ / môn line', () => {
  it('no role (old data) → "Giáo viên: <môn>"', () => {
    expect(html()).toContain('Giáo viên: Toán')
  })
  it('Giáo viên with empty môn → "Giáo viên"', () => {
    expect(html({ card: { ...baseCard, role: 'Giáo viên', subject: '' } })).toContain('>Giáo viên<')
  })
  it('Hiệu trưởng → only the chức vụ', () => {
    const out = html({ card: { ...baseCard, role: 'Hiệu trưởng' } })
    expect(out).toContain('>Hiệu trưởng<')
    expect(out).not.toContain('Toán')
  })
  it('Giám thị → only the chức vụ', () => {
    const out = html({ card: { ...baseCard, role: 'Giám thị' } })
    expect(out).toContain('>Giám thị<')
    expect(out).not.toContain('Toán')
  })
  it('Phó hiệu trưởng → only the chức vụ', () => {
    const out = html({ card: { ...baseCard, role: 'Phó hiệu trưởng' } })
    expect(out).toContain('>Phó hiệu trưởng<')
    expect(out).not.toContain('Giáo viên')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: toLine / subLine / stamp optional props (Noel gift card support)
// ─────────────────────────────────────────────────────────────────────────────

describe('CardView — toLine prop (greeting line)', () => {
  it('undefined (default) → renders "Kính gửi" (20/11 unchanged)', () => {
    expect(html()).toContain('Kính gửi')
  })

  it('null → "Kính gửi" line is hidden', () => {
    const out = html({ toLine: null })
    expect(out).not.toContain('Kính gửi')
    // Other content still present
    expect(out).toContain('Nguyễn Văn A')
  })

  it('custom string → custom greeting shown, "Kính gửi" absent', () => {
    const out = html({ toLine: 'Điều ước của' })
    expect(out).toContain('Điều ước của')
    expect(out).not.toContain('Kính gửi')
  })

  it('empty string → renders an empty <p class="to"> (not hidden)', () => {
    const out = html({ toLine: '' })
    // empty string is truthy for `toLine !== null`, so the element renders
    expect(out).toContain('class="to"')
  })
})

describe('CardView — subLine prop (sub-heading / role line)', () => {
  it('undefined (default) → roleLabel() used (20/11 unchanged)', () => {
    expect(html()).toContain('Giáo viên: Toán')
  })

  it('null → role/subject line is hidden', () => {
    const out = html({ subLine: null })
    expect(out).not.toContain('Giáo viên')
    expect(out).not.toContain('Toán')
    // Name and message still present
    expect(out).toContain('Nguyễn Văn A')
    expect(out).toContain('Chúc mừng!')
  })

  it('custom string → custom sub-line shown, roleLabel absent', () => {
    const out = html({ subLine: 'Khối 11 · 11A1' })
    expect(out).toContain('Khối 11 · 11A1')
    expect(out).not.toContain('Giáo viên')
  })

  it('empty string → subLine="" is falsy; sub-line element not rendered', () => {
    // Empty string is falsy in React JSX conditional `{resolvedSubLabel && <p>…</p>}`,
    // so an empty subLine produces no element — same behaviour as the original null guard.
    const out = html({ subLine: '' })
    expect(out).not.toContain('class="sub"')
  })
})

describe('CardView — stamp prop (footer)', () => {
  it('undefined (default) → site.title + 20/11 (20/11 unchanged)', () => {
    expect(html()).toContain('AI - Chạm yêu thương')
    expect(html()).toContain('20/11')
  })

  it('custom stamp → custom stamp shown, 20/11 absent', () => {
    const out = html({ stamp: 'AI - Chạm yêu thương · Noel' })
    expect(out).toContain('AI - Chạm yêu thương · Noel')
    expect(out).not.toContain('20/11')
  })

  it('stamp="" → empty stamp shown', () => {
    const out = html({ stamp: '' })
    expect(out).toContain('class="card-stamp"')
  })
})

describe('CardView — toLine + subLine + stamp together (Noel gift card scenario)', () => {
  it('gift card: toLine=null, subLine=null, custom stamp → no greeting, no sub, custom stamp', () => {
    const out = html({ toLine: null, subLine: null, stamp: 'AI - Chạm yêu thương · Noel' })
    expect(out).not.toContain('Kính gửi')
    expect(out).not.toContain('Giáo viên')
    expect(out).toContain('AI - Chạm yêu thương · Noel')
    // Core message + name still present
    expect(out).toContain('Nguyễn Văn A')
    expect(out).toContain('Chúc mừng!')
  })
})
