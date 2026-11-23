/**
 * Password hashing for accounts (ADR-9, docs/tech.md "Password hashing on Workers").
 *
 * Stored form: PBKDF2-HMAC-SHA256 over HMAC-SHA256(pepper, NFC password), with a random
 * 16-byte salt and a 32-byte output. The pepper is a Worker secret that is not in D1, so a
 * database-only leak yields no crackable hashes.
 */

/**
 * SHORTCUT: 50,000 iterations. Production Workers refuse more than 100,000 (workerd cap,
 * production only). OWASP recommends 600,000, which the cap blocks. Upgrade path: raise this
 * to 100,000 after the account moves to Workers Paid (CPU budget 30 s default), and rehash on
 * login. Stored per credential, so old hashes keep working.
 */
export const PBKDF2_ITERATIONS = 50_000

/** Counts PBKDF2 derivations, so tests can assert how many hashes a code path computed. */
export const PASSWORD_STATS = { hashes: 0 }

export type StoredCredential = { hash: string; salt: string; iterations: number }

const enc = new TextEncoder()

export async function pbkdf2(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  bits: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits'])
  const out = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    bits,
  )
  return new Uint8Array(out)
}

/** XOR-accumulate compare over the full length. Lengths differing returns false. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function peppered(nfcPassword: string, pepper: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(nfcPassword))
  return new Uint8Array(mac)
}

async function derive(
  nfcPassword: string,
  pepper: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  PASSWORD_STATS.hashes++
  return pbkdf2(await peppered(nfcPassword, pepper), salt, iterations, 256)
}

/** Hashes an NFC password. Callers normalise first (`checkPassword` returns the NFC form). */
export async function hashPassword(
  nfcPassword: string,
  pepper: string,
  opts: { iterations?: number; salt?: Uint8Array } = {},
): Promise<StoredCredential> {
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(nfcPassword, pepper, salt, iterations)
  return { hash: toBase64(hash), salt: toBase64(salt), iterations }
}

/** Checks a password against a stored credential, using the iteration count stored with it. */
export async function verifyPassword(
  nfcPassword: string,
  pepper: string,
  cred: StoredCredential,
): Promise<boolean> {
  const derived = await derive(nfcPassword, pepper, fromBase64(cred.salt), cred.iterations)
  return constantTimeEqual(derived, fromBase64(cred.hash))
}

/** Temporary passwords: no look-alike characters (no 0/O/1/l/i). 31 symbols. */
export const TEMP_PASSWORD_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

const TEMP_LENGTH = 12

/**
 * Builds a 12-character temporary password. Bytes at or above 248 are rejected because
 * 256 mod 31 != 0, so keeping them would bias the symbols. Rejection sampling avoids that.
 */
export function generateTempPassword(
  randomBytes: (n: number) => Uint8Array = n => crypto.getRandomValues(new Uint8Array(n)),
): string {
  const limit = 256 - (256 % TEMP_PASSWORD_ALPHABET.length) // 248
  let out = ''
  while (out.length < TEMP_LENGTH) {
    for (const b of randomBytes(TEMP_LENGTH)) {
      if (b >= limit) continue
      out += TEMP_PASSWORD_ALPHABET[b % TEMP_PASSWORD_ALPHABET.length]
      if (out.length === TEMP_LENGTH) break
    }
  }
  return out
}
