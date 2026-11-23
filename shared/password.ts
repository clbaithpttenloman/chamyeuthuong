/** Password rules for accounts (ADR-9, FR-32). Shared by worker and client. */

/** Raw input caps, in UTF-16 units, checked before NFC normalisation. */
export const RAW_LIMITS = { username: 64, password: 512, nickname: 128, className: 128 } as const

/** Length bounds in code points after NFC normalisation. */
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128

export type PasswordCode =
  | 'password_invalid'
  | 'password_too_short'
  | 'password_too_long'
  | 'password_contains_username'
  | 'password_common'

export type PasswordResult =
  | { ok: true; value: string }
  | { ok: false; code: PasswordCode }

/**
 * Checks a password and returns its NFC form.
 * - Non-strings and raw input over RAW_LIMITS.password are rejected before any normalising.
 * - Length counts code points, so one emoji is one character.
 * - Must not contain the username (case-insensitive).
 * - `isCommon` receives the lower-cased NFC value; true means refused.
 * No composition rules (NIST 800-63B).
 */
export function checkPassword(
  raw: unknown,
  username: string,
  isCommon: (lowerNfc: string) => boolean = () => false,
): PasswordResult {
  if (typeof raw !== 'string' || raw.length > RAW_LIMITS.password) {
    return { ok: false, code: 'password_invalid' }
  }
  const value = raw.normalize('NFC')
  const length = [...value].length
  if (length < PASSWORD_MIN) return { ok: false, code: 'password_too_short' }
  if (length > PASSWORD_MAX) return { ok: false, code: 'password_too_long' }
  const lower = value.toLowerCase()
  if (username && lower.includes(username.toLowerCase())) {
    return { ok: false, code: 'password_contains_username' }
  }
  if (isCommon(lower)) return { ok: false, code: 'password_common' }
  return { ok: true, value }
}
