/**
 * Test helpers for Cloudflare Access JWT authentication.
 * Provides key-pair generation, JWT signing, local JWKS resolvers, and env builders
 * so auth tests run without any network calls.
 */
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose'
import type { CryptoKey, LocalJWKSet } from 'jose'

// ---- Constants ----

export const TEST_TEAM_DOMAIN = 'https://test.cloudflareaccess.com'
export const TEST_AUD = 'test-aud-12345678'
export const TEST_EMAIL = 'admin@example.com'

// ---- Lazy key pairs (generated once per test run) ----

type KP = { privateKey: CryptoKey; publicKey: CryptoKey }
let _kp1: KP | null = null
let _kp2: KP | null = null

async function kp1(): Promise<KP> {
  if (!_kp1) _kp1 = await generateKeyPair('RS256', { extractable: true })
  return _kp1
}

async function kp2(): Promise<KP> {
  if (!_kp2) _kp2 = await generateKeyPair('RS256', { extractable: true })
  return _kp2
}

// ---- JWKS helpers ----

/** One-key local JWKS (kid: 'k1'). Use for most auth tests. */
export async function localJwks(): Promise<LocalJWKSet> {
  const { publicKey } = await kp1()
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1' }
  return createLocalJWKSet({ keys: [jwk] })
}

/** Two-key local JWKS (kid: 'k1' and 'k2'). Use for kid-selection tests. */
export async function twoKeyJwks(): Promise<LocalJWKSet> {
  const { publicKey: pk1 } = await kp1()
  const { publicKey: pk2 } = await kp2()
  const jwk1 = { ...(await exportJWK(pk1)), kid: 'k1' }
  const jwk2 = { ...(await exportJWK(pk2)), kid: 'k2' }
  return createLocalJWKSet({ keys: [jwk1, jwk2] })
}

// ---- JWT signing helpers ----

export type SignOpts = {
  kid?: string       // default: 'k1' (or 'k2' when useK2 is true)
  noIat?: boolean    // skip setIssuedAt()
  noExp?: boolean    // skip setExpirationTime()
  useK2?: boolean    // sign with kp2 private key (useful for wrong-key tests)
}

/**
 * Sign a JWT with exactly the given claims payload.
 * Sets iat and exp automatically unless noIat/noExp are set.
 * Caller is responsible for all claims (iss, aud, email, etc.).
 */
export async function signJwt(
  claims: Record<string, unknown>,
  opts: SignOpts = {},
): Promise<string> {
  const { privateKey } = opts.useK2 ? await kp2() : await kp1()
  const kid = opts.kid ?? (opts.useK2 ? 'k2' : 'k1')

  let builder = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid })
  if (!opts.noIat && !('iat' in claims)) builder = builder.setIssuedAt()
  if (!opts.noExp && !('exp' in claims)) builder = builder.setExpirationTime('1h')
  return builder.sign(privateKey)
}

/**
 * Convenience: sign a valid JWT with the standard test claims and optional overrides.
 * Produces { iss: TEST_TEAM_DOMAIN, aud: TEST_AUD, email: TEST_EMAIL, iat, exp }.
 */
export async function validJwt(
  overrides: Record<string, unknown> = {},
  opts: SignOpts = {},
): Promise<string> {
  return signJwt(
    { iss: TEST_TEAM_DOMAIN, aud: TEST_AUD, email: TEST_EMAIL, ...overrides },
    opts,
  )
}

// ---- Env type and builder ----

export type AccessEnv = {
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  ADMIN_EMAILS: string
  ACCESS_DEV_MODE?: string | undefined
  ADMIN_FAIL_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
}

type AccessEnvOpts = {
  /** Override ACCESS_TEAM_DOMAIN. Pass '' to simulate missing/empty. */
  teamDomain?: string
  /** Override ACCESS_AUD. Pass '' to simulate missing/empty. */
  aud?: string
  /** Override ADMIN_EMAILS. Pass '' to simulate missing/empty. */
  adminEmails?: string
  /** Set ACCESS_DEV_MODE. Pass '1' to enable dev mode. */
  devMode?: string
  /** Whether the rate-limit check succeeds (default true). */
  failLimit?: boolean
}

/**
 * Build a minimal env for direct requireAdmin tests.
 * Does NOT include DB, ASSETS, CARD_IP_LIMIT — add those when calling handleAdmin.
 */
export function accessEnv(opts: AccessEnvOpts = {}): AccessEnv {
  return {
    ACCESS_TEAM_DOMAIN: opts.teamDomain !== undefined ? opts.teamDomain : TEST_TEAM_DOMAIN,
    ACCESS_AUD: opts.aud !== undefined ? opts.aud : TEST_AUD,
    ADMIN_EMAILS: opts.adminEmails !== undefined ? opts.adminEmails : TEST_EMAIL,
    ACCESS_DEV_MODE: opts.devMode,
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: opts.failLimit ?? true }) },
  }
}
