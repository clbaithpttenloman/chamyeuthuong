/**
 * Shared email normalisation for auth.ts and admins.ts.
 *
 * Accepts: ASCII-only, exactly one @, at least one dot in the domain, no whitespace,
 *          ≤ 254 characters after trim + lower-case.
 * Returns the normalised string on success, null on any failure.
 */

/** ASCII email pattern (after trim + lower-case). Requires at least one dot in the domain. */
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z0-9\-]+$/

/**
 * Normalises a raw value to a valid admin email address, or returns null.
 *
 * Steps:
 *   1. Reject null / undefined.
 *   2. Trim outer whitespace and convert to lower-case.
 *   3. Reject empty or length > 254.
 *   4. Reject anything that does not match the ASCII email pattern
 *      (non-ASCII, internal whitespace, multiple @, no dot in domain, etc.).
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const email = raw.trim().toLowerCase()
  if (email.length === 0 || email.length > 254) return null
  if (!EMAIL_RE.test(email)) return null
  return email
}
