/**
 * CardView — a physical-card face (card v3).
 *
 * Used by SendPage (template gallery + write preview), QrPage (reader view),
 * TemplateSection (admin preview) and ModerationSection (thumbnail).
 *
 * - The layout (resolveLayout: closed list, legacy ids mapped) fixes the ratio (3:4 / 4:3) and
 *   the writing zone. The background image covers the whole card at 100%; no overlay.
 * - Text is written in the student's ink and font. Both go through resolveInk / resolveFont and
 *   React style objects, so only lowercase #rrggbb and a fixed font stack can reach CSS.
 * - Sizes are in container-query units (cqw), so a 150 px thumbnail looks exactly like the full
 *   card. After layout, fitText shrinks the zone's font size until the text fits (bounded).
 * - The line under the name comes from roleLabel(): "Giáo viên: <môn>", "Giáo viên", or the
 *   chức vụ alone for Hiệu trưởng / Phó hiệu trưởng.
 * - Image URLs are built only for tokens matching ^[a-z0-9]{16}$. Only the background slot is used.
 */
import { useLayoutEffect, useRef } from 'react'
import { resolveLayout } from '../../shared/layouts.ts'
import { resolveFont, resolveInk } from '../../shared/fonts.ts'
import { roleLabel } from '../../shared/api.ts'
import { fitText } from './fitText.ts'
import site from '../content/site.json'

type CardData = { name: string; subject: string; message: string; title?: 'Thầy' | 'Cô' | null; role?: string | null }
type ImageMap = Partial<Record<string, string>>

const TOKEN_RE = /^[a-z0-9]{16}$/

function imageUrl(token: string | undefined): string | null {
  if (!token || !TOKEN_RE.test(token)) return null
  return `/api/image/${token}`
}

export default function CardView({
  card,
  layout,
  images = {},
  from: fromOverride,
  headingLevel: Heading = 'h1',
  ink,
  font,
  showZone = false,
}: {
  card: CardData
  layout: string
  images: ImageMap
  /** Optional signature line. When provided, replaces the default "Học sinh {org}" text. */
  from?: string
  /** Heading element for the teacher name. Use 'h2' when CardView appears in a list (default 'h1'). */
  headingLevel?: 'h1' | 'h2'
  /** Student's ink (#rrggbb); anything else renders in the default blue. */
  ink?: string
  /** Student's font id; anything else renders in the default font. */
  font?: string
  /** Admin editor: outline the writing zone. */
  showZone?: boolean
}) {
  const l = resolveLayout(layout)
  const bgUrl = imageUrl(images['background'])
  const subLabel = roleLabel(card.role, card.subject)
  const zoneRef = useRef<HTMLDivElement>(null)
  const inkColor = resolveInk(ink)
  const fontStack = resolveFont(font).stack
  const from = fromOverride !== undefined ? fromOverride : `Học sinh ${site.organization}`

  useLayoutEffect(() => {
    const zone = zoneRef.current
    if (!zone) return
    fitText(zone, l.ratio)
    // A web font that is still loading changes the text metrics: fit once more when it arrives.
    // Skipped when fonts are already loaded, so a page of 200 cards fits each card once.
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts || fonts.status === 'loaded') return
    let alive = true
    fonts.ready.then(() => { if (alive) fitText(zone, l.ratio) })
    return () => { alive = false }
  }, [l.ratio, l.id, card.message, card.name, card.title, subLabel, from, fontStack])

  const z = l.zone
  const classes = ['card', `card--${l.ratio}`]
  if (bgUrl) classes.push('card--has-bg')
  if (showZone) classes.push('card--show-zone')

  return (
    <article
      className={classes.join(' ')}
      data-layout={l.id}
      style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : undefined}
    >
      <div
        ref={zoneRef}
        className="card-zone"
        style={{ left: `${z.x}%`, top: `${z.y}%`, width: `${z.w}%`, height: `${z.h}%`, color: inkColor, fontFamily: fontStack }}
      >
        <p className="to">Kính gửi</p>
        <Heading className="name">{card.title ? `${card.title} ${card.name}` : card.name}</Heading>
        {subLabel && <p className="sub">{subLabel}</p>}
        <p className="msg">{card.message}</p>
        <p className="from">{from}</p>
      </div>
      <p className="card-stamp">{site.title} · 20/11</p>
    </article>
  )
}
