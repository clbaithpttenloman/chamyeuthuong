// @vitest-environment node
/**
 * Tests for worker/password.ts
 * RED phase: will fail until worker/password.ts is created.
 *
 * Contract (contracts.md):
 *   PBKDF2_ITERATIONS = 50_000
 *   PASSWORD_STATS: { hashes: number }   — incremented once per PBKDF2 derivation
 *   pbkdf2(password, salt, iterations, bits): Promise<Uint8Array>
 *   constantTimeEqual(a, b): boolean
 *   StoredCredential = { hash: string; salt: string; iterations: number }  (base64)
 *   hashPassword(nfcPassword, pepper, opts?): Promise<StoredCredential>
 *     — input to PBKDF2 = HMAC-SHA256(pepper, utf8(nfcPassword))
 *   verifyPassword(nfcPassword, pepper, cred): Promise<boolean>
 *   TEMP_PASSWORD_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'  (31 chars)
 *   generateTempPassword(randomBytes?): string   — 12 chars, rejection sampling
 *
 * docs/tech.md "Password hashing on Workers":
 *   RFC 7914 §11 vector: P="passwd", S="salt", c=1, dkLen=64
 *   Constant-time compare: XOR-accumulate (no Workers-only timingSafeEqual)
 */
import { describe, it, expect } from 'vitest'
import {
  pbkdf2,
  hashPassword,
  verifyPassword,
  constantTimeEqual,
  generateTempPassword,
  PBKDF2_ITERATIONS,
  PASSWORD_STATS,
  TEMP_PASSWORD_ALPHABET,
} from './password.ts'

// ── Helpers ──────────────────────────────────────────────────────────────────

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
}

/** Provides bytes from a fixed sequence, cycling if exhausted. */
function seqBytes(sequence: number[]): (n: number) => Uint8Array {
  let pos = 0
  return (n: number): Uint8Array => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) out[i] = sequence[pos++ % sequence.length]
    return out
  }
}

// ── RFC 7914 §11 test vector ─────────────────────────────────────────────────
// P = "passwd", S = "salt", c = 1, dkLen = 64 (512 bits)
// From docs/tech.md "Password hashing on Workers"

const RFC_7914_HEX =
  '55ac046e56e3089fec1691c22544b605' + // bytes  1-16
  'f94185216dde0465e68b9d57c20dacbc' + // bytes 17-32
  '49ca9cccf179b645991664b39d77ef31' + // bytes 33-48
  '7c71b845b1e30bd509112041d3a19783'   // bytes 49-64

describe('pbkdf2 — RFC 7914 §11 test vector', () => {
  it('P="passwd", S="salt", c=1, 512 bits → known 64-byte output', async () => {
    const enc = new TextEncoder()
    const result = await pbkdf2(enc.encode('passwd'), enc.encode('salt'), 1, 512)
    expect(uint8ArrayToHex(result)).toBe(RFC_7914_HEX)
  })
})

// ── PBKDF2_ITERATIONS constant ───────────────────────────────────────────────

describe('PBKDF2_ITERATIONS', () => {
  it('is between 10_000 and 100_000 inclusive (workerd cap)', () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(10_000)
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(100_000)
  })
})

// ── hashPassword / verifyPassword round trip ─────────────────────────────────

describe('hashPassword / verifyPassword', () => {
  const PEPPER = 'test-pepper-secret'
  const LOW_ITERS = { iterations: 1_000 } // fast for tests

  it('round trip: verify with correct password → true', async () => {
    const cred = await hashPassword('correct-pass', PEPPER, LOW_ITERS)
    expect(await verifyPassword('correct-pass', PEPPER, cred)).toBe(true)
  })

  it('wrong password → false', async () => {
    const cred = await hashPassword('correct-pass', PEPPER, LOW_ITERS)
    expect(await verifyPassword('wrong-pass', PEPPER, cred)).toBe(false)
  })

  it('wrong pepper → false', async () => {
    const cred = await hashPassword('correct-pass', PEPPER, LOW_ITERS)
    expect(await verifyPassword('correct-pass', 'different-pepper', cred)).toBe(false)
  })

  it('callers pass NFC: verify(nfc) succeeds after hash(nfc)', async () => {
    // Callers normalise to NFC before calling. Test that round-trip works.
    const nfc = 'mật khẩu tốt 1'.normalize('NFC')
    const cred = await hashPassword(nfc, PEPPER, LOW_ITERS)
    expect(await verifyPassword(nfc, PEPPER, cred)).toBe(true)
  })

  it('stored iterations are honoured: hash with 10_000, verify uses stored 10_000', async () => {
    const cred = await hashPassword('pass1234', PEPPER, { iterations: 10_000 })
    expect(cred.iterations).toBe(10_000)
    expect(await verifyPassword('pass1234', PEPPER, cred)).toBe(true)
  })

  it('stored credential has base64 hash and salt strings', async () => {
    const cred = await hashPassword('pass1234', PEPPER, LOW_ITERS)
    expect(typeof cred.hash).toBe('string')
    expect(typeof cred.salt).toBe('string')
    // base64 uses only [A-Za-z0-9+/=]
    expect(cred.hash).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(cred.salt).toMatch(/^[A-Za-z0-9+/=]+$/)
  })
})

