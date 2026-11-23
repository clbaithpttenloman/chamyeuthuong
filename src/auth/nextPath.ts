/** Longest accepted `next` value. Longer values fall back to '/'. */
const MAX_LENGTH = 200

/**
 * Returns a same-origin path from a `?next=` value, or '/'.
 * Control characters, whitespace and backslashes are rejected on the raw value first, because
 * URL parsers strip tab/CR/LF and would turn `/\t/x` into the protocol-relative `//x`.
 * The value is then resolved against `origin`; only its path, query and fragment are used.
 */
export function nextPath(raw: string | null | undefined, origin: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return '/'
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) return '/'
  let url: URL
  try {
    url = new URL(raw, origin)
  } catch {
    return '/'
  }
  if (url.origin !== new URL(origin).origin) return '/'
  return url.pathname + url.search + url.hash
}
