/**
 * CardView — reusable card renderer.
 *
 * Used by CardPage (public view) and the admin live preview.
 *
 * Props:
 *   card:   { name, subject, message }
 *   layout: layout id from LAYOUTS (falls back to DEFAULT_LAYOUT if unknown)
 *   images: slot → 16-char token; invalid tokens are silently dropped
 *
 * Image URLs are only built for tokens matching ^[a-z0-9]{16}$, so no
 * user-supplied string can reach the src/style attributes in another form.
 */
import { LAYOUTS, DEFAULT_LAYOUT, isLayout } from '../../shared/layouts.ts'
import site from '../content/site.json'

type CardData = { name: string; subject: string; message: string }
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
}: {
  card: CardData
  layout: string
  images: ImageMap
}) {
  // Validate layout id against the closed list; never use arbitrary strings as class names.
  const layoutId = isLayout(layout) ? layout : DEFAULT_LAYOUT

  const bgUrl = imageUrl(images['background'])
  const bannerUrl = imageUrl(images['banner'])
  const photoUrl = imageUrl(images['photo'])

  const hasBackground = bgUrl !== null

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
        {photoUrl && (
          <img
            className="card-photo"
            src={photoUrl}
            alt={`Ảnh đại diện của ${card.name}`}
          />
        )}
        <p className="kicker">{site.title}</p>
        <p className="to">Kính gửi</p>
        <h1>{card.name}</h1>
        {card.subject && <p className="sub">{card.subject}</p>}
        <hr />
        <p className="msg">{card.message}</p>
        <p className="from">
          Học sinh {site.organization}
          <br />
          {site.date}
        </p>
      </div>
    </article>
  )
}

// Re-export LAYOUTS so consumers can enumerate them without a second import.
export { LAYOUTS, DEFAULT_LAYOUT }
