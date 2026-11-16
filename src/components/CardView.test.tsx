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
