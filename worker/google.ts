/**
 * worker/google.ts — Google ID token verification and email authority check.
 *
 * verifyGoogleCredential — verifies a Google ID token (credential string) using
 *   jose jwtVerify against Google's JWKS. Pre-checks length and structure before
 *   any network call; throws HttpError('unauthorized') on any failure.
 *
 * isGoogleAuthoritative — returns true when Google vouches for the email address:
 *   @gmail.com (case-insensitive) or Workspace (non-empty hd claim).
 */
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { JWTVerifyGetKey } from 'jose'
import { HttpError } from './http.ts'

export type { JWTVerifyGetKey }

const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs')
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const

/** One JWKS instance per isolate; cooldownDuration stops unknown-kid tokens from forcing refetches. */
let _jwks: JWTVerifyGetKey | null = null
function getJwks(): JWTVerifyGetKey {
  if (!_jwks) _jwks = createRemoteJWKSet(GOOGLE_JWKS_URL, { cooldownDuration: 30_000 })
  return _jwks
}

export type GoogleClaims = {
  sub: string
  email: string
  emailVerified: true
  hd?: string
  nonce: string
}

/** Decode a base64url JWT segment (no padding required). */
function decodeBase64Url(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const rem = base64.length % 4
  const padded = rem === 0 ? base64 : rem === 2 ? base64 + '==' : base64 + '='
  return atob(padded)
}

/**
 * Verify a Google ID token credential.
 *
 * Pre-checks (before JWKS lookup):
 *   - credential length 1–4096 chars
 *   - exactly 3 JWT parts
 *   - protected header has alg: RS256 and a non-empty kid string
 *
 * Full checks (via jwtVerify):
 *   - RS256 signature against Google JWKS
 *   - iss ∈ {accounts.google.com, https://accounts.google.com}
 *   - aud == GOOGLE_CLIENT_ID
 *   - exp not passed, iat within 1 h (maxTokenAge), clockTolerance 60 s
 *   - sub, exp, iat required claims
 *
 * Custom checks after jwtVerify:
 *   - email_verified === true (boolean strict)
 *   - email and sub are strings
 *
 * Pass deps.keys to inject a local JWKS in tests (avoids network calls).
 */
export async function verifyGoogleCredential(
  credential: string,
  env: { GOOGLE_CLIENT_ID: string },
  deps?: { keys?: JWTVerifyGetKey },
): Promise<GoogleClaims> {
  // Pre-check: non-empty, ≤ 4 KB
  if (credential.length === 0 || credential.length > 4096) throw new HttpError('unauthorized')

  // Pre-check: exactly 3 JWT parts
  const parts = credential.split('.')
  if (parts.length !== 3) throw new HttpError('unauthorized')

  // Pre-check: decode and validate protected header (RS256, non-empty kid)
  let headerObj: Record<string, unknown>
  try {
    headerObj = JSON.parse(decodeBase64Url(parts[0]!)) as Record<string, unknown>
  } catch {
    throw new HttpError('unauthorized')
  }
  if (headerObj.alg !== 'RS256') throw new HttpError('unauthorized')
  if (typeof headerObj.kid !== 'string' || headerObj.kid === '') throw new HttpError('unauthorized')

  const keys = deps?.keys ?? getJwks()

  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(credential, keys, {
      algorithms: ['RS256'],
      issuer: GOOGLE_ISSUERS as unknown as string[],
      audience: env.GOOGLE_CLIENT_ID,
      clockTolerance: 60,
      requiredClaims: ['sub', 'exp', 'iat'],
    })
    payload = result.payload as Record<string, unknown>
  } catch {
    throw new HttpError('unauthorized')
  }

  // Strict max-token-age check (1 h with no extra tolerance).
  // jose's built-in maxTokenAge subtracts clockTolerance, so we enforce it manually.
  // Also check for future iat (jose only checks this when maxTokenAge is set).
  const iat = typeof payload.iat === 'number' ? payload.iat : 0
  const nowSec = Math.floor(Date.now() / 1000)
  if (iat > nowSec + 60) throw new HttpError('unauthorized')    // future iat beyond tolerance
  if (nowSec - iat > 3600) throw new HttpError('unauthorized')  // too old: strict 1 h max age

  // Additional strict checks not enforced by jwtVerify options
  if (payload.email_verified !== true) throw new HttpError('unauthorized')
  if (typeof payload.email !== 'string') throw new HttpError('unauthorized')
  if (typeof payload.sub !== 'string') throw new HttpError('unauthorized')
  if (typeof payload.nonce !== 'string') throw new HttpError('unauthorized')

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: true,
    hd: typeof payload.hd === 'string' ? payload.hd : undefined,
    nonce: payload.nonce,
  }
}

/**
 * Returns true when Google vouches for the email address:
 *   - email ends with @gmail.com (case-insensitive), OR
 *   - hd is a non-empty string (Workspace account; Google verified the domain).
 *
 * For other addresses, Google says ownership "may have since changed"; we do
 * not grant admin access on those.
 */
export function isGoogleAuthoritative(email: string, hd?: string): boolean {
  if (email.toLowerCase().endsWith('@gmail.com')) return true
  if (typeof hd === 'string' && hd.length > 0) return true
  return false
}
