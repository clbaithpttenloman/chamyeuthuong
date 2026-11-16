const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789' // 36 chars
const TOKEN_LEN = 16
// Rejection sampling: 7 * 36 = 252. Any byte < 252 maps to ALPHABET without bias; 252-255 are rejected.
const ACCEPT_LIMIT = 252

/**
 * Generates a 16-character random token from [a-z0-9].
 * Uses rejection sampling so there is no modulo bias.
 */
export function newToken(): string {
  const result = new Uint8Array(TOKEN_LEN)
  let count = 0
  while (count < TOKEN_LEN) {
    // Over-sample to minimise loops (rejection rate is 4/256 ≈ 1.6%)
    const buf = new Uint8Array(TOKEN_LEN * 4)
    crypto.getRandomValues(buf)
    for (let i = 0; i < buf.length && count < TOKEN_LEN; i++) {
      if (buf[i] < ACCEPT_LIMIT) result[count++] = buf[i] % 36
    }
  }
  return Array.from(result, (b) => ALPHABET[b]).join('')
}

/** Returns true only for exactly 16 lowercase alphanumeric characters. */
export function isToken(s: string): boolean {
  return /^[a-z0-9]{16}$/.test(s)
}