// ── PASSWORD_STATS.hashes ────────────────────────────────────────────────────

describe('PASSWORD_STATS.hashes', () => {
  it('hashPassword increments by exactly 1', async () => {
    const before = PASSWORD_STATS.hashes
    await hashPassword('pass1234', 'pepper', { iterations: 1_000 })
    expect(PASSWORD_STATS.hashes).toBe(before + 1)
  })

  it('verifyPassword increments by exactly 1', async () => {
    const cred = await hashPassword('pass1234', 'pepper', { iterations: 1_000 })
    const before = PASSWORD_STATS.hashes
    await verifyPassword('pass1234', 'pepper', cred)
    expect(PASSWORD_STATS.hashes).toBe(before + 1)
  })
})

// ── constantTimeEqual ────────────────────────────────────────────────────────

describe('constantTimeEqual', () => {
  it('equal 32-byte arrays → true', () => {
    const a = new Uint8Array(32).fill(0xAB)
    const b = new Uint8Array(32).fill(0xAB)
    expect(constantTimeEqual(a, b)).toBe(true)
  })

  it('differ in last byte → false', () => {
    const a = new Uint8Array(32).fill(0xAB)
    const b = new Uint8Array(32).fill(0xAB)
    b[31] = 0xAC
    expect(constantTimeEqual(a, b)).toBe(false)
  })

  it('different lengths → false', () => {
    const a = new Uint8Array(32).fill(0xAB)
    const b = new Uint8Array(16).fill(0xAB)
    expect(constantTimeEqual(a, b)).toBe(false)
  })
})

// ── generateTempPassword ─────────────────────────────────────────────────────

describe('generateTempPassword', () => {
  it('returns exactly 12 characters', () => {
    expect(generateTempPassword().length).toBe(12)
  })

  it('every character is in TEMP_PASSWORD_ALPHABET', () => {
    const pw = generateTempPassword()
    for (const c of pw) {
      expect(TEMP_PASSWORD_ALPHABET.includes(c), `char '${c}' not in alphabet`).toBe(true)
    }
  })

  it('deterministic with injected randomBytes: bytes 0..11 → first 12 alphabet chars', () => {
    // 0 % 31 = 0 → ALPHABET[0]='2', 1 % 31 = 1 → '3', ..., 11 % 31 = 11 → 'd'
    const pw = generateTempPassword(seqBytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))
    expect(pw).toBe(TEMP_PASSWORD_ALPHABET.slice(0, 12)) // '23456789abcd'
  })

  it('rejection sampling: bytes >= 248 are skipped (256 % 31 = 8, biased range 248..255)', () => {
    // 8 * 31 = 248, so values 248..255 (8 values) would bias the distribution and must be rejected.
    // Inject: 12 high bytes (all rejected) followed by 12 zeros (0 % 31 = 0 → ALPHABET[0]='2').
    const sequence = [...Array(12).fill(248), ...Array(12).fill(0)]
    const pw = generateTempPassword(seqBytes(sequence))
    expect(pw).toBe(TEMP_PASSWORD_ALPHABET[0].repeat(12)) // '222222222222'
  })

  it('distribution sanity: all 31 alphabet chars appear across 5_000 generated passwords', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5_000; i++) {
      for (const c of generateTempPassword()) seen.add(c)
    }
    for (const c of TEMP_PASSWORD_ALPHABET) {
      expect(seen.has(c), `symbol '${c}' never appeared in 5000 samples`).toBe(true)
    }
  })
})
