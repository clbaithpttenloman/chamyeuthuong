/**
 * Shared email normalisation for auth.ts and admins.ts.
 *
 * Accepts: ASCII-only, exactly one @, local part [a-z0-9._%+\-]+, domain made of
 *          [a-z0-9]([a-z0-9-]*[a-z0-9])? labels separated by dots (at least two labels),
 *          ≤ 254 characters after trim + lower-case.
 * Returns the normalised string on success, null on any failure.
 *
 * ASCII is checked BEFORE lower-casing so that characters like Kelvin sign U+212A
 * (which JavaScript toLowerCase() maps to 'k') are correctly rejected.
 */

/** Checks that every code unit is in the ASCII range (must run before toLowerCase). */
const ASCII_RE = /^[\x00-\x7F]*$/
/** Local part: standard printable ASCII characters. */
const LOCAL_RE = /^[a-z0-9._%+\-]+$/
/** Single domain label: starts and ends with alnum, may contain hyphens in the middle. */
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * Normalises a raw value to a valid admin email address, or returns null.
 *
 * Steps:
 *   1. Reject null / undefined.
 *   2. Trim outer whitespace.
 *   3. Reject anything with non-ASCII characters (before lower-casing).
 *   4. Convert to lower-case.
 *   5. Reject empty or length > 254.
 *   6. Reject values without exactly one @, with invalid local part,
 *      or with a domain whose labels are not all [a-z0-9]([a-z0-9-]*[a-z0-9])?.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  // Step 3: ASCII check BEFORE lower-casing (Kelvin sign U+212A → 'k' after toLowerCase)
  if (!ASCII_RE.test(trimmed)) return null
  const email = trimmed.toLowerCase()
  if (email.length === 0 || email.length > 254) return null

  const atIdx = email.indexOf('@')
  if (atIdx <= 0) return null                           // no @ or empty local part
  if (atIdx !== email.lastIndexOf('@')) return null     // multiple @

  const local = email.slice(0, atIdx)
  const domain = email.slice(atIdx + 1)

  if (!LOCAL_RE.test(local)) return null

  // Domain: at least two labels, each matching LABEL_RE (no leading/trailing dashes)
  const labels = domain.split('.')
  if (labels.length < 2) return null
  for (const label of labels) {
    if (!LABEL_RE.test(label)) return null
  }

  return email
}
