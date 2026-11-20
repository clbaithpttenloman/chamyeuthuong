// @vitest-environment node
/**
 * RED-phase tests for worker/google.ts.
 *
 * Contract:
 *   verifyGoogleCredential(credential, env, deps?) → Promise<{sub, email, emailVerified: true, hd?, nonce}>
 *     throws HttpError('unauthorized') on any validation failure.
 *   isGoogleAuthoritative(email, hd?) → boolean
 *
 * These tests fail at import because worker/google.ts does not exist yet.
 * They will turn green when Group 3 implementation ships.
 */
import { describe, it, expect } from 'vitest'
// --- The module under test does not exist yet; import triggers red phase ---
import { verifyGoogleCredential, isGoogleAuthoritative } from './google.ts'
import { HttpError } from './http.ts'
import {
  signIdToken,
  validToken,
  localJwks,
  TEST_CLIENT_ID,
  TEST_EMAIL,
  TEST_EMAIL_WORKSPACE,
  TEST_HD,
  TEST_SUB,
  googleCredentialEnv,
} from './testGoogle.ts'

// ── Helper: build an unsigned/alg:none JWT ─────────────────────────────────

function buildRawJwt(header: object, payload: object): string {
  const enc = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  return `${enc(header)}.${enc(payload)}.`
}

// ── verifyGoogleCredential — happy path ───────────────────────────────────────

describe('verifyGoogleCredential — valid Gmail token', () => {
  it('valid token returns { sub, email, emailVerified: true, nonce }', async () => {
    const credential = await validToken()
    const result = await verifyGoogleCredential(
      credential,
      googleCredentialEnv(),
      { keys: await localJwks() },
    )
    expect(result.sub).toBe(TEST_SUB)
    expect(result.email).toBe(TEST_EMAIL)
    expect(result.emailVerified).toBe(true)
    expect(typeof result.nonce).toBe('string')
  })

  it('iss = "accounts.google.com" (without https) also passes', async () => {
    const credential = await validToken({ iss: 'accounts.google.com' })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).resolves.toMatchObject({ email: TEST_EMAIL })
  })

  it('iss = "https://accounts.google.com" passes', async () => {
    const credential = await validToken({ iss: 'https://accounts.google.com' })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).resolves.toMatchObject({ email: TEST_EMAIL })
  })

  it('token with hd returns hd field', async () => {
    const credential = await validToken({ email: TEST_EMAIL_WORKSPACE, hd: TEST_HD })
    const result = await verifyGoogleCredential(
      credential,
      googleCredentialEnv(),
      { keys: await localJwks() },
    )
    expect(result.hd).toBe(TEST_HD)
  })

  it('aud as array containing TEST_CLIENT_ID passes', async () => {
    const credential = await validToken({ aud: [TEST_CLIENT_ID, 'other-aud'] })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).resolves.toMatchObject({ sub: TEST_SUB })
  })
})

// ── verifyGoogleCredential — audience ────────────────────────────────────────

