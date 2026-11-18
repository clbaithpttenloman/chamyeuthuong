/**
 * CardView — reusable card renderer.
 *
 * Used by SendPage (write preview), QrPage (reader view), and TemplateSection (admin preview).
 *
 * Props:
 *   card:   { name, subject, message, title? }
 *   layout: layout id from LAYOUTS (falls back to DEFAULT_LAYOUT if unknown)
 *   images: slot → 16-char token; invalid tokens are silently dropped
 *
 * Only the background and banner slots exist; any other key in images is ignored.
 *
 * Subject is shown as "GV môn: <subject>" via subjectLabel(); omitted when empty.
 *
 * Image URLs are only built for tokens matching ^[a-z0-9]{16}$, so no
 * user-supplied string can reach the src/style attributes in another form.
 */
import { LAYOUTS, DEFAULT_LAYOUT, isLayout } from '../../shared/layouts.ts'
import { subjectLabel } from '../../shared/api.ts'
import site from '../content/site.json'

type CardData = { name: string; subject: string; message: string; title?: 'Thầy' | 'Cô' | null }
type ImageMap = Partial<Record<string, string>>

// Accepts exactly 16 lowercase alphanumeric chars — the generated token length.
// 16 is the only valid length; validation rejects shorter/longer strings, path
// traversal, and special characters regardless.
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
}: {
  card: CardData
  layout: string
  images: ImageMap
  /** Optional signature line. When provided, replaces the default "Học sinh {org} / {date}" text. */
  from?: string
  /** Heading element for the teacher name. Use 'h2' when CardView appears in a list (default 'h1'). */
  headingLevel?: 'h1' | 'h2'
}) {
  // Validate layout id against the closed list; never use arbitrary strings as class names.
  const layoutId = isLayout(layout) ? layout : DEFAULT_LAYOUT

  const bgUrl = imageUrl(images['background'])
  const bannerUrl = imageUrl(images['banner'])

  const hasBackground = bgUrl !== null
  const subLabel = subjectLabel(card.subject)

  return (
    <article
      className={`card card--${layoutId}${hasBackground ? ' card--has-bg' : ''}`}
      style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : undefined}
    >
      {bannerUrl && (
        <img
          className="card-banner"
          src={bannerUrl}
          alt=""
          aria-hidden="true"
        />
      )}
      <div className="card-body">
        <p className="kicker">{site.title}</p>
        <p className="to">Kính gửi</p>
        <Heading>{card.title ? `${card.title} ${card.name}` : card.name}</Heading>
        {subLabel && <p className="sub">{subLabel}</p>}
        <hr />
        <p className="msg">{card.message}</p>
        <p className="from">
          {fromOverride !== undefined ? (
            fromOverride
          ) : (
            <>
              Học sinh {site.organization}
              <br />
              {site.date}
            </>
          )}
        </p>
      </div>
    </article>
  )
}

// Re-export LAYOUTS so consumers can enumerate them without a second import.
export { LAYOUTS, DEFAULT_LAYOUT }
