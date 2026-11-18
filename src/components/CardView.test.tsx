// @vitest-environment node
/**
 * Tests for src/components/CardView.tsx
 * Failing until Group 2 creates src/components/CardView.tsx.
 * Uses react-dom/server renderToString — no jsdom required.
 *
 * Contract:
 *   CardView({ card, layout, images })
 *     card:   { name, subject, message }
 *     layout: string (layout id from LAYOUTS)
 *     images: Partial<Record<Slot, string>>  — slot → 16-char token
 *
 * Invariants:
 *   - Renders a CSS class `.card--<layoutId>` using only known layout ids
 *   - Image URLs are built as `/api/image/<token>` where token matches ^[a-z0-9]{16}$
 *   - Tokens that do not match the pattern are NOT rendered as URLs
 *   - No inline injection patterns or inline scripts
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'

// This import fails until CardView.tsx is created → all tests in this file fail
import CardView from './CardView.tsx'
import { LAYOUTS, SLOTS } from '../../shared/layouts.ts'

type CardData = { name: string; subject: string; message: string }
const baseCard: CardData = { name: 'Nguyễn Văn A', subject: 'Toán', message: 'Chúc mừng!' }
const validToken = 'imgabc1234567890'

// ===================================================================
// Layout class name
// ===================================================================

describe('CardView — layout class name', () => {
  for (const layout of LAYOUTS) {
    it(`renders CSS class .card--${layout.id} for layout "${layout.id}"`, () => {
      const html = renderToString(
        <CardView card={baseCard} layout={layout.id} images={{}} />,
      )
      expect(html).toContain(`card--${layout.id}`)
    })
  }

  it('does not render an arbitrary string as a layout class', () => {
    // CardView must validate the layout against the known list before applying it as a class name
    const html = renderToString(
      <CardView card={baseCard} layout="injected-class; malicious" images={{}} />,
    )
    expect(html).not.toContain('injected-class')
    expect(html).not.toContain('malicious')
  })

  it('falls back to default layout class when given an unknown layout id', () => {
    const html = renderToString(
      <CardView card={baseCard} layout="unknown-layout" images={{}} />,
    )
    // Should use 'classic' (DEFAULT_LAYOUT) as fallback
    expect(html).toContain('card--classic')
  })
})

// ===================================================================
// Image URLs
// ===================================================================

describe('CardView — image URL handling', () => {
  it('renders /api/image/<token> URL for a valid 16-char token', () => {
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{ banner: validToken }} />,
    )
    expect(html).toContain(`/api/image/${validToken}`)
  })

  it('does not render URLs for tokens that fail isToken validation', () => {
    const badToken = '../../etc/passwd'
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{ banner: badToken }} />,
    )
    expect(html).not.toContain(badToken)
    expect(html).not.toContain('/api/image/')
  })

  it('does not render URLs for a 17-character token (tokens must be exactly 16 chars)', () => {
    // TOKEN_RE must be /^[a-z0-9]{16}$/ — exactly 16, not 16+
    // imgabc12345678901 is 17 lowercase alphanumeric chars
    const token17 = 'imgabc12345678901'
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{ banner: token17 }} />,
    )
    expect(html).not.toContain(`/api/image/${token17}`)
  })

  it('does not render URLs for tokens with uppercase characters', () => {
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{ banner: 'IMGABC1234567890' }} />,
    )
    expect(html).not.toContain('/api/image/IMGABC')
  })

  it('renders no image element when slot is omitted', () => {
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{}} />,
    )
    // No img src with /api/image/ when no images provided
    expect(html).not.toContain('/api/image/')
  })

  it('renders all three slot images when all tokens are valid', () => {
    const images: Record<string, string> = {
      background: 'img001234567890a',
      banner:     'img001234567890b',
      photo:      'img001234567890c',
    }
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={images} />,
    )
    for (const [, token] of Object.entries(images)) {
      expect(html).toContain(`/api/image/${token}`)
    }
  })
})

// ===================================================================
// Card data rendering
// ===================================================================

describe('CardView — card data', () => {
  it('renders teacher name', () => {
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{}} />,
    )
    expect(html).toContain('Nguyễn Văn A')
  })

  it('renders message', () => {
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{}} />,
    )
    expect(html).toContain('Chúc mừng!')
  })

  it('renders subject when present', () => {
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{}} />,
    )
    expect(html).toContain('Toán')
  })

  it('handles empty subject gracefully', () => {
    const card = { ...baseCard, subject: '' }
    const html = renderToString(
      <CardView card={card} layout="classic" images={{}} />,
    )
    expect(html).toContain('Nguyễn Văn A')
  })
})

// ===================================================================
// Slot coverage
// ===================================================================

describe('CardView — slot coverage', () => {
  it('every SLOT name is handled without throwing', () => {
    for (const slot of SLOTS) {
      expect(() =>
        renderToString(
          <CardView card={baseCard} layout="classic" images={{ [slot]: validToken }} />,
        ),
      ).not.toThrow()
    }
  })
})

// ===================================================================
// New for honorific plan: title in heading and photo alt text
// (failing until Group 2 adds title support to CardView)
// ===================================================================

type CardDataWithTitle = {
  name: string
  subject: string
  message: string
  title?: 'Thầy' | 'Cô' | null
}

describe('CardView — teacher title in heading (failing until Group 2)', () => {
  it('heading shows "{title} {name}" when title is Thầy', () => {
    const card: CardDataWithTitle = {
      name: 'Nguyễn Văn A',
      subject: 'Toán',
      message: 'Chúc mừng!',
      title: 'Thầy',
    }
    const html = renderToString(
       
      <CardView card={card as any} layout="classic" images={{}} />,
    )
    expect(html).toContain('Thầy Nguyễn Văn A')
  })

  it('heading shows "{title} {name}" when title is Cô', () => {
    const card: CardDataWithTitle = {
      name: 'Trần Thị B',
      subject: 'Văn',
      message: 'Chúc mừng!',
      title: 'Cô',
    }
    const html = renderToString(
       
      <CardView card={card as any} layout="classic" images={{}} />,
    )
    expect(html).toContain('Cô Trần Thị B')
  })

  it('heading shows name only when title is null', () => {
    const card: CardDataWithTitle = { name: 'Lê Văn C', subject: '', message: '', title: null }
    const html = renderToString(
       
      <CardView card={card as any} layout="classic" images={{}} />,
    )
    expect(html).toContain('Lê Văn C')
    expect(html).not.toMatch(/Thầy Lê Văn C/)
    expect(html).not.toMatch(/Cô Lê Văn C/)
  })

  it('heading shows name only when title is undefined (backward compat)', () => {
    const card: CardDataWithTitle = { name: 'Phạm Văn D', subject: '', message: '' }
    const html = renderToString(
       
      <CardView card={card as any} layout="classic" images={{}} />,
    )
    expect(html).toContain('Phạm Văn D')
  })
})

// ===================================================================
// from prop — custom signature line
// ===================================================================

describe('CardView — from prop (custom signature line)', () => {
  it('shows "Học sinh" in the default signature when from is not provided', () => {
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{}} />,
    )
    expect(html).toContain('Học sinh')
  })

  it('renders the from prop text when provided', () => {
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{}} from="Minh Anh · 11A1" />,
    )
    expect(html).toContain('Minh Anh · 11A1')
  })

  it('from prop replaces default signature (no longer shows the default org text in the from paragraph)', () => {
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{}} from="Người gửi" />,
    )
    expect(html).toContain('Người gửi')
    // The from paragraph is still present
    expect(html).toContain('class="from"')
  })

  it('renders the from paragraph when from is an empty string', () => {
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{}} from="" />,
    )
    // paragraph element is still rendered
    expect(html).toContain('class="from"')
  })

  it('renders "Một bạn học sinh" anonymous signature when from prop carries that string', () => {
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{}} from="Một bạn học sinh" />,
    )
    expect(html).toContain('Một bạn học sinh')
  })
})

// ===================================================================
// white-space: pre-line rendering (message in .msg element, no <br>)
// ===================================================================

describe('CardView — message pre-line rendering', () => {
  it('message with newline is in a .msg element without converting \\n to <br>', () => {
    const card = { name: 'A', subject: '', message: 'line1\nline2' }
    const html = renderToString(
      // Provide `from` to avoid the default <br/> in the from paragraph
      <CardView card={card} layout="classic" images={{}} from="Test" />,
    )
    // The .msg element exists
    expect(html).toContain('class="msg"')
    // Message content is present (react preserves newlines as text, not <br>)
    expect(html).toContain('line1')
    expect(html).toContain('line2')
    // No <br> elements — newlines rendered via CSS pre-line
    expect(html).not.toContain('<br')
  })
})

describe('CardView — photo alt text includes title (failing until Group 2)', () => {
  it('photo alt is "Ảnh đại diện của {title} {name}" when title is set', () => {
    const card: CardDataWithTitle = {
      name: 'Nguyễn Văn A',
      subject: '',
      message: '',
      title: 'Thầy',
    }
    const html = renderToString(
       
      <CardView card={card as any} layout="classic" images={{ photo: validToken }} />,
    )
    expect(html).toContain('Ảnh đại diện của Thầy Nguyễn Văn A')
  })

  it('photo alt is "Ảnh đại diện của {name}" when title is null', () => {
    const card: CardDataWithTitle = { name: 'Lê Thị C', subject: '', message: '', title: null }
    const html = renderToString(
       
      <CardView card={card as any} layout="classic" images={{ photo: validToken }} />,
    )
    expect(html).toContain('Ảnh đại diện của Lê Thị C')
    expect(html).not.toContain('null')
  })
})

// ===================================================================
// New for privacy-about plan — FAILING until Group 2 updates CardView
// ===================================================================

describe('CardView — no photo slot rendered (failing until Group 2)', () => {
  it('photo slot token is NOT rendered as an img element — FAILS until Group 2 removes photo rendering', () => {
    // After Group 2: CardView ignores the "photo" key since SLOTS no longer includes it.
    // Before Group 2: CardView renders a <img class="card-photo"> for the photo token → FAIL.
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{ photo: validToken }} />,
    )
    // After Group 2: no card-photo img. Before Group 2: has card-photo → FAIL.
    expect(html).not.toContain('card-photo')
  })

  it('no photo img even when both background and photo tokens provided', () => {
    const html = renderToString(
      <CardView
        card={baseCard}
        layout="classic"
        images={{ background: 'img001234567890a', photo: 'img001234567890b' }}
      />,
    )
    expect(html).not.toContain('card-photo')
    // Background IS rendered
    expect(html).toContain('img001234567890a')
  })
})

describe('CardView — subject shown as "GV môn: <subject>" (failing until Group 2)', () => {
  it('subject "Toán" is shown as "GV môn: Toán" — FAILS until Group 2 uses subjectLabel()', () => {
    // After Group 2: CardView calls subjectLabel() → "GV môn: Toán".
    // Before Group 2: CardView shows raw subject "Toán" without the prefix → FAIL.
    const html = renderToString(
      <CardView card={baseCard} layout="classic" images={{}} />,
    )
    // After Group 2: contains "GV môn: Toán". Before Group 2: only contains "Toán" (no prefix) → FAIL.
    expect(html).toContain('GV môn: Toán')
  })

  it('empty subject renders nothing — no "GV môn:" prefix for empty subject', () => {
    const card = { ...baseCard, subject: '' }
    const html = renderToString(<CardView card={card} layout="classic" images={{}} />)
    // No subject label rendered when subject is empty
    expect(html).not.toContain('GV môn:')
  })
})