describe('verifyGoogleCredential — wrong audience', () => {
  it('wrong aud → throws HttpError unauthorized', async () => {
    const credential = await validToken({ aud: 'wrong-client-id.apps.googleusercontent.com' })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('missing aud claim → throws HttpError unauthorized', async () => {
    const credential = await signIdToken({
      iss: 'https://accounts.google.com',
      sub: TEST_SUB,
      email: TEST_EMAIL,
      email_verified: true,
      nonce: 'nonce',
    })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })
})

// ── verifyGoogleCredential — issuer ──────────────────────────────────────────

describe('verifyGoogleCredential — wrong issuer', () => {
  it('iss = "https://evil.com" → throws HttpError unauthorized', async () => {
    const credential = await validToken({ iss: 'https://evil.com' })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('iss = "accounts.google.com.evil.org" → throws HttpError unauthorized', async () => {
    const credential = await validToken({ iss: 'accounts.google.com.evil.org' })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })
})

// ── verifyGoogleCredential — algorithm ───────────────────────────────────────

describe('verifyGoogleCredential — wrong algorithm', () => {
  it('HS256 credential → throws HttpError unauthorized (wrong alg before key lookup)', async () => {
    const credential = await signIdToken(
      { iss: 'https://accounts.google.com', aud: TEST_CLIENT_ID, sub: TEST_SUB,
        email: TEST_EMAIL, email_verified: true, nonce: 'nonce' },
      { hs256Secret: 'some-secret' },
    )
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('alg:none credential → throws HttpError unauthorized', async () => {
    const credential = buildRawJwt(
      { alg: 'none', typ: 'JWT' },
      { iss: 'https://accounts.google.com', aud: TEST_CLIENT_ID, sub: TEST_SUB,
        email: TEST_EMAIL, email_verified: true, nonce: 'nonce',
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
    )
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('RS256 token signed with an unknown key → throws HttpError unauthorized', async () => {
    // signIdToken with useK2 but localJwks only has k1
    const credential = await validToken({}, { useK2: true })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })
})

// ── verifyGoogleCredential — expiry and timing ───────────────────────────────

describe('verifyGoogleCredential — expiry and timing', () => {
  it('expired token (exp in the past) → throws HttpError unauthorized', async () => {
    const now = Math.floor(Date.now() / 1000)
    const credential = await signIdToken({
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      sub: TEST_SUB,
      email: TEST_EMAIL,
      email_verified: true,
      nonce: 'nonce',
      iat: now - 7200,
      exp: now - 3600,
    })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('iat = now + 300 s (far future iat) → throws HttpError unauthorized', async () => {
    const now = Math.floor(Date.now() / 1000)
    const credential = await signIdToken({
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      sub: TEST_SUB,
      email: TEST_EMAIL,
      email_verified: true,
      nonce: 'nonce',
      iat: now + 300,
      exp: now + 3900,
    })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('token age exactly 1 h + 2 s (beyond maxTokenAge + tolerance) → throws HttpError unauthorized', async () => {
    const now = Math.floor(Date.now() / 1000)
    // iat = 1 h + 2 s ago; exp = 2 h from that iat (still technically valid per exp, but age exceeded)
    const credential = await signIdToken({
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      sub: TEST_SUB,
      email: TEST_EMAIL,
      email_verified: true,
      nonce: 'nonce',
      iat: now - 3602,
      exp: now + (3600 - 2),  // positive, so jose's exp check passes
    })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })
})

// ── verifyGoogleCredential — required claims ─────────────────────────────────

describe('verifyGoogleCredential — required claims', () => {
  it('missing sub → throws HttpError unauthorized', async () => {
    const credential = await signIdToken({
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      email: TEST_EMAIL,
      email_verified: true,
      nonce: 'nonce',
    })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('missing exp → throws HttpError unauthorized', async () => {
    const credential = await signIdToken(
      { iss: 'https://accounts.google.com', aud: TEST_CLIENT_ID, sub: TEST_SUB,
        email: TEST_EMAIL, email_verified: true, nonce: 'nonce' },
      { noExp: true },
    )
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('missing iat → throws HttpError unauthorized (iat required)', async () => {
    const credential = await signIdToken(
      { iss: 'https://accounts.google.com', aud: TEST_CLIENT_ID, sub: TEST_SUB,
        email: TEST_EMAIL, email_verified: true, nonce: 'nonce' },
      { noIat: true },
    )
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })
})

// ── verifyGoogleCredential — email_verified ───────────────────────────────────

describe('verifyGoogleCredential — email_verified', () => {
  it('email_verified: false → throws HttpError unauthorized', async () => {
    const credential = await validToken({ email_verified: false })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('email_verified: missing → throws HttpError unauthorized', async () => {
    const credential = await signIdToken({
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      sub: TEST_SUB,
      email: TEST_EMAIL,
      nonce: 'nonce',
    })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('email_verified: "true" (string, not boolean) → throws HttpError unauthorized', async () => {
    const credential = await validToken({ email_verified: 'true' })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('email_verified: 1 (number) → throws HttpError unauthorized', async () => {
    const credential = await validToken({ email_verified: 1 })
    await expect(
      verifyGoogleCredential(credential, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })
})

// ── verifyGoogleCredential — credential size and structure checks ─────────────

describe('verifyGoogleCredential — credential pre-checks (before key lookup)', () => {
  it('credential > 4096 chars → throws HttpError unauthorized without touching JWKS', async () => {
    // A 4097-char string that looks like a JWT structurally (3 parts) but is too long
    const header = btoa(JSON.stringify({ alg: 'RS256', kid: 'k1' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const bigBody = 'x'.repeat(4090)
    const fakeJwt = `${header}.${bigBody}.fakesig`

    // Track if key was called (it must NOT be called for over-length credentials)
    let keyCalled = false
    const trackingJwks: JWTVerifyGetKey = async (h, t) => {
      keyCalled = true
      return (await localJwks())(h, t)
    }

    await expect(
      verifyGoogleCredential(fakeJwt, googleCredentialEnv(), { keys: trackingJwks }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
    expect(keyCalled).toBe(false)
  })

  it('2-part credential (one dot, not 3 parts) → throws HttpError unauthorized without key lookup', async () => {
    let keyCalled = false
    const trackingJwks: JWTVerifyGetKey = async (h, t) => {
      keyCalled = true
      return (await localJwks())(h, t)
    }

    await expect(
      verifyGoogleCredential('part1.part2', googleCredentialEnv(), { keys: trackingJwks }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
    expect(keyCalled).toBe(false)
  })

  it('empty string credential → throws HttpError unauthorized', async () => {
    await expect(
      verifyGoogleCredential('', googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('4-part credential (extra dot) → throws HttpError unauthorized', async () => {
    await expect(
      verifyGoogleCredential('a.b.c.d', googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })

  it('missing kid in protected header → throws HttpError unauthorized', async () => {
    // Strip kid from a valid JWT header
    const full = await validToken()
    const parts = full.split('.')
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf-8')) as Record<string, unknown>
    delete header['kid']
    const newHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
    const stripped = `${newHeader}.${parts[1]}.${parts[2]}`
    await expect(
      verifyGoogleCredential(stripped, googleCredentialEnv(), { keys: await localJwks() }),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.code === 'unauthorized')
  })
})

// ── isGoogleAuthoritative ────────────────────────────────────────────────────

describe('isGoogleAuthoritative', () => {
  it('@gmail.com (lowercase) → true', () => {
    expect(isGoogleAuthoritative('user@gmail.com')).toBe(true)
  })

  it('@Gmail.com (mixed case) → true (case-insensitive)', () => {
    expect(isGoogleAuthoritative('user@Gmail.com')).toBe(true)
  })

  it('@GMAIL.COM (uppercase) → true', () => {
    expect(isGoogleAuthoritative('USER@GMAIL.COM')).toBe(true)
  })

  it('workspace email with non-empty hd → true', () => {
    expect(isGoogleAuthoritative(TEST_EMAIL_WORKSPACE, TEST_HD)).toBe(true)
  })

  it('other domain WITHOUT hd (non-Gmail, no workspace) → false', () => {
    expect(isGoogleAuthoritative('admin@school.edu')).toBe(false)
  })

  it('other domain WITHOUT hd even though email_verified would be true → false', () => {
    // Google says ownership "may have changed" for non-Gmail without hd
    expect(isGoogleAuthoritative('cto@company.com')).toBe(false)
  })

  it('empty hd string → false (hd must be non-empty)', () => {
    expect(isGoogleAuthoritative('admin@company.com', '')).toBe(false)
  })

  it('@gmail.com.evil.org → false (must end exactly with @gmail.com)', () => {
    expect(isGoogleAuthoritative('phish@gmail.com.evil.org')).toBe(false)
  })

  it('no @ sign → false', () => {
    expect(isGoogleAuthoritative('notanemail')).toBe(false)
  })
})
